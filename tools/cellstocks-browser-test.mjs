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

  const emptyState = { storage: { units: [] }, lines: [], vials: [], withdrawals: [], rules: {}, settings: {} };
  const labmateBox = { id: "b-1", name: "Box 1", rows: 9, cols: 9, scheme: "grid", note: "", archived: false };
  const labmateState = {
    storage: { units: [{ id: "u-1", name: "Labmate's Freezer", type: "freezer", childLabel: "Rack",
                         racks: [{ id: "r-1", name: "Rack 1", boxes: [labmateBox] }] }] },
    lines: [], withdrawals: [], rules: {}, settings: {},
    vials: [{ id: "v-lm-1", name: "Special Guest Line", location: { unitId: "u-1", rackId: "r-1", boxId: "b-1", position: "A1" }, status: "stored" }]
  };
  await page.route("https://raw.githubusercontent.com/**", (route) => {
    const url = route.request().url();
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

  // GET /messages: registered up front (rather than only where it's used, like /notifications
  // below) so the very first renderNotifications() call -- triggered by the onboarding banner's
  // navigation to Settings, before any of the later broadcast checks run -- already has a
  // distinguishable, non-default value to prove the placeholder actually came from the worker.
  await page.route("https://fake-worker.example/messages", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ messages: { "broadcast-placeholder-queued": "[lab] needs an admin's OK first" } })
    }));

  // POST /requests: the catch-all above would 404 it (only /login and /logout are
  // handled there), so this is registered separately -- a later page.route()
  // registration takes priority over an earlier, broader one for the same URL.
  await page.route("https://fake-worker.example/requests", (route) => {
    const req = route.request();
    workerCalls.push({ path: "/requests", method: req.method(), auth: req.headers()["authorization"], body: req.postData() });
    return route.fulfill({
      status: 201, contentType: "application/json",
      body: JSON.stringify({ request: { id: "req-1", status: "pending" } })
    });
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

  // One failed + one successful login attempt so far, plus renderSettings() fetching
  // notifications right after the successful one. The point of this check is that no
  // *cellstocks data* read ever goes to the worker: only auth, saves, and the worker's
  // own native bookkeeping (notifications, requests) are meant to talk to it -- a vial,
  // a box, an inventory file never is.
  check("cellstocks data reads never go through the worker -- only auth/notification calls happened",
    workerCalls.every((c) => c.path === "/login" || c.path === "/notifications"), JSON.stringify(workerCalls));

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
  check("a lab result offers only Request this -- no Took it / Edit / Show in box",
    JSON.stringify(labCardButtons) === JSON.stringify(["Request this"]), JSON.stringify(labCardButtons));

  // ---- requesting an item (Phase 4b-ii) ----
  await page.click(".res:has-text('Special Guest Line') button:has-text('Request this')");
  await page.waitForSelector("dialog[open]");
  await page.fill("#dlgBody textarea", "need it for a rescue");
  await page.click("#dlgFoot button:has-text('Send request')");
  await page.waitForFunction(() => /Asked labmate about/.test(document.querySelector(".banner")?.textContent || ""));
  const requestCall = workerCalls.find((c) => c.path === "/requests" && c.method === "POST");
  check("sending a request posts to the worker's /requests", !!requestCall, JSON.stringify(workerCalls));
  const requestBody = requestCall && JSON.parse(requestCall.body || "{}");
  check("the request names the right owner, item and vial",
    requestBody && requestBody.toUser === "labmate" && requestBody.itemName === "Special Guest Line" && requestBody.vialId === "v-lm-1",
    JSON.stringify(requestBody));
  check("the request carries the typed note", requestBody && requestBody.note === "need it for a rescue", JSON.stringify(requestBody));

  await page.waitForFunction(() => /Request sent\./.test(document.querySelector(".res")?.textContent || ""));
  const afterRequestButtons = await page.$$eval(".res:has-text('Special Guest Line') button", (btns) => btns.map((b) => b.textContent.trim()));
  check("after sending, the button is replaced so it can't be sent twice", afterRequestButtons.length === 0, JSON.stringify(afterRequestButtons));

  await page.click("#filters .toggle input[type=checkbox]");
  await page.waitForFunction(() => !/Special Guest Line/.test(document.getElementById("results").textContent));
  check("turning search-in-lab back off hides the lab-mate's vial again", true);

  // ---- notifications: approving a request (Phase 4b-ii) ----
  // A pending request FOR Umut, from a fictitious lab-mate -- stubbed directly rather
  // than driving a second logged-in session, the same way the worker's own request/
  // approve/notify lifecycle is already proven end-to-end in
  // cellstocks-worker-selftest.mjs. This is only about the app's side of acting on one.
  // The GET /notifications stub is swapped in now (route.fulfill of the LATEST matching
  // page.route() registration wins) -- notifications is cached client-side once fetched
  // (see renderNotifications() in the app), and it was already fetched once, empty, the
  // first time this session visited Settings via the onboarding banner earlier.
  await page.unroute("https://fake-worker.example/**");
  await page.route("https://fake-worker.example/notifications", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ notifications: [{
        id: "notif-1", type: "request", requestId: "req-1", fromUser: "Someone",
        vialId: "v-does-not-exist", itemName: "Nonexistent Vial", text: "Someone is asking about Nonexistent Vial",
        read: false, createdAt: "2026-01-01T00:00:00.000Z"
      }] })
    }));
  await page.route("https://fake-worker.example/requests/req-1/approve", (route) => {
    workerCalls.push({ path: "/requests/req-1/approve", method: route.request().method(), auth: route.request().headers()["authorization"] });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ request: { id: "req-1", status: "approved" } }) });
  });
  await page.route("https://fake-worker.example/notifications/notif-1/read", (route) => {
    workerCalls.push({ path: "/notifications/notif-1/read", method: route.request().method(), auth: route.request().headers()["authorization"] });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notification: { id: "notif-1", read: true } }) });
  });
  await page.route("https://fake-worker.example/logout", (route) => {
    workerCalls.push({ path: "/logout", method: route.request().method(), auth: route.request().headers()["authorization"] });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.evaluate(() => { window.location.reload(); });
  await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "fake-session-token");
  await page.waitForSelector("nav button[data-screen=settings]");
  await page.click("nav button[data-screen=settings]");
  await page.waitForFunction(() => /Someone is asking about Nonexistent Vial/.test(document.getElementById("notificationsCard").textContent));
  const notifButtons = await page.$$eval("#notificationsCard .item button", (btns) => btns.map((b) => b.textContent.trim()));
  check("a pending request notification offers Approve and Deny", JSON.stringify(notifButtons) === JSON.stringify(["Approve", "Deny"]), JSON.stringify(notifButtons));

  await page.click("#notificationsCard button:has-text('Approve')");
  await page.waitForFunction(() => {
    const c = document.getElementById("notificationsCard");
    return c && !/Approve/.test(c.textContent);
  });
  check("approving calls the worker's approve endpoint",
    workerCalls.some((c) => c.path === "/requests/req-1/approve" && c.method === "POST"), JSON.stringify(workerCalls));
  check("approving also marks the notification read",
    workerCalls.some((c) => c.path === "/notifications/notif-1/read" && c.method === "POST"), JSON.stringify(workerCalls));

  // ---- sending a broadcast (Phase 4c-ii) ----
  await page.route("https://fake-worker.example/broadcasts", (route) => {
    const req = route.request();
    workerCalls.push({ path: "/broadcasts", method: req.method(), auth: req.headers()["authorization"], body: req.postData() });
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ broadcast: { id: "bc-1", status: "pending" } }) });
  });
  await page.waitForFunction(() =>
    document.querySelector("#notificationsCard textarea")?.placeholder === "[lab] needs an admin's OK first");
  check("the compose box's placeholder is fetched from the worker's /messages, not hardcoded", true);

  await page.fill("#notificationsCard textarea", "Anyone seen my pipette?");
  await page.click("#notificationsCard button:has-text('Send')");
  await page.waitForFunction(() => /Sent to an admin for approval/.test(document.querySelector(".banner")?.textContent || ""));
  const broadcastCall = workerCalls.find((c) => c.path === "/broadcasts" && c.method === "POST");
  check("sending a broadcast posts the typed text", broadcastCall && JSON.parse(broadcastCall.body).text === "Anyone seen my pipette?", JSON.stringify(broadcastCall));
  check("an account without broadcast authority is told it needs approval, not that it was sent",
    /Sent to an admin for approval/.test(await page.evaluate(() => document.querySelector(".banner").textContent)));
  const textareaAfterSend = await page.$eval("#notificationsCard textarea", (t) => t.value);
  check("the compose box clears after sending", textareaAfterSend === "", `left with ${JSON.stringify(textareaAfterSend)}`);

  // ---- approving a pending broadcast from a notification ----
  await page.route("https://fake-worker.example/notifications", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ notifications: [{
        id: "notif-2", type: "broadcast-pending", broadcastId: "bc-2", fromUser: "Labmate",
        text: "Labmate wants to send to the whole lab: \"free pizza in the break room\"",
        read: false, createdAt: "2026-01-01T00:00:00.000Z"
      }] })
    }));
  await page.route("https://fake-worker.example/broadcasts/bc-2/approve", (route) => {
    workerCalls.push({ path: "/broadcasts/bc-2/approve", method: route.request().method(), auth: route.request().headers()["authorization"] });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ broadcast: { id: "bc-2", status: "sent" } }) });
  });
  await page.route("https://fake-worker.example/notifications/notif-2/read", (route) => {
    workerCalls.push({ path: "/notifications/notif-2/read", method: route.request().method(), auth: route.request().headers()["authorization"] });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notification: { id: "notif-2", read: true } }) });
  });
  await page.evaluate(() => { window.location.reload(); });
  await page.waitForFunction(() => localStorage.getItem("cst_worker_token") === "fake-session-token");
  await page.waitForSelector("nav button[data-screen=settings]");
  await page.click("nav button[data-screen=settings]");
  await page.waitForFunction(() => /free pizza in the break room/.test(document.getElementById("notificationsCard").textContent));
  const pendingBroadcastButtons = await page.$$eval("#notificationsCard .item button", (btns) => btns.map((b) => b.textContent.trim()));
  check("a pending broadcast notification offers Send it / Don't send",
    JSON.stringify(pendingBroadcastButtons) === JSON.stringify(["Send it", "Don't send"]), JSON.stringify(pendingBroadcastButtons));

  await page.click("#notificationsCard button:has-text('Send it')");
  await page.waitForFunction(() => {
    const c = document.getElementById("notificationsCard");
    return c && !/Send it/.test(c.textContent);
  });
  check("approving a pending broadcast calls the worker's approve endpoint",
    workerCalls.some((c) => c.path === "/broadcasts/bc-2/approve" && c.method === "POST"), JSON.stringify(workerCalls));
  check("approving a pending broadcast also marks its notification read",
    workerCalls.some((c) => c.path === "/notifications/notif-2/read" && c.method === "POST"), JSON.stringify(workerCalls));

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
  await page.route("https://fake-worker.example/notifications", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notifications: [] }) }));

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

if (fails.length) {
  console.error(`${fails.length} of ${pass + fails.length} cell stocks browser checks failed:\n`);
  fails.forEach((f) => console.error(`  ✗ ${f}\n`));
  process.exit(1);
} else {
  console.log(`All ${pass} cell stocks browser checks passed.`);
}
