// Drives the Notes page (cellstocks/notes.html) in a real browser: a member's own notes
// (add, type, search, delete, autosave through /commit, reload), the read-only list staff
// wrote for them, and an admin writing a note for somebody else.
//
// Run:  node tools/cellstocks-notes-browser-test.mjs
//
// The Worker is stood in for by a few lines of node holding a map path -> file content.
// Same playwright-missing policy as the other browser suites.

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "cellstocks");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  for (const guess of ["/opt/node22/lib/node_modules/playwright/index.mjs",
                       "/usr/lib/node_modules/playwright/index.mjs",
                       "/usr/local/lib/node_modules/playwright/index.mjs"]) {
    try { ({ chromium } = await import(guess)); break; } catch { /* keep looking */ }
  }
}
if (!chromium) {
  if (process.env.CI) {
    console.error("::error::playwright is missing, so the Notes browser checks did not run.");
    process.exit(1);
  }
  console.log("playwright is not installed — skipping the Notes browser test.");
  process.exit(0);
}

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? "\n    " + detail : ""}`);
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
const repo = {
  "cellstocks/notes/umut.from.json": JSON.stringify({ notes: [{ id: "s1", title: "Freezer", text: "Box 3 is yours", by: "admin", updatedAt: "2026-10-12T10:00:00Z" }] })
};
let role = "member", name = "Umut";   // who the fake session is

const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const read = (p) => (repo[p] ? JSON.parse(repo[p]) : null);

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const path = decodeURIComponent(url.pathname);
  const staff = role === "admin" || role === "pi";
  if (path === "/notes" && req.method === "GET") {
    const target = url.searchParams.get("for");
    if (target) return staff ? send(res, 200, { staff: read(`cellstocks/notes/${target.toLowerCase()}.from.json`) }) : send(res, 403, { error: "staff only" });
    return send(res, 200, { mine: read(`cellstocks/notes/${name.toLowerCase()}.json`), staff: read(`cellstocks/notes/${name.toLowerCase()}.from.json`) });
  }
  if (path === "/notes/people") return staff ? send(res, 200, { people: [{ name: "Umut", role: "member" }] }) : send(res, 403, { error: "staff only" });
  if (path === "/commit" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const f = JSON.parse(raw).files[0];
      const own = f.path === `cellstocks/notes/${name.toLowerCase()}.json`;
      const theirs = /^cellstocks\/notes\/[a-z0-9_-]+\.from\.json$/.test(f.path) && staff;
      if (!own && !theirs) return send(res, 403, { error: "may not write " + f.path });
      repo[f.path] = f.content;
      send(res, 200, { commit: "c" });
    });
    return;
  }
  const file = join(ROOT, path === "/" ? "index.html" : path);
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(8799, r));

const browser = await chromium.launch();
const errors = [];

async function open(asRole, asName) {
  role = asRole; name = asName;
  const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
  await ctx.addInitScript(([r, n]) => {
    localStorage.setItem("cst_worker_token", "tok");
    localStorage.setItem("cst_worker_user", JSON.stringify({ name: n, role: r }));
  }, [asRole, asName]);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto("http://localhost:8799/notes.html");
  await page.waitForFunction(() => window.__notes && window.__notes.pads.length > 0);
  return page;
}

try {
  let page = await open("member", "Umut");
  check("the staff-written note is shown read-only", (await page.locator("#fromStaff .note").count()) === 1 &&
    (await page.locator("#fromStaff textarea").count()) === 0);
  check("a member has no 'write for someone else' section", await page.locator("#forOthersSec").isHidden());

  await page.click("#mine button.primary");
  await page.click("#mine button.primary");
  check("+ Not adds notes", (await page.locator("#mine .note").count()) === 2);
  await page.locator("#mine .note").nth(0).locator("input").fill("qPCR");
  await page.locator("#mine .note").nth(0).locator("textarea").fill("primers in box 2");
  await page.waitForFunction(() => /Kaydedildi/.test(document.querySelector("#mine .status").textContent), null, { timeout: 8000 });
  const saved = JSON.parse(repo["cellstocks/notes/umut.json"]);
  check("autosave commits the member's own file", saved.notes.length === 2 && saved.notes[0].title === "qPCR" && saved.notes[0].by === "Umut", JSON.stringify(saved));

  await page.fill("#mine input[type=search]", "primers");
  check("search filters by every word", (await page.locator("#mine .note").count()) === 1);
  await page.fill("#mine input[type=search]", "");
  await page.locator("#mine .note").nth(1).locator("button").click();
  await page.waitForFunction(() => /Kaydedildi/.test(document.querySelector("#mine .status").textContent), null, { timeout: 8000 });
  check("delete removes the note and saves", JSON.parse(repo["cellstocks/notes/umut.json"]).notes.length === 1);

  await page.reload();
  await page.waitForFunction(() => window.__notes && window.__notes.pads.length > 0);
  check("a reload shows the saved note", (await page.locator("#mine .note").count()) === 1 &&
    (await page.locator("#mine .note input").inputValue()) === "qPCR");
  await page.context().close();

  page = await open("admin", "admin");
  check("admin sees the write-for-someone section", await page.locator("#forOthersSec").isVisible());
  await page.waitForFunction(() => window.__notes.pads.length === 2);
  check("admin sees the existing note written for Umut", (await page.locator("#forOthers .note").count()) === 1);
  await page.click("#forOthers button.primary");
  await page.locator("#forOthers .note").nth(0).locator("textarea").fill("Please label your boxes");
  await page.waitForFunction(() => /Kaydedildi/.test(document.querySelector("#forOthers .status").textContent), null, { timeout: 8000 });
  const staffFile = JSON.parse(repo["cellstocks/notes/umut.from.json"]);
  check("admin's note lands in the staff file, signed", staffFile.notes.length === 2 && staffFile.notes[0].by === "admin" && staffFile.notes[0].text === "Please label your boxes", JSON.stringify(staffFile));
  check("admin did not touch Umut's own file", JSON.parse(repo["cellstocks/notes/umut.json"]).notes.length === 1);
  await page.context().close();
} finally {
  await browser.close();
  server.close();
}

check("no console errors", errors.length === 0, errors.join("\n    "));
if (fails.length) {
  console.error(`${fails.length} Notes browser check(s) failed:\n  ✗ ${fails.join("\n  ✗ ")}`);
  process.exit(1);
}
console.log(`All ${pass} Notes browser checks passed.`);
