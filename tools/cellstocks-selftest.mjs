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
  return { id, name, rows, cols, scheme: scheme || "grid", note: "", archived: false };
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
  const boxId = imported.storage.units[0].racks[0].boxes[0].id;
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
  const boxId = imported.storage.units[0].racks[0].boxes[0].id;
  const res = E.resolveImportRow(imported, ambiguous.id, { name: "Another Line", boxId: boxId, position: "A1" });
  if (res.ok) return "expected the already-taken slot to be refused";
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
const real = existsSync(REAL_PATH) ? E.mergeDefaults(JSON.parse(readFileSync(REAL_PATH, "utf8"))) : null;

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

check("the real inventory validates with no errors", () => {
  if (!real) return null;   // not imported yet
  const errs = E.errorsOnly(E.validate(real));
  return errs.length ? `${errs.length} errors, first: ${errs[0].message}` : null;
});

check("the real inventory is eight 9x9 boxes with nothing double-booked", () => {
  if (!real) return null;
  const boxes = [];
  E.eachBox(real, (b) => boxes.push(b));
  // Six in the -80 freezer, two in the nitrogen tank -- the tank is set up but
  // deliberately still empty.
  if (boxes.length !== 8) return `found ${boxes.length} boxes`;
  for (const b of boxes) if (b.rows !== 9 || b.cols !== 9) return `${b.name} is ${b.rows}x${b.cols}`;
  const total = boxes.reduce((n, b) => n + E.occupancy(real, b.id).used, 0);
  // Not a fixed head-count: every stored (non-withdrawn) vial occupies exactly one
  // slot, no more, no fewer. Withdrawals change how many that is; they must never
  // change whether occupancy and vial status agree with each other.
  const stored = real.vials.filter((v) => v.status !== "withdrawn").length;
  if (total !== stored) return `${total} slots are occupied but ${stored} vials are marked stored`;
  const tank = E.unitSummary(real, "u-ln2");
  if (!tank) return "the nitrogen tank is missing";
  // Not "must be empty": the tank exists to be frozen into, and the moment it holds
  // its first vial is the moment this app is fully doing its job. total === stored
  // above already covers the tank's occupancy along with everything else's.
  if (tank.capacity !== 162) return `the tank has ${tank.capacity} slots, expected 162`;
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

check("the nitrogen tank is modelled but empty, and can be placed into", () => {
  if (!real) return null;
  const tank = E.unitSummary(real, "u-ln2");
  if (!tank) return "no nitrogen tank";
  if (tank.boxes.length !== 2) return `${tank.boxes.length} boxes, expected 2`;
  const plan = E.suggestPlacement(real, { name: "LnCap Canada", count: 5, unitId: "u-ln2" });
  if (!plan.ok) return `nothing can be placed into it: ${plan.reason}`;
  if (plan.segments[0].unitId !== "u-ln2") return "the plan left the tank";
  // A tower is a rack with a different word, and the path has to say so.
  if (!/Tower/.test(plan.segments[0].path)) return `path did not name a Tower: ${json(plan.segments[0].path)}`;
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

check("a real search finds a real vial in a real box", () => {
  if (!real) return null;
  const hits = E.search(real, { query: "dudtxr caspex g5.1" });
  if (!hits.length) return "a line that is definitely in the freezer was not found";
  const paths = new Set(hits.map((h) => h.path));
  if (!paths.size) return "results came back with no location";
  for (const h of hits) if (!/→/.test(h.path)) return `a result had no location path: ${json(h.path)}`;
  return null;
});

check("freezing into the real freezer avoids the two full boxes", () => {
  if (!real) return null;
  const plan = E.suggestPlacement(real, { name: "Huh7", count: 3 });
  if (!plan.ok) return `no plan: ${plan.reason}`;
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
