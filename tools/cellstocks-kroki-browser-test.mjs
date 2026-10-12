// Drives the Kroki page (cellstocks/kroki.html) in a real browser: adding boxes, typing,
// dragging, linking by dragging a port onto another box, undo, saving through the Worker's
// /commit and loading again through GET /kroki.
//
// Run:  node tools/cellstocks-kroki-browser-test.mjs
//
// The Worker is stood in for by a few lines of node: the page is served from cellstocks/
// at the origin's root (as the real Worker's assets binding does), GET /kroki returns what
// the last /commit wrote, and a /commit for anyone else's board is refused like the real
// canWrite() would. Same playwright-missing policy as the other browser suites.

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
    console.error("::error::playwright is missing, so the Kroki browser checks did not run.");
    process.exit(1);
  }
  console.log("playwright is not installed — skipping the Kroki browser test.");
  process.exit(0);
}

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? "\n    " + detail : ""}`);
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

let stored = null;          // what the fake repository holds for Umut's board
let commits = 0;
let failNextCommit = false;

function serve(port) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url.split("?")[0]);
    if (path === "/kroki" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ board: stored }));
      return;
    }
    if (path === "/commit" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw);
        if (failNextCommit) {
          failNextCommit = false;
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "github is down" }));
          return;
        }
        const f = body.files[0];
        if (f.path !== "cellstocks/kroki/umut.json") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "umut may not write " + f.path }));
          return;
        }
        stored = JSON.parse(f.content);
        commits++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ commit: "c" + commits }));
      });
      return;
    }
    const file = join(ROOT, path === "/" ? "index.html" : path);
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

const server = await serve(8798);
const browser = await chromium.launch();
const errors = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("cst_worker_token", "tok");
      localStorage.setItem("cst_worker_user", JSON.stringify({ name: "Umut", role: "member" }));
      sessionStorage.setItem("seeded", "1");
    }
  });
  const page = await ctx.newPage();
  // The 502 is the refused save this test provokes on purpose.
  page.on("console", (m) => { if (m.type() === "error" && !/status of 502/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  const url = "http://localhost:8798/kroki.html";
  await page.goto(url);
  await page.waitForFunction(() => window.__kroki && window.__kroki.loaded);

  check("an empty board shows the hint and no boxes",
    (await page.locator(".box").count()) === 0 && await page.locator("#empty").isVisible());

  await page.click("#add");
  await page.click("#add");
  check("+ Kutu adds boxes", (await page.locator(".box").count()) === 2);

  const first = page.locator(".box").nth(0), second = page.locator(".box").nth(1);
  await first.locator("input").fill("Login");
  await first.locator("textarea").fill("needs a token");
  await second.locator("input").fill("Backend");
  check("typing lands in the board",
    await page.evaluate(() => window.__kroki.board.boxes.map((b) => b.title + "|" + b.text).join(",")) === "Login|needs a token,Backend|");

  // Move the second box well clear of the first, by its title bar.
  const bar = second.locator(".bar");
  const bb = await bar.boundingBox();
  await page.mouse.move(bb.x + bb.width - 14, bb.y + 4);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width + 190, bb.y + 154, { steps: 6 });
  await page.mouse.up();
  const moved = await page.evaluate(() => window.__kroki.board.boxes[1]);
  check("dragging a box by its bar moves it", moved.x > 200 && moved.y > 100, JSON.stringify(moved));

  // Link: drag the first box's port onto the second box.
  const port = await first.locator(".port").boundingBox();
  const target = await second.boundingBox();
  await page.mouse.move(port.x + 9, port.y + 9);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  check("dragging a port onto another box links the two",
    await page.evaluate(() => window.__kroki.board.links.length) === 1);
  check("the new line is drawn and selected for a label",
    (await page.locator("#lines line.vis").count()) === 1 && await page.locator("#linkbar.on").count() === 1);

  await page.fill("#linkLabel", "uses");
  check("a label can be put on the line",
    await page.evaluate(() => window.__kroki.board.links[0].label) === "uses" &&
    (await page.locator("#lines text").textContent()) === "uses");

  // Save, then reload: what comes back is what was drawn.
  await page.evaluate(() => window.__kroki.save());
  await page.waitForFunction(() => !window.__kroki.dirty);
  check("save commits exactly one file, to the member's own path", commits === 1 && stored.boxes.length === 2 && stored.links.length === 1);

  await page.reload();
  await page.waitForFunction(() => window.__kroki && window.__kroki.loaded);
  check("reloading shows the saved boxes and line",
    (await page.locator(".box").count()) === 2 && (await page.locator("#lines line.vis").count()) === 1);
  check("titles survive the round trip",
    (await page.locator(".box input").nth(0).inputValue()) === "Login" && (await page.locator(".box textarea").nth(0).inputValue()) === "needs a token");

  // Deleting a box takes its line; undo brings both back.
  await page.locator(".box").nth(1).locator(".bar button").click();
  check("deleting a box removes its line too",
    (await page.locator(".box").count()) === 1 && (await page.locator("#lines line.vis").count()) === 0);
  await page.click("#undo");
  check("undo restores the box and the line",
    (await page.locator(".box").count()) === 2 && (await page.locator("#lines line.vis").count()) === 1);

  // A failed save keeps the work on this device and the next load does not replace it.
  failNextCommit = true;
  await page.click("#add");
  await page.evaluate(() => window.__kroki.save());
  await page.waitForFunction(() => /Kaydedilemedi/.test(document.getElementById("status").textContent));
  check("a refused save says so and stays dirty", await page.evaluate(() => window.__kroki.dirty));
  await page.evaluate(() => { window.onbeforeunload = null; });
  page.on("dialog", (d) => d.accept());
  await page.reload();
  await page.waitForFunction(() => window.__kroki && window.__kroki.loaded);
  check("unsaved work survives a reload instead of being replaced by the saved copy",
    (await page.locator(".box").count()) === 3, "boxes: " + (await page.locator(".box").count()));
  await page.evaluate(() => window.__kroki.save());
  await page.waitForFunction(() => !window.__kroki.dirty);
  check("and is saved on the next attempt", stored.boxes.length === 3);

  // Not signed in: no board, a pointer to the app.
  const anon = await browser.newContext();
  const ap = await anon.newPage();
  await ap.goto(url);
  check("without a login the page asks for one and shows no board",
    (await ap.locator("#gate").textContent()).includes("giriş") && !(await ap.locator("#viewport").isVisible()));

  check("no console errors", errors.length === 0, errors.join("\n    "));
} finally {
  await browser.close();
  server.close();
}

if (fails.length) {
  console.error(`${fails.length} of ${pass + fails.length} Kroki browser checks failed:\n`);
  fails.forEach((f) => console.error("  ✗ " + f + "\n"));
  process.exit(1);
}
console.log(`All ${pass} Kroki browser checks passed.`);
