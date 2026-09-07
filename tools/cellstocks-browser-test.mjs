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
  // Locally this is a courtesy: a contributor without playwright still gets every other
  // suite. In CI it is the opposite -- a step that goes green whether the checks ran or
  // not is worse than no step at all, because it looks like coverage and is not.
  if (process.env.CI) {
    console.error("::error::playwright is missing, so the browser checks did not run.");
    console.error("This step must not pass without them -- install playwright before it.");
    process.exit(1);
  }
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
  const segButtons = await page.$$eval("#gateAppearance .seg button", (btns) => btns.map((b) => b.textContent.trim()));
  check("the appearance control offers System, Light and Dark", JSON.stringify(segButtons) === JSON.stringify(["System", "Light", "Dark"]),
    `got ${JSON.stringify(segButtons)}`);

  const systemIsDefault = await page.$eval("#gateAppearance .seg button", (b) => b.classList.contains("on"));
  check("System is selected by default (no theme forced yet)", systemIsDefault);

  await page.click("#gateAppearance .seg button:nth-child(2)"); // Light
  let attr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  let stored = await page.evaluate(() => localStorage.getItem("cst_theme"));
  check("clicking Light sets data-theme=light and persists it", attr === "light" && stored === "light", `attr=${attr} stored=${stored}`);

  await page.click("#gateAppearance .seg button:nth-child(3)"); // Dark
  attr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  stored = await page.evaluate(() => localStorage.getItem("cst_theme"));
  check("clicking Dark sets data-theme=dark and persists it", attr === "dark" && stored === "dark", `attr=${attr} stored=${stored}`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("the dark theme actually changes the rendered background", bg !== "rgb(246, 247, 249)", `background stayed ${bg}`);

  await page.click("#gateAppearance .seg button:nth-child(1)"); // System
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
    const caaBox = { id: "b-caa-1", name: "Box 1", isBox: true, rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "caa" };
    const umutBox = { id: "b-umut-1", name: "Box 2", isBox: true, rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "umut" };
    const labStorage = {
      labName: "CAA Lab Stocks", labIcon: "",
      children: [{ id: "u-1", name: "-80 Freezer", icon: "", note: "freezer",
                   children: [{ id: "r-1", name: "Rack 1", icon: "", note: "",
                                children: [caaBox, umutBox] }] }],
      unplaced: []
    };
    const caaState = {
      lines: [], withdrawals: [], rules: {}, settings: {},
      vials: [{ id: "v-2", name: "CAA Line", location: { boxId: "b-caa-1", position: "A1" }, status: "stored" }]
    };
    const umutState = {
      lines: [], withdrawals: [], rules: {}, settings: {},
      vials: [{ id: "v-2", name: "Umut's Own Line", location: { boxId: "b-umut-1", position: "A1" }, status: "stored" }]
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
    const rackAfter = committedStorage && committedStorage.children[0].children[0];
    const handedBox = rackAfter && rackAfter.children.find((b) => b.id === "b-caa-1");
    check("the handed-over box stays exactly where it was and only changes owner",
      !!handedBox && handedBox.owner === "umut" && rackAfter.children.length === 2,
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

// ---- the Boxes tab reaches a box however deep in the tree it sits ----
//
// This used to assert one <select> per level: a four-deep branch drew four dropdowns.
// The tree takes any depth now, so that design would have put six taps between a
// person and a grid. It is two controls instead -- which area, then which box -- and
// the route down to the box travels in the option group and in the line underneath.
// What this proves is that neither of those loses a box, however deep it is.
{
  const server4 = await serve(8801);
  const browser4 = await chromium.launch();
  try {
    const context = await browser4.newContext();
    await context.addInitScript(() => {
      localStorage.setItem("cst_cfg", JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" }));
    });
    const page = await context.newPage();

    const boxD1 = { id: "b-d1", name: "Box D1", isBox: true, rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "umut" };
    const boxD2 = { id: "b-d2", name: "Box D2", isBox: true, rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "umut" };
    const flatBox = { id: "b-flat-1", name: "Flat Box 1", isBox: true, rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "umut" };
    const layer = (id, name, children) => ({ id, name, icon: "", note: "", children });
    const nestedStorage = {
      labName: "CAA Lab Stocks", labIcon: "",
      children: [
        layer("u-deep", "Deep Freezer", [
          layer("shelf-1", "Shelf 1", [layer("rack-1", "Rack 1", [boxD1])]),
          layer("shelf-2", "Shelf 2", [layer("rack-2", "Rack 2", [boxD2])])
        ]),
        layer("u-flat", "Flat Freezer", [layer("rack-flat", "Rack 1", [flatBox])])
      ],
      unplaced: []
    };
    const nestedState = {
      lines: [], withdrawals: [], rules: {}, settings: {},
      vials: [
        { id: "v-d1", name: "Deep Line 1", location: { boxId: "b-d1", position: "A1" }, status: "stored" },
        { id: "v-d2", name: "Deep Line 2", location: { boxId: "b-d2", position: "A1" }, status: "stored" }
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

    // One picker, whatever the depth. Six layers deep would still be one.
    const deepSelectCount = await page.$$eval("#bxPath select", (els) => els.length);
    check("a box picker, and only a box picker, however deep the branch is",
      deepSelectCount === 1, `saw ${deepSelectCount}`);

    // Both of the deep freezer's boxes are reachable, and each says which shelf and
    // rack it is on -- that is what replaces the per-level dropdowns.
    const deepGroups = await page.$$eval("#bxPath select optgroup",
      (gs) => gs.map((g) => ({ label: g.label, options: [...g.children].map((o) => o.textContent.trim()) })));
    check("each box is grouped under the whole route down to it",
      deepGroups.length === 2 &&
      deepGroups.some((g) => g.label === "Shelf 1 → Rack 1" && /Box D1/.test(g.options[0])) &&
      deepGroups.some((g) => g.label === "Shelf 2 → Rack 2" && /Box D2/.test(g.options[0])),
      JSON.stringify(deepGroups));

    const whereLine = await page.evaluate(() => document.getElementById("bxWhere").textContent);
    check("the full path is written out under the picker",
      whereLine === "Deep Freezer → Shelf 1 → Rack 1 → Box D1", whereLine);

    // Picking the box on the other shelf is one action now, not three.
    await page.selectOption("#bxPath select", "b-d2");
    await page.waitForFunction(() =>
      document.getElementById("bxWhere").textContent === "Deep Freezer → Shelf 2 → Rack 2 → Box D2");
    check("picking a box on another shelf takes one tap, and the path follows it", true);

    await page.selectOption("#bxUnit", "u-flat");
    await page.waitForFunction(() =>
      /Flat Box 1/.test(document.getElementById("bxWhere").textContent));
    const flatGroups = await page.$$eval("#bxPath select optgroup", (gs) => gs.map((g) => g.label));
    check("a one-layer freezer alongside it reads just as simply",
      flatGroups.length === 1 && flatGroups[0] === "Rack 1", JSON.stringify(flatGroups));
  } catch (err) {
    check("the Boxes tab reaches a box however deep in the tree it sits", false, String(err));
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

    const boxD1 = { id: "b-d1", name: "Box D1", isBox: true, rows: 9, cols: 9, scheme: "grid", note: "", archived: false, owner: "umut" };
    const layer = (id, name, children, note) => ({ id, name, icon: "", note: note || "", children });
    let labStorage = {
      labName: "CAA Lab Stocks", labIcon: "",
      children: [
        layer("u-deep", "Deep Freezer", [
          layer("shelf-1", "Shelf 1", [
            layer("rack-1", "Rack 1", [boxD1]),
            layer("rack-2", "Rack 2", [])
          ])
        ], "-80"),
        layer("u-ln2", "LN2 Tank", [layer("tower-1", "Tower 1", [])], "LN2")
      ],
      // A box a member made that nobody has placed yet -- its own region below the tree.
      unplaced: [{ id: "b-loose", name: "Homeless Box", isBox: true, rows: 2, cols: 2,
                   scheme: "grid", note: "", archived: false, owner: "umut" }]
    };
    let umutState = {
      lines: [], withdrawals: [], rules: {}, settings: {},
      vials: [{ id: "v-d1", name: "Deep Line 1",
                location: { boxId: "b-d1", position: "A1",
                            path: [{ id: "u-deep", name: "Deep Freezer" },
                                   { id: "shelf-1", name: "Shelf 1" },
                                   { id: "rack-1", name: "Rack 1" }] }, status: "stored" }]
    };
    let lastStorageCommit = null;
    let lastMemberCommit = null;
    let lastCommitPaths = [];
    let staleTree = null;
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      const url = route.request().url();
      if (url.includes("cellstocks/lab-storage.json")) {
        // `staleTree`, once set, stands in for raw.githubusercontent still serving the
        // previous version of a file for a while after it has been committed.
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify(staleTree || labStorage) });
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
        // A change to the tree can invalidate a member's own file too -- a vial stores
        // its whole route -- and both travel in one commit, so read every file in it.
        body.files.filter((f) => f.path.endsWith(".json")).forEach((f) => {
          if (f.path.includes("lab-storage")) { lastStorageCommit = JSON.parse(f.content); labStorage = lastStorageCommit; }
          else { lastMemberCommit = JSON.parse(f.content); umutState = lastMemberCommit; }
        });
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

    // A row carries two buttons now -- "+" to add a child and "✎" to edit -- so pick the
    // one by its label rather than by position.
    //
    // A save is async and ends with $("dlg").close(); opening the next dialog before that
    // lands would see it closed under it. So: wait for no dialog, click, wait for one.
    // (Sleeping instead is what made this block fail one run in three.)
    // Clicking a row button is three things that can each be too early: the previous
    // save's dialog may still be closing, the row may not be redrawn yet, and the click
    // itself may land between renders. The old version evaluated once and silently did
    // nothing when the row was missing -- then waited 30s for a dialog nobody opened,
    // which is what made this block fail two runs in three from different call sites.
    // So: retry the whole thing, and if it never opens, say which row and what was there.
    const clickRowButton = (title, label) => page.evaluate(([t, l]) => {
      const body = document.querySelector(`#admin-structure .treeBody[data-title="${t}"]`);
      const btn = body && [...body.parentElement.querySelectorAll(".structRowEdit")]
        .filter((b) => b.textContent === l)[0];
      if (!btn) return false;
      btn.click();
      return true;
    }, [title, label]);
    const noDialog = () => page.waitForFunction(() => !document.getElementById("dlg").open, null, { timeout: 15000 });
    const dialogIsOpen = () => page.evaluate(() => document.getElementById("dlg").open);

    async function openRowDialog(title, label){
      for (let i = 0; i < 60; i++){
        await noDialog().catch(() => {});
        if (await clickRowButton(title, label)){
          // The handler is synchronous, but give the render a tick before deciding.
          for (let j = 0; j < 10; j++){
            if (await dialogIsOpen()) return;
            await page.waitForTimeout(50);
          }
        }
        await page.waitForTimeout(250);
      }
      const rows = await titles();
      throw new Error(`"${label}" on row ${JSON.stringify(title)} never opened a dialog. On screen: ${JSON.stringify(rows)}`);
    }
    const editRow = (title) => openRowDialog(title, "✎");
    const titles = () => page.evaluate(() =>
      Array.from(document.querySelectorAll("#admin-structure .treeBody")).map((b) => b.dataset.title));

    // Every level at once, root first -- this is the whole point of the rewrite.
    const shown = await titles();
    check("the whole lab is on screen at once, from the root down to a box",
      ["CAA Lab Stocks", "Deep Freezer", "Shelf 1", "Rack 1", "Box D1", "Rack 2", "LN2 Tank", "Tower 1"]
        .every((t) => shown.includes(t)), JSON.stringify(shown));
    check("there is no person level anywhere in the tree",
      !shown.includes("umut") && !(await page.$("#structureUser")), JSON.stringify(shown));
    // A box nobody has placed yet is not in the freezer, and the screen says so rather
    // than hiding it or pretending it sits somewhere.
    check("boxes waiting for a home get their own region under the tree",
      shown.includes("Not placed yet") && shown.includes("Homeless Box"), JSON.stringify(shown));

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

    // ---- one node type, added the same way at every depth ---------------------------
    //
    // The old screen had a "how many children" number per level, which could only ever
    // grow or trim from the end -- so there was no way to add one named thing, and no
    // way to delete anything but the last. + adds exactly one, wherever you are.
    const addUnder = (title) => openRowDialog(title, "+");

    await addUnder("Shelf 1");
    await page.waitForSelector("#dlgBody input");
    await page.fill("#dlgBody input", "Rack 3");
    await page.click("#dlgFoot button.primary");
    await page.waitForFunction(() => !!document.querySelector('.treeBody[data-title="Rack 3"]'));
    const shelfOf = (st) => st && st.children.find((u) => u.id === "u-deep").children[0];
    check("+ on a layer adds exactly one child, by name, at that depth",
      shelfOf(lastStorageCommit) &&
      shelfOf(lastStorageCommit).children.map((r) => r.name).join(",") === "Rack 1,Rack 2,Rack 3",
      JSON.stringify(shelfOf(lastStorageCommit)));
    // Renaming a level that no workbook mentions writes the tree and nothing else --
    // the sheets name the path down to a box, and this one holds none.
    check("adding a layer no workbook mentions does not drag anybody's .xlsx into the commit",
      lastCommitPaths.length === 1 && lastCommitPaths[0] === "cellstocks/lab-storage.json",
      JSON.stringify(lastCommitPaths));

    // There is no depth limit, and nothing in the screen assumes one.
    await addUnder("Rack 3");
    await page.waitForSelector("#dlgBody input");
    await page.fill("#dlgBody input", "Drawer A");
    await page.click("#dlgFoot button.primary");
    await page.waitForFunction(() => !!document.querySelector('.treeBody[data-title="Drawer A"]'));
    check("a fifth level goes in as easily as the second -- the depth is not capped",
      shelfOf(lastStorageCommit).children[2].children[0].name === "Drawer A",
      JSON.stringify(shelfOf(lastStorageCommit).children[2]));

    // A box is a layer that stopped: tick the box, and it takes an owner and a grid.
    await addUnder("Rack 2");
    await page.waitForSelector("#dlgBody input");
    await page.fill("#dlgBody input", "Box D2");
    await page.click("#dlgBody input[type=checkbox]");
    await page.waitForSelector("#dlgBody select");
    // A box with nobody's name on it is refused rather than saved as nobody's -- it
    // would then show on no member's Boxes screen at all.
    await page.click("#dlgFoot button.primary");
    await page.waitForFunction(() => /belong to somebody/.test(document.querySelector("#dlgBody .note").textContent));
    check("a box with no owner is refused, and says why", true);
    await page.selectOption("#dlgBody select", "umut");
    await page.click("#dlgFoot button.primary");
    await page.waitForFunction(() => !!document.querySelector('.treeBody[data-title="Box D2"]'));
    const newBox = shelfOf(lastStorageCommit).children[1].children[0];
    check("ticking 'this is a box' gives it a grid and an owner, and stops the tree there",
      newBox && newBox.isBox === true && !!newBox.owner && newBox.rows >= 1 && newBox.cols >= 1 &&
      newBox.children === undefined, JSON.stringify(newBox));
    const boxAddButton = await page.evaluate(() => {
      const body = document.querySelector('.treeBody[data-title="Box D2"]');
      return [...body.parentElement.querySelectorAll(".structRowEdit")].map((b) => b.textContent);
    });
    check("a box has no + at all -- nothing goes inside one",
      !boxAddButton.includes("+"), JSON.stringify(boxAddButton));

    // A workbook spells its locations out by name and carries a whole `storage` sheet
    // besides, so renaming a freezer makes every member's .xlsx wrong while not one vial
    // has moved. It has to be regenerated in the SAME commit, or the repo is left
    // inconsistent: exactly what CI caught the first time Umut renamed a freezer.
    await editRow("Deep Freezer");
    await page.waitForSelector("#dlgBody input");
    await page.fill("#dlgBody input", "Deep -80");
    await page.click("#dlgFoot button.primary");
    await page.waitForFunction(() => !!document.querySelector('.treeBody[data-title="Deep -80"]'));
    check("renaming a freezer regenerates the affected member's workbook in the same commit",
      lastCommitPaths.includes("cellstocks/lab-storage.json") &&
      lastCommitPaths.includes("cellstocks/data/umut.xlsx"),
      JSON.stringify(lastCommitPaths));

    // Drag Box D1 out of Deep Freezer entirely and into the LN2 tank -- impossible
    // before, when only siblings were on screen. Playwright's mouse API doesn't emit
    // native HTML5 drag events, so the row's own handlers are invoked directly with a
    // stand-in DataTransfer, which is what a real drag does.
    const isDesktop = await page.evaluate(() => !("ontouchstart" in window));
    check("the structure tree runs in a desktop (non-touch) context for this test", isDesktop);
    const drag = (fromTitle, toTitle) => page.evaluate(([f, t]) => {
      const fromRow = document.querySelector(`.treeBody[data-title="${f}"]`)?.closest(".treeRow");
      const toRow = document.querySelector(`.treeBody[data-title="${t}"]`)?.closest(".treeRow");
      if (!fromRow) return { ok: false, reason: `${f} row not found` };
      if (!toRow) return { ok: false, reason: `${t} drop target not found` };
      if (!fromRow.ondragstart) return { ok: false, reason: `${f} isn't draggable` };
      if (!toRow.ondrop) return { ok: false, reason: `${t} has no drop handler` };
      const store = {};
      const dataTransfer = { setData: (k, v) => { store[k] = v; }, getData: (k) => store[k] };
      fromRow.ondragstart({ dataTransfer });
      toRow.ondrop({ dataTransfer, preventDefault: () => {} });
      return { ok: true, payload: store["text/plain"] };
    }, [fromTitle, toTitle]);

    // A drag is fire-and-forget in the page: the commit and the redraw happen after the
    // handler returns. Sleeping a fixed 500ms for that is what made this block fail one
    // run in three -- the commit landed late and closed the dialog the next step had
    // just opened. Wait for the committed tree to actually say what the drag asked for.
    const until = async (fn) => {
      for (let i = 0; i < 200; i++) { if (fn()) return true; await page.waitForTimeout(50); }
      return false;
    };

    const dragResult = await drag("Box D1", "Tower 1");
    check("the drag simulation found both rows and their handlers", dragResult.ok, JSON.stringify(dragResult));
    // One kind of node means one payload: an id, with no kind prefix to keep in step.
    check("the drag payload is just the node's id", dragResult.payload === "b-d1", JSON.stringify(dragResult.payload));
    const towerOf = (st) => st && st.children.find((u) => u.id === "u-ln2").children[0];
    await until(() => towerOf(lastStorageCommit) && towerOf(lastStorageCommit).children.some((b) => b.id === "b-d1"));
    check("a box drags into a different freezer, not just a sibling rack",
      towerOf(lastStorageCommit) && towerOf(lastStorageCommit).children.some((b) => b.id === "b-d1"),
      JSON.stringify(lastStorageCommit && lastStorageCommit.children.map((u) => u.name)));
    // Umut chose to store the whole path on the vial rather than just the box id, so a
    // move has to rewrite it -- in the owner's own file, not admin's.
    check("the vial's stored path is rewritten to the route it actually has now",
      lastMemberCommit &&
      JSON.stringify((lastMemberCommit.vials[0].location.path || []).map((p) => p.name)) ===
        JSON.stringify(["LN2 Tank", "Tower 1"]),
      JSON.stringify(lastMemberCommit && lastMemberCommit.vials[0].location));
    check("moving a box never writes the structure into a member's file",
      lastMemberCommit && !lastMemberCommit.storage,
      JSON.stringify(lastMemberCommit && Object.keys(lastMemberCommit)));

    // ---- dragging a whole shelf ---------------------------------------------------
    //
    // A shelf is a node like any other, so it moves the same way and carries everything
    // underneath it. Nothing here knows the word "rack".
    const rackDrag = await drag("Shelf 1", "LN2 Tank");
    check("a layer row is draggable and another layer accepts it", rackDrag.ok, JSON.stringify(rackDrag));
    await until(() => lastStorageCommit &&
      lastStorageCommit.children.find((u) => u.id === "u-ln2").children.some((r) => r.id === "shelf-1"));
    check("a whole shelf moves into another freezer, bringing its racks and boxes",
      lastStorageCommit &&
      lastStorageCommit.children.find((u) => u.id === "u-ln2").children.some((r) => r.id === "shelf-1") &&
      lastStorageCommit.children.find((u) => u.id === "u-deep").children.length === 0,
      JSON.stringify(lastStorageCommit && lastStorageCommit.children.map(
        (u) => ({ name: u.name, children: (u.children || []).map((r) => r.id) }))));

    // A layer cannot be dropped inside itself or anything under it -- that would cut the
    // subtree off the tree entirely, taking every vial in it out of the world.
    const intoOwnChild = await drag("Shelf 1", "Rack 1");
    check("dragging a layer into its own descendant is refused, not silently applied",
      intoOwnChild.ok, JSON.stringify(intoOwnChild));
    await page.waitForTimeout(300);
    check("and the tree still has the shelf where it was",
      lastStorageCommit &&
      lastStorageCommit.children.find((u) => u.id === "u-ln2").children.some((r) => r.id === "shelf-1"),
      JSON.stringify(lastStorageCommit && lastStorageCommit.children.map((u) => u.name)));

    // A box can be pulled back out of the freezer without being deleted: it lands in
    // the same holding pen a member's new box starts in.
    await drag("Box D1", "Not placed yet");
    await until(() => lastStorageCommit && (lastStorageCommit.unplaced || []).some((b) => b.id === "b-d1"));
    check("a box dragged onto 'Not placed yet' leaves the tree without being deleted",
      lastStorageCommit && (lastStorageCommit.unplaced || []).some((b) => b.id === "b-d1") &&
      !JSON.stringify(lastStorageCommit.children).includes("b-d1"),
      JSON.stringify(lastStorageCommit && lastStorageCommit.unplaced));
    check("its vial's path says so rather than naming a shelf it is not on",
      lastMemberCommit && (lastMemberCommit.vials[0].location.path || []).length === 0,
      JSON.stringify(lastMemberCommit && lastMemberCommit.vials[0].location));
    // Put it back for the delete checks below.
    await drag("Box D1", "Tower 1");
    await until(() => lastStorageCommit && !(lastStorageCommit.unplaced || []).some((b) => b.id === "b-d1"));

    // ---- deleting one named thing -------------------------------------------------
    //
    // The count fields could only ever trim from the END of a list, so there was no way
    // to delete the middle shelf or one particular box. Delete lives in the row's own
    // edit dialog, not on the row: the row is what you tap to open a folder.
    await editRow("Drawer A");
    await page.waitForSelector("#dlgFoot button.danger");
    page.once("dialog", (d) => d.accept());
    await page.click("#dlgFoot button.danger");
    await page.waitForFunction(() => !document.querySelector('.treeBody[data-title="Drawer A"]'));
    const shelfOne = (st) => {
      let hit = null;
      (function walk(list){ (list || []).forEach((n) => { if (n.id === "shelf-1") hit = n; walk(n.children); }); })(st.children);
      return hit;
    };
    check("an empty layer can be deleted by name, leaving its siblings alone",
      lastStorageCommit && shelfOne(lastStorageCommit) &&
      shelfOne(lastStorageCommit).children.map((r) => r.name).join(",") === "Rack 1,Rack 2,Rack 3",
      JSON.stringify(lastStorageCommit && shelfOne(lastStorageCommit)));

    // Box D1 still holds umut's vial, and that vial is in umut's file, not admin's. Admin
    // can delete it anyway -- no Handoff, no emptying it by hand first -- but the vial is
    // taken out and logged rather than erased, and the confirm says so before anything runs.
    let confirmText = "";
    page.once("dialog", (d) => { confirmText = d.message(); d.accept(); });
    await editRow("Box D1");
    await page.waitForSelector("#dlgFoot button.danger");
    await page.click("#dlgFoot button.danger");
    await page.waitForFunction(() => !document.querySelector('.treeBody[data-title="Box D1"]'));
    check("the confirm counts the vials and whose they are before anything is deleted",
      /1 vial/.test(confirmText) && /umut/.test(confirmText) && /logged/.test(confirmText), confirmText);
    check("a box that still holds a vial can be deleted by admin, with no Handoff",
      lastStorageCommit && !JSON.stringify(lastStorageCommit).includes("b-d1"),
      JSON.stringify(lastStorageCommit && lastStorageCommit.children));
    // The oldest rule in this app: nothing deletes a vial. It leaves the active
    // inventory as a withdrawal, with a snapshot of where it was.
    const gone = lastMemberCommit && (lastMemberCommit.vials || []).filter((v) => v.id === "v-d1")[0];
    check("its vial is withdrawn in its owner's own file, not erased",
      !!gone && gone.status === "withdrawn" && !gone.location, JSON.stringify(gone));
    const logged = lastMemberCommit && (lastMemberCommit.withdrawals || [])
      .filter((w) => w.vialId === "v-d1")[0];
    check("and the Log keeps where it was and why it went",
      !!logged && logged.from && logged.from.boxId === "b-d1" && /removed from the freezer/.test(logged.notes || ""),
      JSON.stringify(logged));

    // Its parent goes the same way -- empty now, so nothing to take out.
    page.once("dialog", (d) => d.accept());
    await editRow("Tower 1");
    await page.waitForSelector("#dlgFoot button.danger");
    await page.click("#dlgFoot button.danger");
    await page.waitForFunction(() => !document.querySelector('.treeBody[data-title="Tower 1"]'));
    check("a layer goes too, taking its (now empty) boxes with it",
      lastStorageCommit &&
      !(lastStorageCommit.children.find((u) => u.id === "u-ln2").children || []).some((r) => r.id === "tower-1"),
      JSON.stringify(lastStorageCommit && lastStorageCommit.children.find((u) => u.id === "u-ln2")));

    // ---- an empty tree is an answer, not a missing one -----------------------------
    //
    // Deleting the last freezer used to bring the others back. The app treated "no units"
    // as "not loaded yet" and re-read the file -- and raw.githubusercontent serves the
    // previous version for a while after a commit, so the deleted freezers reappeared and
    // the next delete wrote one of them back. Five rounds of that are in the real
    // lab-storage.json's history. Here the raw route is frozen at the tree as it stands
    // now, which is exactly that stale copy.
    staleTree = JSON.parse(JSON.stringify(labStorage));
    for (const unit of ["Deep -80", "LN2 Tank"]) {
      page.once("dialog", (d) => d.accept());
      await editRow(unit);
      await page.waitForSelector("#dlgFoot button.danger");
      await page.click("#dlgFoot button.danger");
      await page.waitForFunction((n) => !document.querySelector(`.treeBody[data-title="${n}"]`), unit);
    }
    await page.waitForTimeout(600);
    const leftOnScreen = await titles();
    check("deleting the last freezer leaves the tree empty instead of reviving the others",
      !leftOnScreen.includes("Deep -80") && !leftOnScreen.includes("LN2 Tank") &&
      leftOnScreen.includes("CAA LAB"), JSON.stringify(leftOnScreen));
    check("and the emptied tree is what was committed",
      lastStorageCommit && (lastStorageCommit.children || []).length === 0,
      JSON.stringify(lastStorageCommit && lastStorageCommit.children));

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
    // The rules are the whole lab's now, in their own file -- a member's own file has
    // carried none since they were merged.
    const labRules = { origin: [{ match: "HEK", value: "HEK293T" }], koox: [], resistance: [], caspex: [], guide: [] };
    const umutState = {
      lines: [], withdrawals: [], settings: {},
      vials: [{ id: "v-1", name: "HEK ATP7B KO g3", location: { boxId: "b-1", position: "A1" }, status: "stored" }]
    };
    let renameCall = null;
    let lastCommit = null;
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      const url = route.request().url();
      if (url.includes("cellstocks/lab-storage.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(labStorage) });
      }
      if (url.includes("cellstocks/lab-rules.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(labRules) });
      }
      // Admin has no inventory of its own; the vial being counted is umut's, which is
      // the whole point of the lab-wide impact number below.
      if (url.includes("cellstocks/data/admin.json")) return route.fulfill({ status: 404, body: "" });
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
      if (path === "/commit" && req.method() === "POST") {
        lastCommit = JSON.parse(req.postData());
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
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
    // The rules are the whole lab's, so Edit/Delete stay disabled until the lab has been
    // read -- otherwise the impact preview would count only your own vials and say
    // "changes 0" while re-reading everybody else's. Locally that load finishes before
    // the next line runs; in CI it does not, and clicking a disabled button opened no
    // dialog and timed out. Wait for the gate the app actually applies.
    await page.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll("#rulesCard .item"));
      const row = rows.find((r) => /HEK → HEK293T/.test(r.textContent));
      const del = row && Array.from(row.querySelectorAll("button"))
        .find((b) => b.textContent.trim() === "Delete");
      return !!del && !del.disabled;
    }, null, { timeout: 20000 });
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
      /This changes 1 of/.test(deleteBody), deleteBody);
    await page.click("#dlgFoot button");
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    const rulesAfter = await page.evaluate(() => document.getElementById("rulesCard").textContent);
    check("and the rule is actually gone afterwards", !/HEK → HEK293T/.test(rulesAfter), rulesAfter);

    // Where it went is the point of the change Umut asked for: one shared file, never a
    // private copy in whoever happened to be logged in.
    const rulePaths = (lastCommit && lastCommit.files.map((f) => f.path)) || [];
    check("a rule edit is committed to the lab's shared rules file",
      rulePaths.includes("cellstocks/lab-rules.json"), JSON.stringify(rulePaths));
    // A member's file may still be rewritten by the same commit -- a vial stores the
    // route to its box -- but it must never carry a second copy of the rules again.
    const memberFile = lastCommit && lastCommit.files.find((f) => f.path === "cellstocks/data/umut.json");
    check("and never back into a member's own file as a second copy",
      !memberFile || JSON.parse(memberFile.content).rules === undefined,
      memberFile && JSON.stringify(Object.keys(JSON.parse(memberFile.content))));
    const committedRules = lastCommit &&
      JSON.parse(lastCommit.files.find((f) => f.path === "cellstocks/lab-rules.json").content);
    check("the committed file is the whole rule set, with the deleted rule gone from it",
      committedRules && Array.isArray(committedRules.origin) &&
      !committedRules.origin.some((r) => r.match === "HEK"), JSON.stringify(committedRules && committedRules.origin));
    // The vials sheet spells every facet out, so re-reading a name rewrites the workbook
    // -- and it has to travel in the same commit, exactly as a rename of a freezer does.
    check("the member's workbook is regenerated in that same commit",
      rulePaths.includes("cellstocks/data/umut.xlsx"), JSON.stringify(rulePaths));

    // The rules are shared, so "how many vials does this change?" is the lab's number.
    check("the impact preview counts the lab's vials, not just your own",
      /the lab's 1 vials/.test(deleteBody), deleteBody);
  } catch (err) {
    check("admin can rename a user, and rules can be edited and deleted", false, String(err));
  } finally {
    await browser7.close();
    server7.close();
  }
}

// ---- Admin -> History & export: who the daily mail goes to, and when ----
//
// The send time used to be a literal in the workflow, so changing it meant editing YAML.
// It is data now, in the one file under exports/ the app may write -- which is what lets
// an admin set it here. The trap this guards: the save used to write { emails } alone, so
// adding an address would silently reset the time (and now, vice versa).
{
  const server8 = await serve(8805);
  const browser8 = await chromium.launch();
  try {
    const context = await browser8.newContext();
    await context.addInitScript(() => {
      localStorage.setItem("cst_cfg", JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" }));
    });
    const page = await context.newPage();

    let settings = { emails: ["already@example.com"], sendAt: "07:30", timeZone: "Europe/Istanbul" };
    // raw.githubusercontent keeps serving the PREVIOUS version of a file for a while
    // after a commit. Once this is set, the route is frozen at whatever it held then --
    // which is exactly what a stale CDN read is.
    let staleSettings = null;
    let lastCommit = null;
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      const url = route.request().url();
      if (url.includes("cellstocks/exports/recipients.json")) {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify(staleSettings || settings) });
      }
      if (url.includes("cellstocks/lab-storage.json")) {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ labName: "CAA Lab Stocks", labIcon: "", children: [], unplaced: [] }) });
      }
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
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ users: [] }) });
      }
      if (path === "/commit" && req.method() === "POST") {
        lastCommit = JSON.parse(req.postData());
        const f = lastCommit.files.find((x) => x.path.includes("recipients.json"));
        if (f) settings = JSON.parse(f.content);
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
    });

    await page.goto(`http://localhost:8805/cellstocks/`);
    await page.waitForSelector("#gateBody input");
    const li = await page.$$("#gateBody input");
    await li[0].fill("https://fake-worker.example");
    await li[1].fill("admin");
    await li[2].fill("anything");
    await page.click("#workerLoginBtn");
    await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "admin-token");

    await page.click("nav button[data-screen=admin]");
    await page.click("#adminTabs button[data-admintab=history]");
    // Wait for the field to be FILLED, not merely present. renderExportRecipients sets
    // the value after an await, so the input exists for a moment holding "" -- which on a
    // slow runner is what the next line reads. That is what failed in CI on 7b04cc7 and
    // then "passed" on a commit touching neither this test nor the card: a flake, not a fix.
    const timeFieldReady = () => page.waitForFunction(() => {
      const el = document.querySelector("#admin-history input[type=time]");
      return !!el && !!el.value;
    }, null, { timeout: 20000 });
    await timeFieldReady();

    const shownTime = await page.$eval("#admin-history input[type=time]", (el) => el.value);
    check("the export card shows the send time that is actually configured",
      shownTime === "07:30", shownTime);
    const timeNote = await page.evaluate(() => document.getElementById("admin-history").textContent);
    check("and says what the schedule really does rather than promising an exact minute",
      /every half hour/.test(timeNote) && /Europe\/Istanbul/.test(timeNote), timeNote.slice(0, 200));

    // Change the time.
    await page.fill("#admin-history input[type=time]", "06:15");
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("#admin-history button")]
        .find((b) => b.textContent.trim() === "Save the time");
      btn.click();
    });
    await page.waitForFunction(() => /goes out at 06:15/.test(document.getElementById("admin-history").textContent));
    const afterTime = lastCommit && JSON.parse(lastCommit.files[0].content);
    check("saving the time writes it to the shared settings file",
      afterTime && afterTime.sendAt === "06:15", JSON.stringify(afterTime));
    // The trap: the addresses must survive a change to the time.
    check("and does not drop the recipients while doing it",
      afterTime && JSON.stringify(afterTime.emails) === JSON.stringify(["already@example.com"]),
      JSON.stringify(afterTime && afterTime.emails));
    check("only that one file is written -- the app never touches a workflow",
      lastCommit && lastCommit.files.length === 1 &&
      lastCommit.files[0].path === "cellstocks/exports/recipients.json",
      JSON.stringify(lastCommit && lastCommit.files.map((f) => f.path)));

    // And the mirror image: adding an address must not reset the time.
    await page.fill("#admin-history input[type=email]", "second@example.com");
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("#admin-history button")]
        .find((b) => b.textContent.trim() === "Add");
      btn.click();
    });
    await page.waitForFunction(() => /second@example.com/.test(document.getElementById("admin-history").textContent));
    const afterAddr = lastCommit && JSON.parse(lastCommit.files[0].content);
    check("adding an address keeps the send time, instead of silently resetting it",
      afterAddr && afterAddr.sendAt === "06:15" && afterAddr.emails.length === 2,
      JSON.stringify(afterAddr));

    // ---- the stale CDN read, which is how this actually broke for Umut -------------
    //
    // He set the time to 13:15, removed an address, removed it again -- and the third
    // save wrote his old 07:30 back. The card re-read recipients.json from
    // raw.githubusercontent after committing, got the pre-13:15 copy, and the next save
    // merged his deletion onto that stale object. Same failure as the freezers that kept
    // coming back, in a new place. From here the raw route is frozen at the old file.
    staleSettings = { emails: ["already@example.com"], sendAt: "07:30", timeZone: "Europe/Istanbul" };

    // Leave the screen and come back, so the card renders again from scratch.
    await page.click("#adminTabs button[data-admintab=users]");
    await page.click("#adminTabs button[data-admintab=history]");
    await timeFieldReady();
    const timeAfterReturn = await page.$eval("#admin-history input[type=time]", (el) => el.value);
    check("coming back to the card shows what was committed, not the stale copy",
      timeAfterReturn === "06:15", timeAfterReturn);

    // And the save that follows must not carry the stale value back into the file.
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#admin-history .item"))
        .find((r) => /second@example.com/.test(r.textContent));
      Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "Remove").click();
    });
    await page.waitForFunction(() => !/second@example.com/.test(document.getElementById("admin-history").textContent));
    const afterRemove = lastCommit && JSON.parse(lastCommit.files[0].content);
    check("removing an address actually removes it",
      afterRemove && !afterRemove.emails.includes("second@example.com"), JSON.stringify(afterRemove));
    check("and it does not resurrect the send time from the stale read",
      afterRemove && afterRemove.sendAt === "06:15", JSON.stringify(afterRemove));
  } catch (err) {
    check("the export card sets who the daily mail goes to and when", false, String(err));
  } finally {
    await browser8.close();
    server8.close();
  }
}

// ============================================================================
// Work a device never managed to save is not thrown away when the app reopens
// ============================================================================
//
// The real incident, reproduced. Umut froze two vials, the save was refused, and the
// next time the app opened they were gone -- he had to enter them again. The cause was
// three lines apart: markDirty() cached the state, `dirty` lived only in memory, and
// load() then replaced state with the committed copy and wrote that over the cache too.
// Nothing was shown. In a freezer people are now using, this is the failure that matters.
{
  const server9 = await serve(8806);
  const browser9 = await chromium.launch();
  try {
    const committed = {
      lines: [], withdrawals: [], rules: {}, settings: {},
      vials: [{ id: "v-committed", name: "HEK293T", passage: "p5",
                location: { boxId: "b-1", position: "A1", path: [] }, status: "stored" }]
    };
    const labStorage = {
      labName: "CAA Lab Stocks", labIcon: "", unplaced: [],
      children: [{ id: "u-1", name: "Freezer 1", children: [
        { id: "r-1", name: "Rack 1", children: [
          { id: "b-1", name: "Box 1", isBox: true, owner: "umut", rows: 9, cols: 9, scheme: "grid" }] }] }]
    };
    // What the device was holding and had never committed: the committed vial plus the
    // two that were typed in front of the freezer.
    const unsaved = JSON.parse(JSON.stringify(committed));
    unsaved.vials.push({ id: "v-frozen-1", name: "Du145 TOX4 KO", passage: "p3",
                         location: { boxId: "b-1", position: "B1", path: [] }, status: "stored" });
    unsaved.vials.push({ id: "v-frozen-2", name: "Du145 TOX4 KO", passage: "p3",
                         location: { boxId: "b-1", position: "B2", path: [] }, status: "stored" });

    const context = await browser9.newContext();
    await context.addInitScript(([cache, cfg]) => {
      localStorage.setItem("cst_cfg", cfg);
      localStorage.setItem("cst_worker_url", "https://fake-worker.example");
      localStorage.setItem("cst_worker_token", "fake-session-token");
      localStorage.setItem("cst_worker_user", JSON.stringify({ name: "Umut", role: "member", hidden: false }));
      localStorage.setItem("cst_device", "the phone");
      localStorage.setItem("cst_cache:umut", cache);
    }, [JSON.stringify({ at: Date.now(), state: unsaved, dirty: true }),
        JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" })]);

    const page = await context.newPage();
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      const url = route.request().url();
      if (url.includes("cellstocks/lab-storage.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(labStorage) });
      }
      if (url.includes("cellstocks/data/umut.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(committed) });
      }
      return route.fulfill({ status: 404, body: "" });
    });
    await page.route("https://api.github.com/repos/test-owner/test-repo/contents/cellstocks/data", (route) =>
      route.fulfill({ status: 200, contentType: "application/json",
                      body: JSON.stringify([{ name: "umut.json", type: "file" }]) }));

    let committedFiles = null;
    await page.route("https://fake-worker.example/**", (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (path === "/commit" && req.method() === "POST") {
        committedFiles = JSON.parse(req.postData());
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commit: "abc" }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
    });

    await page.goto("http://localhost:8806/cellstocks/");

    // Probed through what the app actually persists, not a hook added for the test: the
    // cache is rewritten by load(), so if the two vials are still in it afterwards they
    // survived the read of the committed copy.
    const idsInCache = async () => page.evaluate(() => {
      try {
        const c = JSON.parse(localStorage.getItem("cst_cache:umut") || "null");
        return c && c.state && c.state.vials ? c.state.vials.map((v) => v.id) : null;
      } catch (e) { return null; }
    });
    await page.waitForFunction(() => {
      try {
        const c = JSON.parse(localStorage.getItem("cst_cache:umut") || "null");
        // Wait until load() has been through it -- the committed vial arriving is the
        // signal that the read happened, which is the moment the old code lost the rest.
        return c && c.state && c.state.vials.some((v) => v.id === "v-committed");
      } catch (e) { return false; }
    }, { timeout: 10000 }).catch(() => {});

    const ids = await idsInCache();
    check("the two vials this device never saved are still here after reopening",
      !!ids && ids.includes("v-frozen-1") && ids.includes("v-frozen-2"), JSON.stringify(ids));
    check("and the committed one is not lost on the way",
      !!ids && ids.includes("v-committed"), JSON.stringify(ids));

    // And it retries the save by itself rather than waiting to be noticed.
    await page.waitForFunction(() => true);
    for (let i = 0; i < 40 && !committedFiles; i++) await page.waitForTimeout(100);
    check("reopening retries the save that had failed",
      !!committedFiles, committedFiles ? "committed" : "no /commit call was made");
    if (committedFiles) {
      const written = JSON.parse(committedFiles.files[0].content);
      const writtenIds = written.vials.map((v) => v.id);
      check("what it saves contains both vials, so the committed file is right afterwards",
        writtenIds.includes("v-frozen-1") && writtenIds.includes("v-frozen-2"), JSON.stringify(writtenIds));
    }
  } catch (err) {
    check("unsaved work survives the app being reopened", false, String(err));
  } finally {
    await browser9.close();
    server9.close();
  }
}

// ============================================================================
// save() must not clobber a change that landed on the server after this
// session's own last read, however unrelated the edit that triggers it
// ============================================================================
//
// The other half of the same incident class as above, found from a real report: "Accept
// all" on Review's facet-drift list reported success, but the same rows kept coming
// back. dropEmptyImportRows/mergeInventories's tombstone (see engine.js) fixed the case
// where a removal races its own debounced save -- but save() never re-read the server
// before committing at all, for ANY edit. A tab that loaded once and is then left open
// (backgrounded, suspended, or simply a second device) holds a `state` that can fall
// behind whatever else gets committed in the meantime; the first time that tab saves
// ANYTHING -- however unrelated -- it used to serialise its own stale snapshot whole,
// silently re-committing everything the server had since moved past. Reproduced here
// with a fully unrelated edit (marking a different vial's date Unknown) after the
// server has already moved on from a facetsFromSheet this session's own view still has.
{
  const server10 = await serve(8807);
  const browser10 = await chromium.launch();
  try {
    const labStorage = {
      labName: "CAA Lab Stocks", labIcon: "", unplaced: [],
      children: [{ id: "u-1", name: "Freezer 1", children: [
        { id: "r-1", name: "Rack 1", children: [
          { id: "b-1", name: "Box 1", isBox: true, owner: "umut", rows: 9, cols: 9, scheme: "grid" }] }] }]
    };
    // What this session reads on its one and only load(): a vial still carrying the
    // sheet's own (buggy) facet reading, waiting in Review.
    const stale = {
      lines: [], withdrawals: [], rules: {}, settings: {},
      vials: [
        { id: "v-facet", name: "DuPar50CR NT KO", passage: "p5",
          location: { boxId: "b-1", position: "A1", path: [] }, status: "stored",
          facetsFromSheet: { resistance: "50CR" } },
        { id: "v-nodate", name: "HEK293T", passage: "p3",
          location: { boxId: "b-1", position: "A2", path: [] }, status: "stored" }
      ]
    };
    // What is actually on the server by the time this session gets around to saving
    // anything: someone else already accepted the facet correction.
    const current = JSON.parse(JSON.stringify(stale));
    delete current.vials[0].facetsFromSheet;

    let servedContent = stale;
    const context = await browser10.newContext();
    await context.addInitScript(([cfg]) => {
      localStorage.setItem("cst_cfg", cfg);
      localStorage.setItem("cst_worker_url", "https://fake-worker.example");
      localStorage.setItem("cst_worker_token", "fake-session-token");
      localStorage.setItem("cst_worker_user", JSON.stringify({ name: "Umut", role: "member", hidden: false }));
      localStorage.setItem("cst_device", "the phone");
      // No pre-existing cache: this is a plain, ordinary first load, never marked dirty.
    }, [JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" })]);

    const page = await context.newPage();
    let getCount = 0;
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      const url = route.request().url();
      if (url.includes("cellstocks/lab-storage.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(labStorage) });
      }
      if (url.includes("cellstocks/data/umut.json")) {
        getCount++;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(servedContent) });
      }
      return route.fulfill({ status: 404, body: "" });
    });
    await page.route("https://api.github.com/repos/test-owner/test-repo/contents/cellstocks/data", (route) =>
      route.fulfill({ status: 200, contentType: "application/json",
                      body: JSON.stringify([{ name: "umut.json", type: "file" }]) }));

    const commits = [];
    await page.route("https://fake-worker.example/**", (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (path === "/commit" && req.method() === "POST") {
        commits.push(JSON.parse(req.postData()));
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commit: "abc" }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
    });

    await page.goto("http://localhost:8807/cellstocks/");

    // Wait for the one and only load() this session makes to land, then -- as far as
    // this page is concerned -- the server quietly moves on without it, the same way
    // another device's commit would.
    await page.waitForFunction(() => document.getElementById("status").textContent === "Ready",
      { timeout: 10000 }).catch(() => {});
    check("the initial load actually read the stale copy with the facet still on it", getCount >= 1, getCount);
    servedContent = current;

    // Now make a change with nothing to do with facets at all: confirm a different
    // vial has no date to give and never will.
    await page.click("nav button[data-screen=review]");
    await page.waitForSelector("#reviewBody .item");
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#reviewBody .item"))
        .find((r) => r.textContent.includes("HEK293T"));
      Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "Unknown").click();
    });

    for (let i = 0; i < 40 && !commits.length; i++) await page.waitForTimeout(100);
    check("the unrelated edit was saved at all", commits.length === 1, commits.length);
    if (commits.length){
      const written = JSON.parse(commits[0].files[0].content);
      const facetVial = written.vials.find((v) => v.id === "v-facet");
      check("saving an unrelated edit must not resurrect a facet correction the server already had",
        facetVial && !facetVial.facetsFromSheet, JSON.stringify(facetVial));
      const dateVial = written.vials.find((v) => v.id === "v-nodate");
      check("and the edit this session actually made must still go through",
        dateVial && dateVial.dateUnknown === true, JSON.stringify(dateVial));
    }
  } catch (err) {
    check("save() reconciles with the server before committing", false, String(err));
  } finally {
    await browser10.close();
    server10.close();
  }
}

if (fails.length) {
  console.error(`${fails.length} of ${pass + fails.length} cell stocks browser checks failed:\n`);
  fails.forEach((f) => console.error(`  ✗ ${f}\n`));
  process.exit(1);
} else {
  console.log(`All ${pass} cell stocks browser checks passed.`);
}
