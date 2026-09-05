// Proves the Cell Stocks worker actually enforces what it claims to, instead of trusting
// that it does -- same reasoning as tools/cellstocks-selftest.mjs for the engine.
//
// Run:  node tools/cellstocks-worker-selftest.mjs
//
// Loads cellstocks-worker/worker.js -- the exact file Cloudflare deploys -- and drives its
// handleRequest() directly against an in-memory stand-in for KV and a stubbed GitHub API.
// No network, no Cloudflare account, no deploy. See that file's own header for why it is
// built only on fetch/Request/Response/crypto.subtle: those are what make this possible.

import { handleRequest, dataPathFor, xlsxPathFor, canWrite, fillTemplate } from "../cellstocks-worker/worker.js";

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

function makeGithubFetch({ failOn } = {}) {
  const calls = [];
  let blobN = 0;
  const fn = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method, body });
    const step = url.includes("/git/blobs") ? "blob"
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

// ==================================================================== requests & notifications
//
// The vial itself never moves through any of this (see worker.js's own comment on why) --
// these only exercise the bookkeeping: a request gets created and notifies the owner, only
// the owner (or an admin) may resolve it, resolving notifies the requester back, and a
// notification's id round-trips through GET /notifications into POST /notifications/:id/read
// (a real regression: the KV key and the value's own .id field used to be generated by two
// separate newId() calls that never matched).

async function twoMembers() {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "a" }, token), env);
  await handleRequest(req("POST", "/admin/users", { name: "Labmate", password: "b" }, token), env);
  const { body: umutLogin } = await login(env, "Umut", "a");
  const { body: labmateLogin } = await login(env, "Labmate", "b");
  return { env, adminToken: token, umutToken: umutLogin.token, labmateToken: labmateLogin.token };
}

await check("requesting an item notifies its owner, not the requester", async () => {
  const { env, umutToken, labmateToken } = await twoMembers();
  const res = await handleRequest(
    req("POST", "/requests", { toUser: "Labmate", itemName: "HEK293T p12", vialId: "v-1", note: "for a rescue" }, umutToken),
    env
  );
  const body = await res.json();
  if (res.status !== 201) return `expected 201, got ${res.status}: ${json(body)}`;
  if (body.request.status !== "pending" || body.request.fromUser !== "Umut" || body.request.toUser !== "Labmate") {
    return `unexpected request shape: ${json(body.request)}`;
  }
  const labmateNotifs = await (await handleRequest(req("GET", "/notifications", undefined, labmateToken), env)).json();
  if (labmateNotifs.notifications.length !== 1) return `Labmate got ${labmateNotifs.notifications.length} notifications, expected 1`;
  if (!/Umut is asking about HEK293T p12/.test(labmateNotifs.notifications[0].text)) return `unexpected text: ${labmateNotifs.notifications[0].text}`;
  // vialId and itemName ride on the notification itself, not just embedded in the text --
  // that's what lets the app act on approval (mark its own vial reserved) without a
  // second round-trip to look the request record back up.
  if (labmateNotifs.notifications[0].vialId !== "v-1" || labmateNotifs.notifications[0].itemName !== "HEK293T p12") {
    return `notification did not carry vialId/itemName: ${json(labmateNotifs.notifications[0])}`;
  }
  const umutNotifs = await (await handleRequest(req("GET", "/notifications", undefined, umutToken), env)).json();
  if (umutNotifs.notifications.length !== 0) return "the requester got notified about their own request";
  return null;
});

await check("requesting your own item, or a nonexistent user, is refused", async () => {
  const { env, umutToken } = await twoMembers();
  const own = await handleRequest(req("POST", "/requests", { toUser: "Umut", itemName: "x" }, umutToken), env);
  if (own.status !== 400) return `requesting your own item: expected 400, got ${own.status}`;
  const nobody = await handleRequest(req("POST", "/requests", { toUser: "NoSuchPerson", itemName: "x" }, umutToken), env);
  if (nobody.status !== 404) return `requesting from a nonexistent user: expected 404, got ${nobody.status}`;
  return null;
});

await check("only the item's owner (or an admin) may approve or deny a request", async () => {
  const { env, adminToken, umutToken } = await twoMembers();
  const createRes = await handleRequest(req("POST", "/requests", { toUser: "Labmate", itemName: "x" }, umutToken), env);
  const { request: reqRecord } = await createRes.json();

  const byRequester = await handleRequest(req("POST", `/requests/${reqRecord.id}/approve`, {}, umutToken), env);
  if (byRequester.status !== 403) return `the requester approving their own request: expected 403, got ${byRequester.status}`;

  const byAdmin = await handleRequest(req("POST", `/requests/${reqRecord.id}/deny`, {}, adminToken), env);
  if (byAdmin.status !== 200) return `admin denying: expected 200, got ${byAdmin.status}: ${json(await byAdmin.json())}`;
  return null;
});

await check("approving notifies the requester and resolving twice is refused", async () => {
  const { env, umutToken, labmateToken } = await twoMembers();
  const createRes = await handleRequest(req("POST", "/requests", { toUser: "Labmate", itemName: "HEK293T p12" }, umutToken), env);
  const { request: reqRecord } = await createRes.json();

  const approveRes = await handleRequest(req("POST", `/requests/${reqRecord.id}/approve`, {}, labmateToken), env);
  const approveBody = await approveRes.json();
  if (approveRes.status !== 200 || approveBody.request.status !== "approved") return `approve failed: ${json(approveBody)}`;

  const umutNotifs = await (await handleRequest(req("GET", "/notifications", undefined, umutToken), env)).json();
  if (!umutNotifs.notifications.some((n) => /Labmate approved your request/.test(n.text))) {
    return `the requester was not notified of the approval: ${json(umutNotifs.notifications)}`;
  }

  const again = await handleRequest(req("POST", `/requests/${reqRecord.id}/deny`, {}, labmateToken), env);
  if (again.status !== 409) return `resolving an already-resolved request: expected 409, got ${again.status}`;
  return null;
});

await check("GET /requests shows both sides of a request, to both people, and no one else's", async () => {
  const { env, umutToken, labmateToken, adminToken } = await twoMembers();
  await handleRequest(req("POST", "/requests", { toUser: "Labmate", itemName: "x" }, umutToken), env);

  const asRequester = await (await handleRequest(req("GET", "/requests", undefined, umutToken), env)).json();
  if (asRequester.requests.length !== 1) return `requester saw ${asRequester.requests.length} requests, expected 1`;

  const asOwner = await (await handleRequest(req("GET", "/requests", undefined, labmateToken), env)).json();
  if (asOwner.requests.length !== 1) return `owner saw ${asOwner.requests.length} requests, expected 1`;

  const asAdmin = await (await handleRequest(req("GET", "/requests", undefined, adminToken), env)).json();
  if (asAdmin.requests.length !== 0) return "an uninvolved account (even admin) saw a request that wasn't theirs";
  return null;
});

await check("a notification's id round-trips: GET /notifications -> POST /notifications/:id/read", async () => {
  const { env, umutToken, labmateToken } = await twoMembers();
  await handleRequest(req("POST", "/requests", { toUser: "Labmate", itemName: "x" }, umutToken), env);
  const before = await (await handleRequest(req("GET", "/notifications", undefined, labmateToken), env)).json();
  if (before.notifications.length !== 1 || before.notifications[0].read !== false) return `unexpected notifications: ${json(before)}`;
  const id = before.notifications[0].id;

  const readRes = await handleRequest(req("POST", `/notifications/${id}/read`, {}, labmateToken), env);
  if (readRes.status !== 200) return `marking read failed (id mismatch between KV key and stored .id?): ${readRes.status}`;

  const after = await (await handleRequest(req("GET", "/notifications", undefined, labmateToken), env)).json();
  if (after.notifications[0].id !== id || after.notifications[0].read !== true) return `unexpected notifications after marking read: ${json(after)}`;
  return null;
});

await check("a notification belongs to one account only -- another account cannot mark it read", async () => {
  const { env, umutToken, labmateToken } = await twoMembers();
  await handleRequest(req("POST", "/requests", { toUser: "Labmate", itemName: "x" }, umutToken), env);
  const { notifications } = await (await handleRequest(req("GET", "/notifications", undefined, labmateToken), env)).json();
  const res = await handleRequest(req("POST", `/notifications/${notifications[0].id}/read`, {}, umutToken), env);
  if (res.status !== 404) return `expected 404 (Umut has no notification by that id under their own prefix), got ${res.status}`;
  return null;
});

// ==================================================================== broadcasts
//
// "Only Umut has authority over lab-wide things" -- but his own everyday login is an
// ordinary member account, not the hidden admin one (he said he won't switch to admin
// unless he has to), so broadcast authority is a canBroadcast flag on the user record,
// true always for admin and settable on anyone else. These check that flag decides
// send-directly-vs-queued, that a queued one only notifies people who can act on it
// (not the whole lab, which would defeat the point of approval), that approving fans out
// to everyone but the sender, and that a hidden account never receives a broadcast --
// same "not really in the lab for notification purposes" rule as search-in-lab.

async function labWithBroadcaster() {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "a", canBroadcast: true }, token), env);
  await handleRequest(req("POST", "/admin/users", { name: "Labmate", password: "b" }, token), env);
  const { body: umutLogin } = await login(env, "Umut", "a");
  const { body: labmateLogin } = await login(env, "Labmate", "b");
  return { env, adminToken: token, umutToken: umutLogin.token, labmateToken: labmateLogin.token };
}

await check("a canBroadcast account's message sends immediately and reaches everyone else", async () => {
  const { env, umutToken, labmateToken } = await labWithBroadcaster();
  const res = await handleRequest(req("POST", "/broadcasts", { text: "Freezer 2 is being defrosted Friday" }, umutToken), env);
  const body = await res.json();
  if (res.status !== 201 || body.broadcast.status !== "sent") return `expected sent, got ${res.status}: ${json(body)}`;
  const labmateNotifs = await (await handleRequest(req("GET", "/notifications", undefined, labmateToken), env)).json();
  if (!labmateNotifs.notifications.some((n) => n.type === "broadcast" && /Freezer 2 is being defrosted/.test(n.text))) {
    return `Labmate did not get the broadcast: ${json(labmateNotifs.notifications)}`;
  }
  return null;
});

await check("an ordinary member's broadcast queues instead of sending, and only notifies who can approve it", async () => {
  const { env, umutToken, labmateToken } = await labWithBroadcaster();
  const res = await handleRequest(req("POST", "/broadcasts", { text: "Anyone seen my pipette?" }, labmateToken), env);
  const body = await res.json();
  if (res.status !== 201 || body.broadcast.status !== "pending") return `expected pending, got ${res.status}: ${json(body)}`;

  const umutNotifs = await (await handleRequest(req("GET", "/notifications", undefined, umutToken), env)).json();
  if (!umutNotifs.notifications.some((n) => n.type === "broadcast-pending")) return `Umut (canBroadcast) was not notified: ${json(umutNotifs.notifications)}`;

  // Nobody else should see it yet -- that's the entire point of queuing it. Labmate is
  // the sender so has none of their own to receive; check there is no visible-to-the-lab
  // broadcast notification anywhere yet by confirming Labmate's own inbox has nothing of
  // type "broadcast" (only "broadcast-pending" would ever go to an approver).
  const labmateNotifs = await (await handleRequest(req("GET", "/notifications", undefined, labmateToken), env)).json();
  if (labmateNotifs.notifications.some((n) => n.type === "broadcast")) return "the pending broadcast reached the lab before approval";
  return null;
});

await check("approving a pending broadcast sends it to the lab and tells the sender", async () => {
  const { env, umutToken, labmateToken } = await labWithBroadcaster();
  const createRes = await handleRequest(req("POST", "/broadcasts", { text: "Anyone seen my pipette?" }, labmateToken), env);
  const { broadcast } = await createRes.json();

  const approveRes = await handleRequest(req("POST", `/broadcasts/${broadcast.id}/approve`, {}, umutToken), env);
  const approveBody = await approveRes.json();
  if (approveRes.status !== 200 || approveBody.broadcast.status !== "sent") return `approve failed: ${json(approveBody)}`;

  const labmateNotifs = await (await handleRequest(req("GET", "/notifications", undefined, labmateToken), env)).json();
  if (!labmateNotifs.notifications.some((n) => n.type === "broadcast-resolved" && /was sent/.test(n.text))) {
    return `the sender was not told it went out: ${json(labmateNotifs.notifications)}`;
  }
  return null;
});

await check("denying a pending broadcast never reaches the lab, only tells the sender", async () => {
  const { env, umutToken, labmateToken } = await labWithBroadcaster();
  const createRes = await handleRequest(req("POST", "/broadcasts", { text: "Anyone seen my pipette?" }, labmateToken), env);
  const { broadcast } = await createRes.json();

  const denyRes = await handleRequest(req("POST", `/broadcasts/${broadcast.id}/deny`, {}, umutToken), env);
  if (denyRes.status !== 200) return `deny failed: ${denyRes.status}`;

  const labmateNotifs = await (await handleRequest(req("GET", "/notifications", undefined, labmateToken), env)).json();
  if (!labmateNotifs.notifications.some((n) => n.type === "broadcast-resolved" && /did not send/.test(n.text))) {
    return `the sender was not told it was denied: ${json(labmateNotifs.notifications)}`;
  }
  if (labmateNotifs.notifications.some((n) => n.type === "broadcast")) return "a denied broadcast still reached someone as if sent";
  return null;
});

await check("an ordinary member may not approve or deny a broadcast, even their own", async () => {
  const { env, labmateToken } = await labWithBroadcaster();
  const createRes = await handleRequest(req("POST", "/broadcasts", { text: "x" }, labmateToken), env);
  const { broadcast } = await createRes.json();
  const res = await handleRequest(req("POST", `/broadcasts/${broadcast.id}/approve`, {}, labmateToken), env);
  if (res.status !== 403) return `expected 403, got ${res.status}`;
  return null;
});

await check("resolving an already-resolved broadcast is refused", async () => {
  const { env, umutToken, labmateToken } = await labWithBroadcaster();
  const createRes = await handleRequest(req("POST", "/broadcasts", { text: "x" }, labmateToken), env);
  const { broadcast } = await createRes.json();
  await handleRequest(req("POST", `/broadcasts/${broadcast.id}/deny`, {}, umutToken), env);
  const again = await handleRequest(req("POST", `/broadcasts/${broadcast.id}/approve`, {}, umutToken), env);
  if (again.status !== 409) return `expected 409, got ${again.status}`;
  return null;
});

await check("GET /broadcasts: broadcast authority sees everything, an ordinary member sees only their own", async () => {
  const { env, umutToken, labmateToken } = await labWithBroadcaster();
  await handleRequest(req("POST", "/broadcasts", { text: "from umut" }, umutToken), env);
  await handleRequest(req("POST", "/broadcasts", { text: "from labmate" }, labmateToken), env);

  const asUmut = await (await handleRequest(req("GET", "/broadcasts", undefined, umutToken), env)).json();
  if (asUmut.broadcasts.length !== 2) return `broadcast authority saw ${asUmut.broadcasts.length}, expected 2 (everything)`;

  const asLabmate = await (await handleRequest(req("GET", "/broadcasts", undefined, labmateToken), env)).json();
  if (asLabmate.broadcasts.length !== 1 || asLabmate.broadcasts[0].fromUser !== "Labmate") {
    return `an ordinary member saw more than their own: ${json(asLabmate.broadcasts)}`;
  }
  return null;
});

await check("a hidden account never receives a broadcast", async () => {
  const { env, token: adminToken } = await adminEnvWithToken(); // admin itself is hidden:true
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "a", canBroadcast: true }, adminToken), env);
  const { body: umutLogin } = await login(env, "Umut", "a");
  await handleRequest(req("POST", "/broadcasts", { text: "hello lab" }, umutLogin.token), env);
  const adminNotifs = await (await handleRequest(req("GET", "/notifications", undefined, adminToken), env)).json();
  if (adminNotifs.notifications.some((n) => n.type === "broadcast")) return "the hidden admin account received a broadcast meant for the visible lab";
  return null;
});

// ==================================================================== message templates
//
// Every notification text in worker.js goes through a named template now, not an inline
// string -- Umut asked to be able to edit these ("X requests ABC vial from your box" and
// "many more") from the admin panel. These prove the default behavior is unchanged (the
// 42 checks above already do that implicitly, since none of them were touched by this),
// that an override actually changes what a real notification says, that only admin can
// read or write the config, and that an unknown key or a blanked-out override is handled
// the way the editor needs (rejected / reset-to-default) rather than silently corrupting
// the stored config.

await check("an admin can read the default and overridden message templates", async () => {
  const { env, token } = await adminEnvWithToken();
  const res = await handleRequest(req("GET", "/admin/messages", undefined, token), env);
  const body = await res.json();
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(body)}`;
  if (body.defaults.request !== "{fromUser} is asking about {itemName}{noteSuffix}") return `unexpected default: ${json(body.defaults.request)}`;
  if (json(body.overrides) !== "{}") return `expected no overrides yet, got ${json(body.overrides)}`;
  return null;
});

await check("a non-admin cannot read or write message templates", async () => {
  const { env, umutToken } = await twoMembers();
  const getRes = await handleRequest(req("GET", "/admin/messages", undefined, umutToken), env);
  if (getRes.status !== 403) return `GET: expected 403, got ${getRes.status}`;
  const putRes = await handleRequest(req("PUT", "/admin/messages", { messages: { request: "x" } }, umutToken), env);
  if (putRes.status !== 403) return `PUT: expected 403, got ${putRes.status}`;
  return null;
});

await check("an unknown message key is refused, not silently stored", async () => {
  const { env, token } = await adminEnvWithToken();
  const res = await handleRequest(req("PUT", "/admin/messages", { messages: { "not-a-real-key": "x" } }, token), env);
  if (res.status !== 400) return `expected 400, got ${res.status}`;
  return null;
});

await check("an override actually changes what a real request notification says", async () => {
  const { env, adminToken, umutToken, labmateToken } = await twoMembers();
  const putRes = await handleRequest(
    req("PUT", "/admin/messages", { messages: { request: "[custom] {fromUser} wants {itemName}" } }, adminToken),
    env
  );
  if (putRes.status !== 200) return `PUT failed: ${putRes.status}`;

  await handleRequest(req("POST", "/requests", { toUser: "Labmate", itemName: "HEK293T p12" }, umutToken), env);
  const { notifications } = await (await handleRequest(req("GET", "/notifications", undefined, labmateToken), env)).json();
  if (notifications[0].text !== "[custom] Umut wants HEK293T p12") return `unexpected text: ${json(notifications[0])}`;
  return null;
});

await check("blanking out an override resets that message to its default", async () => {
  const { env, adminToken, umutToken, labmateToken } = await twoMembers();
  await handleRequest(req("PUT", "/admin/messages", { messages: { request: "[custom] {fromUser} wants {itemName}" } }, adminToken), env);
  const resetRes = await handleRequest(req("PUT", "/admin/messages", { messages: { request: "" } }, adminToken), env);
  const resetBody = await resetRes.json();
  if (Object.prototype.hasOwnProperty.call(resetBody.overrides, "request")) return `override was not cleared: ${json(resetBody.overrides)}`;

  await handleRequest(req("POST", "/requests", { toUser: "Labmate", itemName: "HEK293T p12" }, umutToken), env);
  const { notifications } = await (await handleRequest(req("GET", "/notifications", undefined, labmateToken), env)).json();
  if (notifications[0].text !== "Umut is asking about HEK293T p12") return `expected the default text back, got ${json(notifications[0].text)}`;
  return null;
});

await check("fillTemplate leaves an unknown {placeholder} untouched rather than dropping it", () => {
  const out = fillTemplate("hello {name}, {mystery}", { name: "world" });
  if (out !== "hello world, {mystery}") return `got ${json(out)}`;
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

// ==================================================================== summary

if (failures.length) {
  console.error(`${failures.length} of ${passed + failures.length} cell stocks worker checks failed:\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}\n`));
  process.exit(1);
} else {
  console.log(`All ${passed} cell stocks worker checks passed.`);
}
