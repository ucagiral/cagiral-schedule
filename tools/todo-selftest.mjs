// Proves the Reminders rules hold. Run: node tools/todo-selftest.mjs
// Loads the same engine.js the app and the Worker load, plus the Worker itself against a
// fake KV and a fake push service. No network, no browser.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const E = createRequire(import.meta.url)(join(ROOT, "todo", "engine.js"));
const { b64u, fromB64u, vapidJwt, sendPush } = await import(join(ROOT, "todo-worker", "webpush.mjs"));
const W = await import(join(ROOT, "todo-worker", "worker.mjs"));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL: " + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + " (got " + JSON.stringify(a) + ")");
const MIN = 60000;

// ---- makeTask
ok(E.makeTask({ title: "   ", id: "a", seq: 1 }).error, "blank title refused");
let t = E.makeTask({ title: "  Buy   milk ", id: "a", seq: 1, now: 5 }).task;
eq([t.title, t.due, t.everyMin], ["Buy milk", null, null], "untimed task has no interval");
t = E.makeTask({ title: "x", id: "b", seq: 2, due: 1000, everyMin: "" }).task;
eq(t.everyMin, 10, "timed task defaults to 10 min");
ok(E.makeTask({ title: "x", due: 1, everyMin: 0 }).error, "interval 0 refused");
ok(E.makeTask({ title: "x", due: 1, everyMin: 1.5 }).error, "fractional interval refused");
ok(E.makeTask({ title: "x", due: 1, everyMin: 1441 }).error, "interval over a day refused");
ok(!E.makeTask({ title: "x", due: 1, everyMin: 1 }).error, "interval 1 accepted");
ok(E.makeTask({ title: "x", due: "abc" }).error, "bad time refused");

// ---- sort: timed first (soonest first), then insertion order
const mk = (id, due, seq) => ({ id, due, everyMin: due === null ? null : 10, seq });
eq(E.sortOpen([mk("u1", null, 1), mk("late", 500, 2), mk("u2", null, 3), mk("soon", 100, 4), mk("tie", 100, 0)]).map((x) => x.id),
  ["tie", "soon", "late", "u1", "u2"], "timed first, ties and untimed by insertion");

// ---- dueToSend
const tk = [mk("a", 1000, 1), mk("n", null, 2)];
eq(E.dueToSend(tk, {}, 999).length, 0, "not due before its time");
eq(E.dueToSend(tk, {}, 1000).map((x) => x.id), ["a"], "due at its time");
eq(E.dueToSend(tk, { a: 1000 }, 1000 + 9 * MIN + 59999).length, 0, "not repeated inside the interval");
eq(E.dueToSend(tk, { a: 1000 }, 1000 + 10 * MIN).length, 1, "repeated after the interval");
eq(E.dueToSend(tk, {}, 1e12).map((x) => x.id), ["a"], "untimed task is never pushed");

// ---- hold to confirm
ok(!E.holdComplete(0, E.HOLD_MS - 1), "a tap does not complete");
ok(E.holdComplete(0, E.HOLD_MS), "a full hold completes");
eq(E.holdProgress(null, 99), 0, "no hold, no progress");

// ---- notification text
eq(E.notificationText([mk("a", 1, 1)]).title, "1 task due", "singular title");
const many = [1, 2, 3, 4, 5].map((i) => ({ ...mk("i" + i, 1, i), title: "T" + i }));
eq(E.notificationText(many).body, "T1\nT2\nT3\n+2 more", "overflow line");

// ---- server merge forgets completed tasks
const m = E.mergeServerTasks([mk("a", 1, 1)], { a: 7, gone: 9 });
eq(m.sent, { a: 7 }, "sent time kept for open tasks only");

// ---- VAPID JWT verifies against the public key
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const endpoint = "https://web.push.apple.com/abc123";
const jwt = await vapidJwt(endpoint, "mailto:a@b.co", privJwk, 1000);
const [h, c, s] = jwt.split(".");
const claims = JSON.parse(new TextDecoder().decode(fromB64u(c)));
eq([claims.aud, claims.sub, claims.exp], ["https://web.push.apple.com", "mailto:a@b.co", 1000 + 43200], "JWT claims");
ok(fromB64u(s).length === 64, "signature is raw r||s");
ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, fromB64u(s), new TextEncoder().encode(h + "." + c)), "signature verifies");
ok(pubRaw.length === 65 && pubRaw[0] === 4, "public key is an uncompressed point");

// ---- worker against fakes
const store = new Map();
const env = {
  TODO_KV: { get: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null), put: async (k, v) => { store.set(k, v); } },
  AUTH_TOKEN: "secret-token", VAPID_PUBLIC: b64u(pubRaw), VAPID_SUBJECT: "mailto:a@b.co",
  VAPID_PRIVATE_JWK: JSON.stringify(privJwk), ASSETS: { fetch: async () => new Response("asset") }
};
let pushes = [], pushStatus = 201;
const fakeFetch = async (url, init) => { pushes.push({ url, init }); return { status: pushStatus }; };
const call = (path, method, body, token) => W.handleRequest(new Request("https://x" + path, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: token === undefined ? {} : { authorization: "Bearer " + token }
}), env, fakeFetch);

eq(await (await call("/index.html", "GET")).text(), "asset", "non-API goes to assets");
eq((await call("/api/config", "GET")).status, 200, "config is public");
eq((await call("/api/state", "PUT", { tasks: [] }, "wrong")).status, 401, "wrong token refused");
eq((await call("/api/state", "PUT", { tasks: [] })).status, 401, "missing token refused");
eq((await call("/api/state", "PUT", { tasks: "x" }, "secret-token")).status, 400, "bad body refused");
eq((await call("/api/test", "POST", null, "secret-token")).status, 409, "test push without subscription refused");

const sub = { endpoint, keys: { p256dh: "x", auth: "y" } };
await call("/api/state", "PUT", { sub, tasks: [{ id: "a", title: "A", due: 1000, everyMin: 5 }, { id: "n", title: "N", due: null, everyMin: null }] }, "secret-token");
eq((await W.tick(env, 999, fakeFetch)).reason, "nothing-due", "tick: nothing before due");
eq((await W.tick(env, 1000, fakeFetch)).sent, 1, "tick: pushes at due time");
ok(/^vapid t=.+, k=.+$/.test(pushes[0].init.headers.Authorization), "push carries VAPID header");
eq((await W.tick(env, 1000 + 4 * MIN, fakeFetch)).reason, "nothing-due", "tick: silent inside interval");
eq((await W.tick(env, 1000 + 5 * MIN, fakeFetch)).sent, 1, "tick: repeats after interval");
// completing in the app removes it server-side, and the repeat stops
await call("/api/state", "PUT", { tasks: [{ id: "n", title: "N", due: null, everyMin: null }] }, "secret-token");
eq((await W.tick(env, 1000 + 99 * MIN, fakeFetch)).reason, "nothing-due", "completed task is not pushed again");
ok(JSON.parse(store.get("state")).sub, "subscription survives a sync that omits it");
// rejected subscription is dropped, not retried forever
await call("/api/state", "PUT", { tasks: [{ id: "b", title: "B", due: 1, everyMin: 1 }] }, "secret-token");
pushStatus = 410;
eq((await W.tick(env, 5 * MIN, fakeFetch)).reason, "subscription-gone", "410 drops the subscription");
eq(JSON.parse(store.get("state")).sub, null, "subscription cleared");
pushStatus = 500;
await call("/api/state", "PUT", { sub, tasks: [{ id: "b", title: "B", due: 1, everyMin: 1 }] }, "secret-token");
eq((await W.tick(env, 5 * MIN, fakeFetch)).reason, "push-failed", "5xx reported");
eq(JSON.parse(store.get("state")).sent.b, undefined, "failed push is not recorded as sent, so the next minute retries");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
