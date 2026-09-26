// One-off: move primer rows the import left in Review into their own box, loose.
//
// Run:  node tools/cellstocks-place-loose.mjs [--write]
//
// Without --write it prints what it would do and changes nothing.
//
// Umut's primer sheet names each primer's box and no slot. It was imported before
// importSheet() knew how to bring a slotless non-Cell row in loose, so all of it sat
// in Review as "could not be placed" and none of it showed on the Boxes tab. His call,
// asked and answered: show them in their box as a list, do not invent slots. The move
// itself is E.placeLooseImports, in the engine, so the app and this tool cannot
// disagree about which rows qualify. The workbook is regenerated alongside each file
// it touches, exactly as the app does on save and as CI checks.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "cellstocks", "data");
const write = process.argv.includes("--write");

new Function(readFileSync(join(ROOT, "cellstocks", "xlsx.js"), "utf8"))();
new Function(readFileSync(join(ROOT, "cellstocks", "engine.js"), "utf8"))();
const E = globalThis.CellStocksEngine;
const X = globalThis.XlsxLite;

const lab = E.mergeStorageDefaults(JSON.parse(readFileSync(join(ROOT, "cellstocks", "lab-storage.json"), "utf8")));
const rulesPath = join(ROOT, "cellstocks", "lab-rules.json");
const labRules = E.mergeRulesDefaults(existsSync(rulesPath) ? JSON.parse(readFileSync(rulesPath, "utf8")) : null);

const members = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
let total = 0;
for (const name of members) {
  const own = E.mergeDefaults(JSON.parse(readFileSync(join(DATA_DIR, `${name}.json`), "utf8")));
  const state = E.hydrateRules(E.hydrateStorage(own, lab, name), labRules);
  const r = E.placeLooseImports(state);
  if (!r.placed.length && !r.skipped.length) continue;
  console.log(`${name}: ${r.placed.length} placed loose` + (r.skipped.length ? `, ${r.skipped.length} left for Review` : ""));
  r.skipped.forEach((s) => console.log(`  left: ${s.name} (box "${s.box}") -- ${s.why}`));
  const errors = E.errorsOnly(E.validate(r.state));
  if (errors.length) {
    console.error(`  refusing ${name}: the result would not validate -- ${errors[0].message}`);
    process.exitCode = 1;
    continue;
  }
  total += r.placed.length;
  if (!write || !r.placed.length) continue;
  writeFileSync(join(DATA_DIR, `${name}.json`), E.serialise(r.state));
  if (existsSync(join(DATA_DIR, `${name}.xlsx`))) {
    writeFileSync(join(DATA_DIR, `${name}.xlsx`), Buffer.from(await X.writeWorkbookAsync(E.vialsToSheets(r.state))));
  }
}
console.log(write ? `wrote ${total} vial(s)` : `dry run: ${total} vial(s) would move -- rerun with --write`);
