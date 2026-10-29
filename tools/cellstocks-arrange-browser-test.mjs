// Drives the Add screen's "arrange tube by tube" preview and the fall-back to a member's own
// not-yet-placed boxes, in a real browser: the part of freezing that
// tools/cellstocks-selftest.mjs (pure engine) cannot see -- dragging, selecting, the dialog.
//
// Run:  node tools/cellstocks-arrange-browser-test.mjs
//
// GitHub and the Worker are stood in for with page.route, as in cellstocks-browser-test.mjs.
// Same playwright-missing policy as the other browser suites.

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
    console.error("::error::playwright is missing, so the arrange browser checks did not run.");
    process.exit(1);
  }
  console.log("playwright is not installed — skipping the arrange browser test.");
  process.exit(0);
}

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? "\n    " + detail : ""}`);
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
const server = await new Promise((r) => {
  const s = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  s.listen(8833, () => r(s));
});
const browser = await chromium.launch();
const consoleErrors = [];

const box = (id, owner, rows, cols, extra) => Object.assign({ id, name: id.toUpperCase(), isBox: true, owner, rows, cols, scheme: "grid", note: "", archived: false }, extra || {});
const vial = (id, name, boxId, position) => ({ id, name, status: "stored", flags: [], passage: "p3", passageKind: "absolute", passageNumber: 3,
  frozenRaw: "2026-01-01", frozenOn: "2026-01-01", notes: "", lineId: name, location: { path: [], boxId, position } });
const member = (vials) => ({ lines: [], vials, withdrawals: [], rules: {}, settings: {} });

// One scenario: a lab tree and umut's own file; returns what the app committed.
async function scenario(tree, vials, run, ctxOpts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 900, height: 1000 } }, ctxOpts || {}));
  const committed = { files: {}, count: 0 };
  let currentTree = tree;
  await ctx.addInitScript((cfg) => {
    localStorage.setItem("cst_cfg", cfg);
    localStorage.setItem("cst_worker_url", "https://fake-worker.example");
    localStorage.setItem("cst_worker_token", "tok");
    localStorage.setItem("cst_worker_user", JSON.stringify({ name: "umut", role: "member", hidden: false }));
    localStorage.setItem("cst_device", "the phone");
  }, JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" }));
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("response", (r) => { if (r.status() === 404) consoleErrors.push("404 " + r.url()); });
  await page.route("https://raw.githubusercontent.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("cellstocks/lab-storage.json")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentTree) });
    if (url.includes("cellstocks/lab-rules.json")) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    if (url.includes("cellstocks/data/umut.json")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(committed.files["cellstocks/data/umut.json"] || member(vials)) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.route("https://api.github.com/repos/test-owner/test-repo/contents/cellstocks/data", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ name: "umut.json", type: "file" }]) }));
  await page.route("https://api.github.com/repos/test-owner/test-repo/contents/cellstocks/data/*", (route) => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    if (file !== "umut.json") return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "Not Found" }) });
    const v = committed.files["cellstocks/data/umut.json"] || member(vials);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ content: Buffer.from(JSON.stringify(v)).toString("base64") }) });
  });
  await page.route("https://fake-worker.example/**", (route) => {
    const req = route.request();
    if (new URL(req.url()).pathname === "/commit" && req.method() === "POST") {
      for (const f of JSON.parse(req.postData()).files) {
        if (f.path.endsWith(".json")) committed.files[f.path] = JSON.parse(f.content);
        if (f.path === "cellstocks/lab-storage.json") currentTree = JSON.parse(f.content);
      }
      committed.count++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commit: "sha" }) });
    }
    if (new URL(req.url()).pathname === "/types") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ types: [{ name: "Cell", attributes: [] }] }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
  });
  await page.goto("http://localhost:8833/cellstocks/");
  await page.waitForFunction(() => document.getElementById("status").textContent === "Ready", { timeout: 10000 });
  await page.click('nav button[data-screen="freeze"]');
  try { await run(page, committed); }
  finally { await ctx.close(); }
}

async function saved(committed) {
  for (let i = 0; i < 80 && !committed.files["cellstocks/data/umut.json"]; i++) await new Promise((r) => setTimeout(r, 50));
  return committed.files["cellstocks/data/umut.json"];
}

async function dragSlot(page, fromSel, toSel) {
  const a = await (await page.$(fromSel)).boundingBox();
  const b = await (await page.$(toSel)).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}
const slotSel = (boxId, pos) => `#dlgBody [data-box="${boxId}"][data-pos="${pos}"]`;
const dlgText = (page) => page.evaluate(() => document.getElementById("dlgBody").textContent);

const TREE = () => ({ labName: "CAA Lab Stocks", labIcon: "", children: [
  { id: "f1", name: "Freezer 1", note: "-80", children: [
    { id: "s1", name: "Shelf 1", children: [box("b1", "umut", 4, 5), box("b2", "umut", 3, 3), box("bx", "baris", 3, 3)] }
  ] }
], unplaced: [] });
const HEKS = () => [vial("v1", "HEK293T", "b1", "A1"), vial("v2", "HEK293T", "b1", "A2"), vial("v3", "HEK293T", "b1", "A3")];

try {
  // ---- 1. a single tube dragged next to another cell, mixing the row on purpose ----
  await scenario(TREE(), HEKS(), async (page, committed) => {
    await page.fill("#fzName", "HepG2 CuAdapt");
    await page.evaluate(() => { document.getElementById("fzCount").value = "3"; document.getElementById("fzCount").dispatchEvent(new Event("input")); });
    await page.waitForSelector("#fzArrange");
    const autoText = await page.evaluate(() => document.getElementById("fzPlanCard").textContent);
    check("the automatic plan still starts a fresh row for another cell", /B1/.test(autoText) && !/A4/.test(autoText), autoText);
    await page.click("#fzArrange");
    await page.waitForSelector("#dlgBody .newtube");
    check("the preview shows each new tube", (await page.$$("#dlgBody .newtube")).length === 3);
    check("the preview shows the box as it will look, existing tubes included", (await page.$$("#dlgBody .slot.taken")).length === 6);
    check("only the owner's own boxes are offered", /B1/.test(await dlgText(page)) && /B2/.test(await dlgText(page)) && !/BX/.test(await dlgText(page)));
    const target = await page.$eval(".newtube", (e) => e.dataset.pos);
    await dragSlot(page, `${slotSel("b1", target)}`, slotSel("b1", "A4"));
    await page.waitForFunction(() => document.querySelector('#dlgBody [data-pos="A4"]')?.classList.contains("newtube"));
    check("dragging one tube puts it exactly there", true);
    check("mixing two cells in a row is reported, not refused", /now holds .*HEK293T.*HepG2|now holds .*HepG2.*HEK293T/.test(await dlgText(page)), await dlgText(page));
    await page.click("#arrUse");
    await page.waitForFunction(() => !document.getElementById("dlg").open);
    const card = await page.evaluate(() => document.getElementById("fzPlanCard").textContent);
    check("the arrangement is what the Add screen now shows", /A4/.test(card) && /Arranged by you|where you arranged/.test(card), card);
    await page.click("#fzGo");
    const file = await saved(committed);
    const hep = (file ? file.vials : []).filter((v) => /HepG2/.test(v.name));
    check("three tubes were saved", hep.length === 3, JSON.stringify(hep.map((v) => v.location)));
    check("the dragged tube is in A4 of box 1", hep.some((v) => v.location.boxId === "b1" && v.location.position === "A4"), JSON.stringify(hep.map((v) => v.location)));
    check("no two tubes share a slot", new Set((file ? file.vials : []).map((v) => v.location.boxId + v.location.position)).size === (file ? file.vials.length : -1));
    check("every tube saved is in the owner's own box", hep.every((v) => ["b1", "b2"].includes(v.location.boxId)));
  });

  // ---- 2. several tubes selected and moved together into another box ----
  await scenario(TREE(), HEKS(), async (page, committed) => {
    await page.fill("#fzName", "Du145");
    await page.evaluate(() => { document.getElementById("fzCount").value = "3"; document.getElementById("fzCount").dispatchEvent(new Event("input")); });
    await page.waitForSelector("#fzArrange");
    await page.click("#fzArrange");
    await page.waitForSelector("#dlgBody .newtube");
    await page.click("text=Select all tubes");
    check("select all marks every new tube", (await page.$$("#dlgBody .newtube.sel")).length === 3);
    const posOf = (b) => page.$$eval(`#dlgBody [data-box="${b}"].newtube`, (els) => els.map((e) => e.dataset.pos).sort().join());
    const start = await posOf("b1");
    await page.click('#dlgBody [data-tab="b2"]');
    await page.waitForSelector(slotSel("b2", "B1"));
    await page.click(slotSel("b2", "B1"));   // tap a free slot with a selection: move them there together
    await page.waitForSelector('#dlgBody [data-box="b2"].newtube');
    check("the group moves together and keeps its shape", start === "B1,B2,B3" && (await posOf("b2")) === "B1,B2,B3", start + " -> " + await posOf("b2"));
    await page.click("#arrUse");
    await page.click("#fzGo");
    const file = await saved(committed);
    const du = (file ? file.vials : []).filter((v) => v.name === "Du145");
    check("all three were saved in box 2", du.length === 3 && du.every((v) => v.location.boxId === "b2"), JSON.stringify(du.map((v) => v.location)));
  });

  // ---- 2b. the shape does not fit: the group fills free slots in reading order ----
  await scenario(TREE(), HEKS(), async (page) => {
    await page.fill("#fzName", "Du145");
    await page.evaluate(() => { document.getElementById("fzCount").value = "3"; document.getElementById("fzCount").dispatchEvent(new Event("input")); });
    await page.waitForSelector("#fzArrange");
    await page.click("#fzArrange");
    await page.waitForSelector("#dlgBody .newtube");
    await page.click("text=Select all tubes");
    await page.click(slotSel("b1", "A4"));   // three tubes kept apart as they are would run off the edge of row A
    await page.waitForFunction(() => !!document.querySelector('#dlgBody [data-pos="A4"].newtube'));
    const got = await page.$$eval("#dlgBody .newtube", (els) => els.map((e) => e.dataset.pos).sort().join());
    check("when the shape does not fit the group fills free slots in reading order", got === "A4,A5,B1", got);
  });

  // ---- 2c. on a phone: tap a tube, tap a free slot ----
  await scenario(TREE(), HEKS(), async (page, committed) => {
    await page.fill("#fzName", "Du145");
    await page.waitForSelector("#fzArrange");
    await page.tap("#fzArrange");
    await page.waitForSelector("#dlgBody .newtube");
    const tube = await page.$eval(".newtube", (e) => e.dataset.pos);
    await page.tap(slotSel("b1", tube));
    await page.waitForSelector("#dlgBody .newtube.sel");
    await page.tap(slotSel("b1", "C3"));
    await page.waitForFunction(() => !!document.querySelector('#dlgBody [data-pos="C3"].newtube'));
    check("tapping a tube and then a free slot moves it on a touch screen", true);
    await page.tap("#arrUse");
    await page.tap("#fzGo");
    const file = await saved(committed);
    check("the tapped slot is what was saved", (file ? file.vials : []).some((v) => v.name === "Du145" && v.location.position === "C3"));
  }, { hasTouch: true, viewport: { width: 400, height: 800 } });

  // ---- 3. a drop that cannot fit says so and changes nothing ----
  await scenario(TREE(), HEKS(), async (page) => {
    await page.fill("#fzName", "Du145");
    await page.evaluate(() => { document.getElementById("fzCount").value = "2"; document.getElementById("fzCount").dispatchEvent(new Event("input")); });
    await page.waitForSelector("#fzArrange");
    await page.click("#fzArrange");
    await page.waitForSelector("#dlgBody .newtube");
    const before = await page.$$eval("#dlgBody .newtube", (els) => els.map((e) => e.dataset.pos).join());
    await page.click("text=Select all tubes");
    await page.click('#dlgBody [data-tab="b2"]');
    await page.waitForSelector(slotSel("b2", "C3"));
    await page.click(slotSel("b2", "C3"));   // only one slot left from here for two tubes
    await page.waitForFunction(() => /not enough free room/i.test(document.getElementById("dlgBody").textContent));
    await page.click('#dlgBody [data-tab="b1"]');
    await page.waitForSelector("#dlgBody .newtube");
    const after = await page.$$eval("#dlgBody .newtube", (els) => els.map((e) => e.dataset.pos).join());
    check("a move that does not fit leaves the tubes where they were", before === after, before + " vs " + after);
  });

  // ---- 4. everything placed is full: the owner's not-yet-placed box takes the tube ----
  await scenario({ labName: "CAA Lab Stocks", labIcon: "", children: [
      { id: "f1", name: "Freezer 1", note: "-80", children: [{ id: "s1", name: "Shelf 1", children: [box("b1", "umut", 1, 2)] }] }
    ], unplaced: [box("w1", "umut", 2, 2), box("w2", "baris", 2, 2)] },
    [vial("v1", "HEK293T", "b1", "A1"), vial("v2", "HEK293T", "b1", "A2")], async (page, committed) => {
    await page.fill("#fzName", "Du145");
    await page.waitForFunction(() => /Not placed yet/.test(document.getElementById("fzPlanCard").textContent));
    const plan = await page.evaluate(() => document.getElementById("fzPlanCard").textContent);
    check("with every placed box full the plan uses the owner's own not-yet-placed box", /W1/.test(plan) && !/W2/.test(plan), plan);
    await page.click("#fzGo");
    const file = await saved(committed);
    const du = (file ? file.vials : []).find((v) => v.name === "Du145");
    check("the tube was saved in that box", du && du.location.boxId === "w1", JSON.stringify(du && du.location));
  });

  // ---- 5. no room anywhere: one tap makes an own box (not placed) and the plan finds it ----
  await scenario({ labName: "CAA Lab Stocks", labIcon: "", children: [
      { id: "f1", name: "Freezer 1", note: "-80", children: [{ id: "s1", name: "Shelf 1", children: [box("b1", "umut", 1, 1)] }] }
    ], unplaced: [] },
    [vial("v1", "HEK293T", "b1", "A1")], async (page, committed) => {
    await page.fill("#fzName", "Du145");
    await page.waitForSelector("#fzNewBox");
    check("when nothing fits, Add offers a new box instead of a dead end", !(await page.$eval("#fzGo", (b) => !b.disabled)));
    await page.click("#fzNewBox");
    await page.waitForFunction(() => /umut box 1/i.test(document.getElementById("fzPlanCard").textContent), { timeout: 8000 });
    const tree = committed.files["cellstocks/lab-storage.json"];
    check("the new box is the owner's and waits under Not placed yet",
      tree && tree.unplaced && tree.unplaced.length === 1 && tree.unplaced[0].owner === "umut", JSON.stringify(tree && tree.unplaced));
    await page.click("#fzGo");
    for (let i = 0; i < 80 && !((committed.files["cellstocks/data/umut.json"] || {}).vials || []).some((v) => v.name === "Du145"); i++) await page.waitForTimeout(50);
    const file = committed.files["cellstocks/data/umut.json"];
    const du = (file ? file.vials : []).find((v) => v.name === "Du145");
    check("the tube was saved in the new box", du && /umut-box-1/i.test(du.location.boxId), JSON.stringify(du && du.location));
  });
} catch (err) {
  check("the arrange scenarios ran to the end", false, String(err && err.stack || err));
} finally {
  await browser.close();
  server.close();
}

check("no console errors", consoleErrors.length === 0, consoleErrors.join("\n    "));

if (fails.length) {
  console.error(`${fails.length} arrange browser check(s) failed:\n`);
  fails.forEach((f) => console.error(`  ✗ ${f}\n`));
  process.exit(1);
}
console.log(`All ${pass} arrange browser checks passed.`);
