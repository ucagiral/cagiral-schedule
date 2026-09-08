// Checks that the daily layout export actually contains the freezer, in all three shapes.
//
// It runs tools/cellstocks-export.mjs the way the scheduled job does -- as a process, over
// a fixture checkout built here -- and then reads the three files back. Reading them back
// matters: an .xlsx that no reader accepts and a PDF whose cross-reference table is wrong
// both "write successfully", and neither is worth mailing anybody.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
new Function(readFileSync(join(HERE, "cellstocks", "xlsx.js"), "utf8"))();
const X = globalThis.XlsxLite;

let failures = 0;
const results = [];
async function check(name, fn) {
  let problem = null;
  try { problem = await fn(); } catch (err) { problem = String(err && err.stack || err); }
  if (problem) { failures++; results.push(`  ✗ ${name}\n    ${problem}`); }
}

// ---------------------------------------------------------------- a fixture freezer
const root = mkdtempSync(join(tmpdir(), "cellstocks-export-"));
mkdirSync(join(root, "cellstocks", "data"), { recursive: true });

// Layers all the way down, as deep as the admin cared to go, until a node says it is a
// box. This fixture goes four deep on one branch and one deep on another, on purpose:
// nothing in the export may assume the old unit/rack/box triple.
writeFileSync(join(root, "cellstocks", "lab-storage.json"), JSON.stringify({
  labName: "Fixture Lab",
  labIcon: "🏛️",
  children: [
    { id: "u-80", name: "-80 Freezer", icon: "🧊", note: "-80 · 269 Middle Door", children: [
      { id: "s-1", name: "Shelf 1", icon: "📁", note: "", children: [
        { id: "r-1", name: "Rack 1", icon: "📁", note: "", children: [
          { id: "b-1", name: "BOX ONE", icon: "📦", note: "", isBox: true,
            owner: "umut", rows: 3, cols: 3, scheme: "grid", archived: false },
          { id: "b-2", name: "BOX TWO", icon: "📦", note: "", isBox: true,
            owner: "busra", rows: 2, cols: 2, scheme: "grid", archived: false }
        ] }
      ] }
    ] },
    { id: "u-ln2", name: "LN2 Tank", icon: "🥶", note: "-196", children: [
      { id: "t-1", name: "Tower 1", icon: "📁", note: "", children: [] }
    ] }
  ],
  // A box a member has added and filled, that the admin has not yet given a home to. It
  // is real inventory and has to appear in all three files.
  unplaced: [
    { id: "b-3", name: "BOX THREE", icon: "📦", note: "", isBox: true,
      owner: "umut", rows: 2, cols: 2, scheme: "grid", archived: false }
  ]
}, null, 2));

const vial = (id, name, boxId, position, passage) => ({
  id, name, lineId: name.toLowerCase().replace(/\s+/g, "-"),
  passage, passageNumber: Number(String(passage).replace(/\D/g, "")) || null, passageKind: "absolute",
  frozenOn: "2025-06-01", frozenRaw: "01-06-25", notes: "", flags: [],
  location: { boxId, position, path: [] }, status: "stored"
});

writeFileSync(join(root, "cellstocks", "data", "umut.json"), JSON.stringify({
  lines: [], rules: {}, settings: {},
  // A live Add records who and when; the roster's "log" sheet reads exactly this, so an
  // imported/pre-existing vial (v-1, v-4 below) with neither must contribute nothing to it.
  vials: [
    vial("v-1", "HEK293T ATP7B KO", "b-1", "A1", "p12"),
    Object.assign(vial("v-2", "Du145 CASPEX g5.1", "b-1", "B2", "p7"),
                  { addedBy: "umut-phone", addedAt: "2026-09-07T10:00:00Z" }),
    vial("v-4", "Homeless Line", "b-3", "A1", "p2"),
    // A withdrawn vial must not appear anywhere in the export: it is not in the freezer.
    { id: "v-3", name: "Already Taken Out", status: "withdrawn", location: null, flags: [] }
  ],
  withdrawals: [
    { date: "2026-09-08", name: "Already Taken Out", by: "umut-phone",
      from: { boxId: "b-1", position: "C3" }, purpose: "thaw", notes: "", vialId: "v-3" }
  ]
}, null, 2));
writeFileSync(join(root, "cellstocks", "data", "busra.json"), JSON.stringify({
  lines: [], withdrawals: [], rules: {}, settings: {},
  vials: [
    // A non-"cell" kind carries its own free-form attributes; the roster has to surface
    // this as a column without it ever being named in code.
    Object.assign(vial("v-1", "Şişli Line", "b-2", "A1", "p3"),
                  { customFacets: { doxInducible: "yes" } })   // same id as umut's, on purpose
  ]
}, null, 2));

const outDir = join(root, "out");
execFileSync("node", [join(HERE, "tools", "cellstocks-export.mjs"), "--root", root, "--out", outDir],
  { stdio: "pipe" });

// ------------------------------------------------------------------------- the checks
await check("all three files are written", () => {
  for (const f of ["layout.xlsx", "layout.pdf", "layout.csv"]) {
    if (!existsSync(join(outDir, f))) return `${f} is missing`;
  }
  return null;
});

await check("the workbook opens, and has a sheet per box plus the index", async () => {
  const wb = await X.readWorkbook(readFileSync(join(outDir, "layout.xlsx")));
  const names = wb.sheets.map((s) => s.name);
  if (names[0] !== "boxes") return `first sheet is ${names[0]}, not the index`;
  for (const want of ["BOX ONE", "BOX TWO", "BOX THREE"]) {
    if (!names.includes(want)) return `no sheet for ${want}: ${JSON.stringify(names)}`;
  }
  return null;
});

await check("a box's grid holds its vials in the right cells", async () => {
  const wb = await X.readWorkbook(readFileSync(join(outDir, "layout.xlsx")));
  const sheet = wb.sheets.filter((s) => s.name === "BOX ONE")[0];
  const rows = sheet.rows.map((r) => r.map((c) => (c ? String(c.value) : "")));
  const flat = JSON.stringify(rows);
  if (!/HEK293T ATP7B KO p12/.test(flat)) return `A1's vial is not in the grid: ${flat}`;
  if (!/Du145 CASPEX g5.1 p7/.test(flat)) return `B2's vial is not in the grid: ${flat}`;
  if (/Already Taken Out/.test(flat)) return "a withdrawn vial was drawn into the freezer";
  // The header row is the grid's own: a label column then 1..cols.
  const header = rows.filter((r) => r[1] === "1" && r[2] === "2")[0];
  if (!header) return `no column header row: ${flat}`;
  const bRow = rows.filter((r) => r[0] === "B")[0];
  if (!bRow || !/Du145/.test(bRow[2] || "")) return `B2 is not at row B, column 2: ${JSON.stringify(bRow)}`;
  return null;
});

await check("the index counts each box, including the empty ones", async () => {
  const wb = await X.readWorkbook(readFileSync(join(outDir, "layout.xlsx")));
  const rows = wb.sheets[0].rows.map((r) => r.map((c) => (c ? String(c.value) : "")));
  const one = rows.filter((r) => r[2] === "BOX ONE")[0];
  const two = rows.filter((r) => r[2] === "BOX TWO")[0];
  if (!one || one[3] !== "umut" || one[6] !== "2" || one[7] !== "9") {
    return `BOX ONE row wrong (owner/used/capacity): ${JSON.stringify(one)}`;
  }
  if (!two || two[3] !== "busra" || two[6] !== "1" || two[7] !== "4") {
    return `BOX TWO row wrong: ${JSON.stringify(two)}`;
  }
  // The whole route, not just the layer above it -- the tree is four deep on this branch.
  if (one[1] !== "-80 Freezer → Shelf 1 → Rack 1") return `BOX ONE's location is wrong: ${one[1]}`;
  if (one[0] !== "-80 Freezer") return `BOX ONE's area is wrong: ${one[0]}`;
  return null;
});

await check("a box nobody has placed yet is still in the index, said so", async () => {
  const wb = await X.readWorkbook(readFileSync(join(outDir, "layout.xlsx")));
  const rows = wb.sheets[0].rows.map((r) => r.map((c) => (c ? String(c.value) : "")));
  const three = rows.filter((r) => r[2] === "BOX THREE")[0];
  if (!three) return `BOX THREE is missing from the index: ${JSON.stringify(rows)}`;
  if (three[0] !== "Not placed yet" || three[1] !== "Not placed yet") {
    return `an unplaced box claims a location: ${JSON.stringify(three)}`;
  }
  if (three[3] !== "umut" || three[6] !== "1") return `BOX THREE row wrong: ${JSON.stringify(three)}`;
  return null;
});

await check("two members' vials both land, even sharing an id", async () => {
  const wb = await X.readWorkbook(readFileSync(join(outDir, "layout.xlsx")));
  const two = wb.sheets.filter((s) => s.name === "BOX TWO")[0];
  const flat = JSON.stringify(two.rows.map((r) => r.map((c) => (c ? String(c.value) : ""))));
  // Both members named a vial "v-1"; the export namespaces them rather than losing one.
  if (!/Şişli Line p3/.test(flat)) return `busra's vial is missing from BOX TWO: ${flat}`;
  return null;
});

await check("the summary is one row per box, with a BOM so Excel reads it as UTF-8", () => {
  const csv = readFileSync(join(outDir, "layout.csv"), "utf8");
  if (csv.charCodeAt(0) !== 0xfeff) return "no BOM -- Excel will mangle the first column";
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  // A header and the fixture's three boxes. Tower 1 holds none, so it contributes no row:
  // this is a list of boxes, not of layers.
  if (lines.length !== 4) return `expected a header and three boxes, got ${lines.length}: ${JSON.stringify(lines)}`;
  if (!lines[0].startsWith("area,location,box,owner")) return `unexpected header: ${lines[0]}`;
  if (!lines.some((l) => l.includes("BOX ONE") && l.endsWith(",3,3,2,9,7"))) {
    return `BOX ONE's counts are wrong: ${JSON.stringify(lines)}`;
  }
  // The full route travels as one cell, quoted where it needs to be, not flattened.
  if (!lines.some((l) => l.includes("-80 Freezer → Shelf 1 → Rack 1"))) {
    return `the path never reaches the summary: ${JSON.stringify(lines)}`;
  }
  if (!lines.some((l) => l.startsWith("Not placed yet,Not placed yet,BOX THREE"))) {
    return `the unplaced box is missing from the summary: ${JSON.stringify(lines)}`;
  }
  return null;
});

await check("the PDF is a real PDF: every xref offset lands on its object", () => {
  const bytes = readFileSync(join(outDir, "layout.pdf"));
  const text = bytes.toString("latin1");
  if (!text.startsWith("%PDF-")) return "no PDF header";
  if (!/%%EOF\s*$/.test(text)) return "no EOF marker";
  const m = text.match(/xref\n0 (\d+)\n([\s\S]*?)trailer/);
  if (!m) return "no cross-reference table";
  const rows = m[2].trim().split("\n").slice(1);
  for (let i = 0; i < rows.length; i++) {
    const off = Number(rows[i].slice(0, 10));
    const want = `${i + 1} 0 obj`;
    if (text.slice(off, off + want.length) !== want) {
      return `xref entry ${i + 1} points at ${JSON.stringify(text.slice(off, off + 16))}`;
    }
  }
  const pagesNode = Number((text.match(/(\d+) 0 obj\n<< \/Type \/Pages /) || [])[1]);
  const parents = [...new Set([...text.matchAll(/\/Parent (\d+) 0 R/g)].map((x) => Number(x[1])))];
  if (parents.length !== 1 || parents[0] !== pagesNode) {
    return `pages claim parent ${JSON.stringify(parents)}, the /Pages node is ${pagesNode}`;
  }
  const declared = Number((text.match(/\/Count (\d+)/) || [])[1]);
  const actual = (text.match(/\/Type \/Page[^s]/g) || []).length;
  if (declared !== actual) return `/Count says ${declared}, there are ${actual} pages`;
  return null;
});

await check("the map names the freezer, the boxes and what is in them", () => {
  const text = readFileSync(join(outDir, "layout.pdf")).toString("latin1");
  // Text is written as PDF string literals, so the words are readable in the raw file.
  for (const want of ["Fixture Lab", "-80 Freezer", "Shelf 1", "Rack 1", "LN2 Tank",
                      "BOX ONE", "BOX TWO", "BOX THREE", "Not placed yet", "umut", "busra"]) {
    if (!text.includes("(" + want)) return `the map never mentions ${want}`;
  }
  if (!/HEK293T/.test(text)) return "no vial made it into a printed grid";
  if (/Already Taken Out/.test(text)) return "a withdrawn vial was printed into the map";
  // One page for the tree, then one per box.
  const pages = (text.match(/\/Type \/Page[^s]/g) || []).length;
  if (pages !== 1 + 3) return `expected the tree page plus one per box, got ${pages}`;
  return null;
});

await check("the map indents each layer under the one above it, however deep", () => {
  const text = readFileSync(join(outDir, "layout.pdf")).toString("latin1");
  // Every line is drawn as "x y Td (text) Tj", so the x it was drawn at is recoverable.
  const at = (label) => {
    const m = text.match(new RegExp("([\\d.]+) [\\d.]+ Td\\n?[^\\n]*\\(" + label));
    return m ? Number(m[1]) : null;
  };
  const freezer = at("-80 Freezer"), shelf = at("Shelf 1"), rack = at("Rack 1"), box = at("BOX ONE");
  if ([freezer, shelf, rack, box].some((x) => x === null)) {
    return `a layer is missing from the tree page: ${JSON.stringify({ freezer, shelf, rack, box })}`;
  }
  if (!(freezer < shelf && shelf < rack && rack < box)) {
    return `the tree is not indented by depth: ${JSON.stringify({ freezer, shelf, rack, box })}`;
  }
  return null;
});

await check("a Turkish name survives into the PDF, folded rather than dropped", () => {
  const text = readFileSync(join(outDir, "layout.pdf")).toString("latin1");
  // The standard-14 fonts are single-byte, so "Şişli" prints as "Sisli" -- a real
  // limitation, but the name still reads, which is the point.
  if (!/Sisli Line/.test(text)) return "the Turkish vial name is missing from the map entirely";
  return null;
});

// -------------------------------------------------------------- the roster (flat, per-person)
await check("roster.xlsx is written, one sheet per member plus the lab-wide log", async () => {
  if (!existsSync(join(outDir, "roster.xlsx"))) return "roster.xlsx is missing";
  const wb = await X.readWorkbook(readFileSync(join(outDir, "roster.xlsx")));
  const names = wb.sheets.map((s) => s.name);
  for (const want of ["umut", "busra", "log"]) {
    if (!names.includes(want)) return `no "${want}" sheet: ${JSON.stringify(names)}`;
  }
  return null;
});

await check("a member's sheet lists only their active vials, with the fixed columns filled", async () => {
  const wb = await X.readWorkbook(readFileSync(join(outDir, "roster.xlsx")));
  const sheet = wb.sheets.filter((s) => s.name === "umut")[0];
  const rows = sheet.rows.map((r) => r.map((c) => (c ? c.value : "")));
  const flat = JSON.stringify(rows);
  if (!/HEK293T ATP7B KO/.test(flat) || !/Du145 CASPEX g5.1/.test(flat) || !/Homeless Line/.test(flat)) {
    return `umut's active vials are not all present: ${flat}`;
  }
  if (/Already Taken Out/.test(flat)) return "a withdrawn vial leaked into the per-person sheet";
  const hek = rows.filter((r) => r[0] === "HEK293T ATP7B KO")[0];
  const originIdx = rows[0].indexOf("origin"), locationIdx = rows[0].indexOf("location");
  if (!hek || hek[originIdx] !== "HEK293T") return `origin facet missing/wrong: ${JSON.stringify(hek)}`;
  if (!/Rack 1/.test(hek[locationIdx] || "")) return `location is not the full chain path: ${JSON.stringify(hek)}`;
  return null;
});

await check("a customFacets key becomes its own column, blank where a vial doesn't carry it", async () => {
  const wb = await X.readWorkbook(readFileSync(join(outDir, "roster.xlsx")));
  const busra = wb.sheets.filter((s) => s.name === "busra")[0];
  const header = busra.rows[0].map((c) => (c ? c.value : ""));
  const idx = header.indexOf("doxInducible");
  if (idx === -1) return `no doxInducible column on busra's sheet: ${JSON.stringify(header)}`;
  const row = busra.rows[1].map((c) => (c ? c.value : ""));
  if (row[idx] !== "yes") return `busra's Şişli Line should read "yes": ${JSON.stringify(row)}`;

  const umut = wb.sheets.filter((s) => s.name === "umut")[0];
  const uHeader = umut.rows[0].map((c) => (c ? c.value : ""));
  if (uHeader.indexOf("doxInducible") === -1) return "the column must be shared across every sheet, not just busra's";
  const uIdx = uHeader.indexOf("doxInducible");
  const bad = umut.rows.slice(1).find((r) => (r[uIdx] ? r[uIdx].value : "") !== "");
  if (bad) return `a vial with no customFacets should read blank, not ${JSON.stringify(bad)}`;
  return null;
});

await check("the log sheet has one row for the addition and one for the withdrawal, correctly owned", async () => {
  const wb = await X.readWorkbook(readFileSync(join(outDir, "roster.xlsx")));
  const log = wb.sheets.filter((s) => s.name === "log")[0];
  const rows = log.rows.slice(1).map((r) => r.map((c) => (c ? c.value : "")));
  const header = log.rows[0].map((c) => (c ? c.value : ""));
  const added = rows.find((r) => r[header.indexOf("action")] === "added" &&
                                  r[header.indexOf("name")] === "Du145 CASPEX g5.1");
  if (!added) return `no "added" row for Du145 CASPEX g5.1: ${JSON.stringify(rows)}`;
  if (added[header.indexOf("by")] !== "umut-phone" || added[header.indexOf("owner")] !== "umut") {
    return `the added row's who/owner is wrong: ${JSON.stringify(added)}`;
  }
  const withdrawn = rows.find((r) => r[header.indexOf("action")] === "withdrawn");
  if (!withdrawn || withdrawn[header.indexOf("name")] !== "Already Taken Out") {
    return `no "withdrawn" row for Already Taken Out: ${JSON.stringify(rows)}`;
  }
  if (withdrawn[header.indexOf("owner")] !== "umut") return `withdrawn row has the wrong owner: ${JSON.stringify(withdrawn)}`;
  // An imported/pre-existing vial with neither addedBy nor addedAt (v-1, v-4) must not
  // fabricate an "added" entry -- only what was actually recorded shows up.
  const fabricated = rows.find((r) => r[header.indexOf("action")] === "added" &&
                                       (r[header.indexOf("name")] === "HEK293T ATP7B KO" ||
                                        r[header.indexOf("name")] === "Homeless Line"));
  if (fabricated) return `an addition was fabricated for a vial with no addedBy/addedAt: ${JSON.stringify(fabricated)}`;
  return null;
});

await check("hiding a column via recipients.json's rosterHiddenColumns drops it from every sheet", async () => {
  mkdirSync(join(root, "cellstocks", "exports"), { recursive: true });
  writeFileSync(join(root, "cellstocks", "exports", "recipients.json"),
    JSON.stringify({ emails: [], sendAt: "07:30", timeZone: "Europe/Istanbul",
                     rosterHiddenColumns: ["notes", "doxInducible"] }, null, 2));
  const outDir2 = join(root, "out2");
  execFileSync("node", [join(HERE, "tools", "cellstocks-export.mjs"), "--root", root, "--out", outDir2],
    { stdio: "pipe" });
  const wb = await X.readWorkbook(readFileSync(join(outDir2, "roster.xlsx")));
  const umut = wb.sheets.filter((s) => s.name === "umut")[0];
  const header = umut.rows[0].map((c) => (c ? c.value : ""));
  if (header.includes("notes") || header.includes("doxInducible")) {
    return `a hidden column is still present: ${JSON.stringify(header)}`;
  }
  if (!header.includes("origin")) return `hiding two columns should not touch the others: ${JSON.stringify(header)}`;
  return null;
});

console.log("");
if (failures) {
  console.log(`${failures} of 16 cell stocks export checks failed:\n`);
  results.forEach((r) => console.log(r + "\n"));
  process.exit(1);
}
console.log("All 16 cell stocks export checks passed.");
