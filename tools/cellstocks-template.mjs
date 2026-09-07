// Builds a blank, standalone copy of the Cell Stocks app that somebody else can put in
// their own GitHub repository and run for their own lab.
//
//   node tools/cellstocks-template.mjs                 # build + verify + write the .tar.gz
//   node tools/cellstocks-template.mjs --out DIR       # build into DIR instead of a temp dir
//   node tools/cellstocks-template.mjs --keep          # leave the built tree on disk
//   node tools/cellstocks-template.mjs --no-archive    # build and verify, write no archive
//
// Why a generator and not a checked-in copy of the tree: a second copy of index.html and
// engine.js in this repository would go stale the first afternoon somebody fixed a bug in
// the real one, and nothing would notice. This reads the live files every run, so the
// template is always this morning's app.
//
// What it strips, and why each one matters:
//
//   * the inventory        cellstocks/data/*.{json,xlsx} -- other people's vials.
//   * the freezer          cellstocks/lab-storage.json -- our -80, our racks, our boxes.
//   * the mailing list     cellstocks/exports/recipients.json -- personal addresses.
//   * the daily export     cellstocks/exports/layout.* -- regenerated every morning.
//   * our addresses        the Cloudflare host, the KV namespace id, the GitHub owner/repo.
//   * the Pages redirect   index.html sends *.github.io visitors to OUR worker. Left in, a
//                          new lab publishing to Pages would bounce its own users onto our
//                          copy and they would log in against our freezer.
//
// What it keeps: every rule, every test, both workflows, and the classification rule set
// (Umut's call -- a full set is a better starting point than an empty screen, and the
// Rules screen edits it).
//
// Every replacement below is asserted: if the source file changes so that a marker is no
// longer found, this exits non-zero rather than shipping a template that still points at
// our freezer. That is the whole safety property of this script, so do not soften it into
// a best-effort replace.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const OUT = opt("--out", join(tmpdir(), "cellstocks-template"));
const ARCHIVE = !flag("--no-archive");
const KEEP = flag("--keep") || args.includes("--out");

// ---- helpers --------------------------------------------------------------------------

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const write = (rel, text) => {
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
};
const copy = (rel, to) => {
  const dest = join(OUT, to || rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(ROOT, rel), dest);
};

// Replaces `find` with `to` and dies if `find` was not there. The die is the point:
// a silent no-op here means a personal address or our repository name survives into
// somebody else's copy.
function swap(text, find, to, where) {
  if (!text.includes(find)) {
    console.error(`template build failed: ${where} no longer contains ${JSON.stringify(find.slice(0, 70))}.`);
    console.error("The file changed underneath this script. Update the replacement rather than dropping it.");
    process.exit(1);
  }
  return text.split(find).join(to);
}

// ---- 1. a clean output tree -----------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ---- 2. the app, copied as it stands ---------------------------------------------------

for (const f of ["engine.js", "xlsx.js", "pdf.js", "sw.js",
                 "icon-192.png", "icon-512.png", "apple-touch-icon.png"]) {
  copy(join("cellstocks", f));
}

// The lab's classification rules go over whole. They are the five spreadsheet formulas
// turned into data, and a new lab reads a familiar cell name on its first screen instead
// of a blank one. Every one of them is editable from Settings -> Rules.
copy("cellstocks/lab-rules.json");

// The worker, its tests and its tooling.
copy("cellstocks-worker/worker.js");
for (const f of ["cellstocks-selftest.mjs", "cellstocks-worker-selftest.mjs",
                 "cellstocks-export.mjs", "cellstocks-export-selftest.mjs",
                 "cellstocks-mail.mjs", "cellstocks-mail-selftest.mjs",
                 "cellstocks-merge-rules.mjs", "cellstocks-browser-test.mjs",
                 "cellstocks-admin-browser-test.mjs", "png.mjs"]) {
  copy(join("tools", f));
}

// One comment in the icon generator names the original app.
write("tools/make-cellstocks-icons.mjs",
  swap(read("tools/make-cellstocks-icons.mjs"), "(CAApp branding)", "(app branding)",
    "tools/make-cellstocks-icons.mjs (branding comment)"));

copy(".github/workflows/cellstocks.yml");
copy(".github/workflows/cellstocks-export.yml");

// ---- 3. the files that name us ---------------------------------------------------------

// index.html: the Pages redirect and the repository it falls back to.
{
  let html = read("cellstocks/index.html");

  html = swap(html, "// <account>.github.io/cagiral-schedule/cellstocks/, which put a person's name in front",
    "// <account>.github.io/<repo>/cellstocks/, which put a person's name in front",
    "cellstocks/index.html (the old-address comment)");

  html = swap(html, `(function(){
  if (!/\\.github\\.io$/i.test(location.hostname || "")) return;
  location.replace("https://cellstocks-worker.caalabworkersdev.workers.dev/");
})();`, `// (The original lab keeps a redirect here, because its old GitHub Pages address is
// still bookmarked on people's phones. A fresh install has no old address to forward,
// so there is nothing to redirect and this is deliberately empty. If you ever move
// your app to a new host, this is where you would send the old one.)`,
    "cellstocks/index.html (the GitHub Pages redirect)");

  html = swap(html,
    `var DEFAULT_REPO = { owner: "ucagiral", repo: "cagiral-schedule", branch: "main" };`,
    `// ---------------------------------------------------------------------------------
  // FILL THIS IN. Your GitHub username and the repository holding this app. The app
  // reads the inventory straight from raw.githubusercontent.com, so it has to know
  // where to look. Settings -> Connect overrides it per device; this is the default
  // every new phone starts from.
  var DEFAULT_REPO = { owner: "YOUR-GITHUB-USERNAME", repo: "YOUR-REPO-NAME", branch: "main" };`,
    "cellstocks/index.html (DEFAULT_REPO)");

  // The app's name. Three places plus the manifest and the admin page.
  html = swap(html, "<title>CAApp</title>", "<title>Cell Stocks</title>", "cellstocks/index.html (title)");
  html = swap(html, `<meta name="apple-mobile-web-app-title" content="CAApp">`,
    `<meta name="apple-mobile-web-app-title" content="Cell Stocks">`, "cellstocks/index.html (home-screen title)");
  html = swap(html, "<h1>CAApp</h1>", "<h1>Cell Stocks</h1>", "cellstocks/index.html (login heading)");
  html = swap(html, "CAApp is lab-wide now", "Cell Stocks is lab-wide", "cellstocks/index.html (login note)");
  html = swap(html,
    `"© " + new Date().getFullYear() + " CAApp · Umut Cagiral · Built with Claude"`,
    `"© " + new Date().getFullYear() + " Cell Stocks · Built with Claude"`,
    "cellstocks/index.html (footer)");

  write("cellstocks/index.html", html);
}

// The admin page and the manifest carry the same name.
write("cellstocks/admin/index.html",
  swap(read("cellstocks/admin/index.html"), "<title>CAApp — Admin</title>", "<title>Cell Stocks — Admin</title>",
    "cellstocks/admin/index.html (title)"));

{
  const m = JSON.parse(read("cellstocks/manifest.webmanifest"));
  m.name = "Cell Stocks";
  m.short_name = "Cell Stocks";
  write("cellstocks/manifest.webmanifest", JSON.stringify(m, null, 2) + "\n");
}

// sw.js only mentions the old address in a comment, but a comment naming somebody else's
// repository is exactly the kind of thing that gets read as instruction later.
write("cellstocks/sw.js",
  swap(read("cellstocks/sw.js"), "/cagiral-schedule/cellstocks/", "/<your-repo>/cellstocks/",
    "cellstocks/sw.js (scope comment)"));

// wrangler.toml: the KV id is this account's, the vars are this repository's.
{
  let toml = read("cellstocks-worker/wrangler.toml");
  toml = swap(toml, `{ binding = "CST_KV", id = "790f6073ce2748ac950649def52dcb88" }`,
    `{ binding = "CST_KV", id = "PASTE-THE-ID-FROM-wrangler-kv-namespace-create" }`,
    "cellstocks-worker/wrangler.toml (KV id)");
  toml = swap(toml, `GITHUB_OWNER = "ucagiral"`, `GITHUB_OWNER = "YOUR-GITHUB-USERNAME"`,
    "cellstocks-worker/wrangler.toml (owner)");
  toml = swap(toml, `GITHUB_REPO = "cagiral-schedule"`, `GITHUB_REPO = "YOUR-REPO-NAME"`,
    "cellstocks-worker/wrangler.toml (repo)");
  toml = swap(toml, `ALLOWED_ORIGIN = "https://ucagiral.github.io"`,
    `ALLOWED_ORIGIN = "https://YOUR-GITHUB-USERNAME.github.io"`,
    "cellstocks-worker/wrangler.toml (allowed origin)");
  write("cellstocks-worker/wrangler.toml", toml);
}

// worker.js names the repository in one comment and one CORS fallback.
{
  let js = read("cellstocks-worker/worker.js");
  js = swap(js, "cagiral-schedule is a public repository", "this is a public repository",
    "cellstocks-worker/worker.js (comment)");
  js = swap(js, `env.ALLOWED_ORIGIN || "https://ucagiral.github.io"`,
    `env.ALLOWED_ORIGIN || "*"`, "cellstocks-worker/worker.js (CORS fallback)");
  write("cellstocks-worker/worker.js", js);
}

// The worker self-test's fixtures name our owner/repo. They are only fixtures, but they
// are compared against each other, so replacing them consistently keeps it green.
{
  let js = read("tools/cellstocks-worker-selftest.mjs");
  js = js.split("ucagiral/cagiral-schedule").join("example-lab/cell-stocks");
  js = js.split(`"ucagiral"`).join(`"example-lab"`);
  js = js.split(`"cagiral-schedule"`).join(`"cell-stocks"`);
  js = js.split("https://ucagiral.github.io").join("https://example-lab.github.io");
  write("tools/cellstocks-worker-selftest.mjs", js);
}

// The worker README is the deployment manual and worth having; it just cannot keep our
// host, our repository or the story of how our subdomain got its name.
{
  let md = read("cellstocks-worker/README.md");
  md = swap(md, "https://cellstocks-worker.caalabworkersdev.workers.dev",
    "https://<your-worker>.<your-subdomain>.workers.dev", "cellstocks-worker/README.md (host)");
  md = md.split("`cellstocks-worker.caalabworkersdev.workers.dev`").join("`<your-worker>.<your-subdomain>.workers.dev`");
  md = swap(md, "typing `caalab.workers.dev` produced the\nsubdomain `caalabworkersdev`",
    "typing `mylab.workers.dev` produces the\nsubdomain `mylabworkersdev`",
    "cellstocks-worker/README.md (subdomain story)");
  md = md.split("caalabworkersdev").join("<your-subdomain>");
  md = md.split("ucagiral").join("YOUR-GITHUB-USERNAME");
  md = md.split("cagiral-schedule").join("YOUR-REPO-NAME");
  // "Umut" reads as a stranger's name in somebody else's manual. The reasons stay; the
  // name becomes the role, so a sentence still says who decided a thing and why.
  md = md.split("the ordinary `Umut` member").join("an ordinary member")
         .split("Umut's").join("the lab lead's")
         .split("Umut").join("the lab lead");
  write("cellstocks-worker/README.md", md);
}

// ---- 4. the blanks ---------------------------------------------------------------------

// One empty lab. No freezers: the first admin draws the real one on the Structure screen,
// which is the only way it will match the room. `unplaced` is there because a box may be
// filled before anybody has said where it lives.
write("cellstocks/lab-storage.json", JSON.stringify({
  labName: "Lab Stocks",
  labIcon: "🧊",
  children: [],
  unplaced: []
}, null, 2) + "\n");

// No inventories. The directory has to exist -- the export walks it -- but a member file
// appears the first time that person saves.
write("cellstocks/data/.gitkeep", "");
write("cellstocks/exports/.gitkeep", "");

// Nobody on the morning mail yet. The daily job exits without sending on an empty list
// rather than failing, so this is a working state and not a half-configured one.
write("cellstocks/exports/recipients.json", JSON.stringify({ emails: [] }, null, 2) + "\n");

// ---- 5. the documents that only exist in the template ----------------------------------

copy("tools/cellstocks-template/README.md", "README.md");
copy("tools/cellstocks-template/CLAUDE.md", "CLAUDE.md");

// .gitattributes matters more than it looks: the generated .xlsx, .pdf and .csv are
// corrupted by git's line-ending rewriting, and the CSV one made the daily export commit
// an identical file every morning. Carried over, trimmed to this app's files.
write(".gitattributes", `# Normalize text in the repository to LF regardless of who commits from where.
* text=auto

*.png binary
*.jpg binary
*.webp binary

# Excel workbooks are zip containers: "* text=auto" would rewrite line endings inside
# them and corrupt them.
*.xlsx binary

# A PDF stores a byte offset for every object, so rewriting one line ending inside it
# moves every offset after that point and the file stops opening.
*.pdf binary

# The generated summary is written with CRLF (what Excel expects of a .csv). With the
# line endings rewritten underneath it, the daily export would see a diff every morning
# and commit an identical file.
cellstocks/exports/*.csv -text
`);

write(".gitignore", `node_modules/
.cellstocks-shots/
`);

// ---- 6. prove it -----------------------------------------------------------------------

// Nothing of ours may survive into the tree. This is the check that makes the swap()
// failures above meaningful -- it catches an identifier that arrived through a path
// nobody thought to replace.
const FORBIDDEN = [
  "ucagiral", "caalabworkersdev", "cagiral-schedule", "790f6073ce2748ac950649def52dcb88",
  "ku.edu.tr", "umut.cagiral", "CAApp"
];
const offences = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (/\.(png|jpg|jpeg|webp|xlsx|pdf)$/i.test(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const bad of FORBIDDEN) {
      if (text.includes(bad)) offences.push(`${relative(OUT, p)}: ${bad}`);
    }
  }
})(OUT);
if (offences.length) {
  console.error("template build failed: the built tree still names the original lab.\n  " + offences.join("\n  "));
  process.exit(1);
}

// And it has to actually run. The suites read the app out of the tree they are in, so
// running them here is running them against the template, not against this repository.
const suites = ["tools/cellstocks-selftest.mjs", "tools/cellstocks-worker-selftest.mjs",
                "tools/cellstocks-export-selftest.mjs", "tools/cellstocks-mail-selftest.mjs"];
for (const suite of suites) {
  try {
    execFileSync(process.execPath, [join(OUT, suite)], { cwd: OUT, stdio: ["ignore", "pipe", "pipe"] });
    console.log(`ok   ${suite}`);
  } catch (err) {
    console.error(`FAIL ${suite} inside the built template`);
    console.error((err.stdout || "").toString().split("\n").slice(-25).join("\n"));
    console.error((err.stderr || "").toString().split("\n").slice(-25).join("\n"));
    process.exit(1);
  }
}

// ---- 7. hand it over --------------------------------------------------------------------

let archivePath = null;
if (ARCHIVE) {
  archivePath = opt("--archive", join(dirname(OUT), "cellstocks-template.tar.gz"));
  rmSync(archivePath, { force: true });
  // -C so the archive unpacks into one directory rather than spraying the current one.
  execFileSync("tar", ["-czf", archivePath, "-C", dirname(OUT), "--transform",
                       `s|^${OUT.split("/").pop()}|cellstocks-template|`, OUT.split("/").pop()],
               { stdio: "inherit" });
  console.log(`\narchive: ${archivePath} (${(statSync(archivePath).size / 1024).toFixed(0)} KB)`);
}

console.log(`tree:    ${OUT}${KEEP ? "" : " (temporary)"}`);
if (!KEEP && ARCHIVE) rmSync(OUT, { recursive: true, force: true });
