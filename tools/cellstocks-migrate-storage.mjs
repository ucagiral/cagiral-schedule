// One-off: lifts the freezer out of everybody's file and into the lab's own.
//
// Run:  node tools/cellstocks-migrate-storage.mjs [--write]
//
// Until now every account carried its own copy of the storage tree, so the one physical
// -80 in the lab existed as several unrelated records -- Umut's "-80 °C Freezer" and
// anybody else's were different objects that happened to share a name. His picture of
// what he wanted has no person level in it at all: CAA Lab Stocks opens straight into
// the freezers. This moves the structure to cellstocks/lab-storage.json, stamps every
// box with the member who owns it, and takes `storage` back out of the member files.
// Vials do not move: they stay in their owner's file, still pointing at the same box id.
//
// Without --write it only prints what it would do. The result is reviewed as an ordinary
// diff before it is committed, per CLAUDE.md: nothing is repaired behind his back.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "cellstocks", "data");
const STORAGE_FILE = join(ROOT, "cellstocks", "lab-storage.json");
const WRITE = process.argv.includes("--write");

new Function(readFileSync(join(ROOT, "cellstocks", "engine.js"), "utf8"))();
const E = globalThis.CellStocksEngine;

const members = readdirSync(DATA_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

const report = [];
const lab = E.blankStorage();
if (existsSync(STORAGE_FILE)) {
  Object.assign(lab, E.mergeStorageDefaults(JSON.parse(readFileSync(STORAGE_FILE, "utf8"))));
  report.push(`starting from the existing cellstocks/lab-storage.json (${lab.units.length} unit(s))`);
}

// Every id already spoken for, so a second member's "b-box-1" cannot quietly land on
// top of the first member's. Collisions are renamed and the owner's vials follow.
const takenUnitIds = new Set(lab.units.map((u) => u.id));
const takenRackIds = new Set();
const takenBoxIds = new Set();
(function seed(units) {
  units.forEach((u) => (function walk(racks) {
    (racks || []).forEach((r) => {
      takenRackIds.add(r.id);
      (r.boxes || []).forEach((b) => takenBoxIds.add(b.id));
      walk(r.racks);
    });
  })(u.racks));
})(lab.units);

function freshId(wanted, taken) {
  if (!taken.has(wanted)) { taken.add(wanted); return wanted; }
  let n = 2;
  while (taken.has(`${wanted}-${n}`)) n++;
  taken.add(`${wanted}-${n}`);
  return `${wanted}-${n}`;
}

const rewritten = {};   // member -> updated state (storage removed, ids fixed)

for (const member of members) {
  const file = join(DATA_DIR, `${member}.json`);
  const state = JSON.parse(readFileSync(file, "utf8"));
  const units = (state.storage && state.storage.units) || [];
  const boxIdChanges = {};

  units.forEach((unit) => {
    // Two members' units are the same physical freezer only when they named it exactly
    // the same. Anything else stays separate and is listed below for Umut to merge by
    // hand in the tree -- guessing which near-identical names mean one freezer is the
    // kind of repair this repo does not do on its own.
    let target = lab.units.find((u) => u.name.trim().toLowerCase() === String(unit.name).trim().toLowerCase());
    if (!target) {
      target = {
        id: freshId(unit.id, takenUnitIds),
        name: unit.name,
        type: unit.type || "",
        note: unit.note || "",
        childLabel: unit.childLabel || "Rack",
        racks: []
      };
      lab.units.push(target);
      report.push(`${member}: "${unit.name}" becomes a lab freezer/tank (${target.id})`);
    } else {
      report.push(`${member}: "${unit.name}" merges into the existing lab unit ${target.id} (same name)`);
    }

    (function copyRacks(from, into) {
      (from || []).forEach((rack) => {
        let sibling = (into || []).find((r) => r.name.trim().toLowerCase() === String(rack.name).trim().toLowerCase());
        if (!sibling) {
          sibling = { id: freshId(rack.id, takenRackIds), name: rack.name, boxes: [], racks: [] };
          if (rack.icon) sibling.icon = rack.icon;
          into.push(sibling);
        }
        (rack.boxes || []).forEach((box) => {
          const id = freshId(box.id, takenBoxIds);
          if (id !== box.id) {
            boxIdChanges[box.id] = id;
            report.push(`${member}: box id ${box.id} was already taken, renamed to ${id}`);
          }
          sibling.boxes = sibling.boxes || [];
          sibling.boxes.push(Object.assign({}, box, { id, owner: member }));
        });
        if (rack.racks && rack.racks.length) {
          sibling.racks = sibling.racks || [];
          copyRacks(rack.racks, sibling.racks);
        }
      });
    })(unit.racks, target.racks);
  });

  const next = JSON.parse(JSON.stringify(state));
  delete next.storage;
  let moved = 0;
  (next.vials || []).forEach((v) => {
    if (!v.location) return;
    if (boxIdChanges[v.location.boxId]) { v.location.boxId = boxIdChanges[v.location.boxId]; moved++; }
  });
  if (moved) report.push(`${member}: ${moved} vial(s) repointed at a renamed box id`);
  rewritten[member] = next;

  const boxCount = units.reduce((n, u) => n + E.leafRacks({ units: [u] }).reduce((m, l) => m + (l.rack.boxes || []).length, 0), 0);
  report.push(`${member}: ${units.length} unit(s), ${boxCount} box(es), ${(state.vials || []).length} vial(s)`);
}

// Prove it before writing it: every vial in every member's file must still resolve to a
// real slot in the shared tree, with the same box and the same position it had before.
const problems = [];
for (const member of members) {
  const before = JSON.parse(readFileSync(join(DATA_DIR, `${member}.json`), "utf8"));
  const after = E.hydrateStorage(E.mergeDefaults(rewritten[member]), lab, member);
  (before.vials || []).forEach((v, i) => {
    if (!v.location || !v.location.boxId) return;
    const now = (after.vials || [])[i];
    const found = E.findBox(after, now.location.boxId);
    if (!found) { problems.push(`${member}: ${v.name} points at a box that is not in the lab tree`); return; }
    if (now.location.position !== v.location.position) {
      problems.push(`${member}: ${v.name} changed position ${v.location.position} -> ${now.location.position}`);
    }
    const wasPath = E.locationPath(E.mergeDefaults(before), v.location).split(" → ").slice(-2).join(" → ");
    const nowPath = E.locationPath(after, now.location).split(" → ").slice(-2).join(" → ");
    if (wasPath !== nowPath) problems.push(`${member}: ${v.name} moved: ${wasPath} -> ${nowPath}`);
  });
  const errors = E.errorsOnly(E.validate(after));
  errors.forEach((e) => problems.push(`${member}: ${e.message}`));
}

console.log(report.join("\n"));
console.log("");
if (problems.length) {
  console.error(`${problems.length} problem(s) -- nothing written:\n`);
  problems.slice(0, 20).forEach((p) => console.error(`  ✗ ${p}`));
  process.exit(1);
}
console.log(`every vial still resolves to the same box and slot (${members.length} account(s) checked)`);

if (!WRITE) {
  console.log("\nDry run. Re-run with --write to actually move the files.");
  process.exit(0);
}

writeFileSync(STORAGE_FILE, E.serialiseStorage(lab));
for (const member of members) {
  writeFileSync(join(DATA_DIR, `${member}.json`), E.serialise(E.mergeDefaults(rewritten[member])));
}
console.log(`\nwrote cellstocks/lab-storage.json and ${members.length} member file(s)`);
