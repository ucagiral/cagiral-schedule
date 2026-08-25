// Proves the cell stocks rules actually hold, instead of trusting that they do.
//
// Run:  node tools/cellstocks-selftest.mjs
//
// Loads cellstocks/engine.js and cellstocks/xlsx.js -- the same two files the app
// loads in the browser -- and runs them against a synthetic freezer built for the
// edge cases, and then against the real inventory in cellstocks/cellstocks.json.
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
    vials: [
      // Box A: four HeLa p12 and one HeLa p20, plus filler, leaving a known gap.
      vial("v-1", "HeLa", "b-a", "A1", { passage: "p12" }),
      vial("v-2", "HeLa", "b-a", "A2", { passage: "p12" }),
      vial("v-3", "HeLa", "b-a", "A3", { passage: "p12" }),
      vial("v-4", "HeLa", "b-a", "A4", { passage: "p20", frozenOn: "2024-01-01" }),
      vial("v-5", "Huh7 CBX3 KO g2", "b-a", "B1", { passage: "p+3", notes: "myco -" }),
      vial("v-6", "DuDtxR CASPEX g5.1", "b-b", "A1", { passage: "p?" })
    ]
  });
  return state;
}

// A box with every slot but three taken, for the placement corner cases.
function nearlyFull(state, boxId, freeCount) {
  const occ = E.occupancy(state, boxId);
  const next = JSON.parse(JSON.stringify(state));
  let n = 0;
  occ.slots.forEach((s) => {
    if (s.vial) return;
    if (occ.capacity - occ.used - n <= freeCount) return;
    next.vials.push(vial("fill-" + boxId + "-" + s.index, "Filler line", boxId, s.position));
    n++;
  });
  return next;
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
  const got = E.classify("LCC-V");
  if (got.origin !== null) return `origin was ${json(got.origin)}, expected null`;
  if (got.unmatched.indexOf("origin") === -1) return "origin was not listed as unmatched";
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
  rules.origin.unshift({ match: "LCC", value: "LCC" });
  if (E.classify("LCC-V", rules).origin !== "LCC") return "the added rule did not take effect";
  if (E.classify("LCC-V").origin !== null) return "adding a rule mutated the defaults";
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

// ==================================================================== search

check("a keyword finds the vial and names where it is", () => {
  const s = fixture();
  const hits = E.search(s, { query: "hela p12" });
  if (hits.length !== 3) return `expected the 3 p12 vials, got ${hits.length}`;
  if (!/Box A/.test(hits[0].path)) return `path was ${json(hits[0].path)}`;
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
  const hits = E.search(s, { query: "hela p12 crispr" });
  if (!hits.length) return "a 2-of-3 match was rejected";
  if (json(hits[0].missed) !== json(["crispr"])) return `missed was ${json(hits[0].missed)}`;
  const full = E.search(s, { query: "hela p12" });
  if (full[0].missed.length) return "a full match reported a missed word";
  return null;
});

check("a query that matches nothing returns nothing", () => {
  const s = fixture();
  if (E.search(s, { query: "zebrafish" }).length) return "nonsense matched something";
  if (E.search(s, { query: "hela zebrafish quokka wombat" }).length) return "a 1-of-4 match was accepted";
  return null;
});

check("results are ordered, and the same call twice gives the same order", () => {
  const s = fixture();
  const a = E.search(s, { query: "hela" });
  const b = E.search(s, { query: "hela" });
  for (let i = 1; i < a.length; i++) if (a[i - 1].score < a[i].score) return "results are not sorted by score";
  if (json(a.map((r) => r.vial.id)) !== json(b.map((r) => r.vial.id))) return "two identical calls disagreed";
  return null;
});

check("the sliders only ever narrow", () => {
  const s = fixture();
  const all = E.search(s, { query: "hela" }).map((r) => r.vial.id);
  const narrowed = E.search(s, { query: "hela", frozenFrom: "2025-01-01" }).map((r) => r.vial.id);
  if (narrowed.length > all.length) return "a date filter added results";
  for (const id of narrowed) if (all.indexOf(id) === -1) return `${id} appeared only once filtered`;
  if (narrowed.indexOf("v-4") !== -1) return "the 2024 vial survived a 2025 floor";
  const byPassage = E.search(s, { query: "hela", passageKind: "absolute", passageMin: 15 }).map((r) => r.vial.id);
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
  if (E.search(after, { query: "hela p12" }).length !== 2) return "a withdrawn vial still shows by default";
  const shown = E.search(after, { query: "hela p12", includeWithdrawn: true });
  if (shown.length !== 3) return "includeWithdrawn did not bring it back";
  if (shown[shown.length - 1].vial.id !== "v-1") return "the withdrawn vial did not sort last";
  return null;
});

check("results group to one card per line and box", () => {
  const s = fixture();
  const groups = E.searchGroups(E.search(s, { query: "hela p12" }));
  if (groups.length !== 1) return `expected 1 group, got ${groups.length}`;
  if (groups[0].count !== 3) return `group counted ${groups[0].count}`;
  if (json(groups[0].positions) !== json(["A1", "A2", "A3"])) return `positions were ${json(groups[0].positions)}`;
  return null;
});

// ================================================================= placement

check("a line goes back into the box that already holds it", () => {
  const s = fixture();
  const plan = E.suggestPlacement(s, { name: "HeLa", count: 4 });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  if (plan.strategy !== "same-line") return `strategy was ${plan.strategy}`;
  if (plan.segments[0].boxId !== "b-a") return `landed in ${plan.segments[0].boxId}`;
  if (plan.segments[0].positions.length !== 4) return "wrong number of positions";
  return null;
});

check("one freeze-down lands in one contiguous run", () => {
  const s = fixture();
  const plan = E.suggestPlacement(s, { name: "HeLa", count: 5 });
  const b = E.findBox(s, plan.segments[0].boxId).box;
  const idx = plan.segments[0].positions.map((p) => E.parsePosition(b, p).index);
  for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1] + 1) return `positions are not contiguous: ${json(plan.segments[0].positions)}`;
  return null;
});

check("scattered slots are listed, never described as a block that isn't there", () => {
  // A box with free slots dotted around it can still take five vials, but calling
  // that "E6-H8" describes a run somebody would open the box looking for.
  var s = fixture();
  var occ = E.occupancy(s, "b-c");
  // Fill Box C leaving five free slots that are deliberately not adjacent.
  var keep = { 0: true, 10: true, 20: true, 30: true, 40: true };
  occ.slots.forEach((slot) => { if (!keep[slot.index]) s.vials.push(vial("scat-" + slot.index, "Filler line", "b-c", slot.position)); });
  // Aimed at Box C explicitly: the other boxes have more room and would otherwise win.
  const plan = E.suggestPlacement(s, { name: "Brand New Line", count: 5, boxId: "b-c" });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  const seg = plan.segments[0];
  if (seg.contiguous) return "five scattered slots were reported as contiguous";
  if (/–/.test(plan.summary)) return `summary claims a range: ${json(plan.summary)}`;
  for (const p of seg.positions) if (plan.summary.indexOf(p) === -1) return `${p} is missing from the summary`;
  return null;
});

check("a proposal never names an occupied slot, or the same slot twice", () => {
  const s = fixture();
  for (const count of [1, 2, 5, 20, 76]) {
    const plan = E.suggestPlacement(s, { name: "HeLa", count });
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

check("a new line takes the emptiest box, preferring a wholly empty one", () => {
  const s = fixture();
  const plan = E.suggestPlacement(s, { name: "Brand New Line", count: 3 });
  if (plan.strategy !== "new-box") return `strategy was ${plan.strategy} (${plan.reason})`;
  if (plan.segments[0].boxId !== "b-c") return `landed in ${plan.segments[0].boxId}, expected the empty Box C`;
  return null;
});

check("a full box spills into another, and says so", () => {
  let s = fixture();
  s = nearlyFull(s, "b-a", 2);   // Box A: only 2 free, and it holds the HeLa
  const plan = E.suggestPlacement(s, { name: "HeLa", count: 5 });
  if (!plan.ok) return `plan failed: ${plan.reason}`;
  // Box A holds the HeLa but has only 2 free, so keeping the line together loses to
  // not part-filling: tier 1 passes it over entirely rather than placing 2 of the 5.
  if (plan.segments.length !== 1) return "a single-box plan was expected";
  if (plan.segments[0].boxId === "b-a") return "5 vials were squeezed into a box with 2 free slots";
  if (plan.segments[0].positions.length !== 5) return "the plan did not cover all 5";
  // And it has to SAY why the line was not kept together, or a full box looks like
  // the app forgetting where the line lives.
  if (!/Box A/.test(plan.reason) || !/no room/.test(plan.reason)) {
    return `reason does not explain the full box: ${json(plan.reason)}`;
  }
  return null;
});

check("splitting is explicit, and switching it off never part-fills", () => {
  let s = fixture();
  s = nearlyFull(s, "b-a", 2);
  s = nearlyFull(s, "b-b", 2);
  s = nearlyFull(s, "b-c", 2);
  const split = E.suggestPlacement(s, { name: "HeLa", count: 5 });
  if (!split.ok || split.strategy !== "split") return `expected a split, got ${json(split.strategy || split.reason)}`;
  const total = split.segments.reduce((n, seg) => n + seg.positions.length, 0);
  if (total !== 5) return `split covered ${total} slots, not 5`;

  s.settings.placement.allowSplit = false;
  const refused = E.suggestPlacement(s, { name: "HeLa", count: 5 });
  if (refused.ok) return "splitting was switched off but a plan came back anyway";
  if (!/switched off/.test(refused.reason)) return `reason did not mention the setting: ${refused.reason}`;
  return null;
});

check("a freezer with no room says so instead of overflowing into the tank", () => {
  let s = fixture();
  for (const id of ["b-a", "b-b", "b-c"]) s = nearlyFull(s, id, 0);
  const plan = E.suggestPlacement(s, { name: "HeLa", count: 1, unitId: "u-f80" });
  if (plan.ok) return `a plan came back for a full unit: ${json(plan.segments)}`;
  if (!/0 free/.test(plan.reason)) return `reason was ${json(plan.reason)}`;
  return null;
});

check("an explicitly chosen box wins, or explains why it cannot", () => {
  const s = fixture();
  const ok = E.suggestPlacement(s, { name: "HeLa", count: 2, boxId: "b-c" });
  if (!ok.ok || ok.segments[0].boxId !== "b-c") return "an override was ignored";
  if (ok.strategy !== "chosen") return `strategy was ${ok.strategy}`;
  const full = E.suggestPlacement(nearlyFull(s, "b-c", 1), { name: "HeLa", count: 4, boxId: "b-c" });
  if (full.ok) return "an override was allowed to overfill a box";
  if (!/free slot/.test(full.reason)) return `reason was ${json(full.reason)}`;
  return null;
});

check("the same request twice gives the same plan", () => {
  const s = fixture();
  const a = E.suggestPlacement(s, { name: "HeLa", count: 3 });
  const b = E.suggestPlacement(s, { name: "HeLa", count: 3 });
  return json(a) === json(b) ? null : "two identical requests produced different plans";
});

check("applying a plan is byte-identical twice and touches nothing existing", () => {
  const s = fixture();
  const plan = E.suggestPlacement(s, { name: "HeLa", count: 2 });
  const ctx = { ids: ["v-new-1", "v-new-2"], now: "2026-08-25T09:00:00Z", by: "test" };
  const t = { name: "HeLa", passage: "p13", frozenOn: "25-08-26", notes: "" };
  const a = E.applyPlacement(s, plan, t, ctx);
  const b = E.applyPlacement(s, plan, t, ctx);
  if (json(a.state) !== json(b.state)) return "two identical applies produced different states";
  const before = json(s.vials);
  if (json(a.state.vials.slice(0, s.vials.length)) !== before) return "an existing vial was modified";
  if (json(s.vials) !== before) return "applyPlacement mutated the state it was given";
  if (E.errorsOnly(E.validate(a.state)).length) return "the result does not validate";
  return null;
});

check("a freeze-down of five creates five records, one per slot", () => {
  const s = fixture();
  const plan = E.suggestPlacement(s, { name: "HeLa", count: 5 });
  const out = E.applyPlacement(s, plan, { name: "HeLa", passage: "p13", frozenOn: "25-08-26" },
                               { ids: ["a", "b", "c", "d", "e"], now: null, by: "test" });
  if (out.vials.length !== 5) return `made ${out.vials.length} records`;
  const slots = {};
  out.vials.forEach((v) => { slots[v.location.boxId + v.location.position] = (slots[v.location.boxId + v.location.position] || 0) + 1; });
  if (Object.values(slots).some((n) => n > 1)) return "two new vials share a slot";
  if (out.vials[0].passageKind !== "absolute" || out.vials[0].passageNumber !== 13) return "passage was not parsed";
  if (out.vials[0].frozenOn !== "2026-08-25") return `frozenOn was ${json(out.vials[0].frozenOn)}`;
  return null;
});

// ================================================================ withdrawal

check("taking a vial frees its slot for the very next placement", () => {
  const s = fixture();
  const out = E.withdraw(s, "v-2", { date: "2026-08-25", by: "test", ids: ["w-1"] });
  const occ = E.occupancy(out.state, "b-a");
  if (occ.used !== 4) return `box still shows ${occ.used} used`;
  const plan = E.suggestPlacement(out.state, { name: "HeLa", count: 1 });
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
  const before = E.stockCounts(s).find((c) => c.name === "HeLa").stored;
  const after = E.stockCounts(E.withdraw(s, "v-1", { date: "2026-08-25", by: "t", ids: ["w-1"] }).state)
                 .find((c) => c.name === "HeLa");
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
  if (!/HeLa|Huh7/.test(no.reason)) return `reason did not name a vial: ${no.reason}`;
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

// ============================================================== real inventory
//
// Everything above runs on a fixture. These run on cellstocks/cellstocks.json --
// the 350 vials actually in the freezer -- so a rule change that reclassifies real
// vials fails here rather than in front of an open door.

const REAL_PATH = join(ROOT, "cellstocks", "cellstocks.json");
const real = existsSync(REAL_PATH) ? E.mergeDefaults(JSON.parse(readFileSync(REAL_PATH, "utf8"))) : null;

check("the real inventory validates with no errors", () => {
  if (!real) return null;   // not imported yet
  const errs = E.errorsOnly(E.validate(real));
  return errs.length ? `${errs.length} errors, first: ${errs[0].message}` : null;
});

check("the real inventory is six 9x9 boxes with nothing double-booked", () => {
  if (!real) return null;
  const boxes = [];
  E.eachBox(real, (b) => boxes.push(b));
  if (boxes.length !== 6) return `found ${boxes.length} boxes`;
  for (const b of boxes) if (b.rows !== 9 || b.cols !== 9) return `${b.name} is ${b.rows}x${b.cols}`;
  const total = boxes.reduce((n, b) => n + E.occupancy(real, b.id).used, 0);
  if (total !== 350) return `${total} vials are placed, expected 350`;
  return null;
});

// The five deliberate corrections, and nothing else. If a later rule edit changes a
// sixth thing, this fails and names it.
const EXPECTED_DIFFS = {
  "koox: OX -> KO": 26,
  "resistance: CR -> -": 12,
  "resistance: EnzaR -> -": 4,
  "guide: g1 -> DSg1.2": 7,
  "guide: g1 -> g1.2": 2,
  "guide: g2 -> g2.2": 4
};

check("the corrected rules change exactly the rows they are meant to", () => {
  if (!real) return null;
  const seen = {};
  E.classifyAll(real).diffs.forEach((d) => {
    Object.keys(d.changed).forEach((f) => {
      const key = `${f}: ${d.changed[f].sheet} -> ${d.changed[f].now}`;
      seen[key] = (seen[key] || 0) + 1;
    });
  });
  const keys = new Set([...Object.keys(EXPECTED_DIFFS), ...Object.keys(seen)]);
  for (const k of keys) {
    if ((seen[k] || 0) !== (EXPECTED_DIFFS[k] || 0)) {
      return `${json(k)}: sheet disagrees on ${seen[k] || 0} vials, expected ${EXPECTED_DIFFS[k] || 0}`;
    }
  }
  return null;
});

check("origin and CASPEX still read exactly as the sheet did", () => {
  if (!real) return null;
  const bad = [];
  E.classifyAll(real).diffs.forEach((d) => {
    ["origin", "caspex"].forEach((f) => { if (d.changed[f]) bad.push(`${d.name} ${f}`); });
  });
  return bad.length ? `${bad.length} rows differ, e.g. ${bad[0]}` : null;
});

check("the review queue is the size the import reported", () => {
  if (!real) return null;
  const q = E.reviewQueue(real);
  if (q.dates.length !== 141) return `${q.dates.length} dates need confirming, expected 141`;
  if (q.facets.length !== 49) return `${q.facets.length} rows have changed facets, expected 49`;
  if (q.gaps.length !== 19) return `${q.gaps.length} rows have an unmatched facet, expected 19`;
  if (q.passages.length !== 2) return `${q.passages.length} implausible passages, expected 2`;
  return null;
});

check("no ambiguous date was quietly resolved", () => {
  if (!real) return null;
  const wrong = real.vials.filter((v) => v.frozenOn && E.parseDate(v.frozenRaw || "").needsReview);
  if (wrong.length) return `${wrong.length} vials carry a date the raw text does not support, e.g. ${wrong[0].name}`;
  const dated = real.vials.filter((v) => v.frozenOn).length;
  if (dated !== 209) return `${dated} vials have a confirmed date, expected 209`;
  return null;
});

check("every real vial keeps its passage on the right scale", () => {
  if (!real) return null;
  const counts = { absolute: 0, relative: 0, unknown: 0 };
  real.vials.forEach((v) => { counts[v.passageKind || "unknown"]++; });
  if (counts.unknown !== 67) return `${counts.unknown} unknown passages, expected 67`;
  if (counts.absolute + counts.relative + counts.unknown !== 350) return "the kinds do not add up to 350";
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
