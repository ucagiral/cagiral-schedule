// Drives the Cell Stocks app in a real browser -- currently just the Settings screen's
// appearance controls, which is what tools/cellstocks-selftest.mjs cannot see at all (it
// never touches the DOM). GitHub is stood in for locally so the app actually loads real
// data instead of showing its "open from GitHub Pages" banner.
//
// Run:  node tools/cellstocks-browser-test.mjs
//
// Needs playwright with a chromium build. Without it this exits 0 with a note, same as
// tools/wardrobe-browser-test.mjs.

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  console.log("playwright is not installed — skipping the browser test.");
  console.log("  npm i -D playwright && npx playwright install chromium");
  process.exit(0);
}

let pass = 0;
const fails = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? "\n    " + detail : ""}`);
};

const ROOT = REPO_ROOT;
const TYPES = { ".html":"text/html", ".js":"text/javascript", ".json":"application/json" };

function serve(port){
  const server = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()){
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

const server = await serve(8797);
const browser = await chromium.launch();
const consoleErrors = [];

try {
  const context = await browser.newContext();
  // The app resolves its owner/repo from a stored config when the hostname isn't
  // <owner>.github.io (see resolveConfig() in cellstocks/index.html) -- set on before any
  // page script runs, same trick the app itself documents for local testing.
  await context.addInitScript(() => {
    localStorage.setItem("cst_cfg", JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" }));
  });
  const page = await context.newPage();
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  const emptyState = { lines: [], vials: [], withdrawals: [], rules: {}, settings: {} };
  // One freezer for the whole lab, in its own file -- a member's own file holds only
  // their vials, and every box in the shared tree says whose it is.
  // Deliberately unowned. A box with no owner is a real state -- admin adds one in the
  // Structure screen before saying whose it is -- and it is the only state in which an
  // account holding vials can be deleted outright: the worker refuses the delete while
  // the person still owns a box, and Handoff is the way through. That refusal has its
  // own test further down; this fixture is here to exercise the cache invalidation
  // *after* a delete, which is a different thing.
  const labmateBox = { id: "b-1", name: "Box 1", rows: 9, cols: 9, scheme: "grid", note: "", archived: false };
  const labStorage = {
    labName: "CAA Lab Stocks", labIcon: "",
    units: [{ id: "u-1", name: "Labmate's Freezer", type: "freezer", childLabel: "Rack",
              racks: [{ id: "r-1", name: "Rack 1", boxes: [labmateBox] }] }]
  };
  const labmateState = {
    lines: [], withdrawals: [], rules: {}, settings: {},
    vials: [{ id: "v-lm-1", name: "Special Guest Line", location: { unitId: "u-1", rackId: "r-1", boxId: "b-1", position: "A1" }, status: "stored" }]
  };
  await page.route("https://raw.githubusercontent.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("cellstocks/lab-storage.json")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(labStorage) });
    }
    if (url.includes("cellstocks/data/labmate.json")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(labmateState) });
    }
    if (url.includes("cellstocks.json") || url.includes("cellstocks/data/umut.json")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyState) });
    }
    return route.fulfill({ status: 404, body: "" });
  });

  // The directory listing search-in-lab uses to find out who else has a file, straight
  // from GitHub's own Contents API -- never through the worker (see ensureLabCache() in
  // the app). "admin" deliberately has no entry, the same way a real hidden admin
  // account never gets a cellstocks/data/admin.json of its own.
  await page.route("https://api.github.com/repos/test-owner/test-repo/contents/cellstocks/data", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify([{ name: "umut.json", type: "file" }, { name: "labmate.json", type: "file" }])
    }));

  // A stubbed cellstocks-worker -- just enough of /login and /logout to prove the app's
  // own side of the handshake, not a re-test of cellstocks-worker-selftest.mjs.
  const workerCalls = [];
  await page.route("https://fake-worker.example/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    workerCalls.push({ path, method: req.method(), auth: req.headers()["authorization"] });
    if (path === "/login" && req.method() === "POST") {
      const posted = JSON.parse(req.postData());
      if (posted.name === "Umut" && posted.password === "lab-password") {
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ token: "fake-session-token", user: { name: "Umut", role: "member", hidden: false } })
        });
      }
      return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "wrong name or password" }) });
    }
    if (path === "/logout" && req.method() === "POST") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
  });

  await page.goto(`http://localhost:8797/cellstocks/`);

  // ---- mandatory login gate ----
  // Nothing about anyone's inventory renders before someone is identified: the gate
  // covers the whole app shell (nav included) until a login succeeds. See
  // afterAuthChange() in the app.
  await page.waitForSelector("#gateBody input");
  const gateVisible = await page.evaluate(() => getComputedStyle(document.getElementById("authGate")).display !== "none");
  const navHiddenBeforeLogin = await page.evaluate(() => getComputedStyle(document.querySelector("nav")).display === "none");
  check("the login gate is shown before anyone logs in", gateVisible);
  check("the nav (and the rest of the app shell) is hidden behind the gate", navHiddenBeforeLogin);

  // ---- three-way appearance control (lives in the gate before login, in Settings after) ----
  const segButtons = await page.$$eval("#gateBody .seg button", (btns) => btns.map((b) => b.textContent.trim()));
  check("the appearance control offers System, Light and Dark", JSON.stringify(segButtons) === JSON.stringify(["System", "Light", "Dark"]),
    `got ${JSON.stringify(segButtons)}`);

  const systemIsDefault = await page.$eval("#gateBody .seg button", (b) => b.classList.contains("on"));
  check("System is selected by default (no theme forced yet)", systemIsDefault);

  await page.click("#gateBody .seg button:nth-child(2)"); // Light
  let attr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  let stored = await page.evaluate(() => localStorage.getItem("cst_theme"));
  check("clicking Light sets data-theme=light and persists it", attr === "light" && stored === "light", `attr=${attr} stored=${stored}`);

  await page.click("#gateBody .seg button:nth-child(3)"); // Dark
  attr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  stored = await page.evaluate(() => localStorage.getItem("cst_theme"));
  check("clicking Dark sets data-theme=dark and persists it", attr === "dark" && stored === "dark", `attr=${attr} stored=${stored}`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("the dark theme actually changes the rendered background", bg !== "rgb(246, 247, 249)", `background stayed ${bg}`);

  await page.click("#gateBody .seg button:nth-child(1)"); // System
  attr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  stored = await page.evaluate(() => localStorage.getItem("cst_theme"));
  check("clicking System clears data-theme and the stored override", attr === null && stored === null, `attr=${attr} stored=${stored}`);

  // ---- iOS-style toggle switch ----
  // Search screen has at least one <label class="toggle"><input type=checkbox> once
  // there is data with an undated vial or a passage gap to hold back; the CSS rule
  // applies unconditionally to any .toggle input[type=checkbox], so a synthetic one
  // proves the actual rule that ships, not a coincidence of today's fixture.
  const switchWidth = await page.evaluate(() => {
    const label = document.createElement("label");
    label.className = "toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    label.appendChild(input);
    document.body.appendChild(label);
    const w = getComputedStyle(input).width;
    document.body.removeChild(label);
    return w;
  });
  check("a .toggle checkbox renders pill-switch width, not a native 13px box", switchWidth === "38px", `got ${switchWidth}`);

  // ---- worker login (Phase 3b-ii) ----
  check("read-only banner shows before logging in (no PAT, no worker session)",
    await page.evaluate(() => document.getElementById("status").textContent) === "Read-only");

  const loginInputs = await page.$$("#gateBody input");
  check("the login form has worker URL, name and password fields", loginInputs.length >= 3, `found ${loginInputs.length} inputs`);
  await loginInputs[0].fill("https://fake-worker.example");
  await loginInputs[1].fill("Umut");
  await loginInputs[2].fill("wrong-password");
  await page.click("#workerLoginBtn");
  await page.waitForFunction(() => document.querySelector(".banner") &&
    /wrong name or password/.test(document.querySelector(".banner").textContent));
  const badLoginBanner = await page.evaluate(() => document.querySelector(".banner").textContent);
  check("a wrong password shows the worker's error in the banner", /wrong name or password/.test(badLoginBanner), badLoginBanner);
  const stillGated = await page.evaluate(() => document.body.classList.contains("gated"));
  check("a failed login leaves the gate up", stillGated);

  await page.fill("#gateBody input[type=password]", "lab-password");
  await page.click("#workerLoginBtn");
  await page.waitForFunction(() => !!localStorage.getItem("cst_worker_token"));

  const afterLogin = await page.evaluate(() => ({
    token: localStorage.getItem("cst_worker_token"),
    user: JSON.parse(localStorage.getItem("cst_worker_user") || "null"),
    url: localStorage.getItem("cst_worker_url"),
    status: document.getElementById("status").textContent,
    gated: document.body.classList.contains("gated"),
    navVisible: getComputedStyle(document.querySelector("nav")).display !== "none"
  }));
  check("logging in stores the session token, user and worker url", afterLogin.token === "fake-session-token" && afterLogin.url === "https://fake-worker.example", JSON.stringify(afterLogin));
  check("logging in identifies the user by name", afterLogin.user && afterLogin.user.name === "Umut", JSON.stringify(afterLogin.user));
  check("the app leaves read-only mode once logged in", afterLogin.status === "Ready", `status was ${afterLogin.status}`);
  check("logging in drops the gate and reveals the app shell", !afterLogin.gated && afterLogin.navVisible, JSON.stringify(afterLogin));

  // One failed + one successful login attempt so far. The point of this check is that no
  // *cellstocks data* read ever goes to the worker: only auth and saves are meant to
  // talk to it -- a vial, a box, an inventory file never is.
  check("cellstocks data reads never go through the worker -- only auth calls happened",
    workerCalls.every((c) => c.path === "/login"), JSON.stringify(workerCalls));

  // ---- onboarding banner for a fresh account ----
  // The stubbed cellstocks/data/umut.json is an empty inventory (no units, no vials),
  // same as a brand new account looks once logged in -- the banner should offer to
  // import right away rather than leaving an unexplained empty freezer on screen.
  await page.waitForFunction(() => document.querySelector(".banner") &&
    /nothing imported yet/i.test(document.querySelector(".banner").textContent));
  const onboardBanner = await page.evaluate(() => document.querySelector(".banner").textContent);
  check("a fresh account is welcomed by name", /Welcome, Umut/.test(onboardBanner), onboardBanner);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click(".banner button")
  ]);
  check("the banner's action opens a real file picker", !!chooser);
  const onSettingsNow = await page.evaluate(() => document.getElementById("s-settings").classList.contains("active"));
  check("clicking the onboarding action navigates to Settings", onSettingsNow);

  await page.waitForSelector("#connectCard p.note");
  const loggedInNote = await page.evaluate(() => document.querySelector("#connectCard p.note").textContent);
  check("Settings shows who is logged in and through which worker", /Logged in as Umut/.test(loggedInNote) && /fake-worker\.example/.test(loggedInNote), loggedInNote);

  // ---- search in lab (Phase 4a) ----
  await page.click("nav button[data-screen=find]");
  await page.waitForSelector("#q");
  const labToggleVisible = await page.$("#filters .toggle");
  check("the search-in-lab toggle appears once logged in", !!labToggleVisible);

  await page.fill("#q", "special");
  await page.waitForTimeout(250); // the app debounces #q input by 150ms
  const ownOnly = await page.evaluate(() => document.getElementById("results").textContent);
  check("before toggling search-in-lab on, a lab-mate's vial is not shown", !/Special Guest Line/.test(ownOnly), ownOnly);

  await page.click("#filters .toggle input[type=checkbox]");
  await page.waitForFunction(() => /Special Guest Line/.test(document.getElementById("results").textContent));
  const labResultText = await page.evaluate(() => document.getElementById("results").textContent);
  check("search-in-lab finds a lab-mate's vial by name", /Special Guest Line/.test(labResultText), labResultText);
  check("the result is labeled with whose boxes it's in", /labmate/i.test(labResultText), labResultText);

  const labCardButtons = await page.$$eval(".res:has-text('Special Guest Line') button", (btns) => btns.map((b) => b.textContent.trim()));
  check("a lab-mate's vial is information only -- no buttons at all on the card",
    labCardButtons.length === 0, JSON.stringify(labCardButtons));
  const labCardText = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll(".res")).find((c) => /Special Guest Line/.test(c.textContent));
    return card ? card.textContent : "";
  });
  check("it still says whose it is and exactly where it sits",
    /labmate/i.test(labCardText) && /Box 1/.test(labCardText), labCardText);

  await page.click("#filters .toggle input[type=checkbox]");
  await page.waitForFunction(() => !/Special Guest Line/.test(document.getElementById("results").textContent));
  check("turning search-in-lab back off hides the lab-mate's vial again", true);

  // The catch-all worker route is swapped for one that observes a real /logout --
  // route.fulfill of the LATEST matching page.route() registration wins.
  await page.unroute("https://fake-worker.example/**");
  await page.route("https://fake-worker.example/logout", (route) => {
    workerCalls.push({ path: "/logout", method: route.request().method(), auth: route.request().headers()["authorization"] });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.evaluate(() => { window.location.reload(); });
  await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "fake-session-token");
  await page.waitForSelector("nav button[data-screen=settings]");
  await page.click("nav button[data-screen=settings]");

  await page.click("#workerLogoutBtn");
  await page.waitForFunction(() => !localStorage.getItem("cst_worker_token"));
  const afterLogout = await page.evaluate(() => ({
    token: localStorage.getItem("cst_worker_token"),
    user: localStorage.getItem("cst_worker_user"),
    status: document.getElementById("status").textContent
  }));
  check("logging out clears the session token and user", afterLogout.token === null && afterLogout.user === null, JSON.stringify(afterLogout));
  check("logging out returns the app to read-only", afterLogout.status === "Read-only", `status was ${afterLogout.status}`);
  check("logout actually called the worker's /logout", workerCalls.some((c) => c.path === "/logout" && c.auth === "Bearer fake-session-token"), JSON.stringify(workerCalls));

  // ---- switching accounts on one device must never show the previous account's boxes ----
  // Regression for the bug Umut hit on his own first live test: logging into a second,
  // brand-new account (no data file yet) kept showing the first account's inventory,
  // because load() left the in-memory `state` untouched on a 404 and the offline cache
  // key was shared across every worker account on the device.
  await page.route("https://fake-worker.example/login", (route) => {
    const posted = JSON.parse(route.request().postData());
    if (posted.name === "labmate") {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ token: "labmate-token", user: { name: "labmate", role: "member", hidden: false } }) });
    }
    if (posted.name === "newbie") {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ token: "newbie-token", user: { name: "newbie", role: "member", hidden: false } }) });
    }
    if (posted.name === "admin") {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ token: "admin-token", user: { name: "admin", role: "admin", hidden: true } }) });
    }
    return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "wrong name or password" }) });
  });
  await page.route("https://fake-worker.example/admin/users", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ users: [
        { name: "labmate", role: "member", hidden: false },
        { name: "newbie", role: "member", hidden: false }
      ] })
    }));
  // The previous block ended logged out, so the mandatory-login gate is up again --
  // log the next account in straight through the gate, not through Settings.
  await page.waitForSelector("#gateBody input");
  let li = await page.$$("#gateBody input");
  await li[0].fill("https://fake-worker.example");
  await li[1].fill("labmate");
  await li[2].fill("anything");
  await page.click("#workerLoginBtn");
  await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "labmate-token");

  await page.click("nav button[data-screen=find]");
  await page.waitForSelector("#q");
  await page.fill("#q", "special");
  await page.waitForTimeout(250);
  const labmateOwnResults = await page.evaluate(() => document.getElementById("results").textContent);
  check("logging in as labmate shows labmate's own vial (not through search-in-lab)",
    /Special Guest Line/.test(labmateOwnResults), labmateOwnResults);

  // Regression: `hidden` on #navAdmin was being set correctly all along, but
  // `nav button{display:flex}` (an author rule) overrode the browser's own
  // [hidden]{display:none} default, so a non-admin still saw the tab rendered. Checking
  // the computed style (not just the DOM property) is the only way this bug shows up.
  const navAdminDisplay = await page.evaluate(() => getComputedStyle(document.getElementById("navAdmin")).display);
  check("a non-admin never actually sees the Admin tab rendered", navAdminDisplay === "none", navAdminDisplay);

  await page.click("nav button[data-screen=settings]");
  await page.click("#workerLogoutBtn");
  await page.waitForFunction(() => !localStorage.getItem("cst_worker_token"));
  const gatedAfterLogout = await page.evaluate(() => document.body.classList.contains("gated"));
  check("logging out re-locks the app behind the gate -- nothing stays on screen unattended", gatedAfterLogout);
  await page.waitForSelector("#gateBody input");
  li = await page.$$("#gateBody input");
  await li[0].fill("https://fake-worker.example");
  await li[1].fill("newbie");
  await li[2].fill("anything");
  await page.click("#workerLoginBtn");
  await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "newbie-token");

  await page.click("nav button[data-screen=find]");
  await page.waitForSelector("#q");
  await page.fill("#q", "special");
  await page.waitForTimeout(250);
  const newbieResults = await page.evaluate(() => document.getElementById("results").textContent);
  check("a brand-new second account never inherits the previous account's vials",
    !/Special Guest Line/.test(newbieResults), newbieResults);

  const newbieCache = await page.evaluate(() => localStorage.getItem("cst_cache:newbie"));
  const labmateCache = await page.evaluate(() => localStorage.getItem("cst_cache:labmate"));
  check("the offline cache is scoped per account, not shared",
    newbieCache !== labmateCache, `newbie=${newbieCache} labmate=${labmateCache}`);

  await page.click("nav button[data-screen=settings]");
  await page.waitForSelector("#storageCard");

  // ---- grouping strategy picker (Phase 3c-ii) ----
  // Placed after the login/logout flow above rather than earlier, so its markDirty()
  // call (see below) doesn't overwrite the status text those checks assert on.
  const groupButtons = await page.$$eval("#storageCard .seg button", (btns) => btns.map((b) => b.textContent.trim()));
  check("the grouping picker offers the two implemented strategies", JSON.stringify(groupButtons) === JSON.stringify(["One row per cell", "No rule"]), JSON.stringify(groupButtons));
  const categoryRowIsDefault = await page.$eval("#storageCard .seg button", (b) => b.classList.contains("on"));
  check("one row per cell is selected by default", categoryRowIsDefault);

  await page.click("#storageCard .seg button:nth-child(2)"); // No rule
  const groupingAfterClick = await page.evaluate(() => document.querySelector("#storageCard .seg button.on").textContent.trim());
  check("picking No rule updates the selected option", groupingAfterClick === "No rule", groupingAfterClick);

  // ---- admin sees the whole lab merged, read-only, with its own nav tab (Phase 4) ----
  // Replaces the old "act as" launcher entirely -- admin never impersonates a member to
  // see or write their boxes any more. Find/Boxes/Review/Log show every member merged
  // and tagged by owner, with no write affordance anywhere on those four screens; an
  // actual change only ever happens through the new Admin tab's own sub-tabs (Users,
  // Requests, Messages, History, Handoff, Manage a box), which write straight to the
  // real member's file -- worth confirming those by hand against the real worker, the
  // same as this admin surface always has been.
  await page.click("#workerLogoutBtn");
  await page.waitForFunction(() => !localStorage.getItem("cst_worker_token"));
  await page.waitForSelector("#gateBody input");
  li = await page.$$("#gateBody input");
  await li[0].fill("https://fake-worker.example");
  await li[1].fill("admin");
  await li[2].fill("anything");
  await page.click("#workerLoginBtn");
  await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "admin-token");

  const navState = await page.evaluate(() => ({
    freezeHidden: document.getElementById("navFreeze").hidden,
    adminHidden: document.getElementById("navAdmin").hidden
  }));
  check("admin has no Freeze tab -- Freeze is never how admin changes anything", navState.freezeHidden, JSON.stringify(navState));
  check("admin gets its own Admin tab", !navState.adminHidden, JSON.stringify(navState));

  await page.click("nav button[data-screen=find]");
  await page.waitForSelector("#q");
  await page.fill("#q", "special");
  await page.waitForTimeout(400);
  const adminFindText = await page.evaluate(() => document.getElementById("results").textContent);
  check("admin's merged Find shows a member's vial tagged by owner",
    /labmate/i.test(adminFindText) && /Special Guest Line/.test(adminFindText), adminFindText);
  const adminFindButtons = await page.$$eval("#results .res button", (btns) => btns.map((b) => b.textContent.trim()));
  check("admin's merged Find offers no write action at all", adminFindButtons.length === 0, JSON.stringify(adminFindButtons));

  await page.click("nav button[data-screen=boxes]");
  await page.waitForSelector("#bxOwner");
  const bxOwnerOptions = await page.$$eval("#bxOwner option", (opts) => opts.map((o) => o.value));
  check("admin's Boxes screen offers a member picker listing every member",
    bxOwnerOptions.includes("labmate"), JSON.stringify(bxOwnerOptions));
  await page.selectOption("#bxOwner", "labmate");
  await page.waitForTimeout(200);
  const bxSlotClickable = await page.evaluate(() => {
    const cell = document.querySelector("#bxGrid .slot");
    return cell ? cell.onclick !== null : null;
  });
  check("admin's box grid is read-only -- no slot opens the edit/take dialog",
    bxSlotClickable === false, String(bxSlotClickable));

  await page.click("nav button[data-screen=review]");
  await page.waitForTimeout(200);
  const reviewText = await page.evaluate(() => document.getElementById("reviewBody").textContent);
  check("admin's merged Review is grouped by owner", reviewText.startsWith("labmate"), reviewText);
  const reviewButtonStates = await page.$$eval("#reviewBody button", (btns) => btns.map((b) => b.disabled));
  check("every button in admin's merged Review is disabled -- nothing here can write",
    reviewButtonStates.length > 0 && reviewButtonStates.every((d) => d === true), JSON.stringify(reviewButtonStates));

  await page.click("nav button[data-screen=log]");
  await page.waitForTimeout(200);
  const logText = await page.evaluate(() => document.getElementById("logBody").textContent);
  check("admin's merged Log renders lab-wide", /Nothing has been taken out, lab-wide/.test(logText), logText);

  // ---- deleting a member must immediately drop them from the merged view ----
  // Regression: ensureLabCache() fetches every member's data once per page load and
  // keeps it in memory for the rest of the session -- deleting "labmate" here (and, in
  // the real bug report, someone recreating a new account under the same name right
  // after) kept showing the stale in-memory copy on Find/Boxes/Review/Log until the
  // page was reloaded by hand, because nothing told labCache to forget what it had
  // already cached.
  let deleteCalled = false;
  await page.route("https://fake-worker.example/admin/users/labmate", (route) => {
    if (route.request().method() !== "DELETE") return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    deleteCalled = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  // The directory listing and labmate's own raw file now look like the real repo would
  // after the worker actually deleted them.
  await page.route("https://api.github.com/repos/test-owner/test-repo/contents/cellstocks/data", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ name: "umut.json", type: "file" }]) }));
  await page.route("https://raw.githubusercontent.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("cellstocks/data/labmate.json")) return route.fulfill({ status: 404, body: "" });
    if (url.includes("cellstocks.json") || url.includes("cellstocks/data/umut.json")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyState) });
    }
    return route.fulfill({ status: 404, body: "" });
  });

  page.once("dialog", (d) => d.accept());
  await page.click("nav button[data-screen=admin]");
  await page.click("#adminTabs button[data-admintab=users]");
  await page.waitForSelector("#admin-users .danger");
  await page.click("#admin-users .danger"); // labmate is listed first
  await page.waitForTimeout(300);
  check("delete actually called the worker's DELETE endpoint", deleteCalled);

  await page.click("nav button[data-screen=find]");
  await page.waitForSelector("#q");
  await page.fill("#q", "special");
  await page.waitForTimeout(400);
  const afterDeleteText = await page.evaluate(() => document.getElementById("results").textContent);
  check("deleting a member immediately drops their vial from the merged view, with no page reload needed",
    !/Special Guest Line/.test(afterDeleteText), afterDeleteText);

  // "Failed to load resource: 401" is Chromium's own network-layer log for the
  // deliberate wrong-password request above, not a script error -- the app handled that
  // 401 correctly (that's what the banner check just proved). Real script errors don't
  // look like this.
  const realErrors = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
  check("no console errors were raised while exercising Settings", realErrors.length === 0, realErrors.join("\n    "));
} finally {
  await browser.close();
  server.close();
}

// ---- a hung, never-resolving directory listing must not freeze the admin screen ----
//
// Regression for a real incident: the unauthenticated GitHub Contents API call
// ensureLabCache() makes to build admin's merged view has no timeout of its own, so a
// stalled connection (a flaky network, a proxy that swallows the request rather than
// refusing it) left the promise pending forever -- and everything waiting on it, with
// no error and no way out, only "Loading the lab..." shown forever. fetchWithTimeout()
// bounds it. This drives that exact scenario: a route that never calls fulfill/abort,
// simulating a connection that never completes either way.
{
  const server2 = await serve(8799);
  const browser2 = await chromium.launch();
  try {
    const context = await browser2.newContext();
    await context.addInitScript(() => {
      localStorage.setItem("cst_cfg", JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" }));
    });
    const page = await context.newPage();
    const emptyState = { storage: { units: [] }, lines: [], vials: [], withdrawals: [], rules: {}, settings: {} };
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      if (route.request().url().includes("cellstocks/lab-storage.json")) {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ labName: "CAA Lab Stocks", units: [] }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyState) });
    });
    // Never fulfilled, never aborted -- a request that just sits there, the same as a
    // real stalled connection looks like from the page's own point of view.
    await page.route("https://api.github.com/repos/test-owner/test-repo/contents/cellstocks/data", () => {});
    await page.route("https://fake-worker.example/**", (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (path === "/login" && req.method() === "POST") {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ token: "admin-token", user: { name: "admin", role: "admin", hidden: true } }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
    });

    await page.goto(`http://localhost:8799/cellstocks/`);
    await page.waitForSelector("#gateBody input");
    const li = await page.$$("#gateBody input");
    await li[0].fill("https://fake-worker.example");
    await li[1].fill("admin");
    await li[2].fill("anything");
    await page.click("#workerLoginBtn");
    await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "admin-token");

    await page.click("nav button[data-screen=find]");
    await page.waitForSelector("#results");
    const stillLoading = await page.evaluate(() => document.getElementById("results").textContent);
    check("right after login, the hung request is still showing its own loading state (not yet timed out)",
      /Loading the lab/.test(stillLoading), stillLoading);

    // The rest of the page must stay responsive the whole time -- clicking another
    // screen must not itself be blocked by the pending fetch.
    await page.click("nav button[data-screen=settings]");
    await page.waitForSelector("#storageCard");
    check("the nav stays clickable while the request is still pending", true);
    await page.click("nav button[data-screen=find]");

    // fetchWithTimeout()'s bound is 10s; give it real margin above that rather than
    // racing it, the same way a flaky-network timeout test should.
    await page.waitForFunction(
      () => !/Loading the lab/.test(document.getElementById("results").textContent),
      { timeout: 15000 }
    );
    const afterTimeout = await page.evaluate(() => document.getElementById("results").textContent);
    check("a hung directory listing eventually gives up instead of loading forever",
      /0 vials in range, lab-wide/.test(afterTimeout), afterTimeout);
  } catch (err) {
    check("a hung directory listing eventually gives up instead of loading forever", false, String(err));
  } finally {
    await browser2.close();
    server2.close();
  }
}

// ---- a handoff must never carry the source account's vial ids into the target ----
//
// Regression: two accounts generate their own vial ids independently (often small,
// sequential ones from an import -- "v-2" in one account has no relation to "v-2" in
// another), so a handoff that moved a vial into a target account keeping its original
// id could collide with an id the target already had. validate() correctly refused the
// commit rather than corrupting either file ("Two vials share the id v-2"), but that
// meant the handoff itself was simply broken for this (common) case. This drives it:
// caa hands off a box containing vial id "v-2" to umut, who already has a vial with
// that exact id.
{
  const server3 = await serve(8800);
  const browser3 = await chromium.launch();
  try {
    const context = await browser3.newContext();
    await context.addInitScript(() => {
      localStorage.setItem("cst_cfg", JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" }));
    });
    const page = await context.newPage();

    // One lab freezer holding both people's boxes -- the handoff only changes who owns
    // the box, so caa's box must already be sitting in the shared tree beside umut's.
    const caaBox = { id: "b-caa-1", name: "Box 1", rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "caa" };
    const umutBox = { id: "b-umut-1", name: "Box 2", rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "umut" };
    const labStorage = {
      labName: "CAA Lab Stocks", labIcon: "",
      units: [{ id: "u-1", name: "-80 Freezer", type: "freezer", childLabel: "Rack",
                racks: [{ id: "r-1", name: "Rack 1", boxes: [caaBox, umutBox] }] }]
    };
    const caaState = {
      lines: [], withdrawals: [], rules: {}, settings: {},
      vials: [{ id: "v-2", name: "CAA Line", location: { unitId: "u-1", rackId: "r-1", boxId: "b-caa-1", position: "A1" }, status: "stored" }]
    };
    const umutState = {
      lines: [], withdrawals: [], rules: {}, settings: {},
      vials: [{ id: "v-2", name: "Umut's Own Line", location: { unitId: "u-1", rackId: "r-1", boxId: "b-umut-1", position: "A1" }, status: "stored" }]
    };
    let committedUmutState = null;
    let committedStorage = null;
    let deletedUser = null;
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      const url = route.request().url();
      if (url.includes("cellstocks/lab-storage.json")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(labStorage) });
      if (url.includes("cellstocks/data/caa.json")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(caaState) });
      if (url.includes("cellstocks/data/umut.json")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(umutState) });
      return route.fulfill({ status: 404, body: "" });
    });
    await page.route("https://api.github.com/repos/test-owner/test-repo/contents/cellstocks/data", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }));
    await page.route("https://fake-worker.example/**", (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (path === "/login" && req.method() === "POST") {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ token: "admin-token", user: { name: "admin", role: "admin", hidden: true } }) });
      }
      if (path === "/admin/users" && req.method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ users: [{ name: "caa", role: "member", hidden: false }, { name: "umut", role: "member", hidden: false }] }) });
      }
      if (path === "/commit" && req.method() === "POST") {
        const body = JSON.parse(req.postData());
        const jsonFile = body.files.find((f) => f.path.endsWith(".json"));
        if (jsonFile.path.includes("lab-storage")) committedStorage = JSON.parse(jsonFile.content);
        else if (jsonFile.path.includes("umut")) committedUmutState = JSON.parse(jsonFile.content);
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
      if (path.startsWith("/admin/users/") && req.method() === "DELETE") {
        deletedUser = decodeURIComponent(path.slice("/admin/users/".length));
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
    });

    await page.goto(`http://localhost:8800/cellstocks/`);
    await page.waitForSelector("#gateBody input");
    const li = await page.$$("#gateBody input");
    await li[0].fill("https://fake-worker.example");
    await li[1].fill("admin");
    await li[2].fill("anything");
    await page.click("#workerLoginBtn");
    await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "admin-token");

    await page.click("nav button[data-screen=admin]");
    await page.click("#adminTabs button[data-admintab=handoff]");
    await page.waitForSelector("#admin-handoff select");
    await page.selectOption("#admin-handoff select", "caa");
    await page.click("#admin-handoff input[type=checkbox]");
    await page.waitForTimeout(200);
    const boxSelects = await page.$$("#admin-handoff select");
    // boxSelects[0] is "Who's leaving"; the per-box assignment select is next.
    await boxSelects[1].selectOption("umut");
    // Deleting an account is a confirm(); headless Chromium dismisses dialogs unless
    // something answers them.
    page.on("dialog", (d) => d.accept());
    await page.click("#admin-handoff button.danger");
    await page.waitForTimeout(300);

    const handoffMsg = await page.evaluate(() => document.querySelector("#admin-handoff div:last-child").textContent);
    check("a handoff into an account with a colliding vial id succeeds instead of refusing the commit",
      !/share the id|would be invalid/.test(handoffMsg), handoffMsg);
    check("umut's committed state ends up with two vials under two different ids",
      committedUmutState && committedUmutState.vials.length === 2 &&
      new Set(committedUmutState.vials.map((v) => v.id)).size === 2,
      JSON.stringify(committedUmutState && committedUmutState.vials));
    // Nothing physically moves in a handoff: the box keeps its id, its rack and its
    // slot, and only the name on it changes.
    const handedBox = committedStorage && committedStorage.units[0].racks[0].boxes.find((b) => b.id === "b-caa-1");
    check("the handed-over box stays exactly where it was and only changes owner",
      !!handedBox && handedBox.owner === "umut" && committedStorage.units[0].racks[0].boxes.length === 2,
      JSON.stringify(handedBox));
    check("the vial arrives in umut's file still in b-caa-1 / A1",
      committedUmutState && committedUmutState.vials.some((v) =>
        v.name === "CAA Line" && v.location.boxId === "b-caa-1" && v.location.position === "A1"),
      JSON.stringify(committedUmutState && committedUmutState.vials));
    check("the account that was handed over is deleted afterwards", deletedUser === "caa", String(deletedUser));
  } catch (err) {
    check("a handoff into an account with a colliding vial id succeeds instead of refusing the commit", false, String(err));
  } finally {
    await browser3.close();
    server3.close();
  }
}

// ---- the Boxes tab drills down through a nested subdivision tree ----
//
// Umut's real -80 is unit -> rack -> box; this proves a deeper unit -> shelf -> rack
// -> box unit gets an extra picker automatically, that switching a shelf re-populates
// the rack (and box) pickers underneath it, and that a 2-level unit right alongside it
// still shows just the one rack picker it always has -- nothing here migrates or
// flattens the existing shape.
{
  const server4 = await serve(8801);
  const browser4 = await chromium.launch();
  try {
    const context = await browser4.newContext();
    await context.addInitScript(() => {
      localStorage.setItem("cst_cfg", JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" }));
    });
    const page = await context.newPage();

    const boxD1 = { id: "b-d1", name: "Box D1", rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "umut" };
    const boxD2 = { id: "b-d2", name: "Box D2", rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "umut" };
    const flatBox = { id: "b-flat-1", name: "Flat Box 1", rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "umut" };
    const nestedStorage = {
      labName: "CAA Lab Stocks", labIcon: "",
      units: [
        { id: "u-deep", name: "Deep Freezer", type: "freezer", childLabel: "Shelf",
          racks: [
            { id: "shelf-1", name: "Shelf 1", racks: [{ id: "rack-1", name: "Rack 1", boxes: [boxD1] }] },
            { id: "shelf-2", name: "Shelf 2", racks: [{ id: "rack-2", name: "Rack 2", boxes: [boxD2] }] }
          ] },
        { id: "u-flat", name: "Flat Freezer", type: "freezer", childLabel: "Rack",
          racks: [{ id: "rack-flat", name: "Rack 1", boxes: [flatBox] }] }
      ]
    };
    const nestedState = {
      lines: [], withdrawals: [], rules: {}, settings: {},
      vials: [
        { id: "v-d1", name: "Deep Line 1", location: { unitId: "u-deep", rackId: "rack-1", boxId: "b-d1", position: "A1" }, status: "stored" },
        { id: "v-d2", name: "Deep Line 2", location: { unitId: "u-deep", rackId: "rack-2", boxId: "b-d2", position: "A1" }, status: "stored" }
      ]
    };
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      const url = route.request().url();
      if (url.includes("cellstocks/lab-storage.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(nestedStorage) });
      }
      if (url.includes("cellstocks.json") || url.includes("cellstocks/data/umut.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(nestedState) });
      }
      return route.fulfill({ status: 404, body: "" });
    });
    await page.route("https://api.github.com/repos/test-owner/test-repo/contents/cellstocks/data", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ name: "umut.json", type: "file" }]) }));
    await page.route("https://fake-worker.example/**", (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (path === "/login" && req.method() === "POST") {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ token: "fake-session-token", user: { name: "Umut", role: "member", hidden: false } }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
    });

    await page.goto(`http://localhost:8801/cellstocks/`);
    await page.waitForSelector("#gateBody input");
    const li = await page.$$("#gateBody input");
    await li[0].fill("https://fake-worker.example");
    await li[1].fill("Umut");
    await li[2].fill("anything");
    await page.click("#workerLoginBtn");
    await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "fake-session-token");

    await page.click("nav button[data-screen=boxes]");
    await page.selectOption("#bxUnit", "u-deep");
    await page.waitForSelector("#bxPath select");

    // The freezer belongs to the lab, so a member adds a box into it and nothing more:
    // adding or removing a freezer or tank is admin's, from the Structure screen. The
    // button for it used to sit right here, which meant any member could add a unit to
    // everybody's tree.
    const quickAdd = await page.$$eval("#bxQuickAdd button", (btns) =>
      btns.map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })));
    check("a member's quick-add offers a box and only a box -- no freezer or tank button",
      quickAdd.length === 1 && quickAdd[0].text === "Add a box" && quickAdd[0].disabled === false,
      JSON.stringify(quickAdd));

    const deepSelectCount = await page.$$eval("#bxPath select", (els) => els.length);
    check("a unit -> shelf -> rack -> box unit shows three pickers under the breadcrumb (shelf, rack, box)",
      deepSelectCount === 3, `saw ${deepSelectCount}`);

    const boxNameOnShelf1 = await page.$$eval("#bxPath select",
      (els) => els[els.length - 1].selectedOptions[0].textContent);
    check("Shelf 1's default drill-down lands on Box D1", /Box D1/.test(boxNameOnShelf1), boxNameOnShelf1);

    const shelfSelect = await page.$("#bxPath select");
    await shelfSelect.selectOption("shelf-2");
    await page.waitForFunction(() => {
      const last = document.querySelectorAll("#bxPath select");
      const box = last[last.length - 1];
      return box && box.selectedOptions[0] && /Box D2/.test(box.selectedOptions[0].textContent);
    });
    check("switching to Shelf 2 re-populates the rack and box pickers underneath it", true);

    await page.selectOption("#bxUnit", "u-flat");
    await page.waitForFunction(() => document.querySelectorAll("#bxPath select").length === 2);
    const flatSelectCount = await page.$$eval("#bxPath select", (els) => els.length);
    check("a plain unit -> rack -> box unit alongside it still shows just one rack picker plus the box picker",
      flatSelectCount === 2, `saw ${flatSelectCount}`);
  } catch (err) {
    check("the Boxes tab drills down through a nested subdivision tree", false, String(err));
  } finally {
    await browser4.close();
    server4.close();
  }
}

// ---- Admin's Structure screen: one folder tree for the whole lab ----
//
// The third attempt at this, and the one that matches Umut's picture: a single tree
// rooted at the lab, opening straight into the freezers with no person level in it.
// Everything is on screen at once, every folder renames (the root included), every
// folder takes an icon, and because every branch is drawn a box can be dragged onto
// any rack in the lab -- not just a sibling.
{
  const server5 = await serve(8802);
  const browser5 = await chromium.launch();
  try {
    const context = await browser5.newContext();
    await context.addInitScript(() => {
      localStorage.setItem("cst_cfg", JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" }));
    });
    const page = await context.newPage();

    const boxD1 = { id: "b-d1", name: "Box D1", rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "umut" };
    let labStorage = {
      labName: "CAA Lab Stocks", labIcon: "",
      units: [
        { id: "u-deep", name: "Deep Freezer", type: "-80", childLabel: "Rack",
          racks: [
            { id: "shelf-1", name: "Shelf 1", racks: [
              { id: "rack-1", name: "Rack 1", boxes: [boxD1] },
              { id: "rack-2", name: "Rack 2", boxes: [] }
            ] }
          ] },
        { id: "u-ln2", name: "LN2 Tank", type: "LN2", childLabel: "Tower",
          racks: [{ id: "tower-1", name: "Tower 1", boxes: [] }] }
      ]
    };
    let umutState = {
      lines: [], withdrawals: [], rules: {}, settings: {},
      vials: [{ id: "v-d1", name: "Deep Line 1", location: { unitId: "u-deep", rackId: "rack-1", boxId: "b-d1", position: "A1" }, status: "stored" }]
    };
    let lastStorageCommit = null;
    let lastMemberCommit = null;
    let lastCommitPaths = [];
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      const url = route.request().url();
      if (url.includes("cellstocks/lab-storage.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(labStorage) });
      }
      if (url.includes("cellstocks/data/umut.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(umutState) });
      }
      return route.fulfill({ status: 404, body: "" });
    });
    await page.route("https://api.github.com/repos/test-owner/test-repo/contents/cellstocks/data", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ name: "umut.json" }]) }));
    await page.route("https://fake-worker.example/**", (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (path === "/login" && req.method() === "POST") {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ token: "admin-token", user: { name: "admin", role: "admin", hidden: true } }) });
      }
      if (path === "/admin/users" && req.method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ users: [{ name: "umut", role: "member", hidden: false }] }) });
      }
      if (path === "/commit" && req.method() === "POST") {
        const body = JSON.parse(req.postData());
        lastCommitPaths = body.files.map((f) => f.path);
        const file = body.files.find((f) => f.path.endsWith(".json"));
        // The tree and a member's vials are two separate files now, and the screen
        // writes whichever one the change actually belongs to.
        if (file.path.includes("lab-storage")) { lastStorageCommit = JSON.parse(file.content); labStorage = lastStorageCommit; }
        else { lastMemberCommit = JSON.parse(file.content); umutState = lastMemberCommit; }
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
    });

    await page.goto(`http://localhost:8802/cellstocks/`);
    await page.waitForSelector("#gateBody input");
    const li = await page.$$("#gateBody input");
    await li[0].fill("https://fake-worker.example");
    await li[1].fill("admin");
    await li[2].fill("anything");
    await page.click("#workerLoginBtn");
    await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "admin-token");

    await page.click("nav button[data-screen=admin]");
    await page.click("#adminTabs button[data-admintab=structure]");
    await page.waitForFunction(() => !!document.querySelector('#admin-structure .treeBody[data-title="Box D1"]'));

    function editRow(title){
      return page.evaluate((t) => {
        const body = document.querySelector(`#admin-structure .treeBody[data-title="${t}"]`);
        const btn = body && body.parentElement.querySelector(".structRowEdit");
        if (btn) btn.click();
      }, title);
    }
    const titles = () => page.evaluate(() =>
      Array.from(document.querySelectorAll("#admin-structure .treeBody")).map((b) => b.dataset.title));

    // Every level at once, root first -- this is the whole point of the rewrite.
    const shown = await titles();
    check("the whole lab is on screen at once, from the root down to a box",
      ["CAA Lab Stocks", "Deep Freezer", "Shelf 1", "Rack 1", "Box D1", "Rack 2", "LN2 Tank", "Tower 1"]
        .every((t) => shown.includes(t)), JSON.stringify(shown));
    check("there is no person level anywhere in the tree",
      !shown.includes("umut") && !(await page.$("#structureUser")), JSON.stringify(shown));

    // Collapsing a folder hides its whole subtree and nothing else.
    await page.click('#admin-structure .treeBody[data-title="Deep Freezer"]');
    await page.waitForFunction(() => !document.querySelector('.treeBody[data-title="Shelf 1"]'));
    const collapsed = await titles();
    check("collapsing a freezer hides everything under it but leaves its siblings alone",
      !collapsed.includes("Rack 1") && collapsed.includes("LN2 Tank") && collapsed.includes("Deep Freezer"),
      JSON.stringify(collapsed));
    await page.click('#admin-structure .treeBody[data-title="Deep Freezer"]');
    await page.waitForFunction(() => !!document.querySelector('.treeBody[data-title="Box D1"]'));

    // The root itself renames, and takes an icon, like any other folder.
    await editRow("CAA Lab Stocks");
    await page.waitForSelector("#dlgBody input");
    await page.fill("#dlgBody input", "CAA LAB");
    await page.click("#dlgBody .iconPalette button.iconChoice");
    await page.click("#dlgFoot button.primary");
    await page.waitForFunction(() => !!document.querySelector('.treeBody[data-title="CAA LAB"]'));
    check("the lab root renames from its own ✎, like every other folder",
      lastStorageCommit && lastStorageCommit.labName === "CAA LAB",
      JSON.stringify(lastStorageCommit && lastStorageCommit.labName));
    check("the root's icon is stored on the lab, not hardcoded",
      lastStorageCommit && !!lastStorageCommit.labIcon,
      JSON.stringify(lastStorageCommit && lastStorageCommit.labIcon));

    // A rack's ✎ carries its name, its icon and how many children it holds.
    await editRow("Shelf 1");
    await page.waitForSelector("#structureCountInput");
    await page.fill("#dlgBody input", "Shelf One");
    await page.fill("#structureCountInput", "3");
    await page.click("#dlgFoot button.primary");
    await page.waitForFunction(() => !!document.querySelector('.treeBody[data-title="Rack 3"]'));
    check("one dialog renames a folder and grows its children in the same save",
      lastStorageCommit && lastStorageCommit.units[0].racks[0].name === "Shelf One" &&
      lastStorageCommit.units[0].racks[0].racks.length === 3,
      JSON.stringify(lastStorageCommit && lastStorageCommit.units[0].racks[0]));
    // Renaming a level that no workbook mentions writes the tree and nothing else --
    // the sheets name the unit, the leaf rack and the box, never the shelf between them.
    check("a rename no workbook mentions does not drag anybody's .xlsx into the commit",
      lastCommitPaths.length === 1 && lastCommitPaths[0] === "cellstocks/lab-storage.json",
      JSON.stringify(lastCommitPaths));

    // A workbook spells its locations out by name -- unit, rack, box -- and carries a
    // whole `storage` sheet besides, so renaming a freezer makes every member's .xlsx
    // wrong while not one vial has moved. It has to be regenerated in the SAME commit,
    // or the repo is left inconsistent: exactly what CI caught the first time Umut
    // renamed a freezer from his phone.
    await editRow("Deep Freezer");
    await page.waitForSelector("#dlgBody input");
    await page.fill("#dlgBody input", "Deep -80");
    await page.click("#dlgFoot button.primary");
    await page.waitForFunction(() => !!document.querySelector('.treeBody[data-title="Deep -80"]'));
    check("renaming a freezer regenerates the affected member's workbook in the same commit",
      lastCommitPaths.includes("cellstocks/lab-storage.json") &&
      lastCommitPaths.includes("cellstocks/data/umut.xlsx"),
      JSON.stringify(lastCommitPaths));

    // Shrinking to nothing would strand Box D1's vial -- and that vial is in umut's
    // file, not admin's, so the refusal has to have read the whole lab to see it.
    await editRow("Shelf One");
    await page.waitForSelector("#structureCountInput");
    await page.fill("#structureCountInput", "0");
    await page.click("#dlgFoot button.primary");
    await page.waitForFunction(() => /Box D1/.test(document.querySelector("#dlgBody .note")?.textContent || ""));
    const refusal = await page.evaluate(() => document.querySelector("#dlgBody .note").textContent);
    check("a shrink that would strand a box is refused, naming the box and its new-location duty",
      /Box D1/.test(refusal) && /location/.test(refusal), refusal);
    await page.click("#dlgFoot button:not(.primary), #dlg button.ghost").catch(() => {});
    await page.evaluate(() => document.getElementById("dlg").close());

    // Drag Box D1 out of Deep Freezer entirely and into the LN2 tank -- impossible
    // before, when only siblings were on screen. Playwright's mouse API doesn't emit
    // native HTML5 drag events, so the row's own handlers are invoked directly with a
    // stand-in DataTransfer, which is what a real drag does.
    const isDesktop = await page.evaluate(() => !("ontouchstart" in window));
    check("the structure tree runs in a desktop (non-touch) context for this test", isDesktop);
    const dragResult = await page.evaluate(() => {
      const boxRow = document.querySelector('.treeBody[data-title="Box D1"]')?.closest(".treeRow");
      const targetRow = document.querySelector('.treeBody[data-title="Tower 1"]')?.closest(".treeRow");
      if (!boxRow) return { ok: false, reason: "Box D1 row not found" };
      if (!targetRow) return { ok: false, reason: "Tower 1 drop target not found" };
      if (!boxRow.ondragstart) return { ok: false, reason: "Box D1 row isn't draggable" };
      if (!targetRow.ondrop) return { ok: false, reason: "Tower 1 has no drop handler" };
      const store = {};
      const dataTransfer = { setData: (k, v) => { store[k] = v; }, getData: (k) => store[k] };
      boxRow.ondragstart({ dataTransfer });
      targetRow.ondrop({ dataTransfer, preventDefault: () => {} });
      return { ok: true };
    });
    check("the drag simulation found both rows and their handlers", dragResult.ok, JSON.stringify(dragResult));
    await page.waitForFunction(
      () => !!document.querySelector('.treeBody[data-title="Tower 1"]'), { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    check("a box drags into a different freezer, not just a sibling rack",
      lastStorageCommit && lastStorageCommit.units[1].racks[0].boxes.some((b) => b.id === "b-d1"),
      JSON.stringify(lastStorageCommit && lastStorageCommit.units.map((u) => u.name)));
    check("the box's vial follows it in its owner's own file",
      lastMemberCommit && lastMemberCommit.vials[0].location.unitId === "u-ln2" &&
      lastMemberCommit.vials[0].location.rackId === "tower-1",
      JSON.stringify(lastMemberCommit && lastMemberCommit.vials));
    check("moving a box never writes the structure into a member's file",
      lastMemberCommit && !lastMemberCommit.storage,
      JSON.stringify(lastMemberCommit && Object.keys(lastMemberCommit)));
  } catch (err) {
    check("Admin's Structure screen is one folder tree for the whole lab", false, String(err));
  } finally {
    await browser5.close();
    server5.close();
  }
}

// ---- the PI role: sees the whole lab, owns nothing, changes nothing ----
//
// Umut's own words for what a PI is: "PI has no inventory of their own. They can just see
// our inventories and search them. That's it." So: no Add tab, no Admin tab, no Settings
// cards about a file they don't have -- but Find shows every member's vials without
// anyone having to switch a toggle on.
{
  const server6 = await serve(8803);
  const browser6 = await chromium.launch();
  try {
    const context = await browser6.newContext();
    await context.addInitScript(() => {
      localStorage.setItem("cst_cfg", JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" }));
    });
    const page = await context.newPage();

    const memberBox = { id: "b-1", name: "Box 1", rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "umut" };
    const labStorage = {
      labName: "CAA Lab Stocks", labIcon: "",
      units: [{ id: "u-1", name: "Lab Freezer", type: "freezer", childLabel: "Rack",
                racks: [{ id: "r-1", name: "Rack 1", boxes: [memberBox] }] }]
    };
    const memberState = {
      lines: [], withdrawals: [], rules: {}, settings: {},
      vials: [{ id: "v-1", name: "Umut Only Line", location: { unitId: "u-1", rackId: "r-1", boxId: "b-1", position: "A1" }, status: "stored" }]
    };
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      const url = route.request().url();
      if (url.includes("cellstocks/lab-storage.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(labStorage) });
      }
      if (url.includes("cellstocks/data/umut.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(memberState) });
      }
      return route.fulfill({ status: 404, body: "" });
    });
    await page.route("https://api.github.com/repos/test-owner/test-repo/contents/cellstocks/data", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ name: "umut.json", type: "file" }]) }));
    await page.route("https://fake-worker.example/**", (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (path === "/login" && req.method() === "POST") {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ token: "pi-token", user: { name: "Chief", role: "pi", hidden: false } }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
    });

    await page.goto(`http://localhost:8803/cellstocks/`);
    await page.waitForSelector("#gateBody input");
    const li = await page.$$("#gateBody input");
    await li[0].fill("https://fake-worker.example");
    await li[1].fill("Chief");
    await li[2].fill("anything");
    await page.click("#workerLoginBtn");
    await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "pi-token");

    const nav = await page.evaluate(() => ({
      freezeHidden: document.getElementById("navFreeze").hidden,
      adminHidden: document.getElementById("navAdmin").hidden
    }));
    check("a PI gets no Add tab -- they have no inventory to add to", nav.freezeHidden, JSON.stringify(nav));
    check("a PI gets no Admin tab either", nav.adminHidden, JSON.stringify(nav));

    await page.click("nav button[data-screen=find]");
    await page.waitForFunction(() => /Umut Only Line/.test(document.getElementById("results").textContent), { timeout: 15000 });
    check("a PI sees every member's vials in Find without switching anything on", true);
    const piResultButtons = await page.$$eval("#results .res button", (btns) => btns.map((b) => b.textContent.trim()));
    check("and cannot act on any of them -- the merged view is read-only",
      piResultButtons.length === 0, JSON.stringify(piResultButtons));
    const searchToggle = await page.$("#filters .toggle input[type=checkbox]");
    check("a PI is never offered the search-in-lab toggle -- the lab is all they ever see", !searchToggle);

    await page.click("nav button[data-screen=settings]");
    await page.waitForSelector("#connectCard");
    const settingsCards = await page.evaluate(() => ["storageCard", "rulesCard", "keywordsCard", "importCard", "checkCard"]
      .filter((id) => !document.getElementById(id).hidden));
    check("a PI's Settings holds nothing about an inventory they don't have",
      settingsCards.length === 0, JSON.stringify(settingsCards));
  } catch (err) {
    check("the PI role sees the whole lab and owns nothing", false, String(err));
  } finally {
    await browser6.close();
    server6.close();
  }
}

// ---- admin renames a user, and rules can be edited and deleted ----
{
  const server7 = await serve(8804);
  const browser7 = await chromium.launch();
  try {
    const context = await browser7.newContext();
    await context.addInitScript(() => {
      localStorage.setItem("cst_cfg", JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" }));
    });
    const page = await context.newPage();

    // One vial whose origin only a rule can decide, so deleting that rule has a real,
    // countable effect to show in the preview.
    const labStorage = {
      labName: "CAA Lab Stocks", labIcon: "",
      units: [{ id: "u-1", name: "Freezer", type: "freezer", childLabel: "Rack",
                racks: [{ id: "r-1", name: "Rack 1", boxes: [{ id: "b-1", name: "Box 1", rows: 9, cols: 9, scheme: "grid", archived: false, owner: "umut" }] }] }]
    };
    const umutState = {
      lines: [], withdrawals: [], settings: {},
      rules: { origin: [{ match: "HEK", value: "HEK293T" }], koox: [], resistance: [], caspex: [], guide: [] },
      vials: [{ id: "v-1", name: "HEK ATP7B KO g3", location: { unitId: "u-1", rackId: "r-1", boxId: "b-1", position: "A1" }, status: "stored" }]
    };
    let renameCall = null;
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      if (route.request().url().includes("cellstocks/lab-storage.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(labStorage) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(umutState) });
    });
    await page.route("https://api.github.com/repos/test-owner/test-repo/contents/cellstocks/data", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ name: "umut.json", type: "file" }]) }));
    await page.route("https://fake-worker.example/**", (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (path === "/login" && req.method() === "POST") {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ token: "admin-token", user: { name: "admin", role: "admin", hidden: true } }) });
      }
      if (path === "/admin/users" && req.method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ users: [{ name: "umut", role: "member", hidden: false }] }) });
      }
      if (/^\/admin\/users\/[^/]+\/rename$/.test(path) && req.method() === "POST") {
        renameCall = { path, body: JSON.parse(req.postData() || "{}") };
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ user: { name: "ayse", role: "member", hidden: false } }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
    });

    await page.goto(`http://localhost:8804/cellstocks/`);
    await page.waitForSelector("#gateBody input");
    const li = await page.$$("#gateBody input");
    await li[0].fill("https://fake-worker.example");
    await li[1].fill("admin");
    await li[2].fill("anything");
    await page.click("#workerLoginBtn");
    await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "admin-token");

    // Rename, answering both the prompt and the confirm the button raises.
    await page.click("nav button[data-screen=admin]");
    await page.click("#adminTabs button[data-admintab=users]");
    await page.waitForFunction(() => /umut/.test(document.getElementById("admin-users").textContent));

    // A member who still owns a box in the shared tree cannot simply be deleted -- that
    // is how eight boxes ended up naming an account that no longer existed. The refusal
    // is the worker's (409), but the screen says it without the round trip and sends
    // people to Handoff, which is the thing that actually resolves it. No dialog handler
    // here on purpose: if the guard ever regressed, the confirm would appear, headless
    // Chromium would dismiss it, and this check would time out rather than quietly pass.
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#admin-users .item"))
        .find((r) => /umut/.test(r.textContent));
      Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "Delete").click();
    });
    await page.waitForFunction(() => /Handoff/.test(document.querySelector(".banner")?.textContent || ""),
      { timeout: 10000 });
    const deleteBanner = await page.evaluate(() => document.querySelector(".banner").textContent);
    check("deleting a member who still owns a box is refused, naming the box and pointing at Handoff",
      /Box 1/.test(deleteBanner) && /Handoff/.test(deleteBanner), deleteBanner);

    page.once("dialog", (d) => d.accept("ayse"));
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#admin-users .item"))
        .find((r) => /umut/.test(r.textContent));
      const btn = Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "Rename");
      window.__confirmed = false;
      const realConfirm = window.confirm;
      window.confirm = (msg) => { window.__confirmMsg = msg; window.confirm = realConfirm; return true; };
      btn.click();
    });
    await page.waitForFunction(() => window.__confirmMsg !== undefined, { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => !!document.querySelector(".banner")?.textContent.includes("Renamed"), { timeout: 10000 });
    check("renaming a user posts the new name to the worker's rename route",
      renameCall && renameCall.body.newName === "ayse", JSON.stringify(renameCall));
    const confirmMsg = await page.evaluate(() => window.__confirmMsg || "");
    check("the confirm warns that the person is signed out and logs back in under the new name",
      /log back in as ayse/i.test(confirmMsg), confirmMsg);

    // Rules: every rule now has its own Edit and Delete, and deleting previews the damage.
    await page.click("nav button[data-screen=settings]");
    await page.waitForSelector("#rulesCard");
    const ruleRowButtons = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("#rulesCard .item"));
      const row = rows.find((r) => /HEK → HEK293T/.test(r.textContent));
      return row ? Array.from(row.querySelectorAll("button")).map((b) => b.textContent.trim()) : null;
    });
    check("each individual rule gets its own Edit and Delete",
      JSON.stringify(ruleRowButtons) === JSON.stringify(["Edit", "Delete"]), JSON.stringify(ruleRowButtons));

    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("#rulesCard .item"));
      const row = rows.find((r) => /HEK → HEK293T/.test(r.textContent));
      Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "Delete").click();
    });
    await page.waitForSelector("dialog[open]");
    const deleteBody = await page.evaluate(() => document.getElementById("dlgBody").textContent);
    check("deleting a rule says what it would do to the real inventory first",
      /This changes 1 of 1 vials/.test(deleteBody), deleteBody);
    await page.click("#dlgFoot button");
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    const rulesAfter = await page.evaluate(() => document.getElementById("rulesCard").textContent);
    check("and the rule is actually gone afterwards", !/HEK → HEK293T/.test(rulesAfter), rulesAfter);
  } catch (err) {
    check("admin can rename a user, and rules can be edited and deleted", false, String(err));
  } finally {
    await browser7.close();
    server7.close();
  }
}

if (fails.length) {
  console.error(`${fails.length} of ${pass + fails.length} cell stocks browser checks failed:\n`);
  fails.forEach((f) => console.error(`  ✗ ${f}\n`));
  process.exit(1);
} else {
  console.log(`All ${pass} cell stocks browser checks passed.`);
}
