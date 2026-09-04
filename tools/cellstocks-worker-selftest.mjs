// Proves the Cell Stocks worker actually enforces what it claims to, instead of trusting
// that it does -- same reasoning as tools/cellstocks-selftest.mjs for the engine.
//
// Run:  node tools/cellstocks-worker-selftest.mjs
//
// Loads cellstocks-worker/worker.js -- the exact file Cloudflare deploys -- and drives its
// handleRequest() directly against an in-memory stand-in for KV and a stubbed GitHub API.
// No network, no Cloudflare account, no deploy. See that file's own header for why it is
// built only on fetch/Request/Response/crypto.subtle: those are what make this possible.

import { handleRequest, dataPathFor, canWrite } from "../cellstocks-worker/worker.js";

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
// githubPutFile() in worker.js calls `(env.fetch || fetch)(url, opts)`, so tests inject a
// fake here instead of hitting the network. It records every call so tests can assert on
// exactly what would have been committed.

function makeGithubFetch({ fail } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (fail) {
      return { ok: false, status: fail, json: async () => ({ message: "stubbed failure" }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ commit: { sha: "deadbeef" }, content: { sha: "cafef00d", path: calls[calls.length - 1].url } })
    };
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

// ==================================================================== /write endpoint

await check("a member can write their own data file, and the commit reaches GitHub with the right path", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "lab-password" }, token), env);
  const { body: memberLogin } = await login(env, "Umut", "lab-password");
  const res = await handleRequest(
    req("POST", "/write", { path: dataPathFor("Umut"), content: '{"vials":[]}', message: "test write" }, memberLogin.token),
    env
  );
  const body = await res.json();
  if (res.status !== 200) return `write failed: ${json(body)}`;
  const call = env.fetch.calls[env.fetch.calls.length - 1];
  if (!call.url.endsWith(`/contents/${dataPathFor("Umut")}`)) return `unexpected GitHub URL: ${call.url}`;
  if (call.body.branch !== "main") return `unexpected branch: ${json(call.body)}`;
  return null;
});

await check("a member cannot write another member's data file", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "a" }, token), env);
  await handleRequest(req("POST", "/admin/users", { name: "Labmate", password: "b" }, token), env);
  const { body: memberLogin } = await login(env, "Labmate", "b");
  const res = await handleRequest(
    req("POST", "/write", { path: dataPathFor("Umut"), content: "{}", message: "sneaky" }, memberLogin.token),
    env
  );
  if (res.status !== 403) return `expected 403, got ${res.status}`;
  if (env.fetch.calls.length) return "a GitHub call was made despite the ownership check failing";
  return null;
});

await check("an unauthenticated write is rejected before any ownership check runs", async () => {
  const env = makeEnv();
  const res = await handleRequest(req("POST", "/write", { path: "cellstocks/data/x.json", content: "{}", message: "m" }), env);
  if (res.status !== 401) return `expected 401, got ${res.status}`;
  return null;
});

await check("an admin can write into another user's data file", async () => {
  const { env, token } = await adminEnvWithToken();
  await handleRequest(req("POST", "/admin/users", { name: "Umut", password: "a" }, token), env);
  const res = await handleRequest(
    req("POST", "/write", { path: dataPathFor("Umut"), content: '{"vials":[]}', message: "admin override" }, token),
    env
  );
  if (res.status !== 200) return `expected 200, got ${res.status}: ${json(await res.json())}`;
  return null;
});

await check("a GitHub failure surfaces as an error response, not a silent 200", async () => {
  const env = makeEnv({ fetch: makeGithubFetch({ fail: 422 }) });
  await bootstrapAdmin(env, "admin", "correct-password");
  const { body: adminLogin } = await login(env, "admin", "correct-password");
  const res = await handleRequest(
    req("POST", "/write", { path: dataPathFor("admin"), content: "{}", message: "m" }, adminLogin.token),
    env
  );
  if (res.status < 400) return `expected an error status, got ${res.status}`;
  return null;
});

// ==================================================================== CORS / misc

await check("an OPTIONS preflight gets CORS headers and no body", async () => {
  const env = makeEnv();
  const res = await handleRequest(new Request("https://worker.example/write", { method: "OPTIONS" }), env);
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
