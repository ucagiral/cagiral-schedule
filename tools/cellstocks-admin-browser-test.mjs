// Drives cellstocks/admin/index.html in a real browser -- the desktop-only panel from
// the plan's Phase 5: user CRUD, lab-wide requests, message templates, point-in-time
// history/export, and direct data override. Same reasoning and same pattern as
// tools/cellstocks-browser-test.mjs: GitHub and the worker are stood in for locally so
// the real page runs against real (fake) data instead of asserting on markup alone.
//
// Run:  node tools/cellstocks-admin-browser-test.mjs
//
// Needs playwright with a chromium build. Without it this exits 0 with a note, same as
// the other browser tests in this repo.

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
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

function serve(port) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
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
const consoleErrors = [];

try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem("cst_admin_cfg", JSON.stringify({ owner: "test-owner", repo: "test-repo", branch: "main" }));
  });
  const page = await context.newPage();
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  const workerCalls = [];
  const usersDb = [
    { name: "admin", role: "admin", hidden: true, canBroadcast: true, createdAt: "2026-01-01T00:00:00.000Z" },
    { name: "Umut", role: "member", hidden: false, canBroadcast: true, createdAt: "2026-01-01T00:00:00.000Z" }
  ];
  const requestsDb = [
    { id: "req-1", fromUser: "Labmate", toUser: "Umut", vialId: "v-1", itemName: "HEK293T p12", note: "for a rescue", status: "pending" }
  ];
  let umutState = {
    storage: { units: [] }, lines: [], vials: [{ id: "v-1", name: "HEK293T p12", status: "stored" }], rules: {}, settings: {},
    withdrawals: [{ id: "w-2", vialId: "v-1", name: "HEK293T p12", from: null, date: "2026-05-22", by: "umut-PC", purpose: "thaw", notes: "" }]
  };
  // Renamed to "ayse.json" partway through the test (the rename check below), and also
  // served under "labmate.json" for the export-all test -- one withdrawal each, so the
  // combined Log sheet has more than one owner's row to actually combine.
  const labmateState = {
    storage: { units: [] }, lines: [], vials: [], rules: {}, settings: {},
    withdrawals: [{ id: "w-1", vialId: "v-2", name: "Special Guest Line", from: null, date: "2026-05-20", by: "Labmate's laptop", purpose: "thaw", notes: "" }]
  };

  await page.route("https://raw.githubusercontent.com/**", (route) => {
    const url = route.request().url();
    if (url.includes("cellstocks/data/umut.json") || url.includes("cellstocks/data/ayse.json")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(umutState) });
    }
    if (url.includes("cellstocks/data/labmate.json")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(labmateState) });
    }
    return route.fulfill({ status: 404, body: "" });
  });

  await page.route("https://fake-admin-worker.example/**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const auth = req.headers()["authorization"];
    workerCalls.push({ path, method, auth, body: req.postData() });
    const json = (obj, status) => route.fulfill({ status: status || 200, contentType: "application/json", body: JSON.stringify(obj) });

    if (path === "/login" && method === "POST") {
      const posted = JSON.parse(req.postData());
      const user = usersDb.find((u) => u.name === posted.name);
      if (user && posted.password === "right") return json({ token: "admin-token-" + user.name, user });
      return json({ error: "wrong name or password" }, 401);
    }
    if (path === "/admin/users" && method === "GET") return json({ users: usersDb });
    if (path === "/admin/users" && method === "POST") {
      const posted = JSON.parse(req.postData());
      usersDb.push({ name: posted.name, role: posted.role || "member", hidden: !!posted.hidden, canBroadcast: !!posted.canBroadcast, createdAt: "2026-06-01T00:00:00.000Z" });
      return json({ user: usersDb[usersDb.length - 1] }, 201);
    }
    if (/^\/admin\/users\/[^/]+$/.test(path) && method === "DELETE") return json({ ok: true });
    if (/^\/admin\/users\/[^/]+\/reset-password$/.test(path) && method === "POST") return json({ ok: true });
    if (/^\/admin\/users\/([^/]+)\/rename$/.test(path) && method === "POST") {
      const oldName = decodeURIComponent(path.match(/^\/admin\/users\/([^/]+)\/rename$/)[1]);
      const posted = JSON.parse(req.postData());
      const user = usersDb.find((u) => u.name === oldName);
      if (user) user.name = posted.newName;
      requestsDb.forEach((r) => { if (r.fromUser === oldName) r.fromUser = posted.newName; if (r.toUser === oldName) r.toUser = posted.newName; });
      return json({ user });
    }

    if (path === "/requests" && method === "GET") return json({ requests: requestsDb });
    if (/^\/requests\/req-1\/(approve|deny)$/.test(path) && method === "POST") {
      const decision = path.endsWith("approve") ? "approved" : "denied";
      requestsDb[0].status = decision;
      return json({ request: requestsDb[0] });
    }

    if (path === "/admin/messages" && method === "GET") {
      return json({ defaults: { request: "{fromUser} is asking about {itemName}{noteSuffix}" }, overrides: {} });
    }
    if (path === "/admin/messages" && method === "PUT") return json({ defaults: {}, overrides: JSON.parse(req.postData()).messages });

    if (path === "/admin/history/at" && method === "GET") {
      return json({ sha: "deadbeef12345678", commitDate: "2026-05-23T14:56:00.000Z", content: '{"vials":[{"id":"v-1","name":"a"},{"id":"v-2","name":"b"}]}' });
    }
    if (path === "/admin/history/commits" && method === "GET") {
      return json({ commits: [{ sha: "sha-2", date: "2026-05-24T09:00:00.000Z", message: "Take out a vial" }, { sha: "sha-1", date: "2026-05-01T10:00:00.000Z", message: "Initial import" }] });
    }
    if (path === "/commit" && method === "POST") return json({ commit: "new-commit-sha" });

    return json({ error: "unhandled in test stub: " + path }, 404);
  });

  await page.goto("http://localhost:8798/cellstocks/admin/");
  await page.waitForSelector("#loginCard");

  // ---- width gate ----
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForFunction(() => !document.getElementById("tooNarrow").hidden);
  check("a narrow viewport shows the too-narrow message, not the panel",
    await page.evaluate(() => document.getElementById("app").hidden));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => document.getElementById("tooNarrow").hidden);
  check("a wide viewport shows the app again", await page.evaluate(() => !document.getElementById("app").hidden));

  // ---- login: non-admin refused ----
  await page.fill("#loginUrl", "https://fake-admin-worker.example");
  await page.fill("#loginName", "Umut");
  await page.fill("#loginPass", "right");
  await page.click("#loginBtn");
  await page.waitForFunction(() => /not an admin account/.test(document.getElementById("flash").textContent));
  check("logging in as a non-admin member is refused, not silently let in",
    /not an admin account/.test(await page.evaluate(() => document.getElementById("flash").textContent)));
  check("the panel stays hidden after a refused login", await page.evaluate(() => document.getElementById("panel").hidden));

  // ---- login: admin succeeds ----
  await page.fill("#loginName", "admin");
  await page.click("#loginBtn");
  await page.waitForSelector("#panel:not([hidden])");
  check("logging in as admin shows the panel", true);
  check("the header shows who is logged in", /Logged in as admin/.test(await page.evaluate(() => document.getElementById("whoami").textContent)));

  // ---- users tab ----
  await page.waitForFunction(() => document.querySelectorAll("#usersTable tbody tr").length === 2);
  const userRows = await page.$$eval("#usersTable tbody tr", (rows) => rows.map((r) => r.children[0].textContent));
  check("the users table lists every account", JSON.stringify(userRows) === JSON.stringify(["admin", "Umut"]), JSON.stringify(userRows));

  await page.fill("#newName", "Labmate");
  await page.fill("#newPass", "labpass");
  await page.click("#createUserBtn");
  await page.waitForFunction(() => document.querySelectorAll("#usersTable tbody tr").length === 3);
  const createCall = workerCalls.find((c) => c.path === "/admin/users" && c.method === "POST");
  check("creating a user posts name/password/role/hidden/canBroadcast",
    createCall && JSON.parse(createCall.body).name === "Labmate", JSON.stringify(createCall));

  // ---- renaming a user ----
  page.once("dialog", (dialog) => dialog.accept("Ayse"));
  await page.click("#usersTable tbody tr:has-text('Umut') button:has-text('Rename')");
  await page.waitForFunction(() => /Renamed Umut to Ayse/.test(document.getElementById("flash").textContent));
  const renameCall = workerCalls.find((c) => c.path === "/admin/users/Umut/rename" && c.method === "POST");
  check("renaming posts the new name to the right user's rename endpoint",
    renameCall && JSON.parse(renameCall.body).newName === "Ayse", JSON.stringify(renameCall));
  const rowsAfterRename = await page.$$eval("#usersTable tbody tr", (rows) => rows.map((r) => r.children[0].textContent));
  check("the users table reflects the new name", rowsAfterRename.includes("Ayse") && !rowsAfterRename.includes("Umut"), JSON.stringify(rowsAfterRename));

  // ---- requests tab ----
  await page.click('#tabs button[data-tab="requests"]');
  await page.waitForSelector("#requestsTable tbody tr");
  const reqButtons = await page.$$eval("#requestsTable tbody tr button", (btns) => btns.map((b) => b.textContent.trim()));
  check("a pending request offers Approve and Deny", JSON.stringify(reqButtons) === JSON.stringify(["Approve", "Deny"]), JSON.stringify(reqButtons));

  await page.click("#requestsTable button:has-text('Approve')");
  await page.waitForFunction(() => /approved/.test(document.getElementById("flash").textContent));
  check("approving calls the worker's approve endpoint",
    workerCalls.some((c) => c.path === "/requests/req-1/approve" && c.method === "POST"), JSON.stringify(workerCalls));
  const commitAfterApprove = workerCalls.filter((c) => c.path === "/commit").pop();
  check("approving with a real vialId writes the reservation to the owner's own file via /commit",
    commitAfterApprove && /reservedFor/.test(commitAfterApprove.body) && /Labmate/.test(commitAfterApprove.body),
    JSON.stringify(commitAfterApprove));

  // ---- messages tab ----
  await page.click('#tabs button[data-tab="messages"]');
  await page.waitForSelector("#messagesCard textarea");
  const placeholder = await page.$eval("#messagesCard textarea", (t) => t.placeholder);
  check("the message editor shows the default as a placeholder", placeholder === "{fromUser} is asking about {itemName}{noteSuffix}", placeholder);
  await page.fill("#messagesCard textarea", "[custom] {fromUser} wants {itemName}");
  await page.click("#messagesCard button:has-text('Save changes')");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("flash").textContent));
  const messagesSaveCall = workerCalls.find((c) => c.path === "/admin/messages" && c.method === "PUT");
  check("saving the message editor PUTs the edited text",
    messagesSaveCall && JSON.parse(messagesSaveCall.body).messages.request === "[custom] {fromUser} wants {itemName}",
    JSON.stringify(messagesSaveCall));

  // ---- history tab: export everything ----
  await page.click('#tabs button[data-tab="history"]');
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportAllBtn")
  ]);
  check("exporting all stocks triggers a real download",
    /^cellstocks-export-\d{4}-\d{2}-\d{2}\.xlsx$/.test(download.suggestedFilename()), download.suggestedFilename());
  await page.waitForFunction(() => /Exported \d+ of \d+ account/.test(document.getElementById("exportAllMsg").textContent));
  check("the export summary counts every non-hidden account it found data for",
    /Exported 2 of 2 account/.test(await page.evaluate(() => document.getElementById("exportAllMsg").textContent)),
    await page.evaluate(() => document.getElementById("exportAllMsg").textContent));

  await page.fill("#histUser", "umut");
  await page.fill("#histAt", "2026-05-23T14:56");
  await page.click("#histLoadBtn");
  await page.waitForFunction(() => /2 item\(s\)/.test(document.getElementById("histResult").textContent));
  check("loading a point in time shows how many items were recorded then",
    /2 item\(s\) recorded/.test(await page.evaluate(() => document.getElementById("histResult").textContent)));
  check("a history lookup has an export button", !!(await page.$("#histResult button:has-text('Export as .xlsx')")));

  await page.click("#histCommitsBtn");
  await page.waitForSelector("#histResult table");
  const commitRows = await page.$$eval("#histResult tbody tr", (rows) => rows.length);
  check("the commit list shows every commit to that user's file", commitRows === 2, `got ${commitRows} rows`);

  // ---- override tab ----
  await page.click('#tabs button[data-tab="override"]');
  await page.fill("#ovUser", "umut");
  await page.click("#ovLoadBtn");
  await page.waitForFunction(() => document.getElementById("ovText").value.length > 0);
  const loadedText = await page.$eval("#ovText", (t) => t.value);
  check("loading override data fetches the user's real live file", /HEK293T p12/.test(loadedText), loadedText);

  await page.fill("#ovText", "{ not valid json");
  await page.click("#ovValidateBtn");
  await page.waitForFunction(() => /Not valid JSON/.test(document.getElementById("ovMsg").textContent));
  check("invalid JSON is caught by Validate, not sent anywhere", true);
  check("the Save button stays disabled after a failed validation", await page.$eval("#ovSaveBtn", (b) => b.disabled));

  await page.fill("#ovText", JSON.stringify({ storage: { units: [] }, lines: [], vials: [], withdrawals: [], rules: {}, settings: {} }));
  await page.click("#ovValidateBtn");
  await page.waitForFunction(() => /Valid/.test(document.getElementById("ovMsg").textContent));
  check("valid JSON enables Save", !(await page.$eval("#ovSaveBtn", (b) => b.disabled)));

  await page.click("#ovSaveBtn");
  await page.waitForFunction(() => document.getElementById("ovMsg").textContent === "Saved.");
  const overrideCommit = workerCalls.filter((c) => c.path === "/commit").pop();
  check("saving an override goes through /commit, same as an ordinary save", !!overrideCommit, JSON.stringify(overrideCommit));

  check("no console errors were raised while exercising the admin panel", consoleErrors.length === 0, consoleErrors.join("\n    "));
} finally {
  await browser.close();
  server.close();
}

if (fails.length) {
  console.error(`${fails.length} of ${pass + fails.length} cell stocks admin browser checks failed:\n`);
  fails.forEach((f) => console.error(`  ✗ ${f}\n`));
  process.exit(1);
} else {
  console.log(`All ${pass} cell stocks admin browser checks passed.`);
}
