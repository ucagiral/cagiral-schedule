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
  await page.route("https://raw.githubusercontent.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("cellstocks.json") || url.includes("cellstocks/data/umut.json")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyState) });
    }
    return route.fulfill({ status: 404, body: "" });
  });

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
  await page.waitForSelector("nav button[data-screen=settings]");
  await page.click("nav button[data-screen=settings]");
  await page.waitForSelector("#storageCard");

  // ---- three-way appearance control ----
  const segButtons = await page.$$eval("#connectCard .seg button", (btns) => btns.map((b) => b.textContent.trim()));
  check("the appearance control offers System, Light and Dark", JSON.stringify(segButtons) === JSON.stringify(["System", "Light", "Dark"]),
    `got ${JSON.stringify(segButtons)}`);

  const systemIsDefault = await page.$eval("#connectCard .seg button", (b) => b.classList.contains("on"));
  check("System is selected by default (no theme forced yet)", systemIsDefault);

  await page.click("#connectCard .seg button:nth-child(2)"); // Light
  let attr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  let stored = await page.evaluate(() => localStorage.getItem("cst_theme"));
  check("clicking Light sets data-theme=light and persists it", attr === "light" && stored === "light", `attr=${attr} stored=${stored}`);

  await page.click("#connectCard .seg button:nth-child(3)"); // Dark
  attr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  stored = await page.evaluate(() => localStorage.getItem("cst_theme"));
  check("clicking Dark sets data-theme=dark and persists it", attr === "dark" && stored === "dark", `attr=${attr} stored=${stored}`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("the dark theme actually changes the rendered background", bg !== "rgb(246, 247, 249)", `background stayed ${bg}`);

  await page.click("#connectCard .seg button:nth-child(1)"); // System
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

  const loginInputs = await page.$$("#connectCard input");
  check("the login form has worker URL, name and password fields", loginInputs.length >= 3, `found ${loginInputs.length} inputs`);
  await loginInputs[0].fill("https://fake-worker.example");
  await loginInputs[1].fill("Umut");
  await loginInputs[2].fill("wrong-password");
  await page.click("#workerLoginBtn");
  await page.waitForFunction(() => document.querySelector(".banner") &&
    /wrong name or password/.test(document.querySelector(".banner").textContent));
  const badLoginBanner = await page.evaluate(() => document.querySelector(".banner").textContent);
  check("a wrong password shows the worker's error in the banner", /wrong name or password/.test(badLoginBanner), badLoginBanner);

  await page.fill("#connectCard input[type=password]", "lab-password");
  await page.click("#workerLoginBtn");
  await page.waitForFunction(() => !!localStorage.getItem("cst_worker_token"));

  const afterLogin = await page.evaluate(() => ({
    token: localStorage.getItem("cst_worker_token"),
    user: JSON.parse(localStorage.getItem("cst_worker_user") || "null"),
    url: localStorage.getItem("cst_worker_url"),
    status: document.getElementById("status").textContent
  }));
  check("logging in stores the session token, user and worker url", afterLogin.token === "fake-session-token" && afterLogin.url === "https://fake-worker.example", JSON.stringify(afterLogin));
  check("logging in identifies the user by name", afterLogin.user && afterLogin.user.name === "Umut", JSON.stringify(afterLogin.user));
  check("the app leaves read-only mode once logged in", afterLogin.status === "Ready", `status was ${afterLogin.status}`);

  const loggedInNote = await page.evaluate(() => document.querySelector("#connectCard p.note").textContent);
  check("Settings shows who is logged in and through which worker", /Logged in as Umut/.test(loggedInNote) && /fake-worker\.example/.test(loggedInNote), loggedInNote);

  // One failed + one successful login attempt so far -- both /login. The point of this
  // check is that nothing else (a read, a data fetch) ever went to the worker: only
  // save() and the login/logout calls are meant to talk to it.
  check("reads never go through the worker -- only /login calls happened", workerCalls.every((c) => c.path === "/login"), JSON.stringify(workerCalls));

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
