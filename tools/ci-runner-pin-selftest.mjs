// A workflow that installs Playwright must not run on a floating runner image.
// `ubuntu-latest` moved to 26.04 on its own, Playwright 1.56.1 does not support it,
// and every push to main failed in the install step (2026-11-20). Pin the image.
import fs from "fs";
const dir = ".github/workflows";
let bad = 0;
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
  const text = fs.readFileSync(`${dir}/${f}`, "utf8");
  if (!/playwright install/.test(text)) continue;
  // every job's runs-on in a Playwright workflow must be an explicit version
  for (const m of text.matchAll(/^\s*runs-on:\s*(\S+)/gm)) {
    if (/latest/.test(m[1])) { console.error(`${f}: runs-on ${m[1]} floats; pin e.g. ubuntu-24.04`); bad++; }
  }
}
if (bad) process.exit(1);
console.log("All Playwright workflows use a pinned runner image.");
