// Backend for the Reminders app. It exists for one reason: iOS Safari cannot schedule a
// notification by itself, so something outside the phone has to send the push when a task
// is due. It also serves the app (the [assets] binding), so page and API share one origin.
//
// State is one KV value: { sub, tasks, sent }. `sub` is the phone's push subscription,
// `tasks` the title/time/interval of every open task, `sent` the last push time per task.
// Completing a task in the app removes it here on the next sync -- completion itself never
// happens on the server.
import E from "../todo/engine.js";
import { sendPush } from "./webpush.mjs";

const KEY = "state";
const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function authorised(request, env) {
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const want = env.AUTH_TOKEN || "";
  if (!want || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function load(env) {
  const raw = await env.TODO_KV.get(KEY, "json");
  return raw || { sub: null, tasks: [], sent: {} };
}

function pushConfig(env) {
  return { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC, privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK) };
}

export async function handleRequest(request, env, fetchImpl) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

  if (url.pathname === "/api/config" && request.method === "GET") {
    return json({ publicKey: env.VAPID_PUBLIC || null });
  }
  if (!authorised(request, env)) return json({ error: "Unauthorised" }, 401);

  if (url.pathname === "/api/state" && request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }
    if (!Array.isArray(body.tasks)) return json({ error: "tasks must be a list" }, 400);
    const prev = await load(env);
    const merged = E.mergeServerTasks(body.tasks, prev.sent);
    const sub = body.sub && typeof body.sub.endpoint === "string" ? body.sub : prev.sub;
    await env.TODO_KV.put(KEY, JSON.stringify({ sub, tasks: merged.tasks, sent: merged.sent }));
    return json({ ok: true, tasks: merged.tasks.length, subscribed: !!sub });
  }

  if (url.pathname === "/api/test" && request.method === "POST") {
    const st = await load(env);
    if (!st.sub) return json({ error: "No push subscription yet. Enable notifications in the app first." }, 409);
    const r = await sendPush(st.sub, pushConfig(env), fetchImpl, Math.floor(Date.now() / 1000));
    return json({ pushStatus: r.status }, r.status >= 200 && r.status < 300 ? 200 : 502);
  }
  return json({ error: "Not found" }, 404);
}

// One pass of the cron: push once if anything is due, remember when.
export async function tick(env, now, fetchImpl) {
  const st = await load(env);
  if (!st.sub) return { sent: 0, reason: "no-subscription" };
  const due = E.dueToSend(st.tasks, st.sent, now);
  if (!due.length) return { sent: 0, reason: "nothing-due" };
  const r = await sendPush(st.sub, pushConfig(env), fetchImpl, Math.floor(now / 1000));
  if (r.gone) {
    // The phone no longer accepts pushes (app removed, permission revoked). Forget it so the
    // app shows "not subscribed" instead of silently reminding nobody.
    st.sub = null;
    await env.TODO_KV.put(KEY, JSON.stringify(st));
    return { sent: 0, reason: "subscription-gone", status: r.status };
  }
  if (r.status < 200 || r.status >= 300) return { sent: 0, reason: "push-failed", status: r.status };
  due.forEach((t) => { st.sent[t.id] = now; });
  await env.TODO_KV.put(KEY, JSON.stringify(st));
  return { sent: due.length, status: r.status };
}

export default {
  fetch: (request, env) => handleRequest(request, env),
  scheduled: (event, env, ctx) => { ctx.waitUntil(tick(env, Date.now())); }
};
