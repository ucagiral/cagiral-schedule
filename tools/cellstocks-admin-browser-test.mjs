// cellstocks/admin/index.html used to be a whole second app -- its own login, its own
// localStorage namespace, a launcher that opened the real app "acting as" a member.
// Umut asked for one app, one login instead (this round's Phase 4): admin's tools now
// live behind an admin-only nav tab in cellstocks/index.html, and this page is just a
// redirect stub kept for the old bookmark and the request-notification email that still
// point here. Real coverage for the admin tab itself lives in
// tools/cellstocks-browser-test.mjs, alongside every other login scenario.
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

try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:8798/cellstocks/admin/`);
  await page.waitForURL(/\/cellstocks\/$/, { timeout: 5000 });
  check("cellstocks/admin/ redirects to the real app instead of showing a second one", true);
} catch (err) {
  check("cellstocks/admin/ redirects to the real app instead of showing a second one", false, String(err));
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
