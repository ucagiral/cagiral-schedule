// Builds the daily freezer layout exports, in the four shapes Umut asked for:
//
//   cellstocks/exports/layout.xlsx    one grid sheet per box, cell by cell
//   cellstocks/exports/layout.pdf     the printable map that goes on the freezer door
//   cellstocks/exports/layout.csv     one row per box -- where it is, whose, how full
//   cellstocks/exports/roster.xlsx    one flat sheet per member, plus a lab-wide log
//
// Run: node tools/cellstocks-export.mjs [--out <dir>]
//
// The names are stable on purpose. A dated file would mean a new link every morning and
// a directory nobody prunes; this way the same links always hold today's answer, and git
// already keeps every previous morning.
//
// It reads the lab's shared tree plus every member's own file and merges them into one
// view, because the map is of the freezer, not of one person's vials. Nothing here
// validates or repairs: two members' files can hold the same vial id (they mint ids
// independently) and that is not this tool's business -- it is drawing what is there.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// --root points the whole thing at a different checkout, which is how the selftest runs
// it over a fixture freezer instead of the real one; --out only moves where it writes.
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = arg("--root", HERE);
const OUT_DIR = arg("--out", join(ROOT, "cellstocks", "exports"));

new Function(readFileSync(join(HERE, "cellstocks", "engine.js"), "utf8"))();
new Function(readFileSync(join(HERE, "cellstocks", "xlsx.js"), "utf8"))();
new Function(readFileSync(join(HERE, "cellstocks", "pdf.js"), "utf8"))();
const E = globalThis.CellStocksEngine;
const X = globalThis.XlsxLite;
const P = globalThis.PdfLite;

const DATA_DIR = join(ROOT, "cellstocks", "data");
const storage = E.mergeStorageDefaults(
  JSON.parse(readFileSync(join(ROOT, "cellstocks", "lab-storage.json"), "utf8"))
);
const RULES_PATH = join(ROOT, "cellstocks", "lab-rules.json");
const labRules = E.mergeRulesDefaults(existsSync(RULES_PATH) ? JSON.parse(readFileSync(RULES_PATH, "utf8")) : null);

// One state holding the whole lab's stored vials, hydrated with the shared tree, so
// occupancy() and locationPath() answer for any box regardless of whose it is.
const members = existsSync(DATA_DIR)
  ? readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort()
  : [];
const ownerOfVial = {};
const allVials = [];
// The roster needs the same vials grouped by whose file they came from (one sheet per
// member), plus two things the grid export has no use for: each member's own withdrawal
// history, and a same-shape "addition" entry for any vial that actually recorded who
// added it and when (applyPlacement sets addedBy/addedAt on a live Add; an imported or
// pre-existing vial has neither, and contributes nothing here rather than a guess).
const vialsByOwner = {};
const logRows = [];
for (const name of members) {
  const own = E.mergeDefaults(JSON.parse(readFileSync(join(DATA_DIR, `${name}.json`), "utf8")));
  vialsByOwner[name] = [];
  (own.vials || []).forEach((v) => {
    if (v.addedBy || v.addedAt) {
      logRows.push({ date: v.addedAt || v.frozenOn || "", action: "added", name: v.name || "",
                     by: v.addedBy || "", owner: name });
    }
    if (v.status === "withdrawn" || !v.location) return;
    vialsByOwner[name].push(v);
    const copy = JSON.parse(JSON.stringify(v));
    copy.id = `${name}:${v.id}`;          // ids are per-file; namespace them for this view
    ownerOfVial[copy.id] = name;
    allVials.push(copy);
  });
  (own.withdrawals || []).forEach((w) => {
    logRows.push({ date: w.date || "", action: "withdrawn", name: w.name || "", by: w.by || "",
                   owner: name, from: w.from || null, purpose: w.purpose || "", notes: w.notes || "" });
  });
}
const lab = E.hydrateStorage(E.mergeDefaults({ vials: allVials }), storage, null);

// Every box in the lab, with the path down to it, in tree order.
//
// The tree has no fixed depth any more, so a box is described by its whole chain rather
// than by a unit/rack pair. Two things are pulled out of that chain because a flat file
// needs somewhere to put them: `area` is the top layer it sits under -- the freezer, in
// this lab -- and `path` is the full route. A box nobody has placed yet has neither.
const boxes = [];
E.eachBox(lab, (box, rack, unit, chain) => {
  boxes.push({
    box, chain,
    area: chain.length ? chain[0].name : "Not placed yet",
    path: chain.length ? chain.map((n) => n.name).join(" → ") : "Not placed yet",
    occ: E.occupancy(lab, box.id)
  });
});

const today = new Date().toISOString().slice(0, 10);
const labName = storage.labName || "Cell stocks";

// ---------------------------------------------------------------- 1. the grid workbook
function gridSheets() {
  const sheets = [{
    name: "boxes",
    rows: [["area", "location", "box", "owner", "rows", "cols", "used", "capacity", "free"]].concat(
      boxes.map((b) => [
        b.area, b.path, b.box.name, b.box.owner || "",
        b.box.rows, b.box.cols, b.occ.used, b.occ.capacity, b.occ.capacity - b.occ.used
      ])
    )
  }];

  boxes.forEach((b) => {
    // A sheet name is capped at 31 characters and cannot hold : \ / ? * [ ], so a long
    // box name is trimmed rather than allowed to produce a workbook Excel refuses.
    const safe = (b.box.name || b.box.id).replace(/[:\\/?*\[\]]/g, "-").slice(0, 28);
    const header = [""].concat(
      Array.from({ length: b.box.cols }, (_, c) => String(c + 1))
    );
    const rows = [header];
    for (let r = 0; r < b.box.rows; r++) {
      const line = [E.rowLabel(r)];
      for (let c = 0; c < b.box.cols; c++) {
        const slot = b.occ.slots[r * b.box.cols + c];
        const v = slot && slot.vial;
        line.push(v ? [v.name, v.passage].filter(Boolean).join(" ") : "");
      }
      rows.push(line);
    }
    // Two title rows above the grid, so a printed sheet says which box it is.
    sheets.push({
      name: safe,
      rows: [[b.path], [b.box.name + (b.box.owner ? "  ·  " + b.box.owner : "") +
             "  ·  " + b.occ.used + "/" + b.occ.capacity + " full"], []].concat(rows)
    });
  });
  return sheets;
}

// ------------------------------------------------------------------ 2. the printed map
function buildPdf() {
  const doc = P.createDocument({ margin: 40 });
  doc.text(labName, { size: 20, bold: true });
  doc.text("Freezer layout · " + today, { size: 10 });
  doc.rule();

  // The tree first: what is where, at a glance, before any grid.
  doc.text("Where everything is", { size: 13, bold: true });
  // One kind of node, drawn one way, however deep it goes.
  (function walk(list, depth) {
    (list || []).forEach((node) => {
      if (node.isBox) {
        const b = boxes.filter((x) => x.box.id === node.id)[0];
        doc.text(node.name + "  ·  " + (node.owner || "unassigned") +
                 "  ·  " + (b ? b.occ.used + "/" + b.occ.capacity : "?") + " full",
                 { size: 9.5, indent: 6 + depth * 14 });
        return;
      }
      const kids = (node.children || []).length;
      doc.text(node.name + (node.note ? "  (" + node.note + ")" : "") +
               "  —  " + (kids ? kids + " inside" : "empty"),
               { size: depth === 0 ? 11 : 9.5, bold: depth === 0, indent: 6 + depth * 14 });
      walk(node.children, depth + 1);
      if (depth === 0) doc.gap(6);
    });
  })(storage.children, 0);

  const loose = storage.unplaced || [];
  if (loose.length) {
    doc.gap(4);
    doc.text("Not placed yet", { size: 11, bold: true, indent: 6 });
    loose.forEach((box) => {
      const b = boxes.filter((x) => x.box.id === box.id)[0];
      doc.text(box.name + "  ·  " + (box.owner || "unassigned") +
               "  ·  " + (b ? b.occ.used + "/" + b.occ.capacity : "?") + " full",
               { size: 9.5, indent: 20 });
    });
  }

  // Then a page per box, drawn as the grid it actually is.
  boxes.forEach((b) => {
    doc.addPage();
    doc.text(b.box.name, { size: 16, bold: true });
    doc.text(b.path, { size: 10 });
    doc.text((b.box.owner || "unassigned") + "  ·  " + b.occ.used + " of " + b.occ.capacity + " slots full",
             { size: 10 });
    doc.gap(6);

    const cols = b.box.cols, rows = b.box.rows;
    const left = doc.margin + 22;
    const usable = doc.width - doc.margin * 2 - 22;
    const cw = Math.min(52, usable / cols);
    const ch = Math.min(34, cw * 0.72);
    const top = doc.cursorY;

    for (let c = 0; c < cols; c++) {
      doc.textAt(String(c + 1), left + c * cw + cw / 2 - 3, top + 4, { size: 7.5, bold: true });
    }
    for (let r = 0; r < rows; r++) {
      const y = top - (r + 1) * ch;
      doc.textAt(E.rowLabel(r), doc.margin + 6, y + ch / 2 - 3, { size: 7.5, bold: true });
      for (let c = 0; c < cols; c++) {
        const slot = b.occ.slots[r * cols + c];
        const v = slot && slot.vial;
        doc.rect(left + c * cw, y, cw, ch, v ? { fill: [0.93, 0.95, 0.98] } : {});
        if (!v) continue;
        // Two short lines per cell: the name, wrapped hard, then the passage.
        const name = P.latin1(v.name || "");
        const per = Math.max(4, Math.floor(cw / 3.1));
        doc.textAt(name.slice(0, per), left + c * cw + 2.5, y + ch - 9, { size: 5.4 });
        if (name.length > per) doc.textAt(name.slice(per, per * 2), left + c * cw + 2.5, y + ch - 15, { size: 5.4 });
        if (v.passage) doc.textAt(String(v.passage).slice(0, per), left + c * cw + 2.5, y + 3, { size: 5.4, bold: true });
      }
    }
    doc.cursorY = top - rows * ch - 12;
  });

  return doc.toBytes();
}

// -------------------------------------------------------------------- 3. the summary
function buildCsv() {
  const esc = (v) => {
    const s = String(v === null || v === undefined ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [["area", "location", "box", "owner", "rows", "cols", "used", "capacity", "free"]];
  boxes.forEach((b) => rows.push([
    b.area, b.path, b.box.name, b.box.owner || "",
    b.box.rows, b.box.cols, b.occ.used, b.occ.capacity, b.occ.capacity - b.occ.used
  ]));
  // A leading BOM, so Excel opens it as UTF-8 rather than mangling the first column.
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

// ----------------------------------------------------------------------- 4. the roster
//
// The grid export is shaped like the freezer; this one is shaped like the spreadsheet
// Umut originally handed over -- one flat row per vial, one sheet per person -- plus a
// lab-wide log of who froze and who withdrew what. `location` here is the box's whole
// chain path, not the fixed unit/rack pair vialsToSheets (the per-member workbook) still
// uses, because the tree has no fixed depth any more.
const pathOfBox = {};
boxes.forEach((b) => { pathOfBox[b.box.id] = b.path; });

// Only an admin's explicit "hide" survives here -- a column nobody has an opinion on yet,
// including one that does not exist yet, is shown. Missing/unreadable file: nothing hidden.
let rosterHiddenColumns = [];
try {
  const recipients = JSON.parse(readFileSync(join(ROOT, "cellstocks", "exports", "recipients.json"), "utf8"));
  if (Array.isArray(recipients.rosterHiddenColumns)) rosterHiddenColumns = recipients.rosterHiddenColumns;
} catch (err) { /* no recipients.json yet, or it doesn't have the field -- nothing hidden */ }

const FIXED_COLUMNS = ["name", "origin", "koox", "resistance", "caspex", "guide", "passage",
                       "passage_kind", "frozen", "frozen_raw", "location", "position", "notes", "flags"];
// Whatever a member's non-"cell" kind vial carries beyond the fixed facets (a Plasmid's
// dox-inducible/tet/FLAG...) -- the whole point of the picker is that this list is never
// hardcoded, so a lab member adding a new one tomorrow makes it a column without a code change.
const customKeys = new Set();
allVials.forEach((v) => { if (v.customFacets) Object.keys(v.customFacets).forEach((k) => customKeys.add(k)); });
const allColumns = FIXED_COLUMNS.concat([...customKeys].sort());
const columns = allColumns.filter((c) => !rosterHiddenColumns.includes(c));

function rosterSheets() {
  const sheets = [];
  for (const name of members) {
    const rows = [columns];
    vialsByOwner[name].slice().sort((a, b) => {
      const ap = a.location ? (pathOfBox[a.location.boxId] || "") + " " + (a.location.position || "") : "zzz";
      const bp = b.location ? (pathOfBox[b.location.boxId] || "") + " " + (b.location.position || "") : "zzz";
      return ap < bp ? -1 : ap > bp ? 1 : 0;
    }).forEach((v) => {
      const f = E.facetsFor(v, labRules);
      rows.push(columns.map((c) => cellFor(v, f, c)));
    });
    sheets.push({ name: sheetSafe(name), rows });
  }

  const logSorted = logRows.slice().sort((a, b) => (String(b.date || "") < String(a.date || "") ? -1 : 1));
  const logHeader = ["date", "action", "name", "by", "owner", "location", "purpose", "notes"];
  const logBody = logSorted.map((r) => [
    r.date || "", r.action, r.name, r.by || "", r.owner,
    r.from ? (pathOfBox[r.from.boxId] || "") + (r.from.position ? " " + r.from.position : "") : "",
    r.purpose || "", r.notes || ""
  ]);
  sheets.push({ name: "log", rows: [logHeader].concat(logBody) });
  return sheets;
}

function sheetSafe(name) {
  // A sheet name is capped at 31 characters and cannot hold : \ / ? * [ ], same rule
  // gridSheets() already applies to box names.
  return String(name || "").replace(/[:\\/?*\[\]]/g, "-").slice(0, 31);
}

function cellFor(v, f, column) {
  switch (column) {
    case "name": return v.name || "";
    case "origin": return f.origin || "";
    case "koox": return f.koox || "";
    case "resistance": return f.resistance || "";
    case "caspex": return f.caspex || "";
    case "guide": return f.guide || "";
    case "passage": return v.passage || "";
    case "passage_kind": return v.passageKind || "";
    case "frozen": return v.frozenOn || (v.dateUnknown ? "Unknown" : "");
    case "frozen_raw": return v.frozenRaw || "";
    case "location": return v.location ? (pathOfBox[v.location.boxId] || "") : "";
    case "position": return v.location ? v.location.position || "" : "";
    case "notes": return v.notes || "";
    case "flags": return (v.flags || []).join(", ");
    default: return v.customFacets ? (v.customFacets[column] || "") : "";
  }
}

// ------------------------------------------------------------------------------ write
mkdirSync(OUT_DIR, { recursive: true });
const xlsxBytes = await X.writeWorkbookAsync(gridSheets());
writeFileSync(join(OUT_DIR, "layout.xlsx"), Buffer.from(xlsxBytes));
writeFileSync(join(OUT_DIR, "layout.pdf"), Buffer.from(buildPdf()));
writeFileSync(join(OUT_DIR, "layout.csv"), buildCsv());
const rosterBytes = await X.writeWorkbookAsync(rosterSheets());
writeFileSync(join(OUT_DIR, "roster.xlsx"), Buffer.from(rosterBytes));

const filled = boxes.filter((b) => b.occ.used).length;
console.log(`${labName}: ${storage.children.length} top layer(s), ${boxes.length} box(es) (${filled} holding vials), ` +
            `${allVials.length} stored vial(s) across ${members.length} account(s)`);
console.log(`wrote roster.xlsx (${columns.length} columns, ${logRows.length} log entries)`);
console.log(`wrote layout.xlsx, layout.pdf and layout.csv to ${OUT_DIR}`);
