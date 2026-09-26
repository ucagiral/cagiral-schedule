// One-off: drop the default kind written onto hand-frozen cells, and regenerate every
// workbook the generator now writes differently.
//
// Run:  node tools/cellstocks-normalise-kind.mjs [--write]
//
// Without --write it prints what it would do and changes nothing.
//
// The Add screen sends kind "Cell"; the engine's default is "cell", and applyPlacement
// compared the two case-sensitively -- so every vial frozen by hand got `kind: "Cell"`
// written onto it (46 of umut's), against the rule that the default is never written.
// That is fixed in the engine; this removes the ones already written. The value meant
// Cell either way, so nothing about any vial changes except that one redundant field.
//
// The workbooks are regenerated when their content differs from what the generator now
// produces (primer rows no longer carry cell facets, stock counts are per cell line), by
// the same comparison CI makes -- never by guessing which account is affected.

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
const flatten = (wb) => wb.sheets.map((s) => [s.name, s.rows.map((r) => r.map((c) => (c ? c.value : null)))]);

for (const name of readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort()) {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, `${name}.json`), "utf8"));
  let dropped = 0;
  (raw.vials || []).forEach((v) => {
    if (v.kind !== undefined && String(v.kind).toLowerCase() === E.DEFAULT_KIND) { delete v.kind; dropped++; }
  });
  const state = E.hydrateRules(E.hydrateStorage(E.mergeDefaults(raw), lab, name), labRules);
  const xlsxPath = join(DATA_DIR, `${name}.xlsx`);
  let workbookStale = false;
  let fresh = null;
  if (existsSync(xlsxPath)) {
    fresh = await X.writeWorkbookAsync(E.vialsToSheets(state));
    const onDisk = await X.readWorkbook(readFileSync(xlsxPath));
    workbookStale = JSON.stringify(flatten(await X.readWorkbook(fresh))) !== JSON.stringify(flatten(onDisk));
  }
  if (!dropped && !workbookStale) continue;
  console.log(`${name}: ${dropped} redundant kind field(s)` + (workbookStale ? ", workbook regenerated" : ""));
  if (!write) continue;
  if (dropped) writeFileSync(join(DATA_DIR, `${name}.json`), JSON.stringify(raw, null, 2) + "\n");
  if (workbookStale) writeFileSync(xlsxPath, Buffer.from(fresh));
}
if (!write) console.log("dry run -- rerun with --write");
