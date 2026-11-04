// Drives the schedule app's daily voice assistant in a real Chromium, with GitHub and the
// Worker both stubbed: sign-in gating, proposals, apply-only-what-is-ticked, and the save.
// Run: node tools/schedule-voice-browser-test.mjs   (needs playwright; fails, never skips, without it)
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { createRequire } from "node:module";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(import.meta.url)("playwright");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/json", ".md": "text/plain" };
const srv = http.createServer((q, r) => {
  const u = q.url.split("?")[0];
  const p = join(ROOT, u === "/" ? "index.html" : u);
  if (!p.startsWith(ROOT) || !existsSync(p)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "content-type": TYPES[extname(p)] || "text/plain" }); r.end(readFileSync(p));
}).listen(0);
const base = "http://127.0.0.1:" + srv.address().port + "/";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL: " + m); } };

const d = new Date(); const pad = (n) => String(n).padStart(2, "0");
const iso = (x) => x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate());
const today = iso(d), tomorrow = iso(new Date(d.getTime() + 864e5));
const doc = { events: [
  { id: "e-pcr", date: today, start: "10:00", end: "11:00", title: "PCR", category: "experiment", type: "active", status: "pending", notes: "" },
  { id: "e-other", date: today, start: "14:00", end: "15:00", title: "Meeting", category: "meeting", type: "active", status: "pending", notes: "" }
], _groups: {}, _meta: {} };
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const browser = await chromium.launch(process.env.CI ? { args: ["--no-sandbox"] } : {});
const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 420, height: 900 } });
const page = await ctx.newPage();
const puts = [];
await page.addInitScript(() => {
  localStorage.setItem("cs_cfg", JSON.stringify({ owner: "o", repo: "r", branch: "main" }));
  localStorage.setItem("cs_token", "fake");
});
const gh = (route) => {
  const req = route.request();
  if (req.method() === "PUT") { puts.push(JSON.parse(req.postData())); return route.fulfill({ json: { content: { sha: "s2" } } }); }
  return route.fulfill({ json: { sha: "s1", content: b64(JSON.stringify(doc)) } });
};
await page.route("https://api.github.com/**", (r) => r.request().url().includes("claudeAgent.json") ? gh(r) : r.fulfill({ status: 404, body: "{}" }));
await page.route("https://raw.githubusercontent.com/**", (r) => r.fulfill({ body: JSON.stringify(doc) }));
const worker = "https://w.example";
let aiBody = null;
await page.route(worker + "/**", async (route) => {
  const req = route.request(), path = new URL(req.url()).pathname;
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  if (path === "/login") {
    const b = JSON.parse(req.postData());
    if (b.password === "bad") return route.fulfill({ status: 401, headers: cors, json: { error: "wrong name or password" } });
    return route.fulfill({ headers: cors, json: { token: "tok-" + b.name, user: { name: b.name }, ai: b.name === "umut" } });
  }
  if (path === "/logout") return route.fulfill({ headers: cors, json: { ok: true } });
  if (path === "/ai/daily") {
    aiBody = JSON.parse(req.postData());
    return route.fulfill({ headers: cors, json: {
      done: ["e-pcr"],
      add: [{ title: "Order primers", date: tomorrow, start: "10:00" }, { title: "Call supplier", date: tomorrow }],
      reply: "Tamam." } });
  }
  return route.fulfill({ status: 404, headers: cors, json: {} });
});

await page.goto(base);
await page.waitForSelector("#status");
await page.waitForTimeout(800);

ok(!(await page.isVisible("#btnVoice")), "the mic button must be hidden before sign-in");

const signIn = async (name, pass) => {
  await page.click("#btnConnect");
  await page.evaluate(() => { document.getElementById("aiSetup").open = true; });
  await page.fill("#aiName", name); await page.fill("#aiPass", pass); await page.fill("#aiUrl", worker);
  await page.click("#btnAiSignIn");
  await page.waitForTimeout(400);
};
await signIn("baris", "x");
ok(!(await page.isVisible("#btnVoice")), "an account without the assistant must not get the mic button");
ok(/not enabled/.test(await page.textContent("#aiSetupStatus")), "the refusal must be explained");
ok(await page.evaluate(() => !localStorage.getItem("cs_ai_token")), "no session may be kept for that account");
await page.fill("#aiPass", "bad"); await page.click("#btnAiSignIn"); await page.waitForTimeout(300);
ok(/wrong name/.test(await page.textContent("#aiSetupStatus")), "a wrong password must say so");
await page.fill("#aiName", "umut"); await page.fill("#aiPass", "pw"); await page.click("#btnAiSignIn"); await page.waitForTimeout(400);
await page.click("#btnTokenCancel"); await page.waitForTimeout(400);
ok(await page.isVisible("#btnVoice"), "the mic button must appear for an enabled account");

await page.click("#btnVoice"); await page.waitForTimeout(300);
await page.fill("#voiceText", "PCR yaptim, yarin primer siparisi verecegim, tedarikciyi arayacagim");
await page.click("#btnVoiceSend"); await page.waitForSelector("#voiceResult label");
ok(aiBody && aiBody.today === today && aiBody.events.some((e) => e.id === "e-pcr"), "the open events must be sent with today's date");
ok((await page.$$("#voiceResult input[type=checkbox]")).length === 3, "one row per proposal");
ok(puts.length === 0, "nothing may be saved before the person confirms");
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
// untick the second addition: only what stays ticked is applied
await page.uncheck("#voiceResult input[data-add='1']");
await page.click("#btnVoiceApply");
await page.waitForTimeout(1800);
ok(puts.length >= 1, "applying must save");
const saved = puts.length ? JSON.parse(Buffer.from(puts[puts.length - 1].content, "base64").toString("utf8")) : { events: [] };
ok(saved.events.find((e) => e.id === "e-pcr")?.status === "done", "the ticked event must be done");
ok(saved.events.find((e) => e.id === "e-other")?.status === "pending", "an event not named must be untouched");
const primers = saved.events.find((e) => e.title === "Order primers");
ok(primers && primers.date === tomorrow && primers.start === "10:00" && primers.end > "10:00" && primers.type === "active", "a timed item becomes an active event with an end");
ok(!saved.events.some((e) => e.title === "Call supplier"), "an unticked item must not be added");

await ctx.close(); await browser.close(); srv.close();
if (fail) { console.error(`${fail} failed, ${pass} passed`); process.exit(1); }
console.log(`All ${pass} schedule voice browser checks passed.`);
