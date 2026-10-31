// Drives the Reminders page in a real Chromium: adding, ordering, and that "Done" needs a hold.
// Run: node tools/todo-browser-test.mjs   (needs playwright; fails, never skips, without it)
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "todo");
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/json" };
const srv = http.createServer((q, r) => {
  const p = join(ROOT, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]);
  if (!p.startsWith(ROOT) || !existsSync(p)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "content-type": TYPES[extname(p)] || "text/plain" }); r.end(readFileSync(p));
}).listen(0);
const base = "http://127.0.0.1:" + srv.address().port + "/";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL: " + m); } };
const browser = await chromium.launch(process.env.CI ? { args: ["--no-sandbox"] } : {});
const page = await (await browser.newContext({ serviceWorkers: "block" })).newPage();
await page.goto(base);

async function add(title, due) {
  await page.fill("#title", title);
  if (due) await page.fill("#due", due);
  await page.click("#add button[type=submit]");
}
await add("untimed first", "");
await add("later", "2099-01-02T10:00");
await add("sooner", "2099-01-01T10:00");
let titles = await page.$$eval(".task .title", (e) => e.map((x) => x.textContent));
ok(JSON.stringify(titles) === JSON.stringify(["sooner", "later", "untimed first"]), "timed first, then insertion order: " + titles);
ok(await page.isHidden("#everyBox") === true, "interval hidden without a time");
await page.fill("#due", "2099-01-03T10:00");
ok(await page.isVisible("#everyBox"), "interval shown once a time is set");
await page.fill("#title", "");
await page.fill("#title", "x"); await page.fill("#every", "0");
await page.click("#add button[type=submit]");
ok((await page.$$(".task")).length === 3 && !(await page.evaluate(() => document.getElementById("add").checkValidity())), "interval 0 is refused and nothing is added");

// A tap on Done opens the dialog and removes nothing.
await page.locator(".task button", { hasText: "Done" }).first().click();
ok(await page.isVisible("#dlg"), "Done opens a confirmation");
const box = await page.locator("#hold").boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx, cy); await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up();
ok((await page.$$(".task")).length === 3, "a short press completes nothing");
await page.mouse.move(cx, cy); await page.mouse.down(); await page.waitForTimeout(2900); await page.mouse.up();
titles = await page.$$eval(".task .title", (e) => e.map((x) => x.textContent));
ok(titles.length === 2 && !titles.includes("sooner"), "a full hold completes: " + titles);
await page.reload();
ok((await page.$$(".task")).length === 2, "state survives a reload");

// Daily summary times are validated before anything is saved.
await page.click("#settings summary");
await page.fill("#sumTimes", "25:00");
await page.click("#sumSave");
ok((await page.textContent("#setMsg")).includes("not a time"), "bad summary time is explained");
await page.fill("#sumTimes", "08:15-21:00/5");
await page.click("#sumSave");
await page.reload();
ok((await page.inputValue("#sumTimes")) === "08:15-21:00/5", "summary times survive a reload");

console.log(pass + " passed, " + fail + " failed");
await browser.close(); srv.close();
process.exit(fail ? 1 : 0);
