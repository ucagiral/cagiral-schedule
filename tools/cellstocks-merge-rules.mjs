// One-off: merge every account's classification rules into the lab's shared set.
//
// Run:  node tools/cellstocks-merge-rules.mjs [--write]
//
// Without --write it prints what it would do and changes nothing. That is the point:
// merging rules changes how cell names are read, and nothing in this repository gets
// repaired behind Umut's back.
//
// Why this exists: every account started from the same DEFAULT_RULES and then edited its
// own private copy, so the lab was classifying the same cell name differently depending
// on whose screen you were looking at -- admin read "Du145 TOX4 KO" as a knockout and
// umut's copy read it as an overexpression. Umut asked for one shared set. From here on
// the rules live in cellstocks/lab-rules.json and a member's own file carries none.
//
// The merge itself is E.mergeRuleSets, in the engine, so the app and this tool can never
// disagree about it. Accounts are merged in alphabetical order, which is arbitrary but
// deterministic -- and every place two accounts genuinely disagree is printed rather than
// quietly settled.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "cellstocks", "data");
const RULES_PATH = join(ROOT, "cellstocks", "lab-rules.json");
const STORAGE_PATH = join(ROOT, "cellstocks", "lab-storage.json");
const write = process.argv.includes("--write");

new Function(readFileSync(join(ROOT, "cellstocks", "engine.js"), "utf8"))();
const E = globalThis.CellStocksEngine;

const members = existsSync(DATA_DIR)
  ? readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort()
  : [];
if (!members.length) {
  console.log("no accounts under cellstocks/data -- nothing to merge");
  process.exit(0);
}

const raw = {};
const sets = members.map((name) => {
  raw[name] = JSON.parse(readFileSync(join(DATA_DIR, `${name}.json`), "utf8"));
  return { owner: name, rules: raw[name].rules };
});

const { rules, conflicts } = E.mergeRuleSets(sets);

console.log(`merging the rules of ${members.length} account(s): ${members.join(", ")}`);
E.FACETS.forEach((facet) => {
  const before = members.map((n) => ((raw[n].rules || {})[facet] || []).length);
  console.log(`  ${facet.padEnd(11)} ${before.join(" + ")} rules -> ${rules[facet].length}`);
});

if (conflicts.length) {
  console.log(`\n${conflicts.length} place(s) where two accounts genuinely disagree.`);
  console.log("The first account alphabetically wins; the other reading is listed here so");
  console.log("Umut can flip it from Settings -> Rules if it is the wrong way round.\n");
  conflicts.forEach((c) => {
    console.log(`  ${c.facet}: a name matching ${JSON.stringify(c.matcher)}`);
    console.log(`    reads as ${JSON.stringify(c.kept)} (${c.keptFrom}), not ${JSON.stringify(c.dropped)} (${c.droppedFrom})`);
  });
} else {
  console.log("\nno account contradicts another -- the merge is a plain union.");
}

// What this actually does to the vials in the freezer, which is the only part that can
// hurt. A facet somebody pinned by hand is never recomputed, so it is counted separately.
const labStorage = existsSync(STORAGE_PATH)
  ? E.mergeStorageDefaults(JSON.parse(readFileSync(STORAGE_PATH, "utf8"))) : E.blankStorage();
let moved = 0, pinned = 0, examples = [];
members.forEach((name) => {
  const own = E.mergeDefaults(JSON.parse(JSON.stringify(raw[name])));
  const before = E.hydrateStorage(own, labStorage, name);
  const after = E.hydrateRules(before, rules);
  (before.vials || []).forEach((v, i) => {
    const wasF = E.facetsFor(v, before.rules);
    const nowF = E.facetsFor(after.vials[i], after.rules);
    E.FACETS.forEach((f) => {
      if (wasF[f] === nowF[f]) return;
      if (v.facetsSetByHand && v.facetsSetByHand[f] !== undefined) { pinned++; return; }
      moved++;
      if (examples.length < 8) examples.push(`${name}: ${v.name} — ${f} ${JSON.stringify(wasF[f])} -> ${JSON.stringify(nowF[f])}`);
    });
  });
});
console.log(`\n${moved} vial facet(s) read differently under the merged rules` +
            (pinned ? `, plus ${pinned} that are pinned by hand and so do not move` : "") + ".");
examples.forEach((e) => console.log("  " + e));

if (!write) {
  console.log("\n(nothing written — re-run with --write to apply)");
  process.exit(0);
}

writeFileSync(RULES_PATH, E.serialiseRules(rules));
console.log(`\nwrote cellstocks/lab-rules.json`);
members.forEach((name) => {
  const own = E.mergeDefaults(JSON.parse(JSON.stringify(raw[name])));
  const hydrated = E.hydrateRules(E.hydrateStorage(own, labStorage, name), rules);
  // E.serialise slims it: the rules go out of the member's file the same way the
  // storage tree already has.
  const text = E.serialise(hydrated);
  if (text === readFileSync(join(DATA_DIR, `${name}.json`), "utf8")) return;
  writeFileSync(join(DATA_DIR, `${name}.json`), text);
  console.log(`  rewrote cellstocks/data/${name}.json without its own copy of the rules`);
});
console.log("\nWorkbooks are regenerated by the app on its next save, and by CI's own check.");
