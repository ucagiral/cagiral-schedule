// Drives the Storage map in a real browser: the four temperature cards, each freezer as a
// figure of its own, the drawn freezer with a metal rack per shelf, and what a member may do
// on it (add a freezer or a shelf, add / move / rename / delete a box of their own) -- run
// against the Worker's real tree rules (checkTreeChange), so a button that offers something
// the Worker would refuse fails here, not in the lab.
//
// Run:  node tools/cellstocks-storage-browser-test.mjs
//
// GitHub and the Worker are stood in for with page.route. Same playwright-missing policy as
// the other browser suites.

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { checkTreeChange } from "../cellstocks-worker/worker.js";

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
    console.error("::error::playwright is missing, so the storage browser checks did not run.");
    process.exit(1);
  }
  console.log("playwright is not installed — skipping the storage browser test.");
  process.exit(0);
}

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? "\n    " + detail : ""}`);
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png" };
const server = await new Promise((r) => {
  const s = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  s.listen(8834, () => r(s));
});
const browser = await chromium.launch();
const consoleErrors = [];

const box = (id, owner, extra) => Object.assign({ id, name: id.toUpperCase(), isBox: true, owner, rows: 4, cols: 5, scheme: "grid", note: "", archived: false }, extra || {});
const layer = (id, name, children, extra) => Object.assign({ id, name, note: "", children: children || [] }, extra || {});
const vial = (id, name, boxId, position, path) => ({ id, name, status: "stored", flags: [], passage: "p3", passageKind: "absolute", passageNumber: 3,
  frozenRaw: "2026-01-01", frozenOn: "2026-01-01", notes: "", lineId: name, location: { path: path || [], boxId, position } });
const file = (vials) => ({ lines: [], vials, withdrawals: [], rules: {}, settings: {} });

const TREE = () => ({ labName: "CAA Lab Stocks", labIcon: "", children: [
  layer("f1", "Freezer 1", [
    layer("sh1", "Shelf 1", [box("mine", "umut"), box("theirs", "baris")]),
    layer("sh2", "Shelf 2", [box("mine2", "umut")]),
    layer("sh3", "Shelf 3", [])
  ], { note: "-80°C · corridor" }),
  layer("f2", "Freezer 2", [layer("s", "Shelf A", [])], { note: "-80 (room left)" }),
  layer("fr", "Fridge 1", [], { note: "-20" }),
  layer("ln", "Liquid Nitrogen", [], { note: "-196°C" })
], unplaced: [box("loose", "umut"), box("loose2", "baris")] });

// One scenario as one account. The fake /commit applies the Worker's own tree rules.
async function scenario(role, tree, own, run, ctxOpts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1000, height: 1100 }, serviceWorkers: "block" }, ctxOpts || {}));
  const st = { tree, files: {}, commits: [], uploads: [] };
  const name = role === "admin" ? "admin" : role === "pi" ? "boss" : "umut";
  await ctx.addInitScript(([cfg, user]) => {
    localStorage.setItem("cst_cfg", cfg);
    localStorage.setItem("cst_worker_url", "https://fake-worker.example");
    localStorage.setItem("cst_worker_token", "tok");
    localStorage.setItem("cst_worker_user", user);
    localStorage.setItem("cst_device", "the phone");
  }, [JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" }), JSON.stringify({ name, role, hidden: false })]);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("response", (r) => { if (r.status() === 404) consoleErrors.push("404 " + r.url()); });
  const ownJson = () => st.files["cellstocks/data/umut.json"] || file(own);
  const baris = file([vial("vb", "Du145", "theirs", "A1")]);
  await page.route("https://raw.githubusercontent.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("cellstocks/lab-storage.json")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(st.tree) });
    if (url.includes("cellstocks/lab-rules.json")) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    if (url.includes("cellstocks/data/umut.json")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ownJson()) });
    if (url.includes("cellstocks/data/baris.json")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(baris) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.route("https://api.github.com/repos/test-owner/test-repo/contents/**", (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace("/repos/test-owner/test-repo/contents/", ""));
    const b64 = (v) => JSON.stringify({ content: Buffer.from(JSON.stringify(v)).toString("base64") });
    if (path === "cellstocks/data") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ name: "umut.json", type: "file" }, { name: "baris.json", type: "file" }]) });
    if (path === "cellstocks/lab-storage.json") return route.fulfill({ status: 200, contentType: "application/json", body: b64(st.tree) });
    if (path === "cellstocks/data/umut.json") return route.fulfill({ status: 200, contentType: "application/json", body: b64(ownJson()) });
    if (path === "cellstocks/data/boss.json" || path === "cellstocks/data/admin.json") return route.fulfill({ status: 200, contentType: "application/json", body: b64(file([])) });
    if (path === "cellstocks/data/baris.json") return route.fulfill({ status: 200, contentType: "application/json", body: b64(baris) });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "Not Found" }) });
  });
  await page.route("https://fake-worker.example/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/commit" && req.method() === "POST") {
      const files = JSON.parse(req.postData()).files;
      const tf = files.find((f) => f.path === "cellstocks/lab-storage.json");
      if (tf) {
        const reason = checkTreeChange({ name, role }, st.tree, JSON.parse(tf.content));
        if (reason) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: `${name} may not make that change to the freezer: ${reason}.` }) });
        // a box may only leave the tree once its owner's file no longer holds stored vials in it
        const gone = [];
        const had = new Set(); const walk = (l) => (l || []).forEach((n) => { had.add(n.id); if (!n.isBox) walk(n.children); });
        const now = new Set(); const walk2 = (l) => (l || []).forEach((n) => { now.add(n.id); if (!n.isBox) walk2(n.children); });
        walk(st.tree.children); walk(st.tree.unplaced); walk2(JSON.parse(tf.content).children); walk2(JSON.parse(tf.content).unplaced);
        for (const id of had) if (!now.has(id)) gone.push(id);
        const od = files.find((f) => f.path === "cellstocks/data/umut.json");
        const vials = (od ? JSON.parse(od.content) : ownJson()).vials || [];
        for (const id of gone) if (vials.some((v) => v.status !== "withdrawn" && v.location && v.location.boxId === id)) {
          return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "still holds vials" }) });
        }
      }
      for (const f of files) {
        if (f.path.endsWith(".json") && !f.base64) st.files[f.path] = JSON.parse(f.content);
        if (f.path === "cellstocks/lab-storage.json") st.tree = JSON.parse(f.content);
        if (f.path.startsWith("cellstocks/icons/")) st.uploads.push(f.path);
      }
      st.commits.push(files.map((f) => f.path));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commit: "sha" }) });
    }
    if (path === "/admin/users") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ users: [{ name: "umut", role: "member" }, { name: "baris", role: "member" }] }) });
    if (path === "/types") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ types: [{ name: "Cell", attributes: [] }] }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
  });
  // uploaded pictures live in the repository, not on this static server
  await page.route("**/cellstocks/icons/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.goto("http://localhost:8834/cellstocks/");
  await page.waitForFunction(() => document.getElementById("status").textContent === "Ready", { timeout: 10000 });
  try { await run(page, st); }
  finally { await ctx.close(); }
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || "", sel);
const waitCommit = async (st, n) => { for (let i = 0; i < 100 && st.commits.length < n; i++) await new Promise((r) => setTimeout(r, 50)); };
const find = (tree, id) => { let out = null; const walk = (l, parent) => (l || []).forEach((n) => { if (n.id === id) out = { node: n, parent }; if (!n.isBox) walk(n.children, n.id); }); walk(tree.children, null); walk(tree.unplaced, "unplaced"); return out; };
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, name + ".png"), fullPage: true }); };
const openStorage = async (page) => { await page.click('nav button[data-screen="storage"]'); await page.waitForSelector("#storageBody .mapFig, #storageBody .mapPicture"); };

try {
  // ------------------------------------------------------------------ the cards
  await scenario("member", TREE(), [vial("v1", "HEK293T", "mine", "A1", [{ id: "f1", name: "Freezer 1" }, { id: "sh1", name: "Shelf 1" }])], async (page, st) => {
    await openStorage(page);
    await shot(page, "1-cards");
    const cards = await page.$$eval("#storageBody .mapTempCard", (els) => els.map((e) => e.dataset.temp + ":" + e.querySelector(".mapTitle").textContent));
    check("the first screen is four cards: +4, −20, −80, liquid nitrogen, in that order",
      cards.join("|") === "p4:+4 °C|m20:−20 °C|m80:−80 °C|ln2:Liquid nitrogen", cards.join("|"));
    const subs = await page.$$eval("#storageBody .mapTempCard", (els) => els.map((e) => e.querySelector(".sub").textContent));
    check("a card says how many units are under it, and that +4 has none", /2 units/.test(subs[2]) && /1 unit/.test(subs[1]) && /nothing here yet/.test(subs[0]), subs.join("|"));
    const imgs = await page.$$eval("#storageBody .mapTempCard .mapImg", (els) => els.map((e) => getComputedStyle(e).backgroundImage));
    check("each card has its own stock photo", imgs.every((i) => /stock\/temp-/.test(i)) && new Set(imgs).size === 4, imgs.join("|"));
    check("a member sees no way to change a card's picture", (await page.$$("#storageBody .mapCorner")).length === 0);
    check("boxes with no place are listed, with Move… only on the member's own",
      (await page.$$("#storageBody .mapUnplaced .mapBox")).length === 2 && (await page.$$("#storageBody .mapUnplaced .mapMove")).length === 1);

    // ---- one temperature: every freezer as its own figure
    await page.click('#storageBody [data-temp="m80"]');
    await page.waitForSelector("#storageBody .mapUnits");
    await shot(page, "2-units");
    const units = await page.$$eval("#storageBody .mapUnits .mapFig[data-id]", (els) => els.map((e) => e.querySelector(".mapTitle").textContent));
    check("−80 shows each freezer separately, by name", units.join("|") === "Freezer 1|Freezer 2", units.join("|"));
    check("a freezer figure has a picture and says what is in it",
      /stock\/temp-m80/.test(await page.$eval('.mapFig[data-id="f1"] .mapImg', (e) => getComputedStyle(e).backgroundImage)) && /3 shelves/.test(await text(page, '.mapFig[data-id="f1"] .sub')));
    check("a member may add a freezer", !!(await page.$("#mapAddUnit")));

    // ---- one freezer: drawn, with a rack per shelf
    await page.click('#storageBody .mapFig[data-id="f1"]');
    await page.waitForSelector("#storageBody .mapPicture");
    await shot(page, "3-freezer");
    check("the freezer is drawn with one metal rack for each of its 3 shelves", (await page.$$("#storageBody .mapPicture .mapRack")).length === 3);
    const labels = await page.$$eval("#storageBody .mapPicture .rackLabel", (els) => els.map((e) => e.textContent));
    check("each rack is labelled with its shelf and how many boxes it holds", /Shelf 1 · 2 boxes/.test(labels[0]) && /Shelf 3$/.test(labels[2]), labels.join("|"));

    // ---- a shelf: its boxes
    await page.click('#storageBody .mapRack[data-id="sh1"]');
    await page.waitForSelector("#storageBody .mapBoxes");
    await shot(page, "4-shelf");
    const boxes = await page.$$eval("#storageBody .mapBoxes .mapBox", (els) => els.map((e) => e.dataset.id));
    check("a shelf lists its boxes", boxes.join() === "mine,theirs", boxes.join());
    check("a member can Move or edit a box of their own, not a lab-mate's",
      !!(await page.$('.mapBox[data-id="mine"] .mapMove')) && !(await page.$('.mapBox[data-id="theirs"] .mapMove')));
    check("the box card shows how full it is", /1\/20 full/.test(await text(page, '.mapBox[data-id="mine"]')), await text(page, '.mapBox[data-id="mine"]'));

    // ---- move the member's own box to another shelf, through the dialog
    await page.click('.mapBox[data-id="mine"] .mapMove');
    await page.selectOption("#moveWhere", "sh3");
    await page.click("#moveGo");
    await waitCommit(st, 1);
    check("moving a box puts it on the other shelf in the lab's tree", find(st.tree, "mine").parent === "sh3", JSON.stringify(find(st.tree, "mine")));
    const refreshed = st.files["cellstocks/data/umut.json"];
    check("the vial in it remembers its new route in the same commit",
      refreshed && refreshed.vials[0].location.path.map((p) => p.id).join() === "f1,sh3", JSON.stringify(refreshed && refreshed.vials[0].location));
    check("nothing else in the tree changed", find(st.tree, "theirs").parent === "sh1" && find(st.tree, "mine2").parent === "sh2");
  });

  // ------------------------------------------------------------------ adding
  await scenario("member", TREE(), [], async (page, st) => {
    await openStorage(page);
    await page.click('#storageBody [data-temp="m80"]');
    await page.click("#mapAddUnit");
    await page.waitForSelector("#nodeTemp");
    check("adding a freezer from the −80 card starts on −80", (await page.$eval("#nodeTemp", (e) => e.value)) === "m80");
    await page.fill("#dlgBody input[placeholder='Shelf 1']", "Freezer 3");
    await page.click("#dlgFoot .primary");
    await waitCommit(st, 1);
    const f3 = find(st.tree, "freezer-3");
    check("a member can add a freezer, filed under its temperature", f3 && f3.node.temp === "m80" && f3.parent === null, JSON.stringify(f3));
    check("the new freezer appears on the −80 card without a reload", await page.waitForSelector('#storageBody .mapFig[data-id="freezer-3"]', { timeout: 5000 }).then(() => true, () => false));

    await page.click('#storageBody .mapFig[data-id="f1"]');
    await page.click("#mapAddShelf");
    await page.waitForSelector("#dlgBody input");
    check("'Add a shelf' does not offer to make a box", await page.$eval("#nodeIsBox", (e) => e.closest("label").hidden));
    await page.fill("#dlgBody input[placeholder='Shelf 1']", "Shelf 4");
    await page.click("#dlgFoot .primary");
    await waitCommit(st, 2);
    check("a member can add a shelf to any freezer", find(st.tree, "shelf-4") && find(st.tree, "shelf-4").parent === "f1");

    await page.click('#storageBody .mapRack[data-id="shelf-4"]');
    await page.click("#mapAddBox");
    await page.fill("#dlgBody input[placeholder='Shelf 1']", "My new box");
    const ownerHidden = await page.$eval("#nodeOwnerField", (e) => e.hidden);
    check("a member's new box is theirs: no owner to choose, no common box", ownerHidden && await page.$eval("#nodeCommon", (e) => e.closest("label").hidden));
    await page.click("#dlgFoot .primary");
    await waitCommit(st, 3);
    const nb = find(st.tree, "my-new-box");
    check("the new box is the member's and sits on that shelf", nb && nb.node.owner === "umut" && nb.parent === "shelf-4", JSON.stringify(nb));
  });

  // ------------------------------------------------------------------ own box: rename, resize, delete
  await scenario("member", TREE(), [vial("v1", "HEK293T", "mine", "A1", [{ id: "f1", name: "Freezer 1" }, { id: "sh1", name: "Shelf 1" }]), vial("v2", "HEK293T", "mine", "D5")], async (page, st) => {
    await openStorage(page);
    await page.click('#storageBody [data-temp="m80"]');
    await page.click('#storageBody .mapFig[data-id="f1"]');
    await page.click('#storageBody .mapRack[data-id="sh1"]');
    await page.click('.mapBox[data-id="mine"] button[title="Rename, resize or delete"]');
    await page.waitForSelector("#nodeIsBox");
    check("a member editing their box sees no owner picker, no common tick and no image upload",
      await page.$eval("#nodeOwnerField", (e) => e.hidden) && await page.$eval("#nodeCommon", (e) => e.closest("label").hidden) &&
      !(await page.$$eval("#dlgBody button", (bs) => bs.some((b) => /Upload an image/.test(b.textContent)))));
    // shrinking under its tubes is refused with the reason
    const nums = await page.$$("#dlgBody input[type=number]");
    await nums[0].fill("2"); await nums[1].fill("2");
    await page.click("#dlgFoot .primary");
    await page.waitForFunction(() => /outside the box/i.test(document.getElementById("dlgBody").textContent));
    check("a box cannot be shrunk under its tubes", st.commits.length === 0);
    await nums[0].fill("4"); await nums[1].fill("6");
    await page.fill("#dlgBody input[placeholder='Shelf 1']", "Renamed box");
    await page.click("#dlgFoot .primary");
    await waitCommit(st, 1);
    check("a member can rename and enlarge their own box", find(st.tree, "mine").node.name === "Renamed box" && find(st.tree, "mine").node.cols === 6);

    // delete it: the two tubes are taken out first, then the box goes
    page.once("dialog", (d) => d.accept());
    await page.click('.mapBox[data-id="mine"] button[title="Rename, resize or delete"]');
    await page.click("#dlgFoot .danger");
    await waitCommit(st, 3);
    const after = st.files["cellstocks/data/umut.json"];
    check("deleting a box takes its tubes out and logs them", after && after.vials.every((v) => v.status === "withdrawn") && (after.withdrawals || []).length === 2, JSON.stringify(after && after.vials.map((v) => v.status)));
    check("...and then removes the box from the tree", !find(st.tree, "mine"));
    check("a lab-mate's box is untouched", !!find(st.tree, "theirs"));
  });

  // ------------------------------------------------------------------ not placed yet -> a shelf -> back out
  await scenario("member", TREE(), [], async (page, st) => {
    await openStorage(page);
    await page.waitForSelector("#storageBody .mapUnplaced");
    await page.click('.mapUnplaced .mapBox[data-id="loose"] .mapMove');
    await page.selectOption("#moveWhere", "sh3");
    await page.click("#moveGo");
    await waitCommit(st, 1);
    check("a box that was not placed yet can be put on a shelf from the first screen", find(st.tree, "loose") && find(st.tree, "loose").parent === "sh3");
    check("...and leaves the 'not placed yet' list", (await page.$$('#storageBody .mapUnplaced .mapBox[data-id="loose"]')).length === 0);
    await page.click('#storageBody [data-temp="m80"]');
    await page.click('#storageBody .mapFig[data-id="f1"]');
    await page.click('#storageBody .mapRack[data-id="sh3"]');
    await page.waitForSelector('.mapBox[data-id="loose"]');
    await page.click('.mapBox[data-id="loose"] .mapMove');
    await page.selectOption("#moveWhere", "unplaced");
    await page.click("#moveGo");
    await waitCommit(st, 2);
    check("a box can be taken back out to 'not placed yet'", find(st.tree, "loose").parent === "unplaced");
  });

  // ------------------------------------------------------------------ dragging a box card onto a rack (desktop)
  const TREE2 = TREE(); TREE2.children[0].children.unshift(box("direct", "umut"), box("directb", "baris"));
  await scenario("member", TREE2, [], async (page, st) => {
    await openStorage(page);
    await page.click('#storageBody [data-temp="m80"]');
    await page.click('#storageBody .mapFig[data-id="f1"]');
    await page.waitForSelector('.mapBox[data-id="direct"]');
    check("a box standing directly in the freezer is a draggable card beside the drawn racks",
      (await page.getAttribute('.mapBox[data-id="direct"]', "draggable")) === "true");
    check("a lab-mate's box is not draggable", (await page.getAttribute('.mapBox[data-id="directb"]', "draggable")) !== "true");
    await page.dragAndDrop('.mapBox[data-id="direct"]', '#storageBody .mapRack[data-id="sh3"] .rackHit');
    await waitCommit(st, 1);
    check("dropping a box on a rack puts it on that shelf", find(st.tree, "direct") && find(st.tree, "direct").parent === "sh3", JSON.stringify(find(st.tree, "direct")));
  });

  // ------------------------------------------------------------------ on a phone
  await scenario("member", TREE(), [], async (page) => {
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await openStorage(page);
    await shot(page, "m1-cards");
    check("the four cards fit a phone without sideways scrolling", (await overflow()) <= 0, "overflow " + await overflow());
    const cardBoxes = await page.$$eval("#storageBody .mapTempCard", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)]; }));
    check("on a phone the cards sit two by two", cardBoxes[0][1] === cardBoxes[1][1] && cardBoxes[2][1] === cardBoxes[3][1] && cardBoxes[2][1] > cardBoxes[0][1], JSON.stringify(cardBoxes));
    await page.tap('#storageBody [data-temp="m80"]');
    await page.tap('#storageBody .mapFig[data-id="f1"]');
    await page.waitForSelector("#storageBody .mapPicture");
    await shot(page, "m2-freezer");
    check("the drawn freezer fits a phone", (await overflow()) <= 0, "overflow " + await overflow());
    await page.tap('#storageBody .mapRack[data-id="sh1"]');
    await page.waitForSelector("#storageBody .mapBoxes");
    await shot(page, "m3-shelf");
    check("a shelf's boxes fit a phone", (await overflow()) <= 0, "overflow " + await overflow());
    const navW = await page.$$eval("nav button", (bs) => bs.filter((b) => b.offsetParent).map((b) => Math.round(b.getBoundingClientRect().width)));
    check("every bottom-bar button stays tappable (44px or more) with Storage added", navW.every((w) => w >= 44), navW.join());
  }, { hasTouch: true, viewport: { width: 375, height: 800 } });

  // ------------------------------------------------------------------ a PI reads and changes nothing
  await scenario("pi", TREE(), [], async (page) => {
    await openStorage(page);
    await page.click('#storageBody [data-temp="m80"]');
    check("a PI sees the freezers but cannot add one", !(await page.$("#mapAddUnit")));
    await page.click('#storageBody .mapFig[data-id="f1"]');
    check("a PI has no add-a-shelf or add-a-box button", !(await page.$("#mapAddShelf")) && !(await page.$("#mapAddBox")));
    await page.click('#storageBody .mapRack[data-id="sh1"]');
    check("a PI has no Move… or edit on any box", (await page.$$("#storageBody .mapMove")).length === 0 && (await page.$$('#storageBody button[title="Rename, resize or delete"]')).length === 0);
  });

  // ------------------------------------------------------------------ admin: the same map, plus the pictures
  await scenario("admin", TREE(), [], async (page, st) => {
    await page.waitForSelector("#navAdmin:not([hidden])");
    await page.click('nav button[data-screen="admin"]');
    await page.click("#adminTabs button[data-admintab=structure]");
    await page.waitForSelector("#structMap .mapTempCard");
    check("Admin → Structure opens on the same four cards", (await page.$$("#structMap .mapTempCard")).length === 4);
    check("...with a List view for the folder tree", !!(await page.$('#structMode button[data-mode="list"]')));
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      (async () => {
        await page.click('#structMap [data-temp="m80"] .mapCorner');
        await page.waitForSelector("#dlgFoot .primary");
        await page.click("#dlgFoot .primary");
      })()
    ]);
    await chooser.setFiles({ name: "new freezer.png", mimeType: "image/png", buffer: PNG });
    await waitCommit(st, 2);
    check("an admin's upload is committed as a picture and set on the card", st.uploads.length === 1 && st.tree.tempImages && /\.png$/.test(st.tree.tempImages.m80 || ""), JSON.stringify({ u: st.uploads, t: st.tree.tempImages }));
    await page.waitForFunction(() => /icons\//.test(getComputedStyle(document.querySelector('#structMap [data-temp="m80"] .mapImg')).backgroundImage));
    check("the card now shows the uploaded picture", true);
    // a freezer's own picture
    await page.click('#structMap [data-temp="m80"]');
    check("admin can edit a freezer from its figure", !!(await page.$('#structMap .mapFig[data-id="f1"] .mapCorner')));
    await page.click('#structMode button[data-mode="list"]');
    await page.waitForSelector("#admin-structure .treeBody");
    check("the List view is still the folder tree", (await page.$$("#admin-structure .treeBody")).length > 4);
    await page.click('#structMode button[data-mode="map"]');
    await page.waitForSelector("#structMap");
  });
} catch (err) {
  check("the storage scenarios ran to the end", false, String(err && err.stack || err));
} finally {
  await browser.close();
  server.close();
}

check("no console errors", consoleErrors.length === 0, consoleErrors.join("\n    "));

if (fails.length) {
  console.error(`${fails.length} storage browser check(s) failed:\n`);
  fails.forEach((f) => console.error(`  ✗ ${f}\n`));
  process.exit(1);
}
console.log(`All ${pass} storage browser checks passed.`);
