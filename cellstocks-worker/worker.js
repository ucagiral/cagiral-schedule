// Cell Stocks — private backend.
//
// Everything else in this repository is static: GitHub Pages serving files, GitHub's own
// API doing the writes, no server anywhere. That stops working the moment the lab has more
// than one person, because a GitHub personal access token cannot be scoped to "write access
// to only this one person's data" — a token is repo-wide or nothing. This Worker is the one
// piece of the Cell Stocks system that is not static: it is the only thing that holds the
// GitHub write token, so it is the only thing that can enforce who is allowed to write what.
//
// Everything it protects is otherwise public. cagiral-schedule is a public repository, so
// nothing secret ever belongs in a KV value or a git commit here — passwords are hashed
// (PBKDF2, not reversible) before they are stored, and the GitHub token lives only as a
// Worker secret (`wrangler secret put GITHUB_TOKEN`), never in KV and never in a file.
//
// Reads do not go through this Worker at all: the data files it protects are read straight
// from GitHub's Contents API by the app, unauthenticated, the same way every other app in
// this repo already reads its JSON. Only a write needs an opinion about who is allowed to
// make it, so only writes come here.
//
// No framework, no npm dependencies — Cloudflare Workers and Node both implement the same
// Web platform primitives (fetch, Request/Response, crypto.subtle), so the same file runs
// as the real Worker and, unmodified, inside tools/cellstocks-worker-selftest.mjs against an
// in-memory stand-in for KV. See that file before changing request/response shapes here.

// ============================================================================ password hashing
//
// PBKDF2-SHA256, 100k iterations, a random 16-byte salt per user. No bcrypt/scrypt library
// exists in the Workers runtime without a build step, and this repository has never had a
// build step; PBKDF2 via the standard SubtleCrypto API needs neither.

const PBKDF2_ITERATIONS = 100000;

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function derivePasswordHash(password, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, salt);
  return { hash, salt: bytesToHex(salt) };
}

async function verifyPassword(password, saltHex, hashHex) {
  const got = await derivePasswordHash(password, hexToBytes(saltHex));
  // Constant-time-ish compare: hex strings are fixed length, so a straight loop over both
  // does not short-circuit at the first differing character length the way `!==` could leak.
  if (got.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

function newToken() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

// ============================================================================ KV helpers
//
// One KV namespace, key-prefixed, rather than one namespace per concern — the free tier
// gives plenty of room under one namespace and it is one less thing to provision. Every
// value is a JSON string.

const userKey = (name) => `user:${name.toLowerCase()}`;
const sessionKey = (token) => `session:${token}`;

async function kvGetJson(kv, key) {
  const raw = await kv.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function kvPutJson(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

async function listUsers(kv) {
  const users = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: "user:", cursor });
    for (const k of page.keys) {
      const u = await kvGetJson(kv, k.name);
      if (u) users.push(u);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return users;
}

// ============================================================================ auth
//
// Sessions never expire on their own -- Umut asked for "log in once, stay logged in", the
// same way today's GitHub-token-in-localStorage model already behaves. Logout is the only
// thing that removes a session:<token> key. A deleted user's existing tokens still resolve
// to a session record, but requireSession re-reads the user from KV on every call and 401s
// if the account is gone, so deletion revokes access immediately without needing a token index.

async function requireSession(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m) return null;
  const session = await kvGetJson(env.CST_KV, sessionKey(m[1]));
  if (!session) return null;
  const user = await kvGetJson(env.CST_KV, userKey(session.name));
  if (!user) return null;
  return { user, token: m[1] };
}

function publicUser(u) {
  return { name: u.name, role: u.role, hidden: !!u.hidden, createdAt: u.createdAt };
}

// ============================================================================ GitHub writes
//
// The one thing only this Worker can do: it holds GITHUB_TOKEN as a secret and is the only
// writer of cellstocks/data/**. Reads never come through here (see the file header) so this
// is the entire GitHub surface this Worker needs.

async function githubPutFile(env, path, contentText, message, sha) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(contentText))),
    branch: env.GITHUB_BRANCH || "main"
  };
  if (sha) body.sha = sha;
  const doFetch = env.fetch || fetch;
  const res = await doFetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cellstocks-worker"
    },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json && json.message ? json.message : `GitHub write failed (${res.status})`);
    err.status = res.status;
    err.githubBody = json;
    throw err;
  }
  return json;
}

// Every user's data lives under this prefix, one JSON file per user, named after their
// account -- this is the ownership boundary the write endpoint enforces.
const DATA_PREFIX = "cellstocks/data/";

function dataPathFor(name) {
  return `${DATA_PREFIX}${name.toLowerCase()}.json`;
}

// A path is writable by `user` if it is that user's own file, or `user` is an admin writing
// anywhere under the shared data prefix. Nothing outside cellstocks/data/** is ever writable
// through this endpoint -- it is not a general-purpose GitHub proxy.
function canWrite(user, path) {
  if (!path.startsWith(DATA_PREFIX) || !path.endsWith(".json")) return false;
  if (user.role === "admin") return true;
  return path === dataPathFor(user.name);
}

// ============================================================================ HTTP plumbing

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders || {})
  });
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "https://ucagiral.github.io",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

// ============================================================================ routes

async function routeBootstrap(request, env) {
  // Creates the very first account -- an admin -- so there is someone who can use the
  // admin-only /admin/users endpoints at all. Only works while KV holds zero users, and
  // only with the deploy-time BOOTSTRAP_SECRET, so it cannot be replayed once a lab is set
  // up, and it cannot be used to plant a second admin account through the open internet.
  const body = await request.json().catch(() => null);
  if (!body || !body.name || !body.password || !body.secret) return json({ error: "name, password and secret are required" }, 400);
  if (!env.BOOTSTRAP_SECRET || body.secret !== env.BOOTSTRAP_SECRET) return json({ error: "invalid bootstrap secret" }, 403);
  const existing = await listUsers(env.CST_KV);
  if (existing.length > 0) return json({ error: "already bootstrapped -- use the admin panel to add users" }, 409);
  const { hash, salt } = await hashPassword(body.password);
  const user = { name: body.name, hash, salt, role: "admin", hidden: true, createdAt: new Date().toISOString() };
  await kvPutJson(env.CST_KV, userKey(user.name), user);
  return json({ user: publicUser(user) }, 201);
}

async function routeLogin(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name || !body.password) return json({ error: "name and password are required" }, 400);
  const user = await kvGetJson(env.CST_KV, userKey(body.name));
  if (!user || !(await verifyPassword(body.password, user.salt, user.hash))) {
    return json({ error: "wrong name or password" }, 401);
  }
  const token = newToken();
  await kvPutJson(env.CST_KV, sessionKey(token), { name: user.name, createdAt: new Date().toISOString() });
  return json({ token, user: publicUser(user) });
}

async function routeLogout(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer (.+)$/.exec(auth);
  if (m) await env.CST_KV.delete(sessionKey(m[1]));
  return json({ ok: true });
}

async function routeSession(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  return json({ user: publicUser(session.user) });
}

async function routeListUsers(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const users = await listUsers(env.CST_KV);
  return json({ users: users.map(publicUser) });
}

async function routeCreateUser(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const body = await request.json().catch(() => null);
  if (!body || !body.name || !body.password) return json({ error: "name and password are required" }, 400);
  if (!/^[a-zA-Z0-9_-]+$/.test(body.name)) return json({ error: "name may only contain letters, digits, - and _" }, 400);
  const existing = await kvGetJson(env.CST_KV, userKey(body.name));
  if (existing) return json({ error: "that name is already taken" }, 409);
  const { hash, salt } = await hashPassword(body.password);
  const user = {
    name: body.name,
    hash,
    salt,
    role: body.role === "admin" ? "admin" : "member",
    hidden: !!body.hidden,
    createdAt: new Date().toISOString()
  };
  await kvPutJson(env.CST_KV, userKey(user.name), user);
  return json({ user: publicUser(user) }, 201);
}

async function routeDeleteUser(request, env, name) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const existing = await kvGetJson(env.CST_KV, userKey(name));
  if (!existing) return json({ error: "no such user" }, 404);
  await env.CST_KV.delete(userKey(name));
  return json({ ok: true });
}

async function routeResetPassword(request, env, name) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const body = await request.json().catch(() => null);
  if (!body || !body.password) return json({ error: "password is required" }, 400);
  const existing = await kvGetJson(env.CST_KV, userKey(name));
  if (!existing) return json({ error: "no such user" }, 404);
  const { hash, salt } = await hashPassword(body.password);
  existing.hash = hash;
  existing.salt = salt;
  await kvPutJson(env.CST_KV, userKey(existing.name), existing);
  return json({ ok: true });
}

async function routeWrite(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  const body = await request.json().catch(() => null);
  if (!body || !body.path || typeof body.content !== "string" || !body.message) {
    return json({ error: "path, content and message are required" }, 400);
  }
  if (!canWrite(session.user, body.path)) {
    return json({ error: `${session.user.name} may not write ${body.path}` }, 403);
  }
  try {
    const result = await githubPutFile(env, body.path, body.content, body.message, body.sha);
    return json({ commit: result.commit, content: result.content });
  } catch (err) {
    return json({ error: err.message }, err.status && err.status >= 400 && err.status < 600 ? err.status : 502);
  }
}

// ============================================================================ entry point

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  let response;
  try {
    if (path === "/bootstrap" && request.method === "POST") response = await routeBootstrap(request, env);
    else if (path === "/login" && request.method === "POST") response = await routeLogin(request, env);
    else if (path === "/logout" && request.method === "POST") response = await routeLogout(request, env);
    else if (path === "/session" && request.method === "GET") response = await routeSession(request, env);
    else if (path === "/admin/users" && request.method === "GET") response = await routeListUsers(request, env);
    else if (path === "/admin/users" && request.method === "POST") response = await routeCreateUser(request, env);
    else if (/^\/admin\/users\/[^/]+$/.test(path) && request.method === "DELETE") {
      response = await routeDeleteUser(request, env, decodeURIComponent(path.split("/")[3]));
    } else if (/^\/admin\/users\/[^/]+\/reset-password$/.test(path) && request.method === "POST") {
      response = await routeResetPassword(request, env, decodeURIComponent(path.split("/")[3]));
    } else if (path === "/write" && request.method === "POST") response = await routeWrite(request, env);
    else response = json({ error: "not found" }, 404);
  } catch (err) {
    response = json({ error: err && err.message ? err.message : "internal error" }, 500);
  }

  const headers = new Headers(response.headers);
  const cors = corsHeaders(env);
  Object.keys(cors).forEach((k) => headers.set(k, cors[k]));
  return new Response(response.body, { status: response.status, headers });
}

// Cloudflare's module-worker entry point. Node (the selftest) calls handleRequest directly.
export default { fetch: handleRequest };
export {
  handleRequest,
  hashPassword,
  verifyPassword,
  derivePasswordHash,
  dataPathFor,
  canWrite,
  userKey,
  sessionKey
};
