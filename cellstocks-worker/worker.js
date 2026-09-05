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
const requestKey = (id) => `request:${id}`;
const notificationKey = (user, id) => `notification:${user.toLowerCase()}:${id}`;

function newId() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
}

// One id, used both as the KV key's suffix and the stored value's own .id field -- so a
// client that later addresses a notification by the id it was given (from GET
// /notifications) actually finds the same record, rather than two independently
// generated ids that happen to look alike.
async function notify(env, user, fields) {
  const id = newId();
  const record = Object.assign({ id, user }, fields, { id });
  await kvPutJson(env.CST_KV, notificationKey(user, id), record);
  return record;
}

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

async function listByPrefix(kv, prefix) {
  const values = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const v = await kvGetJson(kv, k.name);
      if (v) values.push(v);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return values;
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

async function githubApi(env, method, path, body) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path}`;
  const doFetch = env.fetch || fetch;
  const res = await doFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cellstocks-worker"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  // A PATCH ref update returns no body worth parsing; everything else does.
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(parsed && parsed.message ? parsed.message : `GitHub API call failed (${res.status})`);
    err.status = res.status;
    err.githubBody = parsed;
    throw err;
  }
  return parsed;
}

// Commits one or more files in a single atomic commit, via the git data API rather than
// the simpler Contents API -- the app always saves cellstocks/data/<name>.json and its
// generated .xlsx together (see cellstocks/index.html's own commitFiles()), and a
// two-request version of this would leave a window where the workbook and the inventory
// it is supposed to describe disagree, exactly what CLAUDE.md says must never happen.
// `files` is [{ path, content, base64 }] -- base64 content for the binary workbook, plain
// text otherwise.
async function commitFilesAtomic(env, files, message) {
  const branch = env.GITHUB_BRANCH || "main";
  const ref = await githubApi(env, "GET", `/git/ref/heads/${branch}`);
  const baseSha = ref.object.sha;
  const baseCommit = await githubApi(env, "GET", `/git/commits/${baseSha}`);
  const tree = [];
  for (const f of files) {
    const blob = await githubApi(env, "POST", "/git/blobs", f.base64 ? { content: f.content, encoding: "base64" } : { content: f.content, encoding: "utf-8" });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await githubApi(env, "POST", "/git/trees", { base_tree: baseCommit.tree.sha, tree });
  const commit = await githubApi(env, "POST", "/git/commits", { message, tree: newTree.sha, parents: [baseSha] });
  await githubApi(env, "PATCH", `/git/refs/heads/${branch}`, { sha: commit.sha });
  return commit.sha;
}

// Renames a user's data/workbook pair in one commit -- admin-only, part of renaming an
// account (see routeRenameUser below). Reuses the same six-call git-data shape as
// commitFilesAtomic (ref -> base commit -> ... -> tree -> commit -> ref update), but the
// tree entries here copy an existing blob to its new path (by reusing the blob sha the
// Contents API already reports, rather than re-uploading identical content) and delete
// the old path in the SAME tree -- GitHub's tree API deletes an entry when its sha is
// null. One tree means the file is never briefly duplicated or briefly missing. A pair
// that 404s (the user never saved anything yet) is skipped rather than failing the whole
// rename.
async function renameUserFiles(env, oldName, newName) {
  const branch = env.GITHUB_BRANCH || "main";
  const ref = await githubApi(env, "GET", `/git/ref/heads/${branch}`);
  const baseSha = ref.object.sha;
  const baseCommit = await githubApi(env, "GET", `/git/commits/${baseSha}`);
  const tree = [];
  const pairs = [
    [dataPathFor(oldName), dataPathFor(newName)],
    [xlsxPathFor(oldName), xlsxPathFor(newName)]
  ];
  for (const [oldPath, newPath] of pairs) {
    let existing;
    try {
      existing = await githubApi(env, "GET", `/contents/${oldPath}?ref=${encodeURIComponent(branch)}`);
    } catch (err) {
      if (err.status === 404) continue;
      throw err;
    }
    tree.push({ path: newPath, mode: "100644", type: "blob", sha: existing.sha });
    tree.push({ path: oldPath, mode: "100644", type: "blob", sha: null });
  }
  if (!tree.length) return null;
  const newTree = await githubApi(env, "POST", "/git/trees", { base_tree: baseCommit.tree.sha, tree });
  const commit = await githubApi(env, "POST", "/git/commits", {
    message: `Rename ${DATA_PREFIX}${oldName.toLowerCase()}.* to ${newName.toLowerCase()}.* (admin rename)`,
    tree: newTree.sha,
    parents: [baseSha]
  });
  await githubApi(env, "PATCH", `/git/refs/heads/${branch}`, { sha: commit.sha });
  return commit.sha;
}

// Deleting an account used to leave its data/workbook pair behind on purpose -- Umut was
// surprised by that in practice (recreating an account under the same name silently
// brought all the old data back), so an admin delete now removes the files too. Same
// six-call git-data shape as renameUserFiles() above, but every tree entry only ever
// deletes (sha: null); a path that 404s (never saved anything) is skipped, not failed.
async function deleteUserFiles(env, name) {
  const branch = env.GITHUB_BRANCH || "main";
  const ref = await githubApi(env, "GET", `/git/ref/heads/${branch}`);
  const baseSha = ref.object.sha;
  const baseCommit = await githubApi(env, "GET", `/git/commits/${baseSha}`);
  const tree = [];
  for (const path of [dataPathFor(name), xlsxPathFor(name)]) {
    try {
      await githubApi(env, "GET", `/contents/${path}?ref=${encodeURIComponent(branch)}`);
    } catch (err) {
      if (err.status === 404) continue;
      throw err;
    }
    tree.push({ path, mode: "100644", type: "blob", sha: null });
  }
  if (!tree.length) return null;
  const newTree = await githubApi(env, "POST", "/git/trees", { base_tree: baseCommit.tree.sha, tree });
  const commit = await githubApi(env, "POST", "/git/commits", {
    message: `Delete ${DATA_PREFIX}${name.toLowerCase()}.* (admin delete)`,
    tree: newTree.sha,
    parents: [baseSha]
  });
  await githubApi(env, "PATCH", `/git/refs/heads/${branch}`, { sha: commit.sha });
  return commit.sha;
}

// Every user's data lives under this prefix, one JSON file and one generated .xlsx per
// user, named after their account -- this is the ownership boundary the commit endpoint
// enforces.
const DATA_PREFIX = "cellstocks/data/";

function dataPathFor(name) {
  return `${DATA_PREFIX}${name.toLowerCase()}.json`;
}

function xlsxPathFor(name) {
  return `${DATA_PREFIX}${name.toLowerCase()}.xlsx`;
}

// A path is writable by `user` if it is that user's own data/workbook pair, or `user` is
// an admin writing anywhere under the shared data prefix. Nothing outside
// cellstocks/data/** is ever writable through this endpoint -- it is not a
// general-purpose GitHub proxy.
function canWrite(user, path) {
  if (!path.startsWith(DATA_PREFIX) || !/\.(json|xlsx)$/.test(path)) return false;
  if (user.role === "admin") return true;
  return path === dataPathFor(user.name) || path === xlsxPathFor(user.name);
}

// ============================================================================ history (time machine)
//
// "Even if someone deletes their stock, I should be able to retrieve the complete stock
// situation on 23 May 2026 14:56" -- Umut, on the admin panel. Every save is already a
// git commit to cellstocks/data/<user>.json (see commitFilesAtomic() above), so this
// needs no separate storage at all: GitHub's own commit history for that one path *is*
// the time machine, including past whatever account or file deletion, since git history
// does not forget. This is read-only and admin-only -- it uses the REST Commits/Contents
// endpoints (not the git-data ones commitFilesAtomic uses), so it is kept separate from
// githubApi's git-data callers even though it shares the same helper.

function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// Every commit that ever touched this one file, newest first -- exactly what a "pick a
// point in time" UI needs to browse, and exactly what proves the file existed (or
// didn't) at all before a given moment.
async function historyCommits(env, path) {
  const branch = env.GITHUB_BRANCH || "main";
  return githubApi(env, "GET", `/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}&per_page=100`);
}

// The content of `path` exactly as it stood at or before `atIso` -- the commit GitHub's
// own `until` filter finds is, by definition, the most recent one that is not later than
// that moment, which is what "the stock situation on 23 May 2026 14:56" means: not the
// nearest commit in either direction, the last one that had already happened by then.
async function historyAt(env, path, atIso) {
  const branch = env.GITHUB_BRANCH || "main";
  const commits = await githubApi(
    env, "GET",
    `/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}&until=${encodeURIComponent(atIso)}&per_page=1`
  );
  if (!commits.length) {
    const err = new Error("no commit to this file exists at or before that time");
    err.status = 404;
    throw err;
  }
  const sha = commits[0].sha;
  const file = await githubApi(env, "GET", `/contents/${path}?ref=${sha}`);
  return { sha, commitDate: commits[0].commit.author.date, content: base64ToUtf8(file.content) };
}

// ============================================================================ requests & notifications
//
// The physical vial never moves through any of this -- Umut's answer was explicit: an
// approved request just marks the vial "reserved for" the requester on the owner's own
// side, because physically it is still sitting in the owner's own freezer until someone
// actually hands it over. That marking is an ordinary edit to the owner's own
// cellstocks/data/<owner>.json, made through the normal /commit path above like any
// other save -- this Worker has no idea what a "vial" is and never touches one. What it
// *does* own is the bookkeeping neither side could otherwise see: the pending request
// itself (a requester cannot write into someone else's file to leave a note there) and
// the notification that tells the other side something happened.
//
// Every message this file ever sends is a named template, not an inline string --
// Umut asked to be able to edit these ("X requests ABC vial from your box" and "many
// more") from the admin panel. DEFAULT_MESSAGES is what ships; a lab can override any
// subset of them via PUT /config/messages, stored once under a single KV key rather
// than one key per template (there are only a handful, and they only ever change
// together, from one editor screen).

const MESSAGES_CONFIG_KEY = "config:messages";

const DEFAULT_MESSAGES = {
  request: "{fromUser} is asking about {itemName}{noteSuffix}",
  "request-approved": "{toUser} approved your request for {itemName}.",
  "request-denied": "{toUser} said no to your request for {itemName}."
};

function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m));
}

async function renderMessage(env, key, vars) {
  const overrides = (await kvGetJson(env.CST_KV, MESSAGES_CONFIG_KEY)) || {};
  const template = (typeof overrides[key] === "string" && overrides[key]) || DEFAULT_MESSAGES[key];
  return fillTemplate(template, vars);
}

async function createRequest(env, fromUser, body) {
  if (!body || !body.toUser || !body.itemName) {
    const err = new Error("toUser and itemName are required");
    err.status = 400;
    throw err;
  }
  if (body.toUser.toLowerCase() === fromUser.toLowerCase()) {
    const err = new Error("cannot request your own item");
    err.status = 400;
    throw err;
  }
  const toUser = await kvGetJson(env.CST_KV, userKey(body.toUser));
  if (!toUser) {
    const err = new Error("no such user");
    err.status = 404;
    throw err;
  }
  const reqRecord = {
    id: newId(), fromUser, toUser: toUser.name, vialId: body.vialId || null, itemName: body.itemName,
    note: body.note || "", status: "pending", createdAt: new Date().toISOString(), resolvedAt: null
  };
  await kvPutJson(env.CST_KV, requestKey(reqRecord.id), reqRecord);
  // vialId and itemName ride along on the notification itself, not just embedded in the
  // text -- so acting on it (approve marks the app's own vial "reserved for" the
  // requester) is one round-trip against GET /notifications, not a second fetch of the
  // request record just to find out which vial it was about.
  await notify(env, toUser.name, {
    type: "request", requestId: reqRecord.id, fromUser, vialId: reqRecord.vialId, itemName: reqRecord.itemName,
    text: await renderMessage(env, "request", {
      fromUser, itemName: body.itemName, noteSuffix: body.note ? `: "${body.note}"` : ""
    }),
    read: false, createdAt: reqRecord.createdAt
  });
  return reqRecord;
}

async function resolveRequest(env, actingUser, id, decision) {
  const reqRecord = await kvGetJson(env.CST_KV, requestKey(id));
  if (!reqRecord) {
    const err = new Error("no such request");
    err.status = 404;
    throw err;
  }
  if (actingUser.role !== "admin" && actingUser.name.toLowerCase() !== reqRecord.toUser.toLowerCase()) {
    const err = new Error("only the item's owner may respond to this request");
    err.status = 403;
    throw err;
  }
  if (reqRecord.status !== "pending") {
    const err = new Error(`this request was already ${reqRecord.status}`);
    err.status = 409;
    throw err;
  }
  reqRecord.status = decision;
  reqRecord.resolvedAt = new Date().toISOString();
  await kvPutJson(env.CST_KV, requestKey(id), reqRecord);
  await notify(env, reqRecord.fromUser, {
    type: "request-resolved", requestId: id, fromUser: reqRecord.toUser,
    text: await renderMessage(env, decision === "approved" ? "request-approved" : "request-denied", {
      toUser: reqRecord.toUser, itemName: reqRecord.itemName
    }),
    read: false, createdAt: reqRecord.resolvedAt
  });
  return reqRecord;
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
  await deleteUserFiles(env, name);
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

// Renaming touches everywhere the old name was ever recorded, not just the account
// itself -- Umut asked that a rename "update everything", so requests get their
// fromUser/toUser fields rewritten and notifications (keyed by recipient name, so
// this is a re-key, not a field edit) move under the new prefix. What is deliberately
// NOT touched: the wording of a notification already sent -- "Umut is asking about X" is
// what was actually said at the time, and rewriting it later would be inventing a history
// that didn't happen, not correcting one.
async function migrateUserReferences(env, oldName, newName) {
  const oldLower = oldName.toLowerCase();

  const requests = await listByPrefix(env.CST_KV, "request:");
  await Promise.all(requests
    .filter((r) => r.fromUser.toLowerCase() === oldLower || r.toUser.toLowerCase() === oldLower)
    .map((r) => {
      if (r.fromUser.toLowerCase() === oldLower) r.fromUser = newName;
      if (r.toUser.toLowerCase() === oldLower) r.toUser = newName;
      return kvPutJson(env.CST_KV, requestKey(r.id), r);
    }));

  const notifications = await listByPrefix(env.CST_KV, `notification:${oldLower}:`);
  await Promise.all(notifications.map((n) => {
    n.user = newName;
    return kvPutJson(env.CST_KV, notificationKey(newName, n.id), n).then(() =>
      env.CST_KV.delete(notificationKey(oldName, n.id))
    );
  }));
}

async function routeRenameUser(request, env, name) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const body = await request.json().catch(() => null);
  if (!body || !body.newName) return json({ error: "newName is required" }, 400);
  if (!/^[a-zA-Z0-9_-]+$/.test(body.newName)) return json({ error: "name may only contain letters, digits, - and _" }, 400);
  const existing = await kvGetJson(env.CST_KV, userKey(name));
  if (!existing) return json({ error: "no such user" }, 404);
  if (body.newName.toLowerCase() === existing.name.toLowerCase()) return json({ error: "that is already this account's name" }, 400);
  const taken = await kvGetJson(env.CST_KV, userKey(body.newName));
  if (taken) return json({ error: "that name is already taken" }, 409);

  try {
    await renameUserFiles(env, existing.name, body.newName);
  } catch (err) {
    return json({ error: err.message }, requestErrorStatus(err));
  }
  const oldKey = userKey(existing.name);
  existing.name = body.newName;
  await kvPutJson(env.CST_KV, userKey(existing.name), existing);
  await env.CST_KV.delete(oldKey);
  await migrateUserReferences(env, name, body.newName);
  // Existing sessions are for the old KV key, which no longer resolves -- requireSession
  // already 401s the moment a session's user record is gone, so this is effectively an
  // immediate, if unannounced, forced logout. Renaming an account you're using right now
  // means logging back in under the new name; that's the same trade-off deleting an
  // account already makes.
  return json({ user: publicUser(existing) });
}

async function routeCommit(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.files) || !body.files.length || !body.message) {
    return json({ error: "files (a non-empty array) and message are required" }, 400);
  }
  for (const f of body.files) {
    if (!f || !f.path || typeof f.content !== "string") return json({ error: "every file needs a path and content" }, 400);
  }
  // Every file in the commit has to be ownership-checked before any GitHub call is made --
  // otherwise a request mixing one writable path with one that is not could commit the
  // writable one and only then discover the other is forbidden, which is not atomic in
  // the sense that matters here (an unauthorized write must never partially happen).
  const forbidden = body.files.find((f) => !canWrite(session.user, f.path));
  if (forbidden) return json({ error: `${session.user.name} may not write ${forbidden.path}` }, 403);
  try {
    const sha = await commitFilesAtomic(env, body.files, body.message);
    return json({ commit: sha });
  } catch (err) {
    return json({ error: err.message }, err.status && err.status >= 400 && err.status < 600 ? err.status : 502);
  }
}

function requestErrorStatus(err) {
  return err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
}

async function routeCreateRequest(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  const body = await request.json().catch(() => null);
  try {
    const reqRecord = await createRequest(env, session.user.name, body);
    return json({ request: reqRecord }, 201);
  } catch (err) {
    return json({ error: err.message }, requestErrorStatus(err));
  }
}

async function routeListRequests(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  const all = await listByPrefix(env.CST_KV, "request:");
  // Admin sees every request lab-wide -- "see and intervene in all pending requests" is
  // one of the admin panel's own listed jobs. Everyone else sees only the ones they're
  // actually a party to, same as before.
  const name = session.user.name.toLowerCase();
  const mine = session.user.role === "admin"
    ? all
    : all.filter((r) => r.fromUser.toLowerCase() === name || r.toUser.toLowerCase() === name);
  mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return json({ requests: mine });
}

async function routeResolveRequest(request, env, id, decision) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  try {
    const reqRecord = await resolveRequest(env, session.user, id, decision);
    return json({ request: reqRecord });
  } catch (err) {
    return json({ error: err.message }, requestErrorStatus(err));
  }
}

async function routeListNotifications(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  const mine = await listByPrefix(env.CST_KV, `notification:${session.user.name.toLowerCase()}:`);
  mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return json({ notifications: mine });
}

async function routeMarkNotificationRead(request, env, id) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  const key = notificationKey(session.user.name, id);
  const n = await kvGetJson(env.CST_KV, key);
  if (!n) return json({ error: "no such notification" }, 404);
  n.read = true;
  await kvPutJson(env.CST_KV, key, n);
  return json({ notification: n });
}

// Any logged-in user, not just admin -- these are UI copy (a notification's wording, a
// compose box's placeholder), not anything sensitive, and every screen that shows one of
// them is shown to ordinary members, not just admin. Returns the text actually in effect
// (an override where a lab has set one, the shipped default otherwise) since a caller here
// only ever wants to display a message, never to know whether it's been customized -- that
// distinction is what the admin-only /admin/messages below is for.
async function routeGetMessages(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  const overrides = (await kvGetJson(env.CST_KV, MESSAGES_CONFIG_KEY)) || {};
  return json({ messages: Object.assign({}, DEFAULT_MESSAGES, overrides) });
}

// Admin-only: the editor screen needs to see both what ships and what's overridden, so
// it can show a lab's customized text alongside a "reset to default" per message rather
// than only ever showing one or the other.
async function routeGetMessagesConfig(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const overrides = (await kvGetJson(env.CST_KV, MESSAGES_CONFIG_KEY)) || {};
  return json({ defaults: DEFAULT_MESSAGES, overrides });
}

async function routeSetMessagesConfig(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.messages !== "object" || body.messages === null) {
    return json({ error: "messages (an object) is required" }, 400);
  }
  const unknown = Object.keys(body.messages).filter((k) => !(k in DEFAULT_MESSAGES));
  if (unknown.length) return json({ error: `unknown message key(s): ${unknown.join(", ")}` }, 400);
  const existing = (await kvGetJson(env.CST_KV, MESSAGES_CONFIG_KEY)) || {};
  const next = Object.assign({}, existing);
  // A key set to an empty/non-string value resets that one message back to its
  // default, rather than storing an override that just happens to look empty.
  Object.keys(body.messages).forEach((k) => {
    if (typeof body.messages[k] === "string" && body.messages[k].trim()) next[k] = body.messages[k];
    else delete next[k];
  });
  await kvPutJson(env.CST_KV, MESSAGES_CONFIG_KEY, next);
  return json({ defaults: DEFAULT_MESSAGES, overrides: next });
}

// ============================================================================ item types
//
// "Freeze" became "Add" because a box can hold a Plasmid, an RNA prep or a Protein just
// as easily as a cell line -- same storage/grid model, different classification. The
// type list, and the set of attribute NAMES each type has been given so far (a
// Protein's "concentration"/"buffer", say), are lab-wide, shared across every account,
// the same way DEFAULT_MESSAGES above is -- not per-account like cellstocks' own
// state.rules, which only ever covers cells. One KV key, like MESSAGES_CONFIG_KEY.
//
// There is deliberately no automatic classification here (no regex matching a name to
// a value, the way the five cell facets work): Umut was explicit that a non-Cell
// type's attributes are typed in by hand, one name+value pair at a time, growing the
// table as needed (see the Add screen's dynamic attribute table). What this config
// tracks is only which attribute NAMES have been typed for a given type before, purely
// as autocomplete suggestions for next time -- never a value, and never shared between
// two different types even if they happen to use the same attribute name later (e.g.
// both Protein and Bacterial Glycerol independently growing a "concentration"
// attribute is fine and is not deduplicated away).
//
// Umut was also explicit that existing vials get no retroactive type: nothing here
// ever assigns a type to an item that doesn't already carry one, and vial.kind is left
// alone by every route in this section -- this is lab-wide *type definitions*, not
// per-vial data, which stays entirely inside each account's own cellstocks/data/*.json.

const TYPES_CONFIG_KEY = "config:types";

const DEFAULT_TYPE_NAMES = ["Cell", "Plasmid", "RNA", "cDNA", "Protein", "Bacterial Glycerol"];

function defaultTypesConfig() {
  return { types: DEFAULT_TYPE_NAMES.map((name) => ({ name, attributes: [] })) };
}

async function loadTypesConfig(env) {
  const stored = await kvGetJson(env.CST_KV, TYPES_CONFIG_KEY);
  if (!stored) return defaultTypesConfig();
  // A lab that already has a stored config still gets any default type name it is
  // missing -- e.g. one shipped after that lab's config was first saved -- without
  // ever touching what the lab itself added or renamed. Tolerates a config saved
  // under the old rules-based shape (facets/rules) by just dropping those fields --
  // no lab had real data in them yet when this shape changed.
  const names = new Set(stored.types.map((t) => t.name));
  const merged = stored.types.map((t) => ({ name: t.name, attributes: t.attributes || [] }));
  DEFAULT_TYPE_NAMES.forEach((name) => { if (!names.has(name)) merged.push({ name, attributes: [] }); });
  return { types: merged };
}

// Any logged-in user -- the type list and its attribute names are UI, not anything
// sensitive, and every screen that offers a type (the Add screen's selector, a vial's
// own attribute table) is shown to ordinary members, not just admin.
async function routeGetTypes(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  const config = await loadTypesConfig(env);
  return json(config);
}

// Any logged-in user, additive only: adds a new type (if it doesn't already exist,
// case-insensitively) and/or a new attribute name to an existing type's suggestion
// list, without ever removing or overwriting anything a concurrent save already
// added. Two people typing near-duplicate types ("RNA" / "mRNA") is expected, not
// rejected here -- only admin (routeMergeTypes) gets to decide which name wins.
async function routeAddType(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "a body is required" }, 400);
  if (!body.name && !body.attribute) return json({ error: "name and/or attribute is required" }, 400);

  const config = await loadTypesConfig(env);
  const byName = (name) => config.types.find((t) => t.name.toLowerCase() === String(name || "").toLowerCase());

  if (body.name) {
    const name = String(body.name).trim();
    if (!name) return json({ error: "name must not be blank" }, 400);
    if (!byName(name)) config.types.push({ name, attributes: [] });
  }

  if (body.attribute) {
    const type = byName(body.attribute.type);
    const attrName = String(body.attribute.name || "").trim();
    if (!type) return json({ error: `no such type: ${body.attribute.type}` }, 404);
    if (!attrName) return json({ error: "attribute.name must not be blank" }, 400);
    // Case-sensitive dedupe: an attribute name is exactly what the person typed, shown
    // back to them verbatim as a suggestion -- silently folding case would make their
    // own typed labels look like they'd been rewritten.
    if (type.attributes.indexOf(attrName) === -1) type.attributes.push(attrName);
  }

  await kvPutJson(env.CST_KV, TYPES_CONFIG_KEY, config);
  return json(config);
}

// Admin only: folds `from`'s known attribute names into `into` and removes `from`.
// Umut asked for this explicitly, since two people can add near-duplicate types and
// only admin should get to clean that up.
async function routeMergeTypes(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const body = await request.json().catch(() => null);
  if (!body || !body.from || !body.into) return json({ error: "from and into are required" }, 400);

  const config = await loadTypesConfig(env);
  const from = config.types.find((t) => t.name.toLowerCase() === String(body.from).toLowerCase());
  const into = config.types.find((t) => t.name.toLowerCase() === String(body.into).toLowerCase());
  if (!from || !into) return json({ error: "no such type" }, 404);
  if (from.name === into.name) return json({ error: "from and into must name different types" }, 400);

  from.attributes.forEach((a) => { if (into.attributes.indexOf(a) === -1) into.attributes.push(a); });
  config.types = config.types.filter((t) => t.name !== from.name);

  await kvPutJson(env.CST_KV, TYPES_CONFIG_KEY, config);
  return json(config);
}

// Admin only. A vial that already used this type keeps its own vial.kind text as
// history -- deleting the type here only stops it being offered for new ones. This
// Worker has no idea what a "vial" is (see the comment at the top of the file) and
// never touches one.
async function routeDeleteType(request, env, name) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const config = await loadTypesConfig(env);
  const before = config.types.length;
  config.types = config.types.filter((t) => t.name.toLowerCase() !== name.toLowerCase());
  if (config.types.length === before) return json({ error: "no such type" }, 404);
  await kvPutJson(env.CST_KV, TYPES_CONFIG_KEY, config);
  return json(config);
}

async function routeHistoryCommits(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const user = new URL(request.url).searchParams.get("user");
  if (!user) return json({ error: "?user= is required" }, 400);
  try {
    const commits = await historyCommits(env, dataPathFor(user));
    return json({ commits: commits.map((c) => ({ sha: c.sha, date: c.commit.author.date, message: c.commit.message })) });
  } catch (err) {
    return json({ error: err.message }, requestErrorStatus(err));
  }
}

async function routeHistoryAt(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const url = new URL(request.url);
  const user = url.searchParams.get("user");
  const at = url.searchParams.get("at");
  if (!user || !at) return json({ error: "?user= and ?at= are required" }, 400);
  try {
    const result = await historyAt(env, dataPathFor(user), at);
    return json(result);
  } catch (err) {
    return json({ error: err.message }, requestErrorStatus(err));
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
    } else if (/^\/admin\/users\/[^/]+\/rename$/.test(path) && request.method === "POST") {
      response = await routeRenameUser(request, env, decodeURIComponent(path.split("/")[3]));
    } else if (path === "/commit" && request.method === "POST") response = await routeCommit(request, env);
    else if (path === "/requests" && request.method === "POST") response = await routeCreateRequest(request, env);
    else if (path === "/requests" && request.method === "GET") response = await routeListRequests(request, env);
    else if (/^\/requests\/[^/]+\/approve$/.test(path) && request.method === "POST") {
      response = await routeResolveRequest(request, env, decodeURIComponent(path.split("/")[2]), "approved");
    } else if (/^\/requests\/[^/]+\/deny$/.test(path) && request.method === "POST") {
      response = await routeResolveRequest(request, env, decodeURIComponent(path.split("/")[2]), "denied");
    } else if (path === "/notifications" && request.method === "GET") response = await routeListNotifications(request, env);
    else if (/^\/notifications\/[^/]+\/read$/.test(path) && request.method === "POST") {
      response = await routeMarkNotificationRead(request, env, decodeURIComponent(path.split("/")[2]));
    } else if (path === "/messages" && request.method === "GET") response = await routeGetMessages(request, env);
    else if (path === "/admin/messages" && request.method === "GET") response = await routeGetMessagesConfig(request, env);
    else if (path === "/admin/messages" && request.method === "PUT") response = await routeSetMessagesConfig(request, env);
    else if (path === "/types" && request.method === "GET") response = await routeGetTypes(request, env);
    else if (path === "/types" && request.method === "POST") response = await routeAddType(request, env);
    else if (path === "/admin/types/merge" && request.method === "POST") response = await routeMergeTypes(request, env);
    else if (/^\/admin\/types\/[^/]+$/.test(path) && request.method === "DELETE") {
      response = await routeDeleteType(request, env, decodeURIComponent(path.split("/")[3]));
    }
    else if (path === "/admin/history/commits" && request.method === "GET") response = await routeHistoryCommits(request, env);
    else if (path === "/admin/history/at" && request.method === "GET") response = await routeHistoryAt(request, env);
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
  xlsxPathFor,
  canWrite,
  userKey,
  sessionKey,
  requestKey,
  notificationKey,
  DEFAULT_MESSAGES,
  MESSAGES_CONFIG_KEY,
  fillTemplate,
  base64ToUtf8,
  TYPES_CONFIG_KEY,
  DEFAULT_TYPE_NAMES
};
