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

// Three roles, and the list is a whitelist rather than "admin or else member" so a typo
// in a role name is refused instead of silently demoting someone.
//
//   member  an ordinary account: its own inventory, its own boxes.
//   admin   the lab's tools -- users, structure, handoff, everyone's boxes. No inventory
//           of its own (see the Add tab, hidden for admin in the app).
//   pi      the lab head: reads and searches everyone's inventory and nothing else. No
//           inventory of its own either, which canWrite() below enforces rather than
//           trusting the app to never offer it.
const ROLES = ["member", "admin", "pi"];

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
// The lab's shared freezer structure. Deliberately outside DATA_PREFIX: a member could
// legally be named "_storage" (the name rule allows an underscore), and their own file
// must never be able to collide with the lab's.
const LAB_STORAGE_PATH = "cellstocks/lab-storage.json";
const ICON_PREFIX = "cellstocks/icons/";

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
  // A PI reads the whole lab and writes none of it -- no inventory of their own, and no
  // structural edits either.
  if (user.role === "pi") return false;

  // The lab's shared storage structure: one freezer tree the whole lab reads. Admin owns
  // it (the Structure screen), but an ordinary member still has to be able to add a box
  // for themselves -- Umut asked for exactly that, and it is the one everyday action that
  // now touches this file. So it is writable by any logged-in member.
  //
  // The app offers a member boxes and nothing else: adding or removing a freezer or tank
  // is admin's alone ("kullanicilarin tank/freezer ekleme ozelligini kaldiralim"), and the
  // button for it is gone rather than merely disabled. That rule lives in the app, not
  // here: this check is path-based, so nothing stops a member's client from writing
  // something else into that file, and two people saving it at the same moment is
  // last-write-wins like every other file in this repo. Enforcing it here means the Worker
  // reading the committed tree and proving the incoming one changes only box lists --
  // worth doing if this lab ever outgrows trusting each other.
  if (path === LAB_STORAGE_PATH) return true;

  // Folder icons for that structure. Admin-only, since only the Structure screen
  // uploads one, and images only: no SVG, which is markup, in a public repository.
  if (path.startsWith(ICON_PREFIX)) {
    return user.role === "admin" && /^[a-zA-Z0-9._-]+\.(png|jpe?g|webp)$/.test(path.slice(ICON_PREFIX.length));
  }

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
  if (body.role !== undefined && ROLES.indexOf(body.role) === -1) {
    return json({ error: `role must be one of: ${ROLES.join(", ")}` }, 400);
  }
  const { hash, salt } = await hashPassword(body.password);
  const user = {
    name: body.name,
    hash,
    salt,
    role: body.role || "member",
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

// ============================================================================ item types
//
// "Freeze" became "Add" because a box can hold a Plasmid, an RNA prep or a Protein just
// as easily as a cell line -- same storage/grid model, different classification. The
// type list, and the set of attribute NAMES each type has been given so far (a
// Protein's "concentration"/"buffer", say), are lab-wide, shared across every account --
// not per-account like cellstocks' own state.rules, which only ever covers cells. One
// KV key holds the lot, since they only ever change together from one editor screen.
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

// Admin only, both of these: adding an attribute name is open to everyone (that is what
// typing one on the Add screen does), but cleaning the list up is not -- the same split
// merge/delete above already uses. Neither touches a vial: a value already recorded
// under this name stays exactly as it was typed, and only the suggestion list changes.
async function routeRenameAttribute(request, env, typeName) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const body = await request.json().catch(() => null);
  if (!body || !body.from || !body.to) return json({ error: "from and to are required" }, 400);
  const to = String(body.to).trim();
  if (!to) return json({ error: "to may not be blank" }, 400);

  const config = await loadTypesConfig(env);
  const type = config.types.find((t) => t.name.toLowerCase() === String(typeName).toLowerCase());
  if (!type) return json({ error: "no such type" }, 404);
  const at = type.attributes.indexOf(body.from);
  if (at === -1) return json({ error: "no such attribute" }, 404);
  // Renaming onto a name this type already has is a merge of the two, not a duplicate.
  if (type.attributes.indexOf(to) === -1) type.attributes[at] = to;
  else type.attributes.splice(at, 1);

  await kvPutJson(env.CST_KV, TYPES_CONFIG_KEY, config);
  return json(config);
}

async function routeDeleteAttribute(request, env, typeName, attrName) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "not logged in" }, 401);
  if (session.user.role !== "admin") return json({ error: "admin only" }, 403);
  const config = await loadTypesConfig(env);
  const type = config.types.find((t) => t.name.toLowerCase() === String(typeName).toLowerCase());
  if (!type) return json({ error: "no such type" }, 404);
  const before = type.attributes.length;
  type.attributes = type.attributes.filter((a) => a !== attrName);
  if (type.attributes.length === before) return json({ error: "no such attribute" }, 404);
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
    else if (path === "/types" && request.method === "GET") response = await routeGetTypes(request, env);
    else if (path === "/types" && request.method === "POST") response = await routeAddType(request, env);
    else if (path === "/admin/types/merge" && request.method === "POST") response = await routeMergeTypes(request, env);
    else if (/^\/admin\/types\/[^/]+\/attributes\/rename$/.test(path) && request.method === "POST") {
      response = await routeRenameAttribute(request, env, decodeURIComponent(path.split("/")[3]));
    }
    else if (/^\/admin\/types\/[^/]+\/attributes\/[^/]+$/.test(path) && request.method === "DELETE") {
      response = await routeDeleteAttribute(request, env,
        decodeURIComponent(path.split("/")[3]), decodeURIComponent(path.split("/")[5]));
    }
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
  ROLES,
  LAB_STORAGE_PATH,
  ICON_PREFIX,
  base64ToUtf8,
  TYPES_CONFIG_KEY,
  DEFAULT_TYPE_NAMES
};
