// Builds the daily freezer layout exports, in the three shapes Umut asked for:
//
//   cellstocks/exports/layout.xlsx    one grid sheet per box, cell by cell
//   cellstocks/exports/layout.pdf     the printable map that goes on the freezer door
//   cellstocks/exports/layout.csv     one row per box -- where it is, whose, how full
//
// Run: node tools/cellstocks-export.mjs [--out <dir>]
//
// The names are stable on purpose. A dated file would mean a new link every morning and
// a directory nobody prunes; this way the same three links always hold today's answer,
// and git already keeps every previous morning.
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

// One state holding the whole lab's stored vials, hydrated with the shared tree, so
// occupancy() and locationPath() answer for any box regardless of whose it is.
const members = existsSync(DATA_DIR)
  ? readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort()
  : [];
const ownerOfVial = {};
const allVials = [];
for (const name of members) {
  const own = E.mergeDefaults(JSON.parse(readFileSync(join(DATA_DIR, `${name}.json`), "utf8")));
  (own.vials || []).forEach((v) => {
    if (v.status === "withdrawn" || !v.location) return;
    const copy = JSON.parse(JSON.stringify(v));
    copy.id = `${name}:${v.id}`;          // ids are per-file; namespace them for this view
    ownerOfVial[copy.id] = name;
    allVials.push(copy);
  });
}
const lab = E.hydrateStorage(E.mergeDefaults({ vials: allVials }), storage, null);

// Every box in the lab, with the path down to it, in tree order.
const boxes = [];
E.eachBox(lab, (box, rack, unit, chain) => {
  boxes.push({
    box, rack, unit,
    path: [unit.name].concat(chain.map((r) => r.name)).join(" → "),
    occ: E.occupancy(lab, box.id)
  });
});

const today = new Date().toISOString().slice(0, 10);
const labName = storage.labName || "Cell stocks";

// ---------------------------------------------------------------- 1. the grid workbook
function gridSheets() {
  const sheets = [{
    name: "boxes",
    rows: [["unit", "rack", "box", "owner", "rows", "cols", "used", "capacity", "free"]].concat(
      boxes.map((b) => [
        b.unit.name, b.rack.name, b.box.name, b.box.owner || "",
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
  storage.units.forEach((unit) => {
    doc.text(unit.name + (unit.type ? "  (" + unit.type + ")" : ""), { size: 11, bold: true, indent: 6 });
    (function walk(racks, depth) {
      (racks || []).forEach((rack) => {
        const kids = (rack.racks || []).length;
        const inside = (rack.boxes || []).length;
        doc.text(rack.name + "  —  " + (kids ? kids + " inside" : inside + " box" + (inside === 1 ? "" : "es")),
                 { size: 9.5, indent: 6 + depth * 14 });
        (rack.boxes || []).forEach((box) => {
          const b = boxes.filter((x) => x.box.id === box.id)[0];
          doc.text(box.name + "  ·  " + (box.owner || "unassigned") +
                   "  ·  " + (b ? b.occ.used + "/" + b.occ.capacity : "?") + " full",
                   { size: 9.5, indent: 6 + (depth + 1) * 14 });
        });
        walk(rack.racks, depth + 1);
      });
    })(unit.racks, 1);
    doc.gap(6);
  });

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
  const rows = [["unit", "type", "rack", "box", "owner", "rows", "cols", "used", "capacity", "free"]];
  boxes.forEach((b) => rows.push([
    b.unit.name, b.unit.type || "", b.rack.name, b.box.name, b.box.owner || "",
    b.box.rows, b.box.cols, b.occ.used, b.occ.capacity, b.occ.capacity - b.occ.used
  ]));
  // A leading BOM, so Excel opens it as UTF-8 rather than mangling the first column.
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------------------ write
mkdirSync(OUT_DIR, { recursive: true });
const xlsxBytes = await X.writeWorkbookAsync(gridSheets());
writeFileSync(join(OUT_DIR, "layout.xlsx"), Buffer.from(xlsxBytes));
writeFileSync(join(OUT_DIR, "layout.pdf"), Buffer.from(buildPdf()));
writeFileSync(join(OUT_DIR, "layout.csv"), buildCsv());

const filled = boxes.filter((b) => b.occ.used).length;
console.log(`${labName}: ${storage.units.length} unit(s), ${boxes.length} box(es) (${filled} holding vials), ` +
            `${allVials.length} stored vial(s) across ${members.length} account(s)`);
console.log(`wrote layout.xlsx, layout.pdf and layout.csv to ${OUT_DIR}`);
