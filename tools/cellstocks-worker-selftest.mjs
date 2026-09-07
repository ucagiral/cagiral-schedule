// Proves the Cell Stocks worker actually enforces what it claims to, instead of trusting
// that it does -- same reasoning as tools/cellstocks-selftest.mjs for the engine.
//
// Run:  node tools/cellstocks-worker-selftest.mjs
//
// Loads cellstocks-worker/worker.js -- the exact file Cloudflare deploys -- and drives its
// handleRequest() directly against an in-memory stand-in for KV and a stubbed GitHub API.
// No network, no Cloudflare account, no deploy. See that file's own header for why it is
// built only on fetch/Request/Response/crypto.subtle: those are what make this possible.

import { handleRequest, dataPathFor, xlsxPathFor, canWrite, ROLES, LAB_STORAGE_PATH, ICON_PREFIX,
         dispatchDailyMail, commitFilesAtomic, COMMIT_ATTEMPTS } from "../cellstocks-worker/worker.js";

// ---------------------------------------------------------------- test harness
let passed = 0;
const failures = [];

function check(name, fn) {
  return (async () => {
    try {
      const problem = await fn();
      if (problem) failures.push(`${name}\n    ${problem}`);
      else passed++;
    } catch (err) {
      failures.push(`${name}\n    threw: ${err && err.stack ? err.stack.split("\n").slice(0, 3).join("\n    ") : err}`);
    }
  })();
}

const json = (x) => JSON.stringify(x);

// ------------------------------------------------------------- in-memory KV
//
// Matches the surface worker.js actually uses: get(key) -> string|null, put(key, value),
// delete(key), list({prefix, cursor}) -> {keys:[{name}], list_complete, cursor}. Cloudflare's
// real KV is eventually consistent across edge locations; this fake is immediately
// consistent, which only ever makes the tests stricter, never looser.

function makeKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _dump() {
      return Object.fromEntries(store);
    }
  };
}

// ------------------------------------------------------------- stubbed GitHub
//
// commitFilesAtomic() in worker.js drives the git data API through githubApi(), which
// calls `(env.fetch || fetch)(url, opts)` -- tests inject a fake here instead of hitting
// the network. It plays along with the real six-call sequence (ref -> base commit ->
// N blobs -> tree -> commit -> ref update) so a test can assert on exactly what would
// have been committed, and `failOn` lets a test make one specific step fail without
// having to fake the calls before it.

// `contents` is an optional map for GET /contents/<path> -- what renameUserFiles() looks
// up before copying a file to its new path, and what boxesOwnedBy() reads the lab's
// storage tree out of. A value may be a bare sha string, or { sha, text } when the
// caller actually reads the file's bytes (the text is base64-encoded here, the way
// GitHub returns it). A path not in the map 404s, the same as a user who never saved
// anything yet.
function makeGithubFetch({ failOn, contents } = {}) {
  const calls = [];
  let blobN = 0;
  const fn = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method, body });
    const contentsMatch = url.match(/\/contents\/([^?]+)/);
    const step = contentsMatch ? "contents"
      : url.includes("/git/blobs") ? "blob"
      : url.includes("/git/trees") ? "tree"
      : url.includes("/git/refs/heads/") ? "ref-update"
      : url.includes("/git/ref/heads/") ? "ref"
      : url.includes("/git/commits/") && opts.method === "GET" ? "base-commit"
      : url.includes("/git/commits") ? "commit"
      : "unknown";
    if (failOn && step === failOn) {
      return { ok: false, status: 422, text: async () => JSON.stringify({ message: `stubbed failure at ${step}` }) };
    }
    const reply = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (step === "contents") {
      const path = decodeURIComponent(contentsMatch[1]);
      const entry = contents && contents[path];
      if (!entry) return { ok: false, status: 404, text: async () => JSON.stringify({ message: "not found" }) };
      if (typeof entry === "string") return reply({ sha: entry });
      return reply({
        sha: entry.sha || "content-sha",
        content: Buffer.from(entry.text, "utf8").toString("base64")
      });
    }
    if (step === "ref") return reply({ object: { sha: "base-ref-sha" } });
    if (step === "base-commit") return reply({ tree: { sha: "base-tree-sha" } });
    if (step === "blob") { blobN++; return reply({ sha: `blob-sha-${blobN}` }); }
    if (step === "tree") return reply({ sha: "new-tree-sha" });
    if (step === "commit") return reply({ sha: "new-commit-sha" });
    if (step === "ref-update") return reply({});
    return reply({});
  };
  fn.calls = calls;
  return fn;
}

// A tiny fake git history for the time-machine endpoints: `commits` is
// newest-first, each `{sha, date, message, content}` -- mirrors what a real
// cellstocks/data/<user>.json's commit log looks like (one save = one commit).
function makeHistoryGithubFetch(commits) {
  const calls = [];
  const fn = async (url) => {
    calls.push({ url });
    const u = new URL(url);
    const reply = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (u.pathname.endsWith("/commits")) {
      const until = u.searchParams.get("until");
      const matching = until ? commits.filter((c) => c.date <= until) : commits;
      const perPage = Number(u.searchParams.get("per_page")) || matching.length;
      return reply(matching.slice(0, perPage).map((c) => ({ sha: c.sha, commit: { author: { date: c.date }, message: c.message } })));
    }
    const contentsMatch = u.pathname.match(/\/contents\/(.+)$/);
    if (contentsMatch) {
      const sha = u.searchParams.get("ref");
      const commit = commits.find((c) => c.sha === sha);
      if (!commit) return { ok: false, status: 404, text: async () => JSON.stringify({ message: "not found" }) };
      return reply({ content: Buffer.from(commit.content, "utf8").toString("base64") });
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ message: "unhandled in test stub: " + url }) };
  };
  fn.calls = calls;
  return fn;
}

function makeEnv(overrides) {
  return Object.assign(
    {
      CST_KV: makeKv(),
      GITHUB_OWNER: "ucagiral",
      GITHUB_REPO: "cagiral-schedule",
      GITHUB_BRANCH: "main",
      GITHUB_TOKEN: "test-token",
      BOOTSTRAP_SECRET: "test-secret",
      ALLOWED_ORIGIN: "https://ucagiral.github.io",
      fetch: makeGithubFetch()
    },
    overrides || {}
  );
}

function req(method, path, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new Request(`https://worker.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function bootstrapAdmin(env, name = "admin", password = "correcthorsebatterystaple") {
  const res = await handleRequest(req("POST", "/bootstrap", { name, password, secret: env.BOOTSTRAP_SECRET }), env);
  const body = await res.json();
  return { status: res.status, body };
}

async function login(env, name, password) {
  const res = await handleRequest(req("POST", "/login", { name, password }), env);
  const body = await res.json();
  return { status: res.status, body };
}

// ==================================================================== bootstrap

await check("bootstrap creates the first account as a hidden admin", async () => {
  const env = makeEnv();
  const { status, body } = await bootstrapAdmin(env);
  if (status !== 201) return `expected 201, got ${status}: ${json(body)}`;
  if (body.user.role !== "admin" || body.user.hidden !== true) return `expected a hidden admin, got ${json(body.user)}`;
  if (body.user.hash || body.user.salt) return "bootstrap response leaked password hash/salt";
  return null;
});

await check("bootstrap refuses a second time once any user exists", async () => {
  const env = makeEnv();
  await bootstrapAdmin(env);
  const { status, body } = await bootstrapAdmin(env, "someone-else");
  if (status !== 409) return `expected 409, got ${status}: ${json(body)}`;
  return null;
});

await check("bootstrap refuses the wrong secret", async () => {
  const env = makeEnv();
  const res = await handleRequest(req("POST", "/bootstrap", { name: "admin", password: "x", secret: "wrong" }), env);
  if (res.status !== 403) return `expected 403, got ${res.status}`;
  return null;
});

// ==================================================================== login / session / logout

await check("a correct password logs in and a session survives a /session check", async () => {
  const env = makeEnv();
  await bootstrapAdmin(env, "admin", "correct-password");
  const { status, body } = await login(env, "admin", "correct-password");
  if (status !== 200) return `login failed: ${json(body)}`;
  if (!body.token) return "no token returned";
  const res = await handleRequest(req("GET", "/session", undefined, body.token), env);
  const session = await res.json();
  if (res.status !== 200 || session.user.name !== "admin") return `session check failed: ${json(session)}`;
  return null;
});

await check("a wrong password is rejected and reveals nothing about which part was wrong", async () => {
  const env = makeEnv();
  await bootstrapAdmin(env, "admin", "correct-password");
  const { status, body } = await login(env, "admin", "wrong-password");
  if (status !== 401) return `expected 401, got ${status}`;
  if (/hash|salt/i.test(json(body))) return "error response leaked hash/salt";
  return null;
});

await check("logout invalidates the token", async () => {
  const env = makeEnv();
  await bootstrapAdmin(env, "admin", "correct-password");
  const { body: loginBody } = await login(env, "admin", "correct-password");
  await handleRequest(req("POST", "/logout", undefined, loginBody.token), env);
  const res = await handleRequest(req("GET", "/session", undefined, loginBody.token), env);
  if (res.status !== 401) return `expected the logged-out token to be rejected, got ${res.status}`;
  return null;
});

await check("no Authorization header at all is rejected, not treated as anonymous", async () => {
  const env = makeEnv();
  const res = await handleRequest(req("GET", "/session"), env);
  if (res.status !== 401) return `expected 401, got ${res.status}`;
  return null;
});

// ==================================================================== admin user CRUD

async function adminEnvWithToken() {
  const env = makeEnv();
  await bootstrapAdmin(env, "admin", "correct-password");
  const { body } = await login(env, "admin", "correct-password");
  return { env, token: body.token };
}

await check("an admin can create a member account, and it can log in", async () => {
  const { env, token } = await adminEnvWithToken();
  const res = await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "lab-password" }, token), env);
  const body = await res.json();
  if (res.status !== 201) return `create failed: ${json(body)}`;
  if (body.user.role !== "member" || body.user.hidden) return `expected a visible member, got ${json(body.user)}`;
  const loginResult = await login(env, "Umut", "lab-password");
  if (loginResult.status !== 200) return `the new account could not log in: ${json(loginResult.body)}`;
  return null;
});

await check("a member cannot create, list, or delete accounts", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "lab-password" }, token), env);
  const { body: memberLogin } = await login(env, "Umut", "lab-password");
  const memberToken = memberLogin.token;

  const list = await handleRequest(req("GET", "/admin/users", undefined, memberToken), env);
  if (list.status !== 403) return `list: expected 403, got ${list.status}`;

  const create = await handleRequest(req("POST", "/admin/users", { name: "Someone", password: "x" }, memberToken), env);
  if (create.status !== 403) return `create: expected 403, got ${create.status}`;

  const del = await handleRequest(req("DELETE", "/admin/users/Umut", undefined, memberToken), env);
  if (del.status !== 403) return `delete: expected 403, got ${del.status}`;
  return null;
});

await check("listing users never includes password hash or salt", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "lab-password" }, token), env);
  const res = await handleRequest(req("GET", "/admin/users", undefined, token), env);
  const body = await res.json();
  if (body.users.length !== 2) return `expected 2 users, got ${body.users.length}`;
  if (/hash|salt/i.test(json(body))) return "user listing leaked hash/salt";
  return null;
});

await check("deleting a user immediately revokes their session", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "lab-password" }, token), env);
  const { body: memberLogin } = await login(env, "Umut", "lab-password");
  await handleRequest(req("DELETE", "/admin/users/Umut", undefined, token), env);
  const res = await handleRequest(req("GET", "/session", undefined, memberLogin.token), env);
  if (res.status !== 401) return `expected the deleted user's session to be rejected, got ${res.status}`;
  return null;
});

// Umut was surprised in practice that a deleted account's data file stayed behind --
// recreating the same name silently brought all the old data back. Deleting an account
// now deletes cellstocks/data/<name>.{json,xlsx} too, in the same one-commit tree-delete
// shape renameUserFiles() already uses for its copy+delete.
await check("deleting a user also deletes their data and workbook from git", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "lab-password" }, token), env);
  env.fetch = makeGithubFetch({
    contents: { "cellstocks/data/umut.json": "umut-json-sha", "cellstocks/data/umut.xlsx": "umut-xlsx-sha" }
  });
  const res = await handleRequest(req("DELETE", "/admin/users/Umut", undefined, token), env);
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(await res.json())}`;

  const treeCall = env.fetch.calls.find((c) => c.url.includes("/git/trees"));
  if (!treeCall) return `no tree call: ${json(env.fetch.calls.map((c) => c.url))}`;
  const paths = treeCall.body.tree.map((t) => `${t.path}:${t.sha === null ? "null" : t.sha}`);
  const wantDelete = paths.includes("cellstocks/data/umut.json:null") && paths.includes("cellstocks/data/umut.xlsx:null");
  if (!wantDelete) return `unexpected tree entries: ${json(paths)}`;
  return null;
});

// Umut's call, after his own test left eight boxes in the shared tree naming an account
// that no longer existed: a delete is refused while the person still owns a box, and
// Handoff -- which gives every box a new owner or discards it and then deletes the
// account -- is the way through. Before the tree was shared this could not happen: the
// boxes lived in the account's own file and went with it.
const LAB_TREE_WITH_UMUT = JSON.stringify({
  labName: "CAA Lab Stocks",
  units: [{ id: "u-1", name: "-80", childLabel: "Rack", racks: [
    { id: "r-1", name: "Rack 1", racks: [
      { id: "r-1-1", name: "Shelf 1", boxes: [
        { id: "b-1", name: "UMUT CELLS", owner: "umut" },
        { id: "b-2", name: "Somebody else's", owner: "busra" }
      ] }
    ] }
  ] }]
});

// The app is served from this same Worker now, so the address carries no GitHub username
// and the page and the API share one origin (which is why CORS stops applying to it).
// Anything that is not one of the API's own routes is the app.
// The login failure that came of binding the assets: on the GitHub Pages copy a login is
// cross-origin, so the browser sends OPTIONS /login first, and Cloudflare's asset router
// answered that before worker.js ever ran -- without the Access-Control-Allow-* headers,
// so the browser refused the real request and the app said "Failed to fetch". The Worker
// runs first now (run_worker_first in wrangler.toml); this is the check that it answers.
// The nightly layout export is mailed to a list an admin keeps in the app. It is a
// committed file rather than a KV setting because the scheduled job that sends the mail
// reads the repository and has no account to log in with.
await check("only an admin may write the export recipients list", async () => {
  const { env, adminToken, umutToken } = await twoMembers();
  const file = { path: "cellstocks/exports/recipients.json", content: '{"emails":["a@b.co"]}' };

  env.fetch = makeGithubFetch();
  const asMember = await handleRequest(req("POST", "/commit", { files: [file], message: "m" }, umutToken), env);
  if (asMember.status !== 403) return `a member was allowed to write it: ${asMember.status}`;

  env.fetch = makeGithubFetch();
  const asAdmin = await handleRequest(req("POST", "/commit", { files: [file], message: "m" }, adminToken), env);
  if (asAdmin.status !== 200) return `admin was refused: ${asAdmin.status} ${json(await asAdmin.json())}`;
  return null;
});

await check("the recipients path is exact -- nothing else under exports/ is writable", async () => {
  const { env, adminToken } = await twoMembers();
  env.fetch = makeGithubFetch();
  const res = await handleRequest(req("POST", "/commit", {
    files: [{ path: "cellstocks/exports/layout.pdf", content: "x" }], message: "m"
  }, adminToken), env);
  // The exports themselves are written by the scheduled job through git, not through
  // this endpoint -- letting the app overwrite them would make the daily file a place
  // anyone logged in as admin could put anything.
  if (res.status !== 403) return `expected 403 for a non-recipients export path, got ${res.status}`;
  return null;
});

await check("a CORS preflight is answered by the Worker, with the allow headers, never by assets", async () => {
  const { env } = await adminEnvWithToken();
  let assetsAsked = false;
  env.ASSETS = { fetch: async () => { assetsAsked = true; return new Response("", { status: 405 }); } };
  const res = await handleRequest(new Request("https://worker.example/login", { method: "OPTIONS" }), env);
  if (res.status !== 204) return `expected 204, got ${res.status}`;
  if (assetsAsked) return "the preflight was handed to the assets instead of answered";
  const allow = res.headers.get("Access-Control-Allow-Origin");
  if (!allow) return "the preflight carried no Access-Control-Allow-Origin";
  if (!/POST/.test(res.headers.get("Access-Control-Allow-Methods") || "")) return "POST is not allowed by the preflight";
  if (!/Authorization/i.test(res.headers.get("Access-Control-Allow-Headers") || "")) return "Authorization is not an allowed header";
  return null;
});

await check("a path that is not an API route is handed to the static assets", async () => {
  const { env, token } = await adminEnvWithToken();
  const asked = [];
  env.ASSETS = { fetch: async (req) => { asked.push(new URL(req.url).pathname); return new Response("<!doctype html>", { status: 200 }); } };
  const res = await handleRequest(req("GET", "/engine.js", undefined, token), env);
  if (res.status !== 200) return `expected the asset, got ${res.status}`;
  if (json(asked) !== json(["/engine.js"])) return `assets were asked for ${json(asked)}`;
  return null;
});

await check("an API route is still the API, not an asset", async () => {
  const { env, token } = await adminEnvWithToken();
  env.ASSETS = { fetch: async () => new Response("nope", { status: 200 }) };
  const res = await handleRequest(req("GET", "/session", undefined, token), env);
  const body = await res.json();
  if (res.status !== 200 || !body.user) return `/session did not reach the API: ${res.status} ${json(body)}`;
  return null;
});

await check("with no assets bound at all, an unknown path is still a plain 404", async () => {
  // Node's own selftest runs the Worker with no ASSETS binding, and so does any deploy
  // made by a wrangler too old to understand one -- neither may start 500ing.
  const { env, token } = await adminEnvWithToken();
  const res = await handleRequest(req("GET", "/nothing-here", undefined, token), env);
  if (res.status !== 404) return `expected 404, got ${res.status}`;
  return null;
});

await check("deleting a user who still owns a box is refused, and names the box", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "lab-password" }, token), env);
  env.fetch = makeGithubFetch({
    contents: { "cellstocks/lab-storage.json": { text: LAB_TREE_WITH_UMUT } }
  });
  const res = await handleRequest(req("DELETE", "/admin/users/Umut", undefined, token), env);
  if (res.status !== 409) return `expected 409, got ${res.status}`;
  const body = await res.json();
  if (!/UMUT CELLS/.test(body.error)) return `the refusal does not name the box: ${body.error}`;
  if (!/Handoff/.test(body.error)) return `the refusal does not point at Handoff: ${body.error}`;
  if (json(body.boxes) !== json(["UMUT CELLS"])) return `unexpected box list: ${json(body.boxes)}`;
  const treeCall = env.fetch.calls.find((c) => c.url.includes("/git/trees"));
  if (treeCall) return `a refused delete must not touch git: ${json(treeCall)}`;
  return null;
});

await check("a nested box belonging to somebody else does not block their delete", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Ayse", password: "lab-password" }, token), env);
  env.fetch = makeGithubFetch({
    contents: { "cellstocks/lab-storage.json": { text: LAB_TREE_WITH_UMUT } }
  });
  const res = await handleRequest(req("DELETE", "/admin/users/Ayse", undefined, token), env);
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(await res.json())}`;
  return null;
});

await check("with no structure file at all, a delete still goes through", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "lab-password" }, token), env);
  env.fetch = makeGithubFetch();   // every path 404s, the structure file included
  const res = await handleRequest(req("DELETE", "/admin/users/Umut", undefined, token), env);
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(await res.json())}`;
  return null;
});

await check("deleting a user who never saved anything skips the git commit cleanly", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "lab-password" }, token), env);
  env.fetch = makeGithubFetch(); // both pairs 404 -- nothing to delete
  const res = await handleRequest(req("DELETE", "/admin/users/Umut", undefined, token), env);
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(await res.json())}`;
  const treeCall = env.fetch.calls.find((c) => c.url.includes("/git/trees"));
  if (treeCall) return `expected no tree call when there was nothing to delete: ${json(treeCall)}`;
  return null;
});

await check("resetting a password locks out the old one and lets the new one in", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "old-password" }, token), env);
  await handleRequest(req("POST", "/admin/users/Umut/reset-password", { password: "new-password" }, token), env);
  const oldLogin = await login(env, "Umut", "old-password");
  if (oldLogin.status !== 401) return "the old password still worked";
  const newLogin = await login(env, "Umut", "new-password");
  if (newLogin.status !== 200) return `the new password did not work: ${json(newLogin.body)}`;
  return null;
});

await check("a duplicate account name is refused", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "x" }, token), env);
  const res = await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "y" }, token), env);
  if (res.status !== 409) return `expected 409, got ${res.status}`;
  return null;
});

// ==================================================================== renaming a user
//
// A rename touches three things: the git files (one atomic commit, copy+delete), the KV
// user record (a new key, the old one gone), and every request/notification
// that named the old account -- Umut asked for a rename to "update everything". These
// prove all three, plus the two guardrails (name taken, not logged in as admin).

await check("renaming a user moves their git files in one commit (copy + delete)", async () => {
  const { env, adminToken, umutToken, labmateToken } = await twoMembers();
  env.fetch = makeGithubFetch({
    contents: { "cellstocks/data/umut.json": "umut-json-sha", "cellstocks/data/umut.xlsx": "umut-xlsx-sha" }
  });
  const res = await handleRequest(req("POST", "/admin/users/Umut/rename", { newName: "Ayse" }, adminToken), env);
  const body = await res.json();
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(body)}`;
  if (body.user.name !== "Ayse") return `expected the renamed user back, got ${json(body.user)}`;

  const treeCall = env.fetch.calls.find((c) => c.url.includes("/git/trees"));
  if (!treeCall) return `no tree call: ${json(env.fetch.calls.map((c) => c.url))}`;
  const paths = treeCall.body.tree.map((t) => `${t.path}:${t.sha === null ? "null" : t.sha}`);
  const wantCopy = paths.includes("cellstocks/data/ayse.json:umut-json-sha") && paths.includes("cellstocks/data/ayse.xlsx:umut-xlsx-sha");
  const wantDelete = paths.includes("cellstocks/data/umut.json:null") && paths.includes("cellstocks/data/umut.xlsx:null");
  if (!wantCopy || !wantDelete) return `unexpected tree entries: ${json(paths)}`;

  const oldSession = await handleRequest(req("GET", "/session", undefined, umutToken), env);
  if (oldSession.status !== 401) return "the old name's session should have been invalidated by the KV key move";
  const newLogin = await login(env, "Ayse", "a");
  if (newLogin.status !== 200) return `logging in under the new name failed: ${json(newLogin.body)}`;

  return null;
});

await check("renaming to an already-taken name, or as a non-admin, is refused", async () => {
  const { env, adminToken, umutToken } = await twoMembers();
  const asMember = await handleRequest(req("POST", "/admin/users/Umut/rename", { newName: "Someone" }, umutToken), env);
  if (asMember.status !== 403) return `expected 403 for a non-admin caller, got ${asMember.status}`;
  const taken = await handleRequest(req("POST", "/admin/users/Umut/rename", { newName: "Labmate" }, adminToken), env);
  if (taken.status !== 409) return `expected 409 for an already-taken name, got ${taken.status}`;
  return null;
});

// ==================================================================== ownership: dataPathFor / canWrite

await check("dataPathFor and canWrite agree with each other for a member's own file", () => {
  const member = { name: "Umut", role: "member" };
  const path = dataPathFor("Umut");
  if (path !== "cellstocks/data/umut.json") return `unexpected path: ${path}`;
  return canWrite(member, path) ? null : "a member could not write their own data path";
});

await check("a member may not write another member's file", () => {
  const member = { name: "Umut", role: "member" };
  return canWrite(member, dataPathFor("someone-else")) ? "wrote another member's file" : null;
});

await check("a member may not write outside cellstocks/data/", () => {
  const member = { name: "Umut", role: "member" };
  if (canWrite(member, "cellstocks/cellstocks.json")) return "wrote the shared legacy file";
  if (canWrite(member, "cellstocks-worker/wrangler.toml")) return "wrote outside cellstocks entirely";
  return null;
});

await check("an admin may write any user's file, still only under cellstocks/data/", () => {
  const admin = { name: "admin", role: "admin" };
  if (!canWrite(admin, dataPathFor("Umut"))) return "admin could not write a member's file";
  if (canWrite(admin, "cellstocks/cellstocks.json")) return "admin wrote outside cellstocks/data/ anyway";
  return null;
});

await check("a member may write their own .xlsx, not just their .json", () => {
  const member = { name: "Umut", role: "member" };
  return canWrite(member, xlsxPathFor("Umut")) ? null : "a member could not write their own workbook path";
});

// ==================================================================== /commit endpoint
//
// The app always saves the JSON and the generated .xlsx together (see
// cellstocks/index.html's commitFiles()) -- /commit is what makes that atomic through
// the worker, so these exercise it with both files at once, the way the app actually
// will, not just a single file in isolation.

function bothFiles(name, opts) {
  return [
    { path: dataPathFor(name), content: '{"vials":[]}' },
    { path: xlsxPathFor(name), content: "ZmFrZS14bHN4", base64: true }
  ].map((f) => Object.assign(f, opts || {}));
}

await check("a member can commit their own data+workbook pair in one atomic commit", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "lab-password" }, token), env);
  const { body: memberLogin } = await login(env, "Umut", "lab-password");
  const res = await handleRequest(
    req("POST", "/commit", { files: bothFiles("Umut"), message: "test commit" }, memberLogin.token),
    env
  );
  const body = await res.json();
  if (res.status !== 200) return `commit failed: ${json(body)}`;
  if (!body.commit) return `no commit sha returned: ${json(body)}`;
  // ref -> base commit -> 2 blobs -> tree -> commit -> ref update = 7 GitHub calls.
  if (env.fetch.calls.length !== 7) return `expected 7 GitHub calls, got ${env.fetch.calls.length}: ${json(env.fetch.calls.map((c) => c.url))}`;
  const treeCall = env.fetch.calls.find((c) => c.url.includes("/git/trees"));
  if (treeCall.body.tree.length !== 2) return `tree did not include both files: ${json(treeCall.body)}`;
  const refUpdate = env.fetch.calls[env.fetch.calls.length - 1];
  if (!refUpdate.url.includes("/git/refs/heads/main")) return `last call was not the ref update: ${refUpdate.url}`;
  return null;
});

await check("a member cannot commit another member's data file, and nothing reaches GitHub", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "a" }, token), env);
  await handleRequest(req("POST", "/admin/users", { name: "Labmate", password: "b" }, token), env);
  const { body: memberLogin } = await login(env, "Labmate", "b");
  const res = await handleRequest(
    req("POST", "/commit", { files: bothFiles("Umut"), message: "sneaky" }, memberLogin.token),
    env
  );
  if (res.status !== 403) return `expected 403, got ${res.status}`;
  if (env.fetch.calls.length) return "a GitHub call was made despite the ownership check failing";
  return null;
});

await check("mixing one writable file with one forbidden file rejects the whole commit, not just the bad file", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "a" }, token), env);
  await handleRequest(req("POST", "/admin/users", { name: "Labmate", password: "b" }, token), env);
  const { body: memberLogin } = await login(env, "Labmate", "b");
  const res = await handleRequest(
    req("POST", "/commit", { files: bothFiles("Labmate").concat(bothFiles("Umut")), message: "half-legit" }, memberLogin.token),
    env
  );
  if (res.status !== 403) return `expected 403, got ${res.status}`;
  if (env.fetch.calls.length) return "the own-file half of the commit reached GitHub before the mix was rejected";
  return null;
});

await check("an unauthenticated commit is rejected before any ownership check runs", async () => {
  const env = makeEnv();
  const res = await handleRequest(req("POST", "/commit", { files: bothFiles("x"), message: "m" }), env);
  if (res.status !== 401) return `expected 401, got ${res.status}`;
  return null;
});

await check("an admin can commit into another user's data+workbook pair", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "a" }, token), env);
  const res = await handleRequest(
    req("POST", "/commit", { files: bothFiles("Umut"), message: "admin override" }, token),
    env
  );
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(await res.json())}`;
  return null;
});

await check("a GitHub failure partway through surfaces as an error, not a silent 200", async () => {
  const env = makeEnv({ fetch: makeGithubFetch({ failOn: "tree" }) });
  await bootstrapAdmin(env, "admin", "correct-password");
  const { body: adminLogin } = await login(env, "admin", "correct-password");
  const res = await handleRequest(
    req("POST", "/commit", { files: bothFiles("admin"), message: "m" }, adminLogin.token),
    env
  );
  if (res.status < 400) return `expected an error status, got ${res.status}`;
  return null;
});

async function twoMembers() {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "a" }, token), env);
  await handleRequest(req("POST", "/admin/users", { name: "Labmate", password: "b" }, token), env);
  const { body: umutLogin } = await login(env, "Umut", "a");
  const { body: labmateLogin } = await login(env, "Labmate", "b");
  return { env, adminToken: token, umutToken: umutLogin.token, labmateToken: labmateLogin.token };
}

// ==================================================================== item types
//
// The type list ("Add" can freeze a Plasmid, an RNA prep, a Protein... not only a
// cell) and each type's own list of known attribute NAMES (autocomplete suggestions,
// never values) are lab-wide, shared across every account -- unlike cellstocks' own
// state.rules, which only ever covers cells. One KV key holds the lot.

await check("GET /types ships the default type list to any logged-in user", async () => {
  const { env, umutToken } = await twoMembers();
  const res = await handleRequest(req("GET", "/types", undefined, umutToken), env);
  const body = await res.json();
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(body)}`;
  const names = body.types.map((t) => t.name);
  ["Cell", "Plasmid", "RNA", "cDNA", "Protein", "Bacterial Glycerol"].forEach((n) => {
    if (names.indexOf(n) === -1) return `missing default type ${n}: ${json(names)}`;
  });
  const anon = await handleRequest(req("GET", "/types", undefined, undefined), env);
  if (anon.status !== 401) return `expected 401 with no token, got ${anon.status}`;
  return null;
});

await check("POST /types adds a new type instantly, for any logged-in user", async () => {
  const { env, umutToken } = await twoMembers();
  const res = await handleRequest(req("POST", "/types", { name: "Antibody" }, umutToken), env);
  const body = await res.json();
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(body)}`;
  if (body.types.map((t) => t.name).indexOf("Antibody") === -1) return `type not added: ${json(body.types)}`;
  const again = await handleRequest(req("GET", "/types", undefined, umutToken), env);
  const bodyAgain = await again.json();
  if (bodyAgain.types.filter((t) => t.name === "Antibody").length !== 1) return "adding the same type twice must not duplicate it";
  return null;
});

await check("POST /types adds an attribute name to an existing type's suggestion list, and dedupes a repeat", async () => {
  const { env, umutToken } = await twoMembers();
  const attribute = { type: "Plasmid", name: "concentration" };
  const res = await handleRequest(req("POST", "/types", { attribute }, umutToken), env);
  const body = await res.json();
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(body)}`;
  const plasmid = body.types.find((t) => t.name === "Plasmid");
  if (!plasmid || plasmid.attributes.indexOf("concentration") === -1) return `attribute not recorded on the type: ${json(plasmid)}`;
  const again = await handleRequest(req("POST", "/types", { attribute }, umutToken), env);
  const bodyAgain = await again.json();
  const plasmidAgain = bodyAgain.types.find((t) => t.name === "Plasmid");
  if (plasmidAgain.attributes.filter((a) => a === "concentration").length !== 1) return "the same attribute posted twice must not duplicate";
  return null;
});

await check("POST /types keeps a same-named attribute independent across two different types", async () => {
  const { env, umutToken } = await twoMembers();
  await handleRequest(req("POST", "/types", { attribute: { type: "Protein", name: "concentration" } }, umutToken), env);
  const res = await handleRequest(req("POST", "/types", { attribute: { type: "Bacterial Glycerol", name: "concentration" } }, umutToken), env);
  const body = await res.json();
  const protein = body.types.find((t) => t.name === "Protein");
  const glycerol = body.types.find((t) => t.name === "Bacterial Glycerol");
  if (!protein.attributes.includes("concentration") || !glycerol.attributes.includes("concentration")) {
    return `both types should independently have it: ${json({ protein, glycerol })}`;
  }
  return null;
});

await check("POST /types rejects an incomplete attribute and a blank name", async () => {
  const { env, umutToken } = await twoMembers();
  const badAttr = await handleRequest(req("POST", "/types", { attribute: { type: "Plasmid", name: "  " } }, umutToken), env);
  if (badAttr.status !== 400) return `expected 400 for a blank attribute name, got ${badAttr.status}`;
  const noSuchType = await handleRequest(req("POST", "/types", { attribute: { type: "NoSuchType", name: "x" } }, umutToken), env);
  if (noSuchType.status !== 404) return `expected 404 for an unknown type, got ${noSuchType.status}`;
  const blank = await handleRequest(req("POST", "/types", { name: "   " }, umutToken), env);
  if (blank.status !== 400) return `expected 400 for a blank name, got ${blank.status}`;
  const nothing = await handleRequest(req("POST", "/types", {}, umutToken), env);
  if (nothing.status !== 400) return `expected 400 for an empty body, got ${nothing.status}`;
  return null;
});

await check("only admin can merge or delete a type", async () => {
  const { env, umutToken } = await twoMembers();
  const merge = await handleRequest(req("POST", "/admin/types/merge", { from: "RNA", into: "cDNA" }, umutToken), env);
  if (merge.status !== 403) return `merge: expected 403, got ${merge.status}`;
  const del = await handleRequest(req("DELETE", "/admin/types/RNA", undefined, umutToken), env);
  if (del.status !== 403) return `delete: expected 403, got ${del.status}`;
  return null;
});

await check("admin can merge one type's known attributes into another and remove it", async () => {
  const { env, adminToken, umutToken } = await twoMembers();
  await handleRequest(req("POST", "/types", { attribute: { type: "RNA", name: "prep-kit" } }, umutToken), env);
  const res = await handleRequest(req("POST", "/admin/types/merge", { from: "RNA", into: "cDNA" }, adminToken), env);
  const body = await res.json();
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(body)}`;
  if (body.types.map((t) => t.name).indexOf("RNA") !== -1) return "the merged-from type must be removed";
  const cdna = body.types.find((t) => t.name === "cDNA");
  if (!cdna || cdna.attributes.indexOf("prep-kit") === -1) return `merged attribute missing from cDNA: ${json(cdna)}`;
  return null;
});

await check("admin deleting a type removes it from the list without touching anyone's vials", async () => {
  const { env, adminToken } = await twoMembers();
  const res = await handleRequest(req("DELETE", "/admin/types/Bacterial%20Glycerol", undefined, adminToken), env);
  const body = await res.json();
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(body)}`;
  if (body.types.map((t) => t.name).indexOf("Bacterial Glycerol") !== -1) return "the type was not removed";
  const missing = await handleRequest(req("DELETE", "/admin/types/NoSuchType", undefined, adminToken), env);
  if (missing.status !== 404) return `deleting a type that doesn't exist: expected 404, got ${missing.status}`;
  return null;
});

// ==================================================================== history (time machine)
//
// "Even if someone deletes their stock, I should be able to retrieve the complete stock
// situation on 23 May 2026 14:56" -- these prove that against a fake git history for
// cellstocks/data/umut.json: three commits, each with different inventory content, the
// way three real saves would look.

const HISTORY_FIXTURE = [
  { sha: "sha-3", date: "2026-05-24T09:00:00Z", message: "Take out a vial", content: '{"vials":["after-may-24"]}' },
  { sha: "sha-2", date: "2026-05-23T14:56:00Z", message: "Freeze a new line", content: '{"vials":["as-of-may-23-1456"]}' },
  { sha: "sha-1", date: "2026-05-01T10:00:00Z", message: "Initial import", content: '{"vials":["initial"]}' }
];

await check("history/commits lists every commit to that user's file, admin only", async () => {
  const { env: base, token } = await adminEnvWithToken();
  const env = Object.assign({}, base, { fetch: makeHistoryGithubFetch(HISTORY_FIXTURE) });
  const res = await handleRequest(req("GET", "/admin/history/commits?user=Umut", undefined, token), env);
  const body = await res.json();
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(body)}`;
  if (body.commits.length !== 3) return `expected 3 commits, got ${body.commits.length}`;
  if (body.commits[0].sha !== "sha-3") return `expected newest first, got ${json(body.commits.map((c) => c.sha))}`;
  return null;
});

await check("a non-admin cannot browse or query history", async () => {
  const { env: base, umutToken } = await twoMembers();
  const env = Object.assign({}, base, { fetch: makeHistoryGithubFetch(HISTORY_FIXTURE) });
  const commitsRes = await handleRequest(req("GET", "/admin/history/commits?user=Umut", undefined, umutToken), env);
  if (commitsRes.status !== 403) return `commits: expected 403, got ${commitsRes.status}`;
  const atRes = await handleRequest(req("GET", "/admin/history/at?user=Umut&at=2026-05-23T14:56:00Z", undefined, umutToken), env);
  if (atRes.status !== 403) return `at: expected 403, got ${atRes.status}`;
  return null;
});

await check("history/at returns the state as of that exact moment, not the nearest commit either way", async () => {
  const { env: base, token } = await adminEnvWithToken();
  const env = Object.assign({}, base, { fetch: makeHistoryGithubFetch(HISTORY_FIXTURE) });
  const res = await handleRequest(req("GET", "/admin/history/at?user=Umut&at=2026-05-23T14:56:00Z", undefined, token), env);
  const body = await res.json();
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(body)}`;
  if (body.sha !== "sha-2") return `expected the exact-moment commit sha-2, got ${body.sha}`;
  if (JSON.parse(body.content).vials[0] !== "as-of-may-23-1456") return `unexpected content: ${body.content}`;
  return null;
});

await check("history/at one second after a commit still returns that commit, not a later one", async () => {
  const { env: base, token } = await adminEnvWithToken();
  const env = Object.assign({}, base, { fetch: makeHistoryGithubFetch(HISTORY_FIXTURE) });
  const res = await handleRequest(req("GET", "/admin/history/at?user=Umut&at=2026-05-23T23:59:59Z", undefined, token), env);
  const body = await res.json();
  if (body.sha !== "sha-2") return `expected sha-2 (the last commit before end of day), got ${json(body)}`;
  return null;
});

await check("history/at before the file's first commit is refused, not silently returning something", async () => {
  const { env: base, token } = await adminEnvWithToken();
  const env = Object.assign({}, base, { fetch: makeHistoryGithubFetch(HISTORY_FIXTURE) });
  const res = await handleRequest(req("GET", "/admin/history/at?user=Umut&at=2026-04-01T00:00:00Z", undefined, token), env);
  if (res.status !== 404) return `expected 404, got ${res.status}: ${json(await res.json())}`;
  return null;
});

await check("history works for a user deleted from KV -- it reads git history, not the live account", async () => {
  const { env: base, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Gone", password: "x" }, token), base);
  await handleRequest(req("DELETE", "/admin/users/Gone", undefined, token), base);
  const env = Object.assign({}, base, { fetch: makeHistoryGithubFetch(HISTORY_FIXTURE) });
  const res = await handleRequest(req("GET", "/admin/history/at?user=Gone&at=2026-05-23T14:56:00Z", undefined, token), env);
  const body = await res.json();
  if (res.status !== 200 || body.sha !== "sha-2") return `expected the same history lookup to work for a deleted account: ${res.status} ${json(body)}`;
  return null;
});

// ==================================================================== CORS / misc

await check("an OPTIONS preflight gets CORS headers and no body", async () => {
  const env = makeEnv();
  const res = await handleRequest(new Request("https://worker.example/commit", { method: "OPTIONS" }), env);
  if (res.status !== 204) return `expected 204, got ${res.status}`;
  if (res.headers.get("Access-Control-Allow-Origin") !== "https://ucagiral.github.io") {
    return `missing/wrong CORS origin: ${res.headers.get("Access-Control-Allow-Origin")}`;
  }
  return null;
});

await check("every response carries the CORS origin header, not just OPTIONS", async () => {
  const env = makeEnv();
  const res = await handleRequest(req("GET", "/session"), env);
  if (res.headers.get("Access-Control-Allow-Origin") !== "https://ucagiral.github.io") return "missing CORS header on a normal response";
  return null;
});

await check("an unknown route 404s instead of falling through to something else", async () => {
  const env = makeEnv();
  const res = await handleRequest(req("GET", "/nonexistent"), env);
  if (res.status !== 404) return `expected 404, got ${res.status}`;
  return null;
});

// ==================================================================== shared lab storage

await check("the lab's shared structure is writable by any member, and by no PI", async () => {
  const member = { name: "Umut", role: "member" };
  if (!canWrite(member, LAB_STORAGE_PATH)) return "a member cannot add a box for themselves any more";
  if (!canWrite({ name: "admin", role: "admin" }, LAB_STORAGE_PATH)) return "admin cannot write the structure";
  if (canWrite({ name: "Chief", role: "pi" }, LAB_STORAGE_PATH)) return "a PI must not write the structure";
  // Still nothing else outside the data prefix.
  if (canWrite(member, "cellstocks/index.html")) return "a member could write app code";
  if (canWrite(member, "cellstocks/lab-storage.json.bak")) return "a near-miss path was accepted";
  return null;
});

await check("a member may commit the lab structure but still not another member's inventory", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "a" }, token), env);
  const { body: umutLogin } = await login(env, "Umut", "a");
  env.fetch = makeGithubFetch();
  const ok = await handleRequest(req("POST", "/commit", {
    files: [{ path: LAB_STORAGE_PATH, content: '{"labName":"CAA Lab Stocks","units":[]}' }], message: "m"
  }, umutLogin.token), env);
  if (ok.status !== 200) return `expected 200 for the shared structure, got ${ok.status}: ${json(await ok.json())}`;
  const nope = await handleRequest(req("POST", "/commit", {
    files: [{ path: dataPathFor("Someone"), content: "{}" }], message: "m"
  }, umutLogin.token), env);
  if (nope.status !== 403) return `expected 403 for someone else's inventory, got ${nope.status}`;
  return null;
});

await check("a folder icon is admin-only, images only, and never a path escape", async () => {
  const admin = { name: "admin", role: "admin" };
  const member = { name: "Umut", role: "member" };
  if (!canWrite(admin, ICON_PREFIX + "freezer.png")) return "admin cannot upload a PNG icon";
  if (!canWrite(admin, ICON_PREFIX + "tank-1a.webp")) return "admin cannot upload a WEBP icon";
  if (canWrite(member, ICON_PREFIX + "freezer.png")) return "a member could upload an icon";
  if (canWrite(admin, ICON_PREFIX + "evil.svg")) return "SVG must not be accepted -- it is markup, in a public repo";
  if (canWrite(admin, ICON_PREFIX + "evil.html")) return "a non-image extension was accepted";
  if (canWrite(admin, ICON_PREFIX + "../data/umut.json")) return "a path traversal was accepted";
  if (canWrite(admin, ICON_PREFIX + "nested/dir.png")) return "a nested path was accepted";
  return null;
});

// ==================================================================== the PI role
//
// A third role, added when Umut asked for a "PI" title in the user list and then said
// exactly what it means: the PI has no inventory of their own at all and can only read
// and search everyone else's. The app hides the Add tab and the admin tools for them;
// these prove the Worker does not simply trust it to.

await check("a role outside the whitelist is refused rather than silently demoted", async () => {
  const { env, token } = await adminEnvWithToken();
  const res = await handleRequest(req("POST", "/admin/users", { name: "Nope", password: "a", role: "wizard" }, token), env);
  if (res.status !== 400) return `expected 400 for an unknown role, got ${res.status}`;
  if (ROLES.join(",") !== "member,admin,pi") return `unexpected role whitelist: ${ROLES.join(",")}`;
  return null;
});

await check("a PI account is created as a real pi, not coerced to member", async () => {
  const { env, token } = await adminEnvWithToken();
  const res = await handleRequest(req("POST", "/admin/users", { name: "Chief", password: "p", role: "pi" }, token), env);
  const body = await res.json();
  if (res.status !== 201) return `expected 201, got ${res.status}: ${json(body)}`;
  if (body.user.role !== "pi") return `expected role pi, got ${json(body.user)}`;
  return null;
});

await check("a PI may not write any data file, not even one named after them", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Chief", password: "p", role: "pi" }, token), env);
  const { body: piLogin } = await login(env, "Chief", "p");
  env.fetch = makeGithubFetch();
  const res = await handleRequest(
    req("POST", "/commit", { files: bothFiles("chief"), message: "m" }, piLogin.token),
    env
  );
  if (res.status !== 403) return `expected 403, got ${res.status}: ${json(await res.json())}`;
  if (canWrite({ name: "Chief", role: "pi" }, dataPathFor("Chief"))) return "canWrite let a PI write their own path";
  return null;
});

await check("a PI is refused by the admin-only routes", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Chief", password: "p", role: "pi" }, token), env);
  const { body: piLogin } = await login(env, "Chief", "p");
  const users = await handleRequest(req("GET", "/admin/users", undefined, piLogin.token), env);
  if (users.status !== 403) return `expected 403 on /admin/users, got ${users.status}`;
  const del = await handleRequest(req("DELETE", "/admin/types/Cell", undefined, piLogin.token), env);
  if (del.status !== 403) return `expected 403 on a type delete, got ${del.status}`;
  return null;
});

// ==================================================================== type attributes
//
// Adding an attribute name is open to anyone (that is what typing one on the Add screen
// does); cleaning the list up is admin-only, the same split merge/delete already uses.
// Neither route ever touches a vial: a value already recorded under a name stays as typed.

await check("admin can rename one of a type's attribute names", async () => {
  const { env, adminToken, umutToken } = await twoMembers();
  await handleRequest(req("POST", "/types", { attribute: { type: "Protein", name: "conc" } }, umutToken), env);
  const res = await handleRequest(
    req("POST", "/admin/types/Protein/attributes/rename", { from: "conc", to: "concentration" }, adminToken), env);
  const body = await res.json();
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(body)}`;
  const protein = body.types.find((t) => t.name === "Protein");
  if (protein.attributes.indexOf("concentration") === -1) return `rename did not land: ${json(protein.attributes)}`;
  if (protein.attributes.indexOf("conc") !== -1) return `old name still there: ${json(protein.attributes)}`;
  return null;
});

await check("renaming onto a name the type already has merges the two rather than duplicating", async () => {
  const { env, adminToken, umutToken } = await twoMembers();
  await handleRequest(req("POST", "/types", { attribute: { type: "Protein", name: "conc" } }, umutToken), env);
  await handleRequest(req("POST", "/types", { attribute: { type: "Protein", name: "concentration" } }, umutToken), env);
  const res = await handleRequest(
    req("POST", "/admin/types/Protein/attributes/rename", { from: "conc", to: "concentration" }, adminToken), env);
  const body = await res.json();
  const protein = body.types.find((t) => t.name === "Protein");
  const hits = protein.attributes.filter((a) => a === "concentration").length;
  if (hits !== 1) return `expected exactly one "concentration", got ${json(protein.attributes)}`;
  return null;
});

await check("admin can delete one attribute name, leaving the type and its others alone", async () => {
  const { env, adminToken, umutToken } = await twoMembers();
  await handleRequest(req("POST", "/types", { attribute: { type: "Protein", name: "conc" } }, umutToken), env);
  await handleRequest(req("POST", "/types", { attribute: { type: "Protein", name: "buffer" } }, umutToken), env);
  const res = await handleRequest(
    req("DELETE", "/admin/types/Protein/attributes/conc", undefined, adminToken), env);
  const body = await res.json();
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(body)}`;
  const protein = body.types.find((t) => t.name === "Protein");
  if (!protein) return "the type itself was removed, not just the attribute";
  if (json(protein.attributes) !== json(["buffer"])) return `expected only buffer left, got ${json(protein.attributes)}`;
  return null;
});

await check("a member cannot rename or delete an attribute, and an unknown one 404s", async () => {
  const { env, adminToken, umutToken } = await twoMembers();
  await handleRequest(req("POST", "/types", { attribute: { type: "Protein", name: "conc" } }, umutToken), env);
  const asMember = await handleRequest(
    req("DELETE", "/admin/types/Protein/attributes/conc", undefined, umutToken), env);
  if (asMember.status !== 403) return `expected 403 for a member, got ${asMember.status}`;
  const missing = await handleRequest(
    req("DELETE", "/admin/types/Protein/attributes/nope", undefined, adminToken), env);
  if (missing.status !== 404) return `expected 404 for an unknown attribute, got ${missing.status}`;
  const blank = await handleRequest(
    req("POST", "/admin/types/Protein/attributes/rename", { from: "conc", to: "   " }, adminToken), env);
  if (blank.status !== 400) return `expected 400 for a blank new name, got ${blank.status}`;
  return null;
});

// ---------------------------------------------------------- the daily mail's trigger
//
// GitHub's scheduler never once fired the export workflow, so a Cloudflare cron on this
// Worker dispatches it instead. What matters is WHAT it dispatches: force=false, meaning
// "check whether it is time" rather than "send now". Get that wrong and the lab is mailed
// at whatever hour the cron happens to run, ignoring the time the admin set in the app.

await check("the cron dispatches the export workflow, asking it to check the time first", async () => {
  const calls = [];
  const env = makeEnv({
    fetch: async (url, opts) => {
      calls.push({ url, method: opts.method, body: JSON.parse(opts.body || "{}"),
                   auth: (opts.headers || {}).Authorization });
      return new Response("{}", { status: 200 });
    }
  });
  const out = await dispatchDailyMail(env);
  if (!out.ok) return `the dispatch reported failure: ${JSON.stringify(out)}`;
  if (calls.length !== 1) return `expected one API call, got ${calls.length}`;
  const c = calls[0];
  if (c.method !== "POST") return `used ${c.method}`;
  if (!/\/actions\/workflows\/cellstocks-export\.yml\/dispatches$/.test(c.url)) {
    return `dispatched the wrong thing: ${c.url}`;
  }
  if (!/ucagiral\/cagiral-schedule/.test(c.url)) return `wrong repository: ${c.url}`;
  if (c.body.ref !== "main") return `dispatched onto ${c.body.ref}`;
  // The whole point. "true" here would mail the lab at the cron's hour rather than the
  // admin's, and would send a second copy on every later poll of the same day.
  if (c.body.inputs.force !== "false") return `force was ${JSON.stringify(c.body.inputs.force)}, not "false"`;
  if (!/test-token/.test(c.auth || "")) return "the Worker's GitHub token was not used";
  return null;
});

await check("a refused dispatch is reported, not swallowed", async () => {
  // Dispatching a workflow needs Actions write permission, which a token minted only for
  // committing files may not have. That must not look like a successful morning.
  const env = makeEnv({
    fetch: async () => new Response(JSON.stringify({ message: "Resource not accessible by integration" }),
                                    { status: 403 })
  });
  const out = await dispatchDailyMail(env);
  if (out.ok) return "a 403 was reported as a successful dispatch";
  if (!/not accessible/.test(out.error || "")) return `unhelpful error: ${JSON.stringify(out)}`;
  return null;
});

// ---------------------------------------------------- seeing what the cron actually did
//
// The reason this endpoint exists: from a phone -- or from a sandbox that cannot reach
// workers.dev -- there is no way to tell "the cron never fired" from "it fired and was
// refused". Those need different fixes, so the Worker records which one happened.

await check("cron-status says so plainly when the cron has never run", async () => {
  const env = makeEnv({});
  const res = await handleRequest(req("GET", "/cron-status"), env);
  if (res.status !== 200) return `status ${res.status}`;
  const body = await res.json();
  if (body.last !== null) return `expected no recorded run, got ${json(body.last)}`;
  if (!/not run yet/.test(body.note || "")) return `unhelpful note: ${json(body.note)}`;
  return null;
});

await check("cron-status reports the last run, refusal and advice included", async () => {
  const env = makeEnv({
    fetch: async () => new Response(JSON.stringify({ message: "Resource not accessible by integration" }),
                                    { status: 403 })
  });
  await dispatchDailyMail(env, new Date("2026-09-07T11:07:00Z"));
  const body = await (await handleRequest(req("GET", "/cron-status"), env)).json();
  if (!body.last) return "the run was not recorded at all -- this endpoint would still be blind";
  if (body.last.ok !== false) return `a 403 was recorded as a success: ${json(body.last)}`;
  if (body.last.status !== 403) return `recorded status ${json(body.last.status)}`;
  if (!/Actions write/.test(body.last.advice || "")) return `no advice on what to fix: ${json(body.last)}`;
  if (body.last.at !== "2026-09-07T11:07:00.000Z") return `wrong timestamp: ${json(body.last.at)}`;
  return null;
});

await check("a successful dispatch is recorded too, so silence means the cron never fired", async () => {
  const env = makeEnv({ fetch: async () => new Response("{}", { status: 200 }) });
  await dispatchDailyMail(env, new Date("2026-09-07T11:37:00Z"));
  const body = await (await handleRequest(req("GET", "/cron-status"), env)).json();
  if (!body.last || body.last.ok !== true) return `a good dispatch was not recorded: ${json(body.last)}`;
  if (body.note) return `still claiming it has not run: ${json(body.note)}`;
  return null;
});

await check("a KV write that fails does not turn a good dispatch into a failed one", async () => {
  const kv = makeKv();
  kv.put = async () => { throw new Error("KV is having a day"); };
  const env = makeEnv({ CST_KV: kv, fetch: async () => new Response("{}", { status: 200 }) });
  const out = await dispatchDailyMail(env, new Date());
  if (!out.ok) return "a KV hiccup was reported as a failed dispatch -- the mail did go out";
  return null;
});

// ------------------------------------------------ a branch that moved is not a conflict
//
// Umut froze two vials and the app told him someone else had saved first. Nobody had.
// main moves on its own here -- the daily export commits to it, phones commit to it,
// merged PRs land on it -- and the ref update was refused simply because the read and
// the write were a second apart. He lost both vials and had to enter them again.
//
// The files being written belong to one account and base_tree is taken from whatever the
// tip is now, so a retry carries everyone else's work forward untouched.

function refMovingFetch(failTimes) {
  // Answers the six calls commitFilesAtomic makes, and refuses the ref update the first
  // `failTimes` times the way GitHub does when the branch has moved on.
  let refused = 0;
  const calls = [];
  return {
    calls,
    get refused() { return refused; },
    fetch: async (url, opts) => {
      calls.push(`${opts.method} ${url.replace(/^.*\/repos\/[^/]+\/[^/]+/, "")}`);
      if (opts.method === "PATCH" && /\/git\/refs\/heads\//.test(url)) {
        if (refused < failTimes) {
          refused++;
          return new Response(JSON.stringify({ message: "Update is not a fast forward" }), { status: 422 });
        }
        return new Response("{}", { status: 200 });
      }
      if (/\/git\/ref\/heads\//.test(url)) return new Response(JSON.stringify({ object: { sha: "tip" + refused } }), { status: 200 });
      if (/\/git\/commits\//.test(url) && opts.method === "GET") return new Response(JSON.stringify({ tree: { sha: "t" + refused } }), { status: 200 });
      if (/\/git\/blobs$/.test(url)) return new Response(JSON.stringify({ sha: "blob" }), { status: 200 });
      if (/\/git\/trees$/.test(url)) return new Response(JSON.stringify({ sha: "newtree" }), { status: 200 });
      if (/\/git\/commits$/.test(url)) return new Response(JSON.stringify({ sha: "newcommit" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }
  };
}

await check("a save whose branch moved under it is retried, not reported as someone else's", async () => {
  const stub = refMovingFetch(1);
  const env = makeEnv({ fetch: stub.fetch });
  const sha = await commitFilesAtomic(env, [{ path: "cellstocks/data/umut.json", content: "{}" }], "Add 2 vials");
  if (sha !== "newcommit") return `expected the commit to go through, got ${json(sha)}`;
  if (stub.refused !== 1) return "the test never actually refused the first attempt";
  // The whole point: the second attempt must read the tip AGAIN. Rebuilding on the
  // stale one would recreate exactly the commit that was just refused.
  const reads = stub.calls.filter((c) => c.startsWith("GET /git/ref/heads/"));
  if (reads.length !== 2) return `expected the tip to be re-read on the retry, saw ${reads.length} reads`;
  return null;
});

await check("a branch that keeps moving eventually gives up rather than spinning", async () => {
  const stub = refMovingFetch(99);
  const env = makeEnv({ fetch: stub.fetch });
  let threw = null;
  try { await commitFilesAtomic(env, [{ path: "cellstocks/data/umut.json", content: "{}" }], "Add 2 vials"); }
  catch (err) { threw = err; }
  if (!threw) return "a ref that never accepts the update must not report success";
  if (stub.refused !== COMMIT_ATTEMPTS) return `tried ${stub.refused} times, expected ${COMMIT_ATTEMPTS}`;
  if (!/fast forward/i.test(threw.message)) return `lost the real reason: ${threw.message}`;
  return null;
});

await check("a refusal that is NOT a moved branch is not retried", async () => {
  // A token without permission, or a path the API rejects, must surface immediately.
  // Retrying those three more times just makes somebody wait longer for the same answer.
  let patches = 0;
  const env = makeEnv({
    fetch: async (url, opts) => {
      if (opts.method === "PATCH") {
        patches++;
        return new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 });
      }
      if (/\/git\/ref\/heads\//.test(url)) return new Response(JSON.stringify({ object: { sha: "tip" } }), { status: 200 });
      if (/\/git\/commits\//.test(url) && opts.method === "GET") return new Response(JSON.stringify({ tree: { sha: "t" } }), { status: 200 });
      return new Response(JSON.stringify({ sha: "x" }), { status: 200 });
    }
  });
  let threw = null;
  try { await commitFilesAtomic(env, [{ path: "cellstocks/data/umut.json", content: "{}" }], "Add 2 vials"); }
  catch (err) { threw = err; }
  if (!threw) return "a 403 was reported as a successful save";
  if (patches !== 1) return `a 403 was retried ${patches} times`;
  return null;
});

// ==================================================================== summary

if (failures.length) {
  console.error(`${failures.length} of ${passed + failures.length} cell stocks worker checks failed:\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}\n`));
  process.exit(1);
} else {
  console.log(`All ${passed} cell stocks worker checks passed.`);
}
