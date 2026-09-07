// Proves the cell stocks rules actually hold, instead of trusting that they do.
//
// Run:  node tools/cellstocks-selftest.mjs
//
// Loads cellstocks/engine.js and cellstocks/xlsx.js -- the same two files the app
// loads in the browser -- and runs them against a synthetic freezer built for the
// edge cases, and then against the real inventory in cellstocks/data/umut.json.
// The second half matters: a rule change that quietly reclassifies 350 real vials
// should fail here, not be discovered in front of an open freezer.
//
// No network, no browser.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Both are plain scripts that assign to globalThis, so node can just run them.
new Function(readFileSync(join(ROOT, "cellstocks", "xlsx.js"), "utf8"))();
new Function(readFileSync(join(ROOT, "cellstocks", "engine.js"), "utf8"))();
const E = globalThis.CellStocksEngine;
const X = globalThis.XlsxLite;

// ---------------------------------------------------------------- test harness
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) failures.push(`${name}\n    ${problem}`);
    else passed++;
  } catch (err) {
    failures.push(`${name}\n    threw: ${err && err.stack ? err.stack.split("\n").slice(0, 3).join("\n    ") : err}`);
  }
}

async function checkAsync(name, fn) {
  try {
    const problem = await fn();
    if (problem) failures.push(`${name}\n    ${problem}`);
    else passed++;
  } catch (err) {
    failures.push(`${name}\n    threw: ${err && err.stack ? err.stack.split("\n").slice(0, 3).join("\n    ") : err}`);
  }
}

const json = (x) => JSON.stringify(x);

// ------------------------------------------------------------- test freezer
//
// Two units on purpose: a freezer whose child is a "Rack" and a tank whose child
// is a "Tower", so the claim that one location model serves both is tested rather
// than asserted. One box is linear-numbered, because real racks mix the two.

function box(id, name, rows, cols, scheme) {
  // Every box belongs to somebody now -- an unowned one is a validate() warning, because
  // "whose is this?" is a question a freezer always has an answer to.
  return { id, name, rows, cols, scheme: scheme || "grid", note: "", archived: false, owner: "umut" };
}

function vial(id, name, boxId, position, extra) {
  const p = E.parsePassage((extra && extra.passage) || "p5");
  return Object.assign({
    id, name,
    lineId: E.lineIdFor(name),
    passage: p.raw, passageNumber: p.number, passageKind: p.kind,
    frozenOn: "2025-06-01", frozenRaw: "01-06-25",
    notes: "", flags: [],
    location: { unitId: "u-f80", rackId: "r-1", boxId, position },
    status: "stored"
  }, extra || {});
}

function fixture() {
  const state = E.mergeDefaults({
    storage: {
      units: [
        { id: "u-f80", name: "-80 Freezer", type: "freezer", childLabel: "Rack",
          racks: [{ id: "r-1", name: "Rack 1", boxes: [box("b-a", "Box A", 9, 9), box("b-b", "Box B", 9, 9), box("b-c", "Box C", 9, 9)] }] },
        { id: "u-ln2", name: "LN2 Tank", type: "ln2", childLabel: "Tower",
          racks: [{ id: "t-1", name: "Tower 1", boxes: [box("b-t1", "Tower box 1", 10, 10, "linear")] }] }
      ]
    },
    // Row A of Box A is HEK293T, row B of Box A is Huh7, row A of Box B is Du145.
    // One kind of cell per row, which is how the real freezer is laid out and what
    // placement has to preserve.
    vials: [
      vial("v-1", "HEK ATP7B KO g3", "b-a", "A1", { passage: "p12" }),
      vial("v-2", "HEK ATP7B KO g3", "b-a", "A2", { passage: "p12" }),
      vial("v-3", "HEK TOX4 OX", "b-a", "A3", { passage: "p12" }),
      vial("v-4", "HEK ATP7B KO g3", "b-a", "A4", { passage: "p20", frozenOn: "2024-01-01" }),
      vial("v-5", "Huh7 CBX3 KO g2", "b-a", "B1", { passage: "p+3", notes: "myco -" }),
      vial("v-6", "DuDtxR CASPEX g5.1", "b-b", "A1", { passage: "p?" })
    ]
  });
  return state;
}

// Leaves a box with `freeCount` slots free. The filler is HepG2 unless told
// otherwise -- a cell that appears nowhere else in the fixture -- so every row it
// touches is closed to everything else, which is the pressure these tests are about.
function nearlyFull(state, boxId, freeCount, fillerName) {
  const occ = E.occupancy(state, boxId);
  const next = JSON.parse(JSON.stringify(state));
  let n = 0;
  occ.slots.forEach((s) => {
    if (s.vial) return;
    if (occ.capacity - occ.used - n <= freeCount) return;
    next.vials.push(vial("fill-" + boxId + "-" + s.index, fillerName || "HepG2 filler", boxId, s.position));
    n++;
  });
  return next;
}

// The same freezer with nothing in it, for the tests that need to control every row.
function emptyFixture() {
  const s = fixture();
  s.vials = [];
  return s;
}

// Fills every row of a box except the named ones, using a cell that appears nowhere
// else -- so those rows are closed to everything, and the named rows stay open.
function closeAllRowsBut(state, boxId, keepLabels) {
  const next = JSON.parse(JSON.stringify(state));
  const occ = E.occupancy(next, boxId);
  occ.slots.forEach((slot) => {
    if (slot.vial) return;
    if (keepLabels.indexOf(rowOf(slot.position)) !== -1) return;
    next.vials.push(vial("shut-" + boxId + "-" + slot.index, "HepG2 filler", boxId, slot.position));
  });
  return next;
}

// Which row a position sits in, and what a plan's slots resolve to. Used by the
// placement checks, which are mostly about rows rather than individual slots.
function rowOf(pos) { return String(pos).replace(/\d+$/, ""); }
function planRows(plan) {
  const out = [];
  plan.segments.forEach((seg) => seg.positions.forEach((p) => {
    const key = seg.boxId + "!" + rowOf(p);
    if (out.indexOf(key) === -1) out.push(key);
  }));
  return out;
}

// ================================================================== geometry

check("position labels round-trip across a 9x9 grid", () => {
  const b = box("x", "X", 9, 9);
  for (let i = 0; i < 81; i++) {
    const label = E.positionLabel(b, i);
    const back = E.parsePosition(b, label);
    if (!back) return `${label} did not parse back`;
    if (back.index !== i) return `${label} came back as index ${back.index}, not ${i}`;
  }
  if (E.positionLabel(b, 0) !== "A1" || E.positionLabel(b, 80) !== "I9") {
    return `first/last labels are ${E.positionLabel(b, 0)}/${E.positionLabel(b, 80)}, not A1/I9`;
  }
  return null;
});

check("a linear box is numbered 1..100, not lettered", () => {
  const b = box("x", "X", 10, 10, "linear");
  if (E.positionLabel(b, 0) !== "1" || E.positionLabel(b, 99) !== "100") return "labels are not 1..100";
  for (let i = 0; i < 100; i++) {
    if (E.parsePosition(b, E.positionLabel(b, i)).index !== i) return `slot ${i} did not round-trip`;
  }
  return E.parsePosition(b, "A1") ? "a lettered position parsed inside a linear box" : null;
});

check("positions outside the grid fail rather than becoming slot 0", () => {
  const b = box("x", "X", 9, 9);
  for (const bad of ["A0", "4A", "", "J1", "A10", "  ", "A", "1", "Z9", "A1B"]) {
    const got = E.parsePosition(b, bad);
    if (got) return `${json(bad)} parsed to index ${got.index}`;
  }
  return null;
});

check("a position survives the spacing the sheet writes it with", () => {
  const b = box("x", "X", 9, 9);
  for (const form of ["C4", "C 4", "c4", " c-4 ", "c.4"]) {
    const got = E.parsePosition(b, form);
    if (!got || got.label !== "C4") return `${json(form)} gave ${json(got && got.label)}, not "C4"`;
  }
  return null;
});

check("capacity matches the number of positions", () => {
  for (const b of [box("a", "A", 9, 9), box("b", "B", 10, 10, "linear"), box("c", "C", 5, 4)]) {
    if (E.capacity(b) !== E.allPositions(b).length) return `${b.name}: capacity ${E.capacity(b)} vs ${E.allPositions(b).length} positions`;
  }
  return null;
});

check("one code path says Rack for the freezer and Tower for the tank", () => {
  const s = fixture();
  const f = E.locationPath(s, { unitId: "u-f80", rackId: "r-1", boxId: "b-a", position: "A1" });
  const t = E.locationPath(s, { unitId: "u-ln2", rackId: "t-1", boxId: "b-t1", position: "7" });
  if (!/Rack 1/.test(f)) return `freezer path was ${json(f)}`;
  if (!/Tower 1/.test(t)) return `tank path was ${json(t)}`;
  return null;
});

check("occupancy and free runs agree with each other", () => {
  const s = fixture();
  const occ = E.occupancy(s, "b-a");
  if (occ.used !== 5) return `Box A shows ${occ.used} used, expected 5`;
  if (occ.free !== occ.capacity - occ.used) return "free does not complement used";
  const runTotal = E.freeRuns(s, "b-a").reduce((n, r) => n + r.positions.length, 0);
  if (runTotal !== occ.free) return `free runs cover ${runTotal} slots but ${occ.free} are free`;
  return null;
});

// ============================================================ classification

check("classify reads the five facets out of one name", () => {
  const got = E.classify("DuDtxR CASPEX DSg1.2");
  // koox reads CASPEX here because the name carries no KO/OX of its own -- exactly
  // what the sheet does. A name with both keeps its KO/OX, which is the change.
  const want = { origin: "Du145", koox: "CASPEX", resistance: "DtxR", caspex: "CASPEX", guide: "DSg1.2" };
  for (const k of Object.keys(want)) if (got[k] !== want[k]) return `${k} was ${json(got[k])}, expected ${json(want[k])}`;
  return null;
});

check("the OX inside TOX4 is not an overexpression", () => {
  if (E.classify("Du145 TOX4 KO g2.2").koox !== "KO") return "TOX4 KO still reads as OX";
  if (E.classify("HEK TOX4 OX").koox !== "OX") return "a real OX stopped being found";
  // A digit before the token is fine -- these really are knockouts.
  if (E.classify("Huh7 ATF3KO10").koox !== "KO") return "ATF3KO10 lost its KO";
  if (E.classify("Huh7 ATF3 KO20").koox !== "KO") return "KO20 lost its KO";
  return null;
});

check("ER only counts as EnzaR on its own", () => {
  if (E.classify("LnCap ER").resistance !== "EnzaR") return "a real EnzaR stopped being found";
  for (const name of ["LnCap Canada CASPEX mCherry 1", "LnCap (m3) (sortER)"]) {
    if (E.classify(name).resistance === "EnzaR") return `${json(name)} still reads as EnzaR`;
  }
  return null;
});

check("the CR in LuCap35CR is part of the name, not a resistance", () => {
  if (E.classify("LuCap35CR").resistance !== "-") return "LuCap35CR is still tagged CR";
  if (E.classify("DuPar50CR ATF3 KO").resistance !== "50CR") return "a real 50CR stopped being found";
  if (E.classify("DuDtxR").resistance !== "DtxR") return "a real DtxR stopped being found";
  return null;
});

check("a guide keeps its sub-clone digit", () => {
  const want = { "Du145 TOX4 KO g2.2": "g2.2", "DuPar50CR TOX4 KO g1.2": "g1.2",
                 "DuDtxR CASPEX DSg1.2": "DSg1.2", "Huh7 gNT": "gNT",
                 "HEK ATP7B KO g3": "g3", "DuDtxR CASPEX g1.1": "g1.1" };
  for (const [name, g] of Object.entries(want)) {
    const got = E.classify(name).guide;
    if (got !== g) return `${json(name)} gave guide ${json(got)}, expected ${json(g)}`;
  }
  return null;
});

check("an uppercase G is not a guide", () => {
  // "HepG2" and "LnCap V1G1" would both become guides if the match were
  // case-insensitive, which is why extraction rules are case-sensitive.
  for (const name of ["HepG2", "LnCap V1G1"]) {
    if (E.classify(name).guide !== "-") return `${json(name)} produced guide ${json(E.classify(name).guide)}`;
  }
  return null;
});

check("a name no rule covers reports a gap instead of inventing a value", () => {
  const got = E.classify("Zebrafish ZF4");
  if (got.origin !== null) return `origin was ${json(got.origin)}, expected null`;
  if (got.unmatched.indexOf("origin") === -1) return "origin was not listed as unmatched";
  return null;
});

check("the LCC and LNC series read as LnCap", () => {
  // Umut's answer for the 19 vials the sheet left as #N/A.
  for (const name of ["LCC-V", "LCC-K no sort", "LCC-C*", "LNC478 #1", "LNC478 #2 98%"]) {
    const got = E.classify(name).origin;
    if (got !== "LnCap") return `${json(name)} read as ${json(got)}, expected LnCap`;
  }
  // And the rule must not have swallowed anything that was already right.
  if (E.classify("LuCap35CR").origin !== "LuCap35CR") return "LuCap35CR was captured by the LnCap rule";
  if (E.classify("HEK ATP7B KO g3").origin !== "HEK293T") return "a HEK name was captured by the LnCap rule";
  return null;
});

check("a facet set by hand is never recomputed", () => {
  const v = { name: "LCC-V", facetsSetByHand: { origin: "LCC" } };
  const f = E.facetsFor(v, E.DEFAULT_RULES);
  if (f.origin !== "LCC") return `hand-set origin came back as ${json(f.origin)}`;
  if (f.unmatched.indexOf("origin") !== -1) return "a hand-answered facet is still reported as a gap";
  return null;
});

check("rules are data: a new label needs no code change", () => {
  const rules = JSON.parse(JSON.stringify(E.DEFAULT_RULES));
  rules.origin.unshift({ match: "ZF", value: "ZF4" });
  if (E.classify("Zebrafish ZF4", rules).origin !== "ZF4") return "the added rule did not take effect";
  if (E.classify("Zebrafish ZF4").origin !== null) return "adding a rule mutated the defaults";
  return null;
});

// ============================================================ passage & date

check("passage keeps its kind, and p+2 is never p2", () => {
  const cases = [["p11", 11, "absolute"], ["p102", 102, "absolute"], ["p+2", 2, "relative"],
                 ["p+21", 21, "relative"], ["p?", null, "unknown"], ["", null, "unknown"],
                 ["p", null, "unknown"], ["p|+7", 7, "relative"]];
  for (const [raw, n, kind] of cases) {
    const got = E.parsePassage(raw);
    if (got.number !== n || got.kind !== kind) return `${json(raw)} gave ${json(got)}`;
  }
  const a = E.parsePassage("p2"), b = E.parsePassage("p+2");
  if (a.kind === b.kind) return "p2 and p+2 landed on the same scale";
  return null;
});

check("an unambiguous date is read, an ambiguous one is not guessed", () => {
  const sure = E.parseDate("28-07-25");
  if (sure.iso !== "2025-07-28" || sure.needsReview) return `28-07-25 gave ${json(sure)}`;
  const amb = E.parseDate("3/7/2025");
  if (amb.iso !== null) return "an ambiguous date was resolved anyway";
  if (!amb.needsReview) return "an ambiguous date was not queued";
  if (amb.asWritten !== "2025-03-07") return `as-written reading was ${json(amb.asWritten)}`;
  if (amb.proposed !== "2025-07-03") return `proposal was ${json(amb.proposed)}`;
  return null;
});

check("junk in the date column is queued, never dropped", () => {
  for (const raw of ["caNT read", "", "not a date", "99-99-99"]) {
    const got = E.parseDate(raw);
    if (got.iso !== null) return `${json(raw)} produced a date`;
    if (!got.needsReview) return `${json(raw)} was not queued for review`;
  }
  return null;
});

check("an ISO date passes through untouched", () => {
  const got = E.parseDate("2025-07-03");
  return got.iso === "2025-07-03" && !got.needsReview ? null : `gave ${json(got)}`;
});

check("notes become searchable flags", () => {
  if (E.flagsFrom("myco -").indexOf("myco-negative") === -1) return "myco - did not become a flag";
  if (E.flagsFrom("myco-").indexOf("myco-negative") === -1) return "the unspaced form did not become a flag";
  if (E.flagsFrom("chip-").indexOf("chip-negative") === -1) return "chip- did not become a flag";
  if (E.flagsFrom("to-do box / thaw").indexOf("to-do") === -1) return "to-do did not become a flag";
  if (E.flagsFrom("").length) return "an empty note produced flags";
  return null;
});

check("an account's own custom keyword becomes a flag too, without dropping the built-ins", () => {
  const custom = [{ match: "aliquot", flag: "aliquot" }];
  const got = E.flagsFrom("myco - aliquot ready", custom);
  if (got.indexOf("myco-negative") === -1) return "a built-in flag was dropped: " + json(got);
  if (got.indexOf("aliquot") === -1) return "the custom keyword did not become a flag: " + json(got);
  if (E.flagsFrom("nothing relevant here", custom).indexOf("aliquot") !== -1) return "matched when it shouldn't have";
  if (E.flagsFrom("ALIQUOT ready", custom).indexOf("aliquot") === -1) return "the match should be case-insensitive";
  return null;
});

check("importSheet() and applyPlacement() honor an account's own custom keywords", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [
    [cell("Position"), cell("Cell Name"), cell("Notes")],
    [cell("A1"), cell("HEK293T p12"), cell("aliquot ready")]
  ];
  const sheet = { name: "Sheet1", rows, merges: [] };
  const imported = E.importSheet(sheet, {
    columns: { position: 0, name: 1, notes: 2 }, headerRow: 1,
    customFlags: [{ match: "aliquot", flag: "aliquot" }]
  }).state;
  if ((imported.vials[0].flags || []).indexOf("aliquot") === -1) {
    return "importSheet() did not apply the custom keyword: " + json(imported.vials[0].flags);
  }

  const s = fixture();
  s.settings.customFlags = [{ match: "aliquot", flag: "aliquot" }];
  const plan = E.suggestPlacement(s, { name: "HEK293T brand new line", count: 1 });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  const out = E.applyPlacement(s, plan, { name: "HEK293T brand new line", passage: "p1", notes: "aliquot ready" }, {});
  if ((out.vials[0].flags || []).indexOf("aliquot") === -1) {
    return "applyPlacement() did not apply the custom keyword: " + json(out.vials[0].flags);
  }
  return null;
});

// ============================================================== item kind (lab-wide scaffolding)
//
// kindOf/rulesForKind are additive groundwork for the multi-user, multi-kind expansion --
// nothing wires a second kind into classify/search/placement yet (see engine.js's comments
// on why). What has to hold today is that this scaffolding is a true no-op for the only
// kind that actually exists: a vial with no `kind` field, and a state with no
// `rulesByKind`, must behave exactly as before.

check("a vial with no kind field defaults to cell", () => {
  if (E.kindOf({ name: "HEK293T" }) !== "cell") return "kindOf did not default to cell";
  if (E.kindOf({ name: "x", kind: "plasmid" }) !== "plasmid") return "kindOf ignored an explicit kind";
  if (E.kindOf(null) !== "cell") return "kindOf threw or misbehaved on null";
  return null;
});

check("rulesForKind(state, 'cell') is state.rules, not a copy with different rules", () => {
  const s = fixture();
  if (E.rulesForKind(s, "cell") !== s.rules) return "rulesForKind did not return the same rules object for cell";
  if (E.rulesForKind(s) !== s.rules) return "rulesForKind did not default the kind argument to cell";
  return null;
});

check("rulesForKind returns null for a kind nothing has defined rules for yet", () => {
  const s = fixture();
  if (E.rulesForKind(s, "plasmid") !== null) return "expected null for an undefined kind, not an invented ruleset";
  return null;
});

// ==================================================================== search

check("a keyword finds the vial and names where it is", () => {
  const s = fixture();
  const hits = E.search(s, { query: "hek p12" });
  // Coverage is always required: the p20 HEK vial matches "hek" but not "p12" --
  // one word of two, below the 0.6 threshold -- so it is excluded, not merely
  // outranked. Only the three p12 vials come back.
  if (hits.length !== 3) return `expected the 3 p12 HEK vials, got ${hits.length}`;
  const passages = hits.map((h) => h.vial.passage);
  if (passages.some((p) => p !== "p12")) return `passages were ${json(passages)}, not all p12`;
  if (!/Box A/.test(hits[0].path)) return `path was ${json(hits[0].path)}`;
  return null;
});

check("a strongly-matching single word does not bypass coverage", () => {
  const s = fixture();
  // Regression for a real bug: "hek" was expanded by SYNONYMS to "hek293t" (7
  // chars), long enough to trip the old STRONG_TOKEN bypass and accept a vial on
  // that one word alone -- so "hek caspex" matched every HEK vial regardless of
  // whether it had anything to do with CASPEX. Coverage must always decide.
  const hits = E.search(s, { query: "hek caspex" });
  if (hits.length) return `expected no hits (no vial is both HEK and CASPEX), got ${json(hits.map((h) => h.vial.id))}`;
  return null;
});

check("a term that appears only in a derived facet is still found", () => {
  const s = fixture();
  // "DtxR" is nowhere in the notes and nowhere in a typed field -- it is derived
  // from the name by classify, and search has to see it.
  const hits = E.search(s, { query: "dtxr" });
  if (hits.length !== 1 || hits[0].vial.id !== "v-6") return `got ${json(hits.map((h) => h.vial.id))}`;
  return null;
});

check("a flag is searchable", () => {
  const s = fixture();
  const hits = E.search(s, { query: "myco" });
  return hits.length === 1 && hits[0].vial.id === "v-5" ? null : `got ${json(hits.map((h) => h.vial.id))}`;
});

check("a partial match says which word it missed", () => {
  const s = fixture();
  const hits = E.search(s, { query: "hek p12 crispr" });
  if (!hits.length) return "a 2-of-3 match was rejected";
  if (json(hits[0].missed) !== json(["crispr"])) return `missed was ${json(hits[0].missed)}`;
  const full = E.search(s, { query: "hek p12" });
  if (full[0].missed.length) return "a full match reported a missed word";
  return null;
});

check("a query that matches nothing returns nothing", () => {
  const s = fixture();
  if (E.search(s, { query: "zebrafish" }).length) return "nonsense matched something";
  // "g3" is not distinctive enough to stand alone, so one word out of four fails.
  if (E.search(s, { query: "g3 zebrafish quokka wombat" }).length) return "a 1-of-4 match was accepted";
  return null;
});

check("results are ordered, and the same call twice gives the same order", () => {
  const s = fixture();
  const a = E.search(s, { query: "hek" });
  const b = E.search(s, { query: "hek" });
  for (let i = 1; i < a.length; i++) if (a[i - 1].score < a[i].score) return "results are not sorted by score";
  if (a.some((r) => r.vial.status === "withdrawn")) return "this check assumes nothing is withdrawn";
  if (json(a.map((r) => r.vial.id)) !== json(b.map((r) => r.vial.id))) return "two identical calls disagreed";
  return null;
});

check("the sliders only ever narrow", () => {
  const s = fixture();
  const all = E.search(s, { query: "hek" }).map((r) => r.vial.id);
  const narrowed = E.search(s, { query: "hek", frozenFrom: "2025-01-01" }).map((r) => r.vial.id);
  if (narrowed.length > all.length) return "a date filter added results";
  for (const id of narrowed) if (all.indexOf(id) === -1) return `${id} appeared only once filtered`;
  if (narrowed.indexOf("v-4") !== -1) return "the 2024 vial survived a 2025 floor";
  const byPassage = E.search(s, { query: "hek", passageKind: "absolute", passageMin: 15 }).map((r) => r.vial.id);
  if (json(byPassage) !== json(["v-4"])) return `passage floor gave ${json(byPassage)}`;
  return null;
});

check("extents bracket every vial, and count what the toggles hide", () => {
  const s = fixture();
  const x = E.searchExtents(s);
  s.vials.forEach((v) => {
    if (v.frozenOn && (v.frozenOn < x.frozen.min || v.frozenOn > x.frozen.max)) throw new Error(`${v.id} is outside the date extent`);
  });
  if (x.passage.unknown !== 1) return `expected 1 unknown passage, got ${x.passage.unknown}`;
  if (x.passage.relative.count !== 1) return `expected 1 relative passage, got ${x.passage.relative.count}`;
  if (x.passage.absolute.min !== 12 || x.passage.absolute.max !== 20) return `absolute extent was ${x.passage.absolute.min}..${x.passage.absolute.max}`;
  return null;
});

check("unknown passages are held back by a toggle, not lost", () => {
  const s = fixture();
  const without = E.search(s, { query: "caspex", passageKind: "absolute" });
  const with_ = E.search(s, { query: "caspex", passageKind: "absolute", includeUnknownPassage: true });
  if (without.length !== 0) return "a p? vial slipped through an absolute filter";
  if (with_.length !== 1) return "the include toggle did not bring it back";
  return null;
});

check("withdrawn vials are out of the way but not hidden", () => {
  const s = fixture();
  const after = E.withdraw(s, "v-1", { date: "2026-08-25", by: "test", ids: ["w-1"] }).state;
  // Of the 3 p12 HEK vials (v-1, v-2, v-3; v-4 is p20 and never matches "hek p12"
  // now that coverage is always required), v-1 was just withdrawn.
  if (E.search(after, { query: "hek p12" }).length !== 2) return "a withdrawn vial still shows by default";
  const shown = E.search(after, { query: "hek p12", includeWithdrawn: true });
  if (shown.length !== 3) return "includeWithdrawn did not bring it back";
  if (shown[shown.length - 1].vial.id !== "v-1") return "the withdrawn vial did not sort last";
  return null;
});

check("results group to one card per line and box", () => {
  const s = fixture();
  const groups = E.searchGroups(E.search(s, { query: "hek p12" }));
  // Grouping is per LINE, not per cell: the ATP7B KO and the TOX4 OX share a row
  // but are different lines, so they get a card each. Only the p12 vials match
  // (v-4 is p20 and coverage is always required), so ATP7B KO here is v-1/v-2.
  if (groups.length !== 2) return `expected 2 groups, got ${groups.length}`;
  const ko = groups.filter((g) => /ATP7B/.test(g.name))[0];
  if (!ko) return "the ATP7B group is missing";
  if (ko.count !== 2) return `the ATP7B group counted ${ko.count}`;
  if (json(ko.positions) !== json(["A1", "A2"])) return `positions were ${json(ko.positions)}`;
  return null;
});

// ================================================================= placement

check("a freeze-down goes into a row that already holds that cell", () => {
  const s = fixture();
  const plan = E.suggestPlacement(s, { name: "HEK CBX3 KO g1", count: 4 });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  if (plan.origin !== "HEK293T") return `origin read as ${json(plan.origin)}`;
  if (plan.strategy !== "same-row") return `strategy was ${plan.strategy}`;
  if (json(planRows(plan)) !== json(["b-a!A"])) return `landed in ${json(planRows(plan))}, expected Box A row A`;
  return null;
});

check("KO, OX and CASPEX of the same cell share a row", () => {
  // Row A of Box A holds HEK ATP7B KO and HEK TOX4 OX already. The edit does not
  // make it a different cell, so a CASPEX line goes in beside them.
  const s = fixture();
  for (const name of ["HEK TOX4 OX", "HEK CASPEX g1.1", "HEK ATP7B KO g3", "HEK 3xFLAG"]) {
    const plan = E.suggestPlacement(s, { name, count: 1 });
    if (!plan.ok) return `${name}: ${plan.reason}`;
    if (json(planRows(plan)) !== json(["b-a!A"])) return `${name} landed in ${json(planRows(plan))}, not Box A row A`;
  }
  return null;
});

check("a different cell never goes next to another, even with room beside it", () => {
  // This is the rule. Box A row A has five free slots and holds HEK293T; a Huh7
  // must not take one of them, and neither must a Du145.
  const s = fixture();
  for (const name of ["Huh7 gNT", "DuDtxR CASPEX g3", "LnCap Canada", "LCC-V"]) {
    const plan = E.suggestPlacement(s, { name, count: 1 });
    if (!plan.ok) return `${name}: ${plan.reason}`;
    for (const seg of plan.segments) {
      for (const pos of seg.positions) {
        const occ = E.occupancy(s, seg.boxId);
        const row = E.rowsOf(s, seg.boxId)[E.parsePosition(occ.box, pos).row];
        const mine = E.classify(name).origin || E.NO_ORIGIN;
        const others = row.origins.filter((o) => o !== mine);
        if (others.length) return `${name} was put in ${seg.boxName} row ${rowOf(pos)}, which holds ${others.join(", ")}`;
      }
    }
  }
  return null;
});

check("a full row starts a new one rather than spilling sideways", () => {
  const s = fixture();
  // Fill the rest of Box A row A with HEK, so its own row has no room left.
  for (let c = 5; c <= 9; c++) s.vials.push(vial("hek-" + c, "HEK ATP7B KO g3", "b-a", "A" + c));
  const plan = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 3 });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  if (plan.strategy !== "new-row") return `strategy was ${plan.strategy}`;
  const rows = planRows(plan);
  if (rows.length !== 1) return `spread over ${rows.length} rows`;
  if (rows[0] === "b-a!A") return "it went back into the full row";
  // And the row it opened must have been empty, not somebody else's.
  const [boxId, label] = rows[0].split("!");
  const row = E.rowsOf(s, boxId)[E.rowIndexFromLabel(label)];
  if (row.origins.length) return `it opened ${label}, which already holds ${row.origins.join(", ")}`;
  return null;
});

check("one freeze-down stays in one row when a row can hold it", () => {
  const s = fixture();
  const plan = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 5 });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  if (planRows(plan).length !== 1) return `spread over ${json(planRows(plan))}`;
  if (!plan.segments[0].contiguous) return "the five slots are not next to each other";
  return null;
});

check("more vials than a row is wide spills onto the next row, not sideways", () => {
  const s = fixture();
  const plan = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 12 });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  const rows = planRows(plan);
  if (rows.length !== 2) return `used ${rows.length} rows, expected 2`;
  if (rows[0] !== "b-a!A") return `did not start in the cell's own row: ${json(rows)}`;
  const total = plan.segments.reduce((n, seg) => n + seg.positions.length, 0);
  if (total !== 12) return `covered ${total} slots`;
  // The second row must have been empty before.
  const [boxId, label] = rows[1].split("!");
  if (E.rowsOf(s, boxId)[E.rowIndexFromLabel(label)].origins.length) return `${label} already held something`;
  return null;
});

check("scattered slots are listed, never described as a block that isn't there", () => {
  // A row with gaps in it can still take vials, but calling that "A2-A8" describes
  // a run somebody would open the box looking for.
  const s = fixture();
  s.vials.push(vial("gap-1", "HEK ATP7B KO g3", "b-a", "A6"));
  s.vials.push(vial("gap-2", "HEK ATP7B KO g3", "b-a", "A8"));
  // Row A now reads: A1-A4 taken, A5 free, A6 taken, A7 free, A8 taken, A9 free.
  const plan = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 3 });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  const seg = plan.segments[0];
  if (seg.contiguous) return "slots either side of a gap were reported as contiguous";
  if (/–/.test(plan.summary)) return `summary claims a range: ${json(plan.summary)}`;
  for (const p of seg.positions) if (plan.summary.indexOf(p) === -1) return `${p} is missing from the summary`;
  return null;
});

check("a proposal never names an occupied slot, or the same slot twice", () => {
  const s = fixture();
  for (const count of [1, 2, 5, 20, 70]) {
    const plan = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count });
    if (!plan.ok) return `count ${count} failed: ${plan.reason}`;
    const seen = {};
    let n = 0;
    for (const seg of plan.segments) {
      const occ = E.occupancy(s, seg.boxId);
      for (const p of seg.positions) {
        n++;
        const key = seg.boxId + "!" + p;
        if (seen[key]) return `count ${count}: ${key} was offered twice`;
        seen[key] = true;
        const slot = occ.slots[E.parsePosition(occ.box, p).index];
        if (slot.vial) return `count ${count}: ${key} already holds ${slot.vial.name}`;
      }
    }
    if (n !== count) return `count ${count}: plan covered ${n} slots`;
  }
  return null;
});

check("a cell nothing has seen before opens a clean row", () => {
  const s = fixture();
  const plan = E.suggestPlacement(s, { name: "MDA-MB-231 TOX4 OX", count: 3 });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  if (plan.strategy !== "new-row") return `strategy was ${plan.strategy} (${plan.reason})`;
  const [boxId, label] = planRows(plan)[0].split("!");
  if (E.rowsOf(s, boxId)[E.rowIndexFromLabel(label)].origins.length) return "it opened a row that was already in use";
  return null;
});

check("a box with no free row sends the vials to another box, and says so", () => {
  let s = fixture();
  // Every row of Box A and Box B closed by a cell of its own.
  s = nearlyFull(s, "b-a", 0);
  s = nearlyFull(s, "b-b", 0);
  const plan = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 4 });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  if (plan.segments[0].boxId !== "b-c") return `landed in ${plan.segments[0].boxId}, expected the free Box C`;
  return null;
});

check("splitting across boxes is explicit, and switching it off never part-fills", () => {
  // One free row in Box A and one in Box B, nothing in Box C. Twelve vials cannot
  // fit in a single box's nine-slot row, so the only way is across two boxes.
  let s = emptyFixture();
  s = closeAllRowsBut(s, "b-a", ["I"]);
  s = closeAllRowsBut(s, "b-b", ["I"]);
  s = closeAllRowsBut(s, "b-c", []);
  const split = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 12 });
  if (!split.ok) return `expected a plan, got ${json(split.reason)}`;
  if (split.strategy !== "split") return `strategy was ${split.strategy}`;
  const total = split.segments.reduce((n, seg) => n + seg.positions.length, 0);
  if (total !== 12) return `split covered ${total} slots, not 12`;
  if (!/split across/.test(split.reason)) return `reason does not say it was split: ${json(split.reason)}`;

  s.settings.placement.allowSplit = false;
  const refused = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 12 });
  if (refused.ok) return "splitting was switched off but a plan came back anyway";
  if (!/switched off/.test(refused.reason)) return `reason did not mention the setting: ${refused.reason}`;
  return null;
});

check("a freezer with no free row says so, and blames the right thing", () => {
  let s = fixture();
  for (const id of ["b-a", "b-b", "b-c"]) s = nearlyFull(s, id, 0);
  const plan = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 1, unitId: "u-f80" });
  if (plan.ok) return `a plan came back for a full unit: ${json(plan.segments)}`;
  if (!/No room/.test(plan.reason)) return `reason was ${json(plan.reason)}`;
  return null;
});

check("a full unit does not quietly overflow into the tank", () => {
  let s = fixture();
  for (const id of ["b-a", "b-b", "b-c"]) s = nearlyFull(s, id, 0);
  const plan = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 1, unitId: "u-f80" });
  if (plan.ok && plan.segments.some((seg) => seg.unitId !== "u-f80")) return "it spilled into the other unit";
  return plan.ok ? "a plan came back for a full unit" : null;
});

check("free slots in another cell's row are counted as blocked, not as room", () => {
  const s = fixture();
  // Box A row A holds HEK and has five free slots. To a Huh7 those are not room.
  const plan = E.suggestPlacement(s, { name: "Huh7 gNT", count: 1 });
  if (!plan.ok) return plan.reason;
  if (planRows(plan)[0] === "b-a!A") return "a Huh7 took a slot in the HEK row";
  // And when nothing else is left, the refusal has to say why.
  let tight = fixture();
  for (const id of ["b-a", "b-b", "b-c"]) tight = nearlyFull(tight, id, 0, "HepG2 filler");
  // Free one slot in a row that belongs to HepG2.
  tight.vials = tight.vials.filter((v) => v.id !== "fill-b-c-80");
  const no = E.suggestPlacement(tight, { name: "Huh7 gNT", count: 1 });
  if (no.ok) return "a Huh7 was placed in a HepG2 row";
  if (!/different cell/.test(no.reason)) return `reason did not blame the row rule: ${json(no.reason)}`;
  return null;
});

check("an explicitly chosen box wins, or explains why it cannot", () => {
  const s = fixture();
  const ok = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 2, boxId: "b-c" });
  if (!ok.ok || ok.segments[0].boxId !== "b-c") return "an override was ignored";
  if (ok.strategy !== "chosen") return `strategy was ${ok.strategy}`;
  const full = E.suggestPlacement(nearlyFull(s, "b-c", 1), { name: "HEK ATP7B KO g3", count: 4, boxId: "b-c" });
  if (full.ok) return "an override was allowed to overfill a box";
  return null;
});

check("an override still cannot mix two cells in one row", () => {
  const s = fixture();
  // Box A is named explicitly, but row A is HEK293T and this is a Huh7.
  const plan = E.suggestPlacement(s, { name: "Huh7 gNT", count: 1, boxId: "b-a" });
  if (!plan.ok) return plan.reason;
  if (planRows(plan)[0] === "b-a!A") return "the override put a Huh7 in the HEK row";
  if (planRows(plan)[0] === "b-a!B") return null;   // Huh7's own row -- correct
  const [boxId, label] = planRows(plan)[0].split("!");
  return E.rowsOf(s, boxId)[E.rowIndexFromLabel(label)].origins.length
    ? "it opened a row that already held something" : null;
});

check("the same request twice gives the same plan", () => {
  const s = fixture();
  const a = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 3 });
  const b = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 3 });
  return json(a) === json(b) ? null : "two identical requests produced different plans";
});

check("applying a plan is byte-identical twice and touches nothing existing", () => {
  const s = fixture();
  const plan = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 2 });
  const ctx = { ids: ["v-new-1", "v-new-2"], now: "2026-08-25T09:00:00Z", by: "test" };
  const t = { name: "HEK ATP7B KO g3", passage: "p13", frozenOn: "25-08-26", notes: "" };
  const a = E.applyPlacement(s, plan, t, ctx);
  const b = E.applyPlacement(s, plan, t, ctx);
  if (json(a.state) !== json(b.state)) return "two identical applies produced different states";
  const before = json(s.vials);
  if (json(a.state.vials.slice(0, s.vials.length)) !== before) return "an existing vial was modified";
  if (json(s.vials) !== before) return "applyPlacement mutated the state it was given";
  if (E.errorsOnly(E.validate(a.state)).length) return "the result does not validate";
  return null;
});

check("a freeze-down of five creates five records, one per slot, in one row", () => {
  const s = fixture();
  const plan = E.suggestPlacement(s, { name: "HEK ATP7B KO g3", count: 5 });
  const out = E.applyPlacement(s, plan, { name: "HEK ATP7B KO g3", passage: "p13", frozenOn: "25-08-26" },
                               { ids: ["a", "b", "c", "d", "e"], now: null, by: "test" });
  if (out.vials.length !== 5) return `made ${out.vials.length} records`;
  const slots = {};
  out.vials.forEach((v) => { slots[v.location.boxId + v.location.position] = (slots[v.location.boxId + v.location.position] || 0) + 1; });
  if (Object.values(slots).some((n) => n > 1)) return "two new vials share a slot";
  const rows = [...new Set(out.vials.map((v) => v.location.boxId + "!" + rowOf(v.location.position)))];
  if (rows.length !== 1) return `the five landed across ${rows.length} rows`;
  if (out.vials[0].passageKind !== "absolute" || out.vials[0].passageNumber !== 13) return "passage was not parsed";
  if (out.vials[0].frozenOn !== "2026-08-25") return `frozenOn was ${json(out.vials[0].frozenOn)}`;
  // And the result must still have one cell per row.
  if (E.mixedRows(out.state).length) return "applying the plan mixed two cells into one row";
  return null;
});

// ======================================================= grouping strategies
//
// state.settings.groupingStrategy picks which placement algorithm suggestPlacement()
// dispatches to. "category-row" is the default and everything above this section
// already covers it exhaustively -- these checks are only about the dispatch itself and
// the one other strategy that is actually implemented, "random".

check("no groupingStrategy setting means category-row, unchanged", () => {
  const s = fixture();
  if (E.groupingStrategyFor(s) !== "category-row") return `defaulted to ${E.groupingStrategyFor(s)}`;
  const plan = E.suggestPlacement(s, { name: "Huh7 gNT", count: 1 });
  if (!plan.ok || plan.strategy === "random") return `expected the default category-row plan, got ${json(plan)}`;
  return null;
});

check("an unimplemented strategy (box, keyword) falls back to random rather than pretending", () => {
  const s = fixture();
  s.settings.groupingStrategy = "box";
  if (E.groupingStrategyFor(s) !== "box") return "groupingStrategyFor did not read the setting back";
  const plan = E.suggestPlacement(s, { name: "Huh7 gNT", count: 1 });
  if (!plan.ok || plan.strategy !== "random") return `expected a random-mode plan, got ${json(plan)}`;
  return null;
});

check("random strategy ignores the one-cell-per-row rule entirely", () => {
  const s = fixture();
  s.settings.groupingStrategy = "random";
  // Box A row A already holds three HEK293T vials (v-1..v-3); a Huh7 line under
  // "random" is free to land right beside them, unlike every check above this one.
  const plan = E.suggestPlacement(s, { name: "Huh7 gNT", count: 1 });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  if (plan.strategy !== "random") return `strategy was ${plan.strategy}`;
  if (plan.origin !== undefined) return "a random plan should not derive an origin at all";
  return null;
});

check("random strategy still respects allowSplit", () => {
  const s = fixture();
  s.settings.groupingStrategy = "random";
  s.settings.placement = { allowSplit: false };
  // Each box is 9x9 = 81 slots; no single box in this fixture has 82 free, so a
  // request that size can only be satisfied by splitting across boxes -- which
  // allowSplit:false must refuse, exactly like category-row does.
  const plan = E.suggestPlacement(s, { name: "Anything", count: 82 });
  if (plan.ok) return `expected splitting to be refused, got ${json(plan)}`;
  if (!/split/i.test(plan.reason)) return `expected a split-related reason, got ${json(plan.reason)}`;
  return null;
});

check("applying a random-mode plan actually stores the vials where it said", () => {
  const s = fixture();
  s.settings.groupingStrategy = "random";
  const plan = E.suggestPlacement(s, { name: "Anything New", count: 2 });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  const out = E.applyPlacement(s, plan, { name: "Anything New" }, { ids: ["rnd-1", "rnd-2"] });
  if (out.vials.length !== 2) return `made ${out.vials.length} records`;
  const errs = E.errorsOnly(E.validate(out.state));
  if (errs.length) return `applying it broke validation: ${errs[0].message}`;
  return null;
});

// ================================================================ withdrawal

check("taking a vial frees its slot for the very next placement", () => {
  const s = fixture();
  const out = E.withdraw(s, "v-2", { date: "2026-08-25", by: "test", ids: ["w-1"] });
  const occ = E.occupancy(out.state, "b-a");
  if (occ.used !== 4) return `box still shows ${occ.used} used`;
  const plan = E.suggestPlacement(out.state, { name: "HEK ATP7B KO g3", count: 1 });
  if (plan.segments[0].positions.indexOf("A2") === -1) return "the freed slot was not offered again";
  return null;
});

check("withdrawal keeps the record and logs where it was", () => {
  const s = fixture();
  const out = E.withdraw(s, "v-2", { date: "2026-08-25", by: "test", purpose: "thaw", ids: ["w-1"] });
  const v = E.indexById(out.state.vials)["v-2"];
  if (!v) return "the vial record was deleted";
  if (v.status !== "withdrawn" || v.location) return "the vial was not marked withdrawn";
  const w = out.state.withdrawals[0];
  if (!w || w.from.position !== "A2" || w.from.boxId !== "b-a") return `log entry was ${json(w)}`;
  if (E.errorsOnly(E.validate(out.state)).length) return "the result does not validate";
  return null;
});

check("withdrawing twice does not log twice", () => {
  const s = fixture();
  const once = E.withdraw(s, "v-2", { date: "2026-08-25", by: "t", ids: ["w-1"] });
  const twice = E.withdraw(once.state, "v-2", { date: "2026-08-26", by: "t", ids: ["w-2"] });
  if (twice.state.withdrawals.length !== 1) return `log has ${twice.state.withdrawals.length} entries`;
  if (!twice.warnings.length) return "no warning was given";
  return null;
});

check("undo puts a vial back, but refuses a slot that was refilled", () => {
  const s = fixture();
  const gone = E.withdraw(s, "v-2", { date: "2026-08-25", by: "t", ids: ["w-1"] }).state;
  const back = E.undoWithdrawal(gone, "w-1");
  if (!back.ok) return `undo failed: ${back.reason}`;
  if (E.indexById(back.state.vials)["v-2"].location.position !== "A2") return "the vial did not go back to A2";
  if (back.state.withdrawals.length) return "the log entry was not cleared";

  const refilled = JSON.parse(JSON.stringify(gone));
  refilled.vials.push(vial("v-other", "Something else", "b-a", "A2"));
  const blocked = E.undoWithdrawal(refilled, "w-1");
  if (blocked.ok) return "undo overwrote a vial that had taken the slot";
  if (!/Something else/.test(blocked.reason)) return `reason did not name the occupant: ${blocked.reason}`;
  return null;
});

check("stock counts follow the vials", () => {
  const s = fixture();
  const before = E.stockCounts(s).find((c) => c.name === "HEK ATP7B KO g3").stored;
  const after = E.stockCounts(E.withdraw(s, "v-1", { date: "2026-08-25", by: "t", ids: ["w-1"] }).state)
                 .find((c) => c.name === "HEK ATP7B KO g3");
  if (after.stored !== before - 1) return `stored went ${before} -> ${after.stored}`;
  if (after.withdrawn !== 1) return `withdrawn is ${after.withdrawn}`;
  return null;
});

// ================================================================ validation

check("a clean fixture has nothing to report", () => {
  const problems = E.validate(fixture());
  return problems.length ? `clean state reported ${json(problems.map((p) => p.code))}` : null;
});

function expectError(mutate, code) {
  const s = fixture();
  mutate(s);
  const errs = E.errorsOnly(E.validate(s));
  const hit = errs.filter((e) => e.code === code);
  if (hit.length !== 1) return `expected exactly one ${code}, got ${json(errs.map((e) => e.code))}`;
  return null;
}

check("two vials in one slot is an error", () =>
  expectError((s) => { s.vials.push(vial("v-dup", "Intruder", "b-a", "A1")); }, "slot-collision"));

check("a position outside the grid is an error", () =>
  expectError((s) => { s.vials[0].location.position = "J1"; }, "bad-position"));

check("a dangling box reference is an error", () =>
  expectError((s) => { s.vials[0].location.boxId = "b-nope"; }, "unknown-box"));

check("a duplicate vial id is an error", () =>
  expectError((s) => { s.vials.push(vial("v-1", "Twin", "b-c", "A1")); }, "duplicate-vial"));

check("a stored vial with no location is an error", () =>
  expectError((s) => { s.vials[0].location = null; }, "no-location"));

check("a withdrawn vial that still holds a slot is an error", () =>
  expectError((s) => { s.vials[0].status = "withdrawn"; }, "withdrawn-with-location"));

check("shrinking a box below its contents is refused, and names what is in the way", () => {
  const s = fixture();
  const no = E.canResizeBox(s, "b-a", 1, 1);
  if (no.ok) return "a shrink that would strand vials was allowed";
  if (!no.blocked || !no.blocked.length) return "nothing was named as being in the way";
  if (!/HEK|Huh7/.test(no.reason)) return `reason did not name a vial: ${no.reason}`;
  const yes = E.canResizeBox(s, "b-a", 9, 12);
  return yes.ok ? null : `growing a box was refused: ${yes.reason}`;
});

check("an impossible passage is a warning, not a silent import", () => {
  const s = fixture();
  s.vials.push(vial("v-serial", "Pasted line", "b-c", "A1", { passage: "p45769" }));
  const warns = E.validate(s).filter((p) => p.code === "implausible-passage");
  if (warns.length !== 1) return `got ${warns.length} warnings`;
  if (E.errorsOnly(E.validate(s)).length) return "it was raised as an error, which would block the save";
  return null;
});

// ====================================================================== xlsx

await checkAsync("a workbook survives being written and read back", async () => {
  const sheets = [{ name: "vials", rows: [["box", "pos", "name", "n"], ["ONGOING", "C4", "DuDtxR CASPEX DSg1.2", 3],
                                          ["DUZENLE", "A1", "LuCap35CR & <friends>", 0]] }];
  const back = await X.readWorkbook(X.writeWorkbook(sheets));
  const got = back.sheets[0].rows.map((r) => r.map((c) => (c ? c.value : null)));
  // A zero is a number, not a blank: a count of 0 has to survive the round-trip.
  const want = [["box", "pos", "name", "n"], ["ONGOING", "C4", "DuDtxR CASPEX DSg1.2", 3],
                ["DUZENLE", "A1", "LuCap35CR & <friends>", 0]];
  if (json(got) !== json(want)) return `round-trip gave ${json(got)}`;
  if (back.sheets[0].name !== "vials") return "the sheet name did not survive";
  return null;
});

await checkAsync("the deflated workbook is much smaller and reads back the same", async () => {
  const sheets = E.vialsToSheets(fixture());
  const stored = X.writeWorkbook(sheets);
  const packed = await X.writeWorkbookAsync(sheets);
  if (packed.length >= stored.length) return `deflating made it ${packed.length} vs ${stored.length} bytes`;
  const a = await X.readWorkbook(stored);
  const b = await X.readWorkbook(packed);
  const flat = (wb) => json(wb.sheets.map((s) => [s.name, s.rows.map((r) => r.map((c) => (c ? c.value : null)))]));
  return flat(a) === flat(b) ? null : "the two forms did not read back identically";
});

await checkAsync("a sheet name Excel would reject is cleaned, not passed through", async () => {
  const back = await X.readWorkbook(X.writeWorkbook([{ name: "a/b:c[d]*e?f-and-a-very-long-tail-beyond-31", rows: [["x"]] }]));
  const n = back.sheets[0].name;
  if (n.length > 31) return `name is ${n.length} characters`;
  if (/[:\\\/?*\[\]]/.test(n)) return `name still contains a forbidden character: ${json(n)}`;
  return null;
});

check("the exported workbook has one row per vial, plus a header", () => {
  const s = fixture();
  const sheets = E.vialsToSheets(s);
  const names = sheets.map((x) => x.name);
  if (json(names) !== json(["vials", "stock", "withdrawals", "storage"])) return `sheets were ${json(names)}`;
  const vials = sheets[0].rows;
  if (vials.length !== s.vials.length + 1) return `vials sheet has ${vials.length} rows for ${s.vials.length} vials`;
  const storage = sheets[3].rows;
  if (storage.length !== 5) return `storage sheet has ${storage.length} rows for 4 boxes`;
  return null;
});

await checkAsync("a date survives the export round-trip as written", async () => {
  const s = fixture();
  const back = await X.readWorkbook(X.writeWorkbook(E.vialsToSheets(s)));
  const rows = back.sheets[0].rows;
  const head = rows[0].map((c) => c.value);
  const col = head.indexOf("frozen");
  const got = rows[1][col].value;
  if (got !== "2025-06-01") return `frozen came back as ${json(got)}`;
  return null;
});

// ============================================================== import shape

check("guessColumns finds a position column that has no header", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [[cell(""), cell(""), cell("Cell Name"), cell("Passage")]];
  for (let i = 0; i < 10; i++) rows.push([cell(""), cell("A " + (i + 1)), cell("Some line"), cell("p3")]);
  const g = E.guessColumns(rows, 0);
  const byIndex = {};
  g.forEach((x) => { byIndex[x.index] = x.role; });
  if (byIndex[1] !== "position") return `column B guessed as ${json(byIndex[1])}`;
  if (byIndex[2] !== "name") return `column C guessed as ${json(byIndex[2])}`;
  return null;
});

check("a headerless name column is found by elimination once a position column exists", () => {
  // Neither column has a header at all -- this is the "some people write position
  // then name, others name then position, with no header either way" case Umut
  // described. guessColumns() never cared about column order (header/content
  // matching is per-column), so this proves the elimination fallback for the one
  // shape it genuinely couldn't recognize before: a headerless name column.
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [[cell(""), cell("")]];
  const names = ["HEK293T p12", "Du145 CASPEX g5.1", "LnCap KO g2", "HEK293T ATF3 OX", "Du145 WT"];
  for (let i = 0; i < names.length; i++) rows.push([cell("A" + (i + 1)), cell(names[i])]);
  const g = E.guessColumns(rows, 0);
  const byIndex = {};
  g.forEach((x) => { byIndex[x.index] = x.role; });
  if (byIndex[0] !== "position") return `column A guessed as ${json(byIndex[0])}`;
  if (byIndex[1] !== "name") return `column B guessed as ${json(byIndex[1])}`;
  return null;
});

check("a single headerless column is never guessed as name without a position column to anchor it", () => {
  // Elimination only fires once a position column has actually been found -- one
  // lone unheaded text column by itself must stay "ignore" rather than being guessed.
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [[cell("")]];
  ["HEK293T p12", "Du145 CASPEX g5.1", "LnCap KO g2"].forEach((n) => rows.push([cell(n)]));
  const g = E.guessColumns(rows, 0);
  if (g[0].role === "name") return "guessed a name column with no position column present";
  return null;
});

check("the box column is found by its merges, since nothing else gives it away", () => {
  // One merged label per block, a blank header, and 80 of 81 cells empty. Content
  // heuristics cannot see this column; the merge list can.
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [[cell(""), cell(""), cell("Cell Name")]];
  for (let i = 0; i < 12; i++) rows.push([cell(i === 0 ? "BOX ONE" : ""), cell("A" + (i + 1)), cell("A line")]);
  const merges = [{ ref: "A2:A13", startCol: 0, endCol: 0, startRow: 2, endRow: 13 }];
  const withMerges = {};
  E.guessColumns(rows, 0, merges).forEach((g) => { withMerges[g.index] = g.role; });
  if (withMerges[0] !== "box") return `column A guessed as ${json(withMerges[0])}`;
  // And without the merge list it must not invent one.
  const without = {};
  E.guessColumns(rows, 0).forEach((g) => { without[g.index] = g.role; });
  if (without[0] === "box") return "a box column was guessed with no evidence for it";
  return null;
});

check("box geometry is read from the data, never assumed", () => {
  if (json(E.gridFromPositions(["A1", "I9", "C4"])) !== json({ rows: 9, cols: 9, scheme: "grid" })) return "a 9x9 block was misread";
  if (json(E.gridFromPositions(["A1", "E10"])) !== json({ rows: 5, cols: 10, scheme: "grid" })) return "a 5x10 block was misread";
  if (E.gridFromPositions(["7", "12"]) !== null) return "linear positions were read as a grid";
  return null;
});

// ---- storage: a unit's racks are a tree, arbitrarily deep ----
//
// Umut's real -80 is unit -> rack -> box; these prove the same functions handle a
// deeper unit -> shelf -> rack -> box just as well, and that a 2-level unit like
// the fixture above is completely unaffected (nothing here migrates existing data).

function nestedFixture() {
  return E.mergeDefaults({
    storage: {
      units: [
        { id: "u-deep", name: "Deep Freezer", type: "freezer", childLabel: "Shelf",
          racks: [
            { id: "shelf-1", name: "Shelf 1", racks: [
              { id: "rack-1", name: "Rack 1", boxes: [box("b-d1", "Box D1", 9, 9)] },
              { id: "rack-2", name: "Rack 2", boxes: [] }
            ] },
            { id: "shelf-2", name: "Shelf 2", boxes: [box("b-d2", "Box D2", 9, 9)] }
          ] }
      ]
    },
    vials: [vial("v-d1", "HEK293T", "b-d1", "A1")]
  });
}

check("eachBox descends through nested subdivisions, not just one level", () => {
  const s = nestedFixture();
  const seen = [];
  E.eachBox(s, (b) => seen.push(b.id));
  if (json(seen.sort()) !== json(["b-d1", "b-d2"])) return `saw ${json(seen)}`;
  return null;
});

check("findBox's chain lists every layer from the top down to the box's own parent", () => {
  const s = nestedFixture();
  const f = E.findBox(s, "b-d1");
  if (!f) return "b-d1 was not found";
  if (json(f.chain.map((r) => r.id)) !== json(["u-deep", "shelf-1", "rack-1"])) return `chain was ${json(f.chain.map((r) => r.id))}`;
  if (f.rack.id !== "rack-1") return `rack should still be the immediate (leaf) one, got ${f.rack.id}`;
  return null;
});

check("locationPath prints every level of a deep chain, not just the leaf rack", () => {
  const s = nestedFixture();
  const p = E.locationPath(s, { boxId: "b-d1", position: "A1" });
  if (p !== "Deep Freezer → Shelf 1 → Rack 1 → Box D1 → A1") return `got ${json(p)}`;
  return null;
});

check("a 2-level unit (today's real shape) is completely unaffected by chain support", () => {
  const s = fixture();
  const p = E.locationPath(s, { boxId: "b-a", position: "A1" });
  if (p !== "-80 Freezer → Rack 1 → Box A → A1") return `got ${json(p)}`;
  return null;
});

check("every layer is somewhere a box can go -- there are no leaf-only destinations now", () => {
  const s = nestedFixture();
  // A layer takes any child now, so "where could a box go?" is every layer there is --
  // one that already holds boxes included, and the top level included.
  const leaves = E.leafRacks(s).map((l) => l.rack.id).sort();
  if (json(leaves) !== json(["rack-1", "rack-2", "shelf-1", "shelf-2", "u-deep"])) return `got ${json(leaves)}`;
  const rack2 = E.leafRacks(s).filter((l) => l.rack.id === "rack-2")[0];
  if (json(rack2.chain.map((r) => r.id)) !== json(["u-deep", "shelf-1", "rack-2"])) return `rack-2 chain was ${json(rack2.chain.map((r) => r.id))}`;
  return null;
});

// ---- the tree: one recursive kind of node ----------------------------------------
//
// This replaced three fixed levels (unit -> rack -> box) and the dozen count/subdivision
// functions that propped them up. A layer holds anything; a layer marked isBox stops and
// holds vials. Umut drew it as a folder tree, and these are its rules.

function treeFixture() {
  let st = E.mergeDefaults({});
  const add = (parent, details) => {
    const r = E.addNode(st.storage, parent, details);
    if (!r.ok) throw new Error(r.reason);
    st = E.hydrateStorage(st, r.state, "umut");
    return r.node.id;
  };
  const freezer = add(null, { name: "Freezer 1", note: "-80 °C" });
  const shelf = add(freezer, { name: "Shelf 1" });
  const rack = add(shelf, { name: "Metal Rack 1" });
  const boxId = add(rack, { name: "Umut Box 1", isBox: true, owner: "umut", rows: 3, cols: 3 });
  const tank = add(null, { name: "LN2 Tank", note: "-196" });
  return { state: st, freezer, shelf, rack, boxId, tank };
}

check("a layer holds layers, boxes, or both -- there is no leaf-or-group rule any more", () => {
  const f = treeFixture();
  const r = E.addNode(f.state.storage, f.rack, { name: "Deeper", note: "" });
  if (!r.ok) return `refused a layer beside a box: ${r.reason}`;
  const rack = E.findNode(r.state, f.rack);
  const kinds = rack.node.children.map((n) => (E.isBoxNode(n) ? "box" : "layer"));
  if (json(kinds) !== json(["box", "layer"])) return `unexpected children: ${json(kinds)}`;
  return null;
});

check("nothing goes inside a box", () => {
  const f = treeFixture();
  const r = E.addNode(f.state.storage, f.boxId, { name: "Nope" });
  if (r.ok) return "a box accepted a child";
  if (!/is a box/.test(r.reason)) return `unexpected reason: ${json(r.reason)}`;
  return null;
});

check("a box has to belong to somebody, at both add and edit", () => {
  const f = treeFixture();
  const a = E.addNode(f.state.storage, f.rack, { name: "Orphan", isBox: true });
  if (a.ok) return "a box was created with no owner";
  if (!/belong to somebody/.test(a.reason)) return `unexpected reason: ${json(a.reason)}`;
  const e = E.editNode(f.state.storage, f.boxId, { owner: "" });
  if (e.ok) return "a box's owner was cleared";
  return null;
});

check("names, notes and icons are editable on any node; what a node IS is not", () => {
  const f = treeFixture();
  const r = E.editNode(f.state.storage, f.shelf, { name: "Shelf One", note: "top", icon: "🧊" });
  if (!r.ok) return `refused: ${r.reason}`;
  const n = E.findNode(r.state, f.shelf).node;
  if (n.name !== "Shelf One" || n.note !== "top" || n.icon !== "🧊") return `not applied: ${json(n)}`;
  // isBox is deliberately not in editNode's vocabulary: flipping it would orphan either
  // the children or the vials, so it is a delete-and-make-again decision.
  const b = E.editNode(r.state, f.shelf, { isBox: true });
  if (E.isBoxNode(E.findNode(b.state, f.shelf).node)) return "a layer was turned into a box by an edit";
  return null;
});

check("depth is unlimited, and findBox reports the whole chain", () => {
  let st = E.mergeDefaults({});
  let parent = null;
  const names = ["A", "B", "C", "D", "E", "F"];
  names.forEach((n) => {
    const r = E.addNode(st.storage, parent, { name: n });
    st = E.hydrateStorage(st, r.state, "umut");
    parent = r.node.id;
  });
  const r = E.addNode(st.storage, parent, { name: "Deep box", isBox: true, owner: "umut", rows: 1, cols: 1 });
  st = E.hydrateStorage(st, r.state, "umut");
  const f = E.findBox(st, r.node.id);
  if (json(f.chain.map((n) => n.name)) !== json(names)) return `chain was ${json(f.chain.map((n) => n.name))}`;
  if (f.unit.name !== "A") return `unit should be the top-level ancestor, got ${f.unit.name}`;
  if (f.rack.name !== "F") return `rack should be the immediate parent, got ${f.rack.name}`;
  return null;
});

check("moveNode takes a whole branch anywhere, and refuses the two moves that lose one", () => {
  const f = treeFixture();
  const moved = E.moveNode(f.state.storage, f.shelf, f.tank);
  if (!moved.ok) return `refused a real move: ${moved.reason}`;
  if (E.findNode(moved.state, f.shelf).chain[0].id !== f.tank) return "the shelf did not land in the tank";
  if (!E.findBox(moved.state, f.boxId)) return "the box under it did not come along";

  const itself = E.moveNode(f.state.storage, f.shelf, f.shelf);
  if (itself.ok) return "a layer was moved into itself";
  const inside = E.moveNode(f.state.storage, f.shelf, f.rack);
  if (inside.ok) return "a layer was moved into its own descendant";
  if (!/inside itself/.test(inside.reason)) return `unexpected reason: ${json(inside.reason)}`;
  const intoBox = E.moveNode(f.state.storage, f.shelf, f.boxId);
  if (intoBox.ok) return "a layer was moved into a box";
  return null;
});

check("a box can be taken out of the freezer without being deleted, and put back", () => {
  const f = treeFixture();
  const out = E.moveNode(f.state.storage, f.boxId, "unplaced");
  if (!out.ok) return `refused: ${out.reason}`;
  if (E.isPlaced(out.state, f.boxId)) return "the box still counts as placed";
  if (!E.findBox(out.state, f.boxId)) return "the box vanished instead of moving";
  if (E.unplacedOf(out.state).length !== 1) return "it is not in the unplaced list";

  const back = E.moveNode(out.state, f.boxId, f.rack);
  if (!back.ok) return `refused putting it back: ${back.reason}`;
  if (!E.isPlaced(back.state, f.boxId)) return "it did not come back into the tree";
  // Only a box can be homeless: a layer with no place in the tree is just lost.
  const layer = E.moveNode(f.state.storage, f.shelf, "unplaced");
  if (layer.ok) return "a layer was allowed to become unplaced";
  return null;
});

check("an unplaced box is never offered as a place to put a vial", () => {
  const f = treeFixture();
  const out = E.moveNode(f.state.storage, f.boxId, "unplaced");
  const st = E.hydrateStorage(f.state, out.state, "umut");
  const offered = E.boxesFor(st, null, "umut").map((b) => b.box.id);
  if (offered.indexOf(f.boxId) !== -1) return "a box with no place in the freezer was offered as one";
  // It is still the owner's box and still shows on their own screens.
  let seen = false;
  E.eachBox(st, (b) => { if (b.id === f.boxId) seen = true; });
  if (!seen) return "the unplaced box disappeared from the owner's view entirely";
  return null;
});

check("removeNode refuses while a vial is inside, and says which box and how many", () => {
  const f = treeFixture();
  let st = f.state;
  st.vials = [Object.assign(vial("v-x", "HEK293T", f.boxId, "A1"), { location: E.locationFor(st, f.boxId, "A1") })];
  const r = E.removeNode(st, f.shelf);
  if (r.ok) return "a shelf holding a full box was deleted";
  if (!/Umut Box 1 still holds 1 vial/.test(r.reason)) return `unexpected reason: ${json(r.reason)}`;

  // Lab-wide counts, because a box in the shared tree is usually full of somebody
  // else's vials, which are in their file and not in this state at all.
  const other = E.removeNode(f.state.storage, f.shelf, { [f.boxId]: 4 });
  if (other.ok) return "counts passed in were ignored";
  if (!/4 vials/.test(other.reason)) return `did not count them: ${json(other.reason)}`;
  return null;
});

check("removeNode takes the whole branch, and says what it would take first", () => {
  const f = treeFixture();
  const what = E.nodeContents(f.state.storage, f.freezer);
  if (what.layers !== 2 || what.boxes.length !== 1) return `nodeContents said ${json(what.layers)} layers, ${what.boxes.length} boxes`;
  const r = E.removeNode(f.state.storage, f.freezer);
  if (!r.ok) return `refused an empty branch: ${r.reason}`;
  if (E.findNode(r.state, f.rack)) return "a nested layer survived its parent being deleted";
  if (E.childrenOfRoot(r.state).length !== 1) return "the wrong number of top-level layers remain";
  return null;
});

check("a vial stores the whole route, and refreshPaths rewrites it after a move", () => {
  const f = treeFixture();
  let st = f.state;
  st.vials = [Object.assign(vial("v-x", "HEK293T", f.boxId, "A1"), { location: E.locationFor(st, f.boxId, "A1") })];
  // Each step carries both: the id, so a rename cannot break it, and the name, so the
  // file still says where the vial is to somebody reading it without the tree.
  if (E.pathKey(st.vials[0].location.path) !== [f.freezer, f.shelf, f.rack].join("/")) {
    return `the stored path is wrong: ${json(st.vials[0].location.path)}`;
  }
  if (E.pathNames(st.vials[0].location.path) !== "Freezer 1/Shelf 1/Metal Rack 1") {
    return `the stored path has no readable names: ${json(st.vials[0].location.path)}`;
  }
  if (E.errorsOnly(E.validate(st)).length) return `a fresh state does not validate: ${json(E.validate(st))}`;

  // Move the box; the stored path is now stale, and validate says so rather than
  // silently believing it or silently rewriting it.
  const moved = E.moveNode(st, f.boxId, f.tank);
  const stale = E.validate(moved.state).filter((p) => p.code === "stale-path");
  if (!stale.length) return "a stale path went unreported";
  if (E.errorsOnly(E.validate(moved.state)).length) return "a stale path was treated as an error, not a warning";

  const fixed = E.refreshPaths(moved.state);
  if (fixed.touched !== 1) return `refreshPaths touched ${fixed.touched}`;
  if (E.validate(fixed.state).filter((p) => p.code === "stale-path").length) return "the path was not fixed";
  if (E.pathKey(fixed.state.vials[0].location.path) !== f.tank) {
    return `the new path is wrong: ${json(fixed.state.vials[0].location.path)}`;
  }

  // Renaming a layer leaves the ids right and the names wrong, which is a different
  // complaint with a different fix -- and refreshPaths is that fix too.
  const renamed = E.editNode(fixed.state, f.tank, { name: "LN2 Tank Two" });
  const nameStale = E.validate(renamed.state).filter((p) => p.code === "stale-path");
  if (!nameStale.length) return "a renamed layer left the stored names unreported";
  if (!/renamed/.test(nameStale[0].message)) return `unhelpful message: ${nameStale[0].message}`;
  const reNamed = E.refreshPaths(renamed.state);
  if (reNamed.touched !== 1) return `refreshPaths ignored a rename (touched ${reNamed.touched})`;
  if (E.pathNames(reNamed.state.vials[0].location.path) !== "LN2 Tank Two") {
    return `the names were not refreshed: ${json(reNamed.state.vials[0].location.path)}`;
  }
  return null;
});

check("locationPath reads out the whole route, and says when a box has no place yet", () => {
  const f = treeFixture();
  const st = f.state;
  const loc = E.locationFor(st, f.boxId, "B2");
  if (E.locationPath(st, loc) !== "Freezer 1 → Shelf 1 → Metal Rack 1 → Umut Box 1 → B2") {
    return `path read: ${E.locationPath(st, loc)}`;
  }
  const out = E.moveNode(st, f.boxId, "unplaced");
  if (!/Not placed yet/.test(E.locationPath(out.state, loc))) {
    return `an unplaced box does not say so: ${E.locationPath(out.state, loc)}`;
  }
  return null;
});

check("the old three-level file still opens, folded into the tree", () => {
  // Somebody's saved copy, or the file as it was before this change: units with a type,
  // racks nested inside them, boxes at the bottom. The type and the note become one note
  // rather than either being dropped.
  const old = E.mergeStorageDefaults({
    labName: "CAA Lab Stocks",
    units: [{ id: "u-f80", name: "-80 Freezer", type: "-80 °C", note: "back corner", childLabel: "Rack",
              racks: [{ id: "r-1", name: "Rack 1", racks: [
                { id: "r-1-1", name: "Shelf 1", boxes: [box("b-a", "Box A", 9, 9)] }
              ] }] }]
  });
  if (old.units) return "the old units array was left behind";
  if (old.children.length !== 1) return `expected one top layer, got ${old.children.length}`;
  if (old.children[0].note !== "-80 °C · back corner") return `the note reads: ${json(old.children[0].note)}`;
  const found = E.findBox(old, "b-a");
  if (!found) return "the box did not survive the fold";
  if (json(found.chain.map((n) => n.name)) !== json(["-80 Freezer", "Rack 1", "Shelf 1"])) {
    return `chain: ${json(found.chain.map((n) => n.name))}`;
  }
  if (!E.isBoxNode(found.box)) return "the box was not marked as one";
  return null;
});


check("removing a box leaves the layers above it alone -- pruning is a decision, not a side effect", () => {
  // The handoff used to walk the structure by hand and prune every layer it emptied,
  // because a rack with no boxes meant nothing in a fixed three-level tree. In a tree of
  // layers an empty layer is a perfectly good shelf that somebody labelled, so removing
  // a box removes the box. Anything more is a separate, deliberate delete.
  const s = nestedFixture();
  // Box D1 holds v-d1, and a box holding a vial is never deleted out from under it --
  // the app takes those out (as withdrawals, in their owner's file) and says so first.
  const held = E.removeNode(s, "b-d1");
  if (held.ok) return "a box holding a vial was deleted";
  if (!/still holds 1 vial/.test(held.reason)) return `unexpected reason: ${json(held.reason)}`;

  const emptied = Object.assign({}, s, { vials: [] });
  const r = E.removeNode(emptied, "b-d1");
  if (!r.ok) return `refused an empty box: ${r.reason}`;
  const remaining = [];
  E.eachBox(r.state, (b) => remaining.push(b.id));
  if (json(remaining) !== json(["b-d2"])) return `remaining boxes: ${json(remaining)}`;
  if (!E.findRackNode(r.state, "rack-1")) return "the layer the box was in was deleted with it";
  if (!E.findRackNode(r.state, "shelf-1")) return "a layer further up was deleted too";
  // And deleting that now-empty layer is one call, when somebody actually asks for it.
  const gone = E.removeNode(r.state, "shelf-1");
  if (!gone.ok) return `an empty branch would not delete: ${gone.reason}`;
  if (E.findRackNode(gone.state, "rack-1")) return "deleting the branch left its children behind";
  return null;
});

// ---- item types: applyPlacement()'s kind/customFacets ----
//
// Non-Cell facets are typed in by hand (a dynamic attribute/value table on the Add
// screen), never derived automatically from the name -- there is no engine-side
// classification step for them, only this plain pass-through storage.

check("applyPlacement writes a non-default kind and customFacets, but never the default kind", () => {
  const box = { id: "b1", name: "Box 1", rows: 9, cols: 9, scheme: "grid" };
  const state = E.mergeDefaults({ storage: { children: [
    { id: "u1", name: "Freezer", children: [
      { id: "r1", name: "Rack 1", children: [Object.assign({ isBox: true, owner: "umut" }, box)] }
    ] }
  ] } });

  const cellPlan = E.suggestPlacement(state, { name: "HEK293T p12", count: 1 });
  const cellOut = E.applyPlacement(state, cellPlan, { name: "HEK293T p12", passage: "p12" },
    { ids: ["v1"], now: null, by: "test" });
  if (cellOut.vials[0].kind !== undefined) return `a default-kind vial must not get a kind field: ${json(cellOut.vials[0].kind)}`;

  const plasmidPlan = E.suggestPlacement(cellOut.state, { name: "pLVX-dox-GFP", count: 1 });
  const plasmidOut = E.applyPlacement(cellOut.state, plasmidPlan,
    { name: "pLVX-dox-GFP", kind: "Plasmid", customFacets: { "dox-inducible": "Yes" } },
    { ids: ["v2"], now: null, by: "test" });
  const v = plasmidOut.vials[0];
  if (v.kind !== "Plasmid") return `expected kind Plasmid, got ${json(v.kind)}`;
  if (!v.customFacets || v.customFacets["dox-inducible"] !== "Yes") return `expected customFacets, got ${json(v.customFacets)}`;
  return null;
});

// ---- import: a cell naming more than one physical vial ("A4 & A5") ----

check("splitPositions splits on &, commas, and/ve, and same-row hyphen ranges", () => {
  if (json(E.splitPositions("A4 & A5")) !== json(["A4", "A5"])) return `"A4 & A5" -> ${json(E.splitPositions("A4 & A5"))}`;
  if (json(E.splitPositions("A8, B1")) !== json(["A8", "B1"])) return `"A8, B1" -> ${json(E.splitPositions("A8, B1"))}`;
  if (json(E.splitPositions("A4 and A5")) !== json(["A4", "A5"])) return `"A4 and A5" -> ${json(E.splitPositions("A4 and A5"))}`;
  if (json(E.splitPositions("A4 ve A5")) !== json(["A4", "A5"])) return `"A4 ve A5" -> ${json(E.splitPositions("A4 ve A5"))}`;
  if (json(E.splitPositions("A4-A6")) !== json(["A4", "A5", "A6"])) return `"A4-A6" -> ${json(E.splitPositions("A4-A6"))}`;
  if (json(E.splitPositions("A2")) !== json(["A2"])) return `a single position must come back unchanged: ${json(E.splitPositions("A2"))}`;
  if (json(E.splitPositions("")) !== json([])) return "blank text must split to nothing";
  return null;
});

check("a multi-position row becomes one vial per slot", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [
    [cell("Position"), cell("Cell Name")],
    [cell("A4 & A5"), cell("HEK293T p12")],
    [cell("A8, B1"), cell("Du145 WT")]
  ];
  const sheet = { name: "Sheet1", rows, merges: [] };
  const out = E.importSheet(sheet, { columns: { position: 0, name: 1 }, headerRow: 1 });
  if (out.state.vials.length !== 4) return `expected 4 vials from 2 rows, got ${out.state.vials.length}`;
  if (out.state.vials.some((v) => v.importAmbiguous)) return "a clean multi-position row must not be queued for review";
  const positions = out.state.vials.map((v) => v.location && v.location.position).sort();
  if (json(positions) !== json(["A4", "A5", "A8", "B1"])) return `unexpected positions: ${json(positions)}`;
  const names = out.state.vials.map((v) => v.name).sort();
  if (json(names) !== json(["Du145 WT", "Du145 WT", "HEK293T p12", "HEK293T p12"])) return `unexpected names: ${json(names)}`;
  return null;
});

check("a multi-position row falls back to review if a piece collides or doesn't parse", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [
    [cell("Position"), cell("Cell Name")],
    [cell("A1"), cell("Line one")],
    [cell("A1 & A2"), cell("Line two")]
  ];
  const sheet = { name: "Sheet1", rows, merges: [] };
  const out = E.importSheet(sheet, { columns: { position: 0, name: 1 }, headerRow: 1 });
  const collided = out.state.vials.find((v) => v.name === "Line two");
  if (!collided) return "the colliding row must still surface, not vanish";
  return null;
});

check("a Unit column fans rows out into separate storage units", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [
    [cell("Place in lab"), cell("Place in the Box"), cell("box name"), cell("Cell Name")],
    [cell("Liquid nitrogen"), cell("A2"), cell("PINK"), cell("HEK293T p12")],
    [cell("-80 freezer"), cell("A1"), cell("BLUE"), cell("Du145 WT")]
  ];
  const sheet = { name: "Sheet1", rows, merges: [] };
  const g = E.guessColumns(rows, 0);
  const byIndex = {};
  g.forEach((x) => { byIndex[x.index] = x.role; });
  if (byIndex[0] !== "unit") return `"Place in lab" guessed as ${json(byIndex[0])}`;
  if (byIndex[1] !== "position") return `"Place in the Box" guessed as ${json(byIndex[1])}`;
  if (byIndex[2] !== "box") return `"box name" guessed as ${json(byIndex[2])}`;

  const out = E.importSheet(sheet, { columns: { unit: 0, position: 1, box: 2, name: 3 }, headerRow: 1 });
  if (out.state.storage.children.length !== 2) return `expected 2 layers, got ${out.state.storage.children.length}`;
  const names = out.state.storage.children.map((u) => u.name).sort();
  if (json(names) !== json(["-80 freezer", "Liquid nitrogen"])) return `unexpected unit names: ${json(names)}`;
  return null;
});

check("an unrecognized column mapped to \"New\" becomes a real field, not notes text", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [
    [cell("Position"), cell("Cell Name"), cell("myco")],
    [cell("A1"), cell("HEK293T p12"), cell("negative")]
  ];
  const sheet = { name: "Sheet1", rows, merges: [] };
  const out = E.importSheet(sheet, { columns: { position: 0, name: 1 }, headerRow: 1, customColumns: { 2: "Myco status" } });
  const v = out.state.vials[0];
  if (!v.custom || v.custom["Myco status"] !== "negative") return `expected a custom field, got ${json(v.custom)}`;
  if (v.notes) return `a custom column must not be folded into notes: ${json(v.notes)}`;
  return null;
});

// ---- import: a row nobody could place goes to Review, never guessed or dropped ----

check("a row with no name is queued for review instead of dropped or guessed", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [
    [cell("Position"), cell("Cell Name")],
    [cell("A1"), cell("HEK293T p12")],
    [cell("A2"), cell("")]
  ];
  const sheet = { name: "Sheet1", rows, merges: [] };
  const out = E.importSheet(sheet, { columns: { position: 0, name: 1 }, headerRow: 1 });
  if (out.state.vials.length !== 2) return `expected 2 vials (one real, one ambiguous), got ${out.state.vials.length}`;
  const ambiguous = out.state.vials.filter((v) => v.importAmbiguous);
  if (ambiguous.length !== 1) return `expected exactly 1 ambiguous vial, got ${ambiguous.length}`;
  if (ambiguous[0].location) return "an ambiguous row must not get a fabricated location";
  const q = E.reviewQueue(out.state);
  if (q.ambiguousImport.length !== 1) return `reviewQueue did not surface it: ${json(q)}`;
  const hits = E.search(out.state, { query: "" });
  if (hits.some((h) => h.vial.importAmbiguous)) return "an ambiguous row showed up in ordinary search results";
  return null;
});

check("a row whose position doesn't parse is queued for review too, not silently dropped", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [[cell("Position"), cell("Cell Name")], [cell("42"), cell("Mystery Line")]];
  const sheet = { name: "Sheet1", rows, merges: [] };
  const out = E.importSheet(sheet, { columns: { position: 0, name: 1 }, headerRow: 1 });
  if (out.state.vials.length !== 1) return `expected the row to still become a vial, got ${out.state.vials.length}`;
  if (!out.state.vials[0].importAmbiguous) return "a bad position should still be flagged for review";
  if (out.report.skipped.length !== 1) return `report.skipped should still record why: ${json(out.report.skipped)}`;
  return null;
});

check("validate() warns about an ambiguous import row rather than blocking the whole save", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [[cell("Position"), cell("Cell Name")], [cell(""), cell("")]];
  const sheet = { name: "Sheet1", rows, merges: [] };
  const out = E.importSheet(sheet, { columns: { position: 0, name: 1 }, headerRow: 1 });
  const problems = E.validate(out.state);
  if (E.errorsOnly(problems).length) return `an ambiguous import row must not be a save-blocking error: ${json(problems)}`;
  if (!problems.some((p) => p.level === "warning" && p.code === "import-ambiguous")) return `expected an import-ambiguous warning: ${json(problems)}`;
  return null;
});

check("resolveImportRow fills in a name and position, and clears the review flag", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [[cell("Position"), cell("Cell Name")], [cell(""), cell("")]];
  const sheet = { name: "Sheet1", rows, merges: [] };
  const imported = E.importSheet(sheet, { columns: { position: 0, name: 1 }, headerRow: 1 }).state;
  const vialId = imported.vials[0].id;
  const boxId = imported.storage.children[0].children[0].children[0].id;
  const res = E.resolveImportRow(imported, vialId, { name: "HEK293T p12", boxId: boxId, position: "A1" });
  if (!res.ok) return `resolveImportRow failed: ${res.reason}`;
  if (res.vial.importAmbiguous) return "importAmbiguous should be cleared";
  if (!res.vial.location || res.vial.location.position !== "A1") return `expected a location at A1, got ${json(res.vial.location)}`;
  if (E.errorsOnly(E.validate(res.state)).length) return "the resolved state should validate cleanly";
  return null;
});

check("resolveImportRow refuses a slot that is already taken", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [
    [cell("Position"), cell("Cell Name")],
    [cell("A1"), cell("HEK293T p12")],
    [cell(""), cell("")]
  ];
  const sheet = { name: "Sheet1", rows, merges: [] };
  const imported = E.importSheet(sheet, { columns: { position: 0, name: 1 }, headerRow: 1 }).state;
  const ambiguous = imported.vials.find((v) => v.importAmbiguous);
  const boxId = imported.storage.children[0].children[0].children[0].id;
  const res = E.resolveImportRow(imported, ambiguous.id, { name: "Another Line", boxId: boxId, position: "A1" });
  if (res.ok) return "expected the already-taken slot to be refused";
  return null;
});

// ---- Review's "Unknown" date: passage's "p?" for a date ----

check("markDateUnknown records a permanent answer, and reviewQueue stops asking", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [[cell("Position"), cell("Cell Name")], [cell("A1"), cell("HEK293T p12")]];
  const sheet = { name: "Sheet1", rows, merges: [] };
  const imported = E.importSheet(sheet, { columns: { position: 0, name: 1 }, headerRow: 1 }).state;
  if (E.reviewQueue(imported).dates.length !== 1) return "expected the dateless vial to start in Review";
  const res = E.markDateUnknown(imported, imported.vials[0].id);
  if (!res.ok) return `markDateUnknown failed: ${res.reason}`;
  if (!res.vial.dateUnknown) return "expected dateUnknown to be set";
  if (res.vial.frozenOn) return "Unknown is not a date -- frozenOn must stay unset";
  if (E.reviewQueue(res.state).dates.length !== 0) return "a vial marked Unknown must not keep reappearing in Review";
  return null;
});

check("confirmDate clears a prior Unknown mark", () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [[cell("Position"), cell("Cell Name")], [cell("A1"), cell("HEK293T p12")]];
  const sheet = { name: "Sheet1", rows, merges: [] };
  const imported = E.importSheet(sheet, { columns: { position: 0, name: 1 }, headerRow: 1 }).state;
  const marked = E.markDateUnknown(imported, imported.vials[0].id).state;
  const res = E.confirmDate(marked, imported.vials[0].id, "2026-01-05");
  if (!res.ok) return `confirmDate failed: ${res.reason}`;
  if (res.vial.dateUnknown) return "confirming a real date must clear the Unknown mark";
  if (res.vial.frozenOn !== "2026-01-05") return `expected frozenOn 2026-01-05, got ${json(res.vial.frozenOn)}`;
  return null;
});

check("a blank Add-screen date defaults to today, never to Review", () => {
  const box = { id: "b1", name: "Box 1", rows: 9, cols: 9, scheme: "grid" };
  const state = E.mergeDefaults({ storage: { children: [
    { id: "u1", name: "Freezer", children: [
      { id: "r1", name: "Rack 1", children: [Object.assign({ isBox: true, owner: "umut" }, box)] }
    ] }
  ] } });
  const plan = E.suggestPlacement(state, { name: "HEK293T p12", count: 1 });
  if (!plan.ok) return "expected a plan into an empty box";
  const out = E.applyPlacement(state, plan, { name: "HEK293T p12", passage: "p12", frozenOn: "" },
    { ids: ["v1"], now: "2026-09-05T12:00:00.000Z", by: "test" });
  const v = out.vials[0];
  if (v.frozenOn !== "2026-09-05") return `expected today's date, got ${json(v.frozenOn)}`;
  if (E.reviewQueue(out.state).dates.length !== 0) return "a live Add with a blank date must not be queued for review";
  return null;
});

// ---- storage: one shared lab structure, hydrated onto each member ----
//
// The freezer belongs to the lab (cellstocks/lab-storage.json), the vials belong to
// whoever froze them (cellstocks/data/<name>.json). state.storage is hydrated from the
// first at load so every existing function still reads it exactly where it always did,
// and slim() takes it back off before a member's own file is written -- if it did not,
// the two copies would drift the first time an admin renamed a rack.

check("a member's own file is written without the lab's storage in it", () => {
  const lab = { labName: "CAA Lab Stocks", units: [
    { id: "u-1", name: "-80", childLabel: "Rack",
      racks: [{ id: "r-1", name: "Rack 1", boxes: [box("b-1", "Box 1", 9, 9)] }] }
  ] };
  const own = E.mergeDefaults({ vials: [vial("v-1", "HEK293T", "b-1", "A1")] });
  const hydrated = E.hydrateStorage(own, lab, "umut");
  if (!E.findBox(hydrated, "b-1")) return "hydration did not put the lab's boxes on the state";
  const written = JSON.parse(E.serialise(hydrated));
  if (written.storage !== undefined) return `storage was written into the member file: ${json(written.storage)}`;
  if (written._owner !== undefined) return "the runtime owner marker leaked into the member file";
  if ((written.vials || []).length !== 1) return "the member's own vials went missing";
  return null;
});

check("the lab's own file keeps the tree, its name and every box's owner", () => {
  const lab = E.mergeStorageDefaults({ children: [
    { id: "u-1", name: "-80", children: [
      { id: "r-1", name: "Rack 1", children: [
        Object.assign({ isBox: true }, box("b-1", "Box 1", 9, 9), { owner: "umut", note: "" })
      ] }
    ] }
  ] });
  const written = JSON.parse(E.serialiseStorage(lab));
  if (written.labName !== "CAA Lab Stocks") return `expected a default lab name, got ${json(written.labName)}`;
  if (written.units) return "the old units array should not be written back";
  const b = written.children[0].children[0].children[0];
  if (b.owner !== "umut") return `the owner was dropped: ${json(b)}`;
  if (!b.isBox) return "a box has to say it is one -- it is the only thing that marks it";
  if (b.note !== undefined) return "an empty note should still be stripped from a box";
  return null;
});

check("hydration is a round trip: the same lab, the same member file, byte for byte", () => {
  const lab = E.mergeStorageDefaults({ units: [
    { id: "u-1", name: "-80", childLabel: "Rack",
      racks: [{ id: "r-1", name: "Rack 1", boxes: [Object.assign(box("b-1", "Box 1", 9, 9), { owner: "umut" })] }] }
  ] });
  const own = E.mergeDefaults({ vials: [vial("v-1", "HEK293T", "b-1", "A1")] });
  const once = E.serialise(E.hydrateStorage(own, lab, "umut"));
  const twice = E.serialise(E.hydrateStorage(E.mergeDefaults(JSON.parse(once)), lab, "umut"));
  if (once !== twice) return "a second save of an untouched state would churn the file";
  return null;
});

check("placement only ever offers a member their own boxes", () => {
  const lab = { units: [{ id: "u-1", name: "-80", childLabel: "Rack", racks: [{ id: "r-1", name: "Rack 1", boxes: [
    Object.assign(box("b-mine", "Mine", 9, 9), { owner: "umut" }),
    Object.assign(box("b-theirs", "Theirs", 9, 9), { owner: "caa" }),
    box("b-nobodys", "Unowned", 9, 9)
  ] }] }] };
  const state = E.hydrateStorage(E.mergeDefaults({ vials: [] }), lab, "umut");

  const mine = E.boxesFor(state, null, "umut").map((e) => e.box.id).sort();
  if (json(mine) !== json(["b-mine", "b-nobodys"])) return `expected mine + the unowned one, got ${json(mine)}`;
  if (E.boxesFor(state, null).length !== 3) return "without an owner every box should still be listed";

  // A plan for this member must never propose a box belonging to someone else.
  const plan = E.suggestPlacement(state, { name: "HEK293T", count: 1, owner: "umut" });
  if (!plan.ok) return `no plan at all: ${plan.reason}`;
  if (plan.segments.some((seg) => seg.boxId === "b-theirs")) return "a plan proposed another member's box";
  return null;
});

check("iconKind tells an uploaded image from an emoji, and blank from both", () => {
  const cases = [["freezer.png", "image"], ["a.JPEG", "image"], ["x.webp", "image"],
                 ["\u{1F9CA}", "emoji"], ["\u{1F4C1}", "emoji"], ["", null], ["   ", null]];
  for (const [value, want] of cases) {
    if (E.iconKind(value) !== want) return `iconKind(${json(value)}) was ${json(E.iconKind(value))}, expected ${json(want)}`;
  }
  return null;
});

// ------------------------------------------------------- an import reaches the lab
//
// The bug this guards: a spreadsheet import invented boxes in the member's own state,
// and slim() drops `storage` from a member's file -- so the boxes were never written
// anywhere. On the next reload every imported vial resolved to "(unknown box)", and
// validate() then refused to save that member's file at all.

const importFixture = () => {
  const cell = (t) => ({ value: t, text: t, formula: null, isDate: false, iso: null, type: "string" });
  const rows = [
    [cell("Position"), cell("Cell Name"), cell("Box")],
    [cell("A1"), cell("HEK293T ATP7B KO p12"), cell("BOX ONE")],
    [cell("B2"), cell("Du145 CASPEX g5.1 p7"), cell("BOX ONE")]
  ];
  return E.importSheet({ name: "Sheet1", rows, merges: [] },
    { columns: { position: 0, name: 1, box: 2 }, headerRow: 1,
      unitName: "-80 Freezer", rackName: "Rack 1", sourceName: "t.xlsx", idPrefix: "v" }).state;
};

check("imported boxes reach the lab's shared file, so they survive a reload", () => {
  const imported = importFixture();
  const lab = E.blankStorage();
  const adopted = E.adoptImportedBoxes(lab, imported, "umut");

  if ((adopted.storage.unplaced || []).length !== 1) {
    return `expected one box in the lab, got ${json(adopted.storage.unplaced)}`;
  }
  const box = adopted.storage.unplaced[0];
  if (box.owner !== "umut") return `the imported box belongs to ${json(box.owner)}`;
  if (!box.isBox) return "the imported box is not marked as a box";
  // A member does not add freezers to everybody's tree, so the sheet's own location
  // is kept as a note rather than becoming layers nobody asked for.
  if (adopted.storage.children.length) return `the import added layers: ${json(adopted.storage.children.map((c) => c.name))}`;
  if (!/-80 Freezer/.test(box.note)) return `the sheet's location was lost: ${json(box.note)}`;

  // The whole point: save it, reload it against the committed tree, and the vials still
  // know where they are.
  const written = JSON.parse(E.serialise(adopted.state));
  if (written.storage !== undefined) return "the member's file still carries the tree";
  const reloaded = E.hydrateStorage(E.mergeDefaults(written), adopted.storage, "umut");
  const errs = E.errorsOnly(E.validate(reloaded));
  if (errs.length) return `after a reload the inventory is invalid: ${errs[0].message}`;
  if (/unknown box/.test(E.locationPath(reloaded, reloaded.vials[0].location))) {
    return "an imported vial came back pointing at a box that does not exist";
  }
  if (E.occupancy(reloaded, box.id).used !== 2) {
    return `the imported vials are not in the box: ${json(E.occupancy(reloaded, box.id).used)}`;
  }
  return null;
});

check("two people importing a box of the same name do not collide", () => {
  const first = E.adoptImportedBoxes(E.blankStorage(), importFixture(), "umut");
  const second = E.adoptImportedBoxes(first.storage, importFixture(), "busra");
  const ids = second.storage.unplaced.map((b) => b.id);
  if (new Set(ids).size !== ids.length) return `two boxes share an id: ${json(ids)}`;
  if (ids.length !== 2) return `expected both boxes to survive: ${json(ids)}`;
  // And the second importer's vials follow their box to its new id.
  const movedTo = ids[1];
  if (second.state.vials.some((v) => v.location.boxId !== movedTo)) {
    return `a vial was left pointing at the old id: ${json(second.state.vials.map((v) => v.location.boxId))}`;
  }
  // The first person's boxes and vials are untouched by somebody else's import.
  if (first.storage.unplaced.length !== 1) return "the first import was mutated by the second";
  return null;
});

// ---------------------------------------------------------------- shared rules
//
// The rules were per-account and had genuinely drifted apart -- admin read
// "Du145 TOX4 KO" as a knockout and umut's copy as an overexpression. Umut asked for
// them merged and shared. Merging an ordered, first-match-wins list is not
// concatenation, and these are the three things that make it not.

check("a merged facet keeps a matcher's first position, and drops the later duplicate", () => {
  const out = E.mergeRuleSets([
    { owner: "a", rules: { origin: [{ match: "Du", value: "Du145" }, { match: "HEK", value: "HEK293T" }] } },
    { owner: "b", rules: { origin: [{ match: "HEK", value: "HEK293T" }, { match: "Du", value: "Du145" }] } }
  ]);
  const seen = out.rules.origin.map((r) => r.match).join(",");
  // Moving "Du" after "HEK" would change what it beats, so the first account's order wins.
  if (seen !== "Du,HEK") return `order changed: ${seen}`;
  if (out.conflicts.length) return `a plain duplicate was called a conflict: ${json(out.conflicts)}`;
  return null;
});

check("the same matcher with a different value is reported, never silently settled", () => {
  const out = E.mergeRuleSets([
    { owner: "admin", rules: { resistance: [{ match: "50CR", value: "CisR" }] } },
    { owner: "umut", rules: { resistance: [{ match: "50CR", value: "50CR" }] } }
  ]);
  if (out.rules.resistance.length !== 1) return `both readings were kept: ${json(out.rules.resistance)}`;
  if (out.conflicts.length !== 1) return `the disagreement went unreported: ${json(out.conflicts)}`;
  const c = out.conflicts[0];
  if (c.kept !== "CisR" || c.dropped !== "50CR" || c.keptFrom !== "admin" || c.droppedFrom !== "umut") {
    return `the report does not say who wanted what: ${json(c)}`;
  }
  return null;
});

check("a catch-all sorts last, so a merged rule can never be dead code behind it", () => {
  // umut's list ends in a bare {value:"WT"}; admin's has a rule that must still be
  // reachable after it. Appended naively, everything after the catch-all never runs.
  const out = E.mergeRuleSets([
    { owner: "umut", rules: { koox: [{ match: "OX", value: "OX" }, { value: "WT" }] } },
    { owner: "admin", rules: { koox: [{ match: "CASP", value: "CASPEX" }, { value: "WT" }] } }
  ]);
  const list = out.rules.koox;
  if (list[list.length - 1].value !== "WT" || list[list.length - 1].match !== undefined) {
    return `the catch-all is not last: ${json(list)}`;
  }
  if (!list.some((r) => r.match === "CASP")) return `a rule was lost: ${json(list)}`;
  // And it must actually be reached.
  if (E.classify("Du145 CASPEX g5", out.rules).koox !== "CASPEX") {
    return `CASP is unreachable behind the catch-all: ${json(list)}`;
  }
  return null;
});

check("two catch-alls that disagree are a conflict too, not two catch-alls", () => {
  const out = E.mergeRuleSets([
    { owner: "a", rules: { resistance: [{ value: "-" }] } },
    { owner: "b", rules: { resistance: [{ value: "none" }] } }
  ]);
  if (out.rules.resistance.length !== 1) return `two fallbacks survived: ${json(out.rules.resistance)}`;
  if (out.conflicts.length !== 1) return "the disagreeing fallback went unreported";
  return null;
});

check("merging is pure -- the sets it was given come back untouched", () => {
  const mine = { origin: [{ match: "HEK", value: "HEK293T" }] };
  const before = json(mine);
  E.mergeRuleSets([{ owner: "a", rules: mine }, { owner: "b", rules: { origin: [{ match: "Du", value: "Du145" }] } }]);
  return json(mine) === before ? null : `the input was mutated: ${json(mine)}`;
});

check("a member's saved file carries no rules of its own any more", () => {
  const st = E.mergeDefaults({ vials: [], lines: [] });
  const written = JSON.parse(E.serialise(st));
  if (written.rules !== undefined) return `slim() still writes rules: ${json(Object.keys(written))}`;
  if (written.storage !== undefined) return "slim() still writes the storage tree";
  // And hydrating puts them back where every screen already reads them.
  const shared = { origin: [{ match: "Zed", value: "ZedLine" }] };
  const hydrated = E.hydrateRules(st, shared);
  if (E.classify("Zed 12", hydrated.rules).origin !== "ZedLine") {
    return `the shared rules did not reach state.rules: ${json(hydrated.rules.origin)}`;
  }
  // A facet the shared file does not mention still falls back to the built-in defaults,
  // rather than becoming undefined and classifying everything as nothing.
  if (!hydrated.rules.guide || !hydrated.rules.guide.length) return "a missing facet was left empty";
  return null;
});

// ============================================================== real inventory
//
// Everything above runs on a fixture. These run on cellstocks/data/umut.json --
// the 350 vials actually in the freezer -- so a rule change that reclassifies real
// vials fails here rather than in front of an open door. This used to be
// cellstocks/cellstocks.json, a single-account file left over from before the
// lab-wide/multi-user split; it stopped being written the moment the worker-login
// flow shipped (dataPath() in index.html has pointed at cellstocks/data/<name>.json
// ever since), so it necessarily drifted out of date and was retired.

const REAL_PATH = join(ROOT, "cellstocks", "data", "umut.json");
const LAB_STORAGE_PATH = join(ROOT, "cellstocks", "lab-storage.json");
// The freezer is the lab's, in its own file; a member's file holds only their vials.
// The app hydrates the two together at load (see loadState in index.html) and these
// checks have to run against the same thing the app renders, so they hydrate too.
const labStorage = existsSync(LAB_STORAGE_PATH)
  ? E.mergeStorageDefaults(JSON.parse(readFileSync(LAB_STORAGE_PATH, "utf8"))) : E.blankStorage();
// The rules moved out of each member's file into one shared set, the same way the tree
// did, so the real inventory is hydrated with both -- exactly what the app does at load.
const LAB_RULES_PATH = join(ROOT, "cellstocks", "lab-rules.json");
const labRules = existsSync(LAB_RULES_PATH)
  ? E.mergeRulesDefaults(JSON.parse(readFileSync(LAB_RULES_PATH, "utf8"))) : E.mergeRulesDefaults(null);
const realOwnFile = existsSync(REAL_PATH) ? E.mergeDefaults(JSON.parse(readFileSync(REAL_PATH, "utf8"))) : null;
const real = realOwnFile ? E.hydrateRules(E.hydrateStorage(realOwnFile, labStorage, "umut"), labRules) : null;

// Umut edits this file from his phone -- takes vials out, confirms dates in bulk,
// fixes a passage -- and this suite runs on every one of those saves. A check here
// is only allowed to assert something that stays true under ANY sequence of
// legitimate app actions. A number captured at one point in time (how many vials
// were imported, how many dates were still ambiguous, which facets the sheet's own
// formulas got wrong) is exactly the kind of thing normal use is designed to change,
// and pinning it here means every correct use of a feature turns CI red forever.
// That happened for real: confirming the 135 ambiguous dates via Review's own
// "Accept the swap for all" button broke three checks that used to hardcode 141,
// 209 and "no vial may have frozenOn set from an ambiguous frozenRaw" -- the very
// thing that button exists to do. The importer's own correctness (the five regex
// fixes, parseDate's day/month handling) stays fully covered above by the synthetic
// fixture, which the app can never edit.

check("saving the real inventory unchanged rewrites it byte for byte", () => {
  if (!real) return null;
  // The app writes the file through E.serialise. If loading it and writing it back
  // is not a no-op, then every save churns lines nobody edited -- and worse, the
  // committed file and what the app believes are already two different things.
  const onDisk = readFileSync(REAL_PATH, "utf8");
  const written = E.serialise(real);
  if (written === onDisk) return null;
  const a = onDisk.split("\n"), b = written.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `first difference at line ${i + 1}: on disk ${json(a[i])}, app would write ${json(b[i])}`;
  }
  return "the files differ in length only";
});

check("the committed lab rules are the ones on disk, written byte for byte", () => {
  if (!existsSync(LAB_RULES_PATH)) return null;   // not merged yet
  const onDisk = readFileSync(LAB_RULES_PATH, "utf8");
  const written = E.serialiseRules(labRules);
  return written === onDisk ? null : "the app would rewrite cellstocks/lab-rules.json on its next save";
});

check("the real inventory validates with no errors", () => {
  if (!real) return null;   // not imported yet
  const errs = E.errorsOnly(E.validate(real));
  return errs.length ? `${errs.length} errors, first: ${errs[0].message}` : null;
});

// This used to assert the freezer's exact contents -- eight 9x9 boxes, a 162-slot
// nitrogen tank, a named cell line that was definitely in there. Every one of those
// numbers was a photograph of one afternoon in 2025, and the whole set went red the
// morning the freezer was rebuilt and the boxes were emptied. Which is what the
// preamble above already says not to do.
//
// What is left is what stays true of ANY inventory: an empty one on the day the tree
// is first drawn, and a full one a year later. Nothing here counts anything.
check("the real inventory holds nothing that is double-booked or shapeless", () => {
  if (!real) return null;
  const boxes = [];
  E.eachBox(real, (b) => boxes.push(b));
  for (const b of boxes) {
    if (!(b.rows >= 1 && b.cols >= 1)) return `${b.name} is ${b.rows}x${b.cols}`;
    // A box belongs to somebody -- that is the rule addNode enforces, and a box that
    // slipped in without an owner appears on nobody's Boxes screen.
    if (!b.owner) return `${b.name} belongs to nobody`;
  }
  // Every stored (non-withdrawn) vial occupies exactly one slot, no more, no fewer.
  // Withdrawals change how many that is; they must never change whether occupancy and
  // vial status agree with each other.
  const total = boxes.reduce((n, b) => n + E.occupancy(real, b.id).used, 0);
  const stored = real.vials.filter((v) => v.status !== "withdrawn").length;
  if (total !== stored) return `${total} slots are occupied but ${stored} vials are marked stored`;
  return null;
});

// classify() correctness -- the five regex fixes, and origin/CASPEX staying stable --
// is fully covered above by the synthetic fixture, which is fixed strings the app can
// never edit. Checking it again here, against classifyAll(real).diffs, used to compare
// against exact per-rule counts (26 OX->KO, 12 CR->-, ...) captured right after import.
// That was the wrong place for it: Review's own "Accept all of these" button clears
// facetsFromSheet on purpose, and a hand-pinned facet does the same for one vial --
// both zero out rows this used to insist on, for reasons that are the app working
// correctly. Deleted rather than chasing a moving target with a growing exception list.

// Same story for a fixed review-queue size (141 dates, 49 facets, 67 unknown passages
// at import time): every one of those numbers is exactly what Find/Freeze/Review exist
// to change. Not re-tested here; searchExtents/search/withdraw already have their own
// synthetic-fixture coverage above for the mechanics reviewQueue is built from.

// The row rule -- one kind of cell per row -- is not something this app imposes on the
// freezer, it is how the freezer already is; that is documented (with the count at the
// time) in README.md and CLAUDE.md. It is not re-asserted here as a row/box head-count,
// because a withdrawal or an edit can freely change which rows are in use or how many
// cells they hold, and none of that is a bug. What has to stay true regardless is
// narrower: nothing is EVER mixed merely because no rule covers it -- since LCC and LNC
// both resolve to LnCap, that gap is closed for good, and a name with a real gap should
// surface in Review, not sit silently doubled up in a row.
check("no row is left mixed only because an origin rule is missing", () => {
  if (!real) return null;
  const forWantOfARule = E.mixedRows(real).filter((m) => m.origins.indexOf(E.NO_ORIGIN) !== -1);
  return forWantOfARule.length
    ? `${forWantOfARule.length} rows are mixed only because no rule covers a name there, e.g. ` +
      `${forWantOfARule[0].box} row ${forWantOfARule[0].label}`
    : null;
});

// Asking for one particular area by id -- it used to be the nitrogen tank -- is a plan
// that must stay inside it and must describe the route down to the slot. Which area
// that is stopped being something to hardcode the moment the tree became the admin's to
// draw, so this asks it of every area that has room.
check("a plan aimed at one area stays in it, and says the whole way down", () => {
  if (!real) return null;
  const areas = (real.storage.children || []).filter((u) => {
    return E.leafRacks(real, u.id).length && E.unitSummary(real, u.id).capacity;
  });
  if (!areas.length) return null;                 // nowhere to put anything yet
  for (const area of areas) {
    const summary = E.unitSummary(real, area.id);
    if (summary.capacity - summary.used < 5) continue;   // full, which is a fair answer
    const plan = E.suggestPlacement(real, { name: "LnCap Canada", count: 5, unitId: area.id });
    if (!plan.ok) return `nothing can be placed into ${area.name}: ${plan.reason}`;
    for (const seg of plan.segments) {
      if (seg.unitId !== area.id) return `a plan for ${area.name} wandered into ${seg.unitId}`;
      // The path is how a person finds the slot with the door open, so it has to name
      // every layer between the area and the box, however many that is.
      const chain = E.findBox(real, seg.boxId).chain;
      for (const node of chain) {
        if (seg.path.indexOf(node.name) === -1) return `path ${json(seg.path)} skips ${node.name}`;
      }
    }
  }
  return null;
});

check("no plan against the real freezer ever mixes two cells in a row", () => {
  if (!real) return null;
  const names = ["Huh7 CBX3 KO g2", "HEK ATP7B KO g3", "DuDtxR CASPEX g5.1", "LnCap Canada",
                 "LuCap35CR", "MDA-MB-231 TOX4 OX", "HepG2 gNT", "LCC-V", "Brand New Cell"];
  for (const name of names) {
    for (const count of [1, 3, 9, 14]) {
      const plan = E.suggestPlacement(real, { name, count });
      if (!plan.ok) continue;                       // a full freezer is a fair answer
      const mine = E.classify(name, real.rules).origin || E.NO_ORIGIN;
      for (const seg of plan.segments) {
        const occ = E.occupancy(real, seg.boxId);
        const rows = E.rowsOf(real, seg.boxId);
        for (const pos of seg.positions) {
          const parsed = E.parsePosition(occ.box, pos);
          if (occ.slots[parsed.index].vial) return `${name} x${count}: ${seg.boxName} ${pos} is taken`;
          const others = rows[parsed.row].origins.filter((o) => o !== mine);
          if (others.length) {
            return `${name} x${count} was put in ${seg.boxName} row ${E.rowLabel(parsed.row)}, which holds ${others.join(", ")}`;
          }
        }
      }
      // And applying it must leave the freezer no more mixed than it started.
      const before = E.mixedRows(real).length;
      const ids = plan.segments.reduce((n, seg) => n + seg.positions.length, 0);
      const out = E.applyPlacement(real, plan, { name, passage: "p1", frozenOn: "2026-08-25" },
        { ids: Array.from({ length: ids }, (_, i) => "probe-" + i), now: null, by: "test" });
      if (E.mixedRows(out.state).length !== before) return `${name} x${count} created a mixed row`;
    }
  }
  return null;
});

// A vial with frozenOn set from an ambiguous frozenRaw is exactly what confirming a
// date through Review produces on purpose -- E.confirmDate() sets frozenOn and leaves
// the original frozenRaw text untouched, so a human-confirmed vial and an importer bug
// are indistinguishable from the file alone. That is why this can only be tested where
// it was above: parseDate() and importSheet() directly, against fixed input strings,
// never against a file Review is designed to keep changing.

check("every real vial keeps its passage on the right scale", () => {
  if (!real) return null;
  const counts = { absolute: 0, relative: 0, unknown: 0 };
  real.vials.forEach((v) => { counts[v.passageKind || "unknown"]++; });
  // How many are still unknown is a Review-queue number like any other -- it only ever
  // goes down as vials get filled in. record count isn't fixed either: freezing new
  // vials adds records, and none of them get deleted. What must always hold is that
  // the three kinds still account for every record that exists right now.
  if (counts.absolute + counts.relative + counts.unknown !== real.vials.length) {
    return `the kinds add up to ${counts.absolute + counts.relative + counts.unknown}, not ${real.vials.length} vials`;
  }
  const wrong = real.vials.filter((v) => v.passage && /\+/.test(v.passage) && v.passageKind !== "relative");
  return wrong.length ? `${wrong.length} p+N vials are not marked relative` : null;
});

// The query used to be a cell line that was definitely in the freezer, by name. It is
// not there any more, and naming another one only moves the problem. A vial taken out
// of the file itself is in the freezer by construction.
check("a real search finds a real vial, and says where it is", () => {
  if (!real) return null;
  const anyVial = real.vials.filter((v) => v.status !== "withdrawn" && v.location && v.name)[0];
  if (!anyVial) return null;                      // nothing stored yet
  const hits = E.search(real, { query: anyVial.name.toLowerCase() });
  if (!hits.some((h) => h.vial.id === anyVial.id)) {
    return `${json(anyVial.name)} is in the freezer but searching for it does not find it`;
  }
  for (const h of hits) {
    // A box the admin has not placed yet is honestly pathless; anything in the tree
    // has a route, and a route reads with arrows.
    const placed = E.isPlaced(real, h.vial.location.boxId);
    if (placed && !/→/.test(h.path)) return `a result had no location path: ${json(h.path)}`;
  }
  return null;
});

check("freezing into the real freezer never offers a slot that is taken", () => {
  if (!real) return null;
  const plan = E.suggestPlacement(real, { name: "Huh7", count: 3 });
  if (!plan.ok) return null;                      // no boxes yet, or no room -- both fair
  for (const seg of plan.segments) {
    const occ = E.occupancy(real, seg.boxId);
    if (occ.free < seg.positions.length) return `${occ.box.name} was offered ${seg.positions.length} slots but has ${occ.free}`;
    for (const p of seg.positions) {
      if (occ.slots[E.parsePosition(occ.box, p).index].vial) return `${occ.box.name} ${p} is already taken`;
    }
  }
  return null;
});

// ---------------------------------------------------------------------- report
const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length} of ${total} checks failed:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`All ${total} cell stocks checks passed.`);
