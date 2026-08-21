// Proves the wardrobe rules actually hold, instead of trusting that they do.
//
// Run:  node tools/wardrobe-selftest.mjs
//
// Loads wardrobe/engine.js — the same file the app loads in the browser — and
// runs it against a synthetic wardrobe built for the edge cases. No network, no
// browser, no fixtures on disk.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The engine is a plain script that assigns to globalThis, so node can just run it.
new Function(readFileSync(join(ROOT, "wardrobe", "engine.js"), "utf8"))();
const E = globalThis.WardrobeEngine;

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

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------- test wardrobe
//
// Colours are chosen to land on specific sides of the neutral test: #e8c33a and
// #c0392b are accents, #f0f0f0 / #202020 / #7a7a7a / #c8b48c are neutral.

const TODAY = "2026-08-21";

function item(o) {
  return Object.assign({
    layer: 1, pattern: "solid", formality: 2, occasions: null,
    fabric: null, waterproof: false, wearsSinceWash: 0, lastWorn: null,
    pinnedUntil: null, guessed: []
  }, o);
}

function wardrobe() {
  return [
    item({ id: "tee-white",   name: "White tee",     slot: "top", layer: 1, warmth: 2, color: "#f0f0f0", formality: 2, washAfter: 1 }),
    item({ id: "tee-yellow",  name: "Yellow tee",    slot: "top", layer: 1, warmth: 2, color: "#e8c33a", formality: 1, washAfter: 1 }),
    item({ id: "tee-black",   name: "Black tee",     slot: "top", layer: 1, warmth: 2, color: "#202020", formality: 2, washAfter: 1 }),
    item({ id: "shirt-green", name: "Green shirt",   slot: "top", layer: 2, warmth: 3, color: "#2f7a4f", formality: 3, washAfter: 3 }),
    item({ id: "knit-grey",   name: "Grey sweater",  slot: "top", layer: 3, warmth: 4, color: "#7a7a7a", formality: 2, washAfter: 4 }),
    item({ id: "knit-red",    name: "Red sweater",   slot: "top", layer: 3, warmth: 4, color: "#c0392b", formality: 2, washAfter: 4, occasions: ["casual"] }),

    item({ id: "chino-beige", name: "Beige chinos",  slot: "bottom", warmth: 3, color: "#c8b48c", formality: 3, washAfter: 5 }),
    item({ id: "jeans-black", name: "Black jeans",   slot: "bottom", warmth: 4, color: "#202020", formality: 2, washAfter: 5 }),
    item({ id: "shorts-khaki",name: "Khaki shorts",  slot: "bottom", warmth: 1, color: "#b5a882", formality: 1, washAfter: 3 }),

    item({ id: "shoe-sneak",  name: "White sneakers",slot: "shoes", warmth: 2, color: "#efefef", formality: 1, washAfter: 60 }),
    item({ id: "shoe-boot",   name: "Brown boots",   slot: "shoes", warmth: 4, color: "#5b4632", formality: 3, washAfter: 60 }),
    item({ id: "shoe-suede",  name: "Suede loafers", slot: "shoes", warmth: 3, color: "#8a6a4a", formality: 3, fabric: "suede", washAfter: 60 }),

    item({ id: "coat-wool",   name: "Wool coat",     slot: "outer", warmth: 4, color: "#3a3a3a", formality: 3, waterproof: false, washAfter: 20 }),
    item({ id: "parka-heavy", name: "Heavy parka",   slot: "outer", warmth: 5, color: "#2b3a4a", formality: 2, waterproof: false, washAfter: 20 }),
    item({ id: "shell-rain",  name: "Rain shell",    slot: "outer", warmth: 2, color: "#33506b", formality: 2, waterproof: true,  washAfter: 20 }),

    item({ id: "scarf-wool",  name: "Wool scarf",    slot: "accessory", warmth: 4, color: "#8a2f2f", formality: 2, washAfter: 10 }),
    item({ id: "cap-navy",    name: "Navy cap",      slot: "accessory", warmth: 2, color: "#1f2d46", formality: 1, washAfter: 10 })
  ];
}

function state(overrides = {}) {
  return Object.assign({
    items: wardrobe(), log: [], swipes: [], rejected: [],
    taste: { weights: {}, n: 0 },
    settings: { cloOffset: 0, repeatDays: 3 }
  }, overrides);
}

const has = (outfit, id) => outfit.ids.indexOf(id) !== -1;
const anyHas = (outfits, id) => outfits.some((o) => has(o, id));
const allHave = (outfits, pred) => outfits.every(pred);

// ============================================================ insulation rules

check("summer day never suggests a sweater or a coat", () => {
  const res = E.recommend(state(), { today: TODAY, tempC: 30 });
  if (!res.outfits.length) return "no outfits at all at 30 °C — the filter is too tight";
  const warm = ["knit-grey", "knit-red", "coat-wool", "parka-heavy", "shell-rain"];
  for (const id of warm) {
    if (anyHas(res.outfits, id)) return `${id} suggested at 30 °C`;
  }
  return null;
});

check("cold day never suggests an outfit without an outer layer", () => {
  const res = E.recommend(state(), { today: TODAY, tempC: 5 });
  if (!res.outfits.length) return "no outfits at all at 5 °C";
  const bare = res.outfits.find((o) => !o.items.some((i) => i.slot === "outer"));
  return bare ? `outfit without an outer layer at 5 °C: ${bare.key}` : null;
});

check("every suggested outfit sits inside the insulation tolerance", () => {
  for (const temp of [-5, 0, 5, 12, 18, 24, 30, 35]) {
    const res = E.recommend(state(), { today: TODAY, tempC: temp });
    for (const o of res.outfits) {
      if (o.requiredClo - o.clo > E.TOLERANCE_COLD + 1e-9) return `too cold at ${temp} °C: ${o.key} (${o.clo} vs ${o.requiredClo})`;
      if (o.clo - o.requiredClo > E.TOLERANCE_WARM + 1e-9) return `too warm at ${temp} °C: ${o.key} (${o.clo} vs ${o.requiredClo})`;
    }
  }
  return null;
});

check("required insulation rises as it gets colder", () => {
  let prev = -Infinity;
  for (const t of [30, 20, 10, 0, -10]) {
    const r = E.requiredClo(t, {});
    if (r < prev) return `required clo fell from ${prev} to ${r} going colder`;
    prev = r;
  }
  return null;
});

check("comfort temperature is the exact inverse of required insulation", () => {
  const opts = { activityFactor: 0.6, cloOffset: 0.1 };
  for (const t of [-5, 0, 8, 15, 22]) {
    const need = E.requiredClo(t, opts);
    if (need <= 0.15) continue;                       // clamped, not invertible
    const back = E.comfortTemp(need, opts);
    if (!near(back, t, 0.05)) return `${t} °C -> ${need} clo -> ${back} °C`;
  }
  return null;
});

check("thickness ladders are per slot, so a thick tee is not a thick parka", () => {
  const tee = E.cloFor({ slot: "top", layer: 1, warmth: 5 });
  const parka = E.cloFor({ slot: "outer", warmth: 5 });
  if (!(parka > tee * 3)) return `thick tee ${tee} vs thick parka ${parka} — ladders are not separated`;
  return null;
});

// ================================================================ pinned items

check("a pinned bottom appears in every outfit and its rivals in none", () => {
  const s = state();
  s.items.find((i) => i.id === "chino-beige").pinnedUntil = "2026-08-28";
  const res = E.recommend(s, { today: TODAY, tempC: 18 });
  if (!res.outfits.length) return "pinning removed every outfit";
  const missing = res.outfits.find((o) => !has(o, "chino-beige"));
  if (missing) return `outfit without the pinned bottom: ${missing.key}`;
  if (anyHas(res.outfits, "jeans-black") || anyHas(res.outfits, "shorts-khaki")) return "a rival bottom still appears";
  return null;
});

check("a pinned item is exempt from the recently-worn rule", () => {
  const s = state();
  const chino = s.items.find((i) => i.id === "chino-beige");
  chino.pinnedUntil = "2026-08-28";
  s.log = [{ date: "2026-08-20", items: ["chino-beige"] }];
  const res = E.recommend(s, { today: TODAY, tempC: 18 });
  if (!res.outfits.length) return "pinned + worn yesterday wiped out every outfit";
  return has(res.outfits[0], "chino-beige") ? null : "pinned bottom was filtered by the repeat rule";
});

check("pinning can be switched off from the criteria panel", () => {
  const s = state();
  s.items.find((i) => i.id === "chino-beige").pinnedUntil = "2026-08-28";
  const res = E.recommend(s, { today: TODAY, tempC: 18, criteria: { usePins: false } });
  return anyHas(res.outfits, "jeans-black") ? null : "rivals still suppressed with pins disabled";
});

// ================================================================ laundry

check("a dirty item drops out, and comes back after a wash", () => {
  const s = state();
  const tee = s.items.find((i) => i.id === "tee-white");
  tee.wearsSinceWash = 1;                              // washAfter is 1
  const dirty = E.recommend(s, { today: TODAY, tempC: 22 });
  if (anyHas(dirty.outfits, "tee-white")) return "dirty tee still suggested";
  if (!dirty.eliminated.dirty) return "dirty item was not counted as eliminated";
  tee.wearsSinceWash = 0;
  const clean = E.recommend(s, { today: TODAY, tempC: 22 });
  return anyHas(clean.outfits, "tee-white") ? null : "washed tee did not come back";
});

check("wash limits default sensibly when not set", () => {
  if (E.defaultWashAfter({ slot: "top", layer: 1 }) !== 1) return "base layer should be one wear";
  if (E.defaultWashAfter({ slot: "bottom" }) < 3) return "bottoms should survive several wears";
  if (E.defaultWashAfter({ slot: "outer" }) < 10) return "outerwear should not be washed constantly";
  return null;
});

// ================================================================ occasion

check("a lab day drops items not tagged for the lab", () => {
  const s = state();
  const res = E.recommend(s, { today: TODAY, tempC: 12, occasion: "lab" });
  if (anyHas(res.outfits, "knit-red")) return "casual-only sweater suggested on a lab day";
  return null;
});

check("items with no occasions recorded go anywhere", () => {
  // Only the name is mandatory when adding an item, so an untagged item must not
  // be filtered out of everything.
  const s = state();
  const res = E.recommend(s, { today: TODAY, tempC: 12, occasion: "lab" });
  return anyHas(res.outfits, "knit-grey") ? null : "untagged sweater was filtered out on a lab day";
});

// ================================================================ rain

check("rain requires a waterproof shell and drops suede", () => {
  const s = state();
  const res = E.recommend(s, { today: TODAY, tempC: 12, rain: true });
  if (!res.outfits.length) return "no outfits at all in the rain";
  if (anyHas(res.outfits, "shoe-suede")) return "suede shoes suggested in the rain";
  const noShell = res.outfits.find((o) => !o.items.some((i) => i.slot === "outer" && i.waterproof === true));
  return noShell ? `outfit without a waterproof shell in the rain: ${noShell.key}` : null;
});

// ================================================================ repeat

check("something worn yesterday is not suggested again today", () => {
  const s = state();
  s.log = [{ date: "2026-08-20", items: ["tee-white", "chino-beige"] }];
  const res = E.recommend(s, { today: TODAY, tempC: 20 });
  if (anyHas(res.outfits, "tee-white")) return "yesterday's tee suggested again";
  if (anyHas(res.outfits, "chino-beige")) return "yesterday's chinos suggested again";
  return null;
});

// ============================================================== colour rules

check("neutrals are never penalised", () => {
  const neutrals = [
    { id: "a", slot: "top", layer: 1, color: "#f0f0f0" },
    { id: "b", slot: "bottom", color: "#202020" },
    { id: "c", slot: "shoes", color: "#7a7a7a" }
  ];
  const parts = E.ruleScores(neutrals, TODAY);
  if (parts.focus !== 1) return `all-neutral outfit lost points on focus: ${parts.focus}`;
  if (parts.harmony !== 1) return `all-neutral outfit lost points on harmony: ${parts.harmony}`;
  if (parts.balance < 0.7) return `all-neutral outfit scored ${parts.balance} on balance — too harsh`;
  return null;
});

check("the neutral test recognises navy, denim and the beige family", () => {
  const cases = { "#1f2d46": "navy", "#4a6f9c": "denim", "#c8b48c": "beige", "#5b4632": "brown", "#7a7a7a": "grey", "#101010": "black", "#fafafa": "white" };
  for (const [hex, label] of Object.entries(cases)) {
    if (E.colourClass(hex) !== "neutral") return `${label} (${hex}) was classed ${E.colourClass(hex)}`;
  }
  if (E.colourClass("#e8c33a") !== "accent") return "a saturated yellow should be an accent";
  if (E.colourClass("#c0392b") !== "accent") return "a saturated red should be an accent";
  return null;
});

check("more than one loud piece is penalised", () => {
  const one = E.ruleScores([{ id: "a", slot: "top", color: "#e8c33a" }, { id: "b", slot: "bottom", color: "#202020" }], TODAY);
  const three = E.ruleScores([{ id: "a", slot: "top", color: "#e8c33a" }, { id: "b", slot: "bottom", color: "#c0392b" }, { id: "c", slot: "shoes", color: "#2f7a4f" }], TODAY);
  return three.focus < one.focus ? null : `three accents (${three.focus}) not penalised against one (${one.focus})`;
});

check("clashing hues score below analogous and complementary ones", () => {
  const pair = (h1, h2) => E.ruleScores([
    { id: "a", slot: "top", color: h1 }, { id: "b", slot: "bottom", color: h2 }
  ], TODAY).harmony;
  const analogous = pair("#e8c33a", "#e88a3a");     // yellow + orange
  const clashing = pair("#e8c33a", "#3ac0e8");      // yellow + cyan, ~90 degrees apart
  return clashing < analogous ? null : `clashing ${clashing} not below analogous ${analogous}`;
});

check("the 60-30-10 balance prefers one accent over an all-accent outfit", () => {
  const balanced = E.ruleScores([
    { id: "a", slot: "top", layer: 1, color: "#f0f0f0" },
    { id: "b", slot: "bottom", color: "#202020" },
    { id: "c", slot: "shoes", color: "#e8c33a" }
  ], TODAY).balance;
  const loud = E.ruleScores([
    { id: "a", slot: "top", layer: 1, color: "#e8c33a" },
    { id: "b", slot: "bottom", color: "#c0392b" },
    { id: "c", slot: "shoes", color: "#2f7a4f" }
  ], TODAY).balance;
  return loud < balanced ? null : `all-accent ${loud} not below balanced ${balanced}`;
});

// ============================================================ pattern rule

check("two patterned pieces score below one", () => {
  const one = E.ruleScores([{ id: "a", slot: "top", pattern: "patterned" }, { id: "b", slot: "bottom", pattern: "solid" }], TODAY);
  const two = E.ruleScores([{ id: "a", slot: "top", pattern: "patterned" }, { id: "b", slot: "bottom", pattern: "patterned" }], TODAY);
  return two.pattern < one.pattern ? null : `two patterns (${two.pattern}) not below one (${one.pattern})`;
});

check("no highly ranked outfit pairs two patterned pieces", () => {
  const s = state();
  s.items.find((i) => i.id === "shirt-green").pattern = "patterned";
  s.items.find((i) => i.id === "chino-beige").pattern = "patterned";
  s.items.find((i) => i.id === "jeans-black").pattern = "patterned";
  const res = E.recommend(s, { today: TODAY, tempC: 16 });
  if (!res.outfits.length) return "no outfits produced";
  const top = res.outfits.slice(0, 10);
  const bad = top.find((o) => o.items.filter((i) => i.pattern === "patterned").length >= 2);
  return bad ? `a top-10 outfit pairs two patterns: ${bad.key}` : null;
});

// ========================================================= personal calibration

check("feeling cold makes the app ask for more insulation next time", () => {
  const before = E.requiredClo(10, { cloOffset: 0 });
  const shifted = E.applyFeedback(0, "cold");
  const after = E.requiredClo(10, { cloOffset: shifted });
  if (!(shifted < 0)) return `cold feedback moved the offset the wrong way: ${shifted}`;
  if (!(after > before)) return `required clo did not rise: ${before} -> ${after}`;
  return null;
});

check("feeling warm makes it ask for less, and 'right' changes nothing", () => {
  const warm = E.applyFeedback(0, "warm");
  if (!(warm > 0)) return `warm feedback moved the offset the wrong way: ${warm}`;
  if (E.applyFeedback(0.2, "right") !== 0.2) return "'right' should leave the offset alone";
  return null;
});

check("the calibration offset cannot run away", () => {
  let v = 0;
  for (let i = 0; i < 200; i++) v = E.applyFeedback(v, "cold");
  return Math.abs(v) <= 0.8 + 1e-9 ? null : `offset reached ${v}`;
});

// ================================================================= relaxing

check("relaxing the rules produces more candidates and says what it dropped", () => {
  const s = state();
  s.log = [{ date: "2026-08-20", items: ["tee-white", "tee-black", "chino-beige"] }];
  const strict = E.recommend(s, { today: TODAY, tempC: 20, relax: 0 });
  const loose = E.recommend(s, { today: TODAY, tempC: 20, relax: 1 });
  if (!(loose.outfits.length > strict.outfits.length)) {
    return `relaxing did not widen the deck: ${strict.outfits.length} -> ${loose.outfits.length}`;
  }
  if (loose.relaxed.indexOf("repeat") === -1) return `relaxed list does not name the repeat rule: ${loose.relaxed}`;
  return null;
});

check("each relax level is cumulative and names every rule it dropped", () => {
  const s = state();
  s.items.find((i) => i.id === "tee-white").wearsSinceWash = 5;
  const res = E.recommend(s, { today: TODAY, tempC: 20, relax: 4 });
  for (const rule of ["repeat", "occasion", "insulation", "dirty"]) {
    if (res.relaxed.indexOf(rule) === -1) return `level 4 did not report dropping ${rule}`;
  }
  return anyHas(res.outfits, "tee-white") ? null : "dirty items still excluded at the last relax level";
});

check("elimination counts explain where the candidates went", () => {
  const s = state();
  s.items.find((i) => i.id === "tee-white").wearsSinceWash = 5;
  const res = E.recommend(s, { today: TODAY, tempC: 30 });
  if (!res.eliminated.dirty) return "dirty eliminations not counted";
  if (!res.eliminated.insulation) return "insulation eliminations not counted at 30 °C";
  return null;
});

// ================================================================ rejections

check("a rejected outfit does not come back", () => {
  const s = state();
  const first = E.recommend(s, { today: TODAY, tempC: 20 });
  const victim = first.outfits[0].key;
  s.rejected = [{ at: "2026-08-21T09:00:00Z", key: victim }];
  const second = E.recommend(s, { today: TODAY, tempC: 20 });
  if (second.outfits.some((o) => o.key === victim)) return "rejected outfit reappeared";
  if (!second.eliminated.rejected) return "rejection was not counted";
  return null;
});

// =============================================================== taste model

check("the model learns the direction of a swipe", () => {
  const items = wardrobe();
  const byId = E.indexById(items);
  const liked = ["tee-yellow", "chino-beige", "shoe-sneak"];
  const swipes = [];
  for (let i = 0; i < 12; i++) swipes.push({ at: TODAY + "T09:00:00Z", items: liked, liked: true });
  for (let i = 0; i < 12; i++) swipes.push({ at: TODAY + "T09:00:00Z", items: ["tee-black", "jeans-black", "shoe-boot"], liked: false });
  const { weights } = E.trainTaste(swipes, byId, TODAY);
  const pLiked = E.predictTaste(weights, E.featurise(E.indexById(items) && liked.map((id) => byId[id]), TODAY));
  const pDisliked = E.predictTaste(weights, E.featurise(["tee-black", "jeans-black", "shoe-boot"].map((id) => byId[id]), TODAY));
  return pLiked > pDisliked ? null : `liked ${pLiked} not above disliked ${pDisliked}`;
});

check("undoing a swipe restores the model exactly", () => {
  const byId = E.indexById(wardrobe());
  const a = { at: TODAY + "T09:00:00Z", items: ["tee-yellow", "chino-beige", "shoe-sneak"], liked: true };
  const b = { at: TODAY + "T09:05:00Z", items: ["tee-black", "jeans-black", "shoe-boot"], liked: false };
  const c = { at: TODAY + "T09:10:00Z", items: ["knit-red", "chino-beige", "shoe-boot"], liked: true };

  const twoBefore = E.trainTaste([a, b], byId, TODAY).weights;
  const three = E.trainTaste([a, b, c], byId, TODAY).weights;
  const afterUndo = E.trainTaste([a, b], byId, TODAY).weights;   // c removed from the log

  if (JSON.stringify(three) === JSON.stringify(twoBefore)) return "the third swipe changed nothing — test is not exercising anything";
  if (JSON.stringify(afterUndo) !== JSON.stringify(twoBefore)) return "undo did not restore the previous weights";
  return null;
});

check("the rules keep a floor no matter how many swipes pile up", () => {
  if (E.ruleWeightFor(0) !== 1) return "with no swipes the rules should decide everything";
  if (!(E.ruleWeightFor(50) < 1)) return "the model should start taking over";
  if (E.ruleWeightFor(100000) < 0.3 - 1e-9) return "the rules dropped below their floor";
  return null;
});

check("rule scores are features, so taste can overrule the book", () => {
  const f = E.featurise([{ id: "a", slot: "top", layer: 1, color: "#e8c33a" }], TODAY);
  for (const rule of Object.keys(E.RULE_LABELS)) {
    if (!(("rule:" + rule) in f)) return `${rule} is not exposed to the model as a feature`;
  }
  return null;
});

// ================================================================ gaps queue

check("thickness outranks everything else in the gaps queue", () => {
  const thin = item({ id: "x", name: "X", slot: "top", warmth: 3, color: "#111111", guessed: ["fabric"] });
  delete thin.fabric;
  const noWarmth = item({ id: "y", name: "Y", slot: "top", color: "#111111", guessed: ["warmth"] });
  const queue = E.gapsQueue([thin, noWarmth]);
  if (queue[0].item.id !== "y") return "the item with an unknown thickness should be first in the queue";
  if (queue[0].gaps[0].field !== "warmth") return "thickness should be the first gap listed";
  return null;
});

check("an agent guess still counts as a gap until it is confirmed", () => {
  const it = item({ id: "z", name: "Z", slot: "top", warmth: 4, color: "#111", pattern: "solid",
                    agentGuessed: { warmth: { value: 4, confidence: 0.8, why: "chunky knit" } } });
  const gaps = E.gapsFor(it).map((g) => g.field);
  if (gaps.indexOf("warmth") === -1) return "an agent-filled thickness should stay in the queue until confirmed";
  const g = E.gapsFor(it).find((x) => x.field === "warmth");
  return g.state === "agent" ? null : `expected state 'agent', got '${g.state}'`;
});

check("the why-line owns up to guessed thickness", () => {
  const s = state();
  s.items.forEach((i) => { i.guessed = ["warmth"]; });
  const res = E.recommend(s, { today: TODAY, tempC: 18 });
  if (!res.outfits.length) return "no outfits produced";
  return /thickness is a guess/.test(res.outfits[0].why) ? null : `why-line hides the guessing: "${res.outfits[0].why}"`;
});

check("the why-line quotes a temperature, not a clo number", () => {
  const s = state();
  const res = E.recommend(s, { today: TODAY, tempC: 18 });
  return /°C outfit/.test(res.outfits[0].why) ? null : `no temperature in the why-line: "${res.outfits[0].why}"`;
});

// ============================================================ weather context

check("a day that warms up is dressed for the morning, with a layer to shed", () => {
  const weather = { hourly: [] };
  for (let h = 0; h < 24; h++) {
    const t = h < 11 ? 11 : 24;
    weather.hourly.push({ time: `${TODAY}T${String(h).padStart(2, "0")}:00`, temp: t, apparent: t, precipProb: 0 });
  }
  const ctx = E.contextFromWeather(weather, { today: TODAY });
  if (ctx.swing < E.SWING_THRESHOLD) return `swing not detected: ${ctx.swing}`;
  if (ctx.tempC !== 11) return `should dress for the cold end of the day, got ${ctx.tempC}`;
  const s = state();
  const res = E.recommend(s, { today: TODAY, tempC: ctx.tempC });
  const shed = E.shedLayer(res.outfits[0], ctx);
  return shed && shed.item ? null : "no layer nominated to take off at midday";
});

check("a steady day nominates nothing to shed", () => {
  const weather = { hourly: [] };
  for (let h = 0; h < 24; h++) weather.hourly.push({ time: `${TODAY}T${String(h).padStart(2, "0")}:00`, temp: 18, apparent: 18, precipProb: 0 });
  const ctx = E.contextFromWeather(weather, { today: TODAY });
  const res = E.recommend(state(), { today: TODAY, tempC: ctx.tempC });
  return E.shedLayer(res.outfits[0], ctx) === null ? null : "suggested shedding a layer on a flat day";
});

check("rain is read off the forecast", () => {
  const weather = { hourly: [] };
  for (let h = 0; h < 24; h++) weather.hourly.push({ time: `${TODAY}T${String(h).padStart(2, "0")}:00`, temp: 14, apparent: 14, precipProb: h === 15 ? 80 : 5 });
  const ctx = E.contextFromWeather(weather, { today: TODAY });
  return ctx.rain === true ? null : `an 80% hour should count as rain, got ${ctx.rainChance}`;
});

// ============================================================== seasonal rule

check("winter boots are not suggested on a hot day", () => {
  // Footwear barely moves the clo total, so this can only be caught by a rule
  // that looks at the item rather than the sum.
  const res = E.recommend(state(), { today: TODAY, tempC: 32 });
  if (!res.outfits.length) return "no outfits at 32 °C";
  if (anyHas(res.outfits, "shoe-boot")) return "winter boots suggested at 32 °C";
  if (anyHas(res.outfits, "jeans-black")) return "the thickest trousers suggested at 32 °C";
  if (!res.eliminated.seasonal) return "seasonal eliminations were not counted";
  return null;
});

check("the same boots are fine once it is actually cold", () => {
  const res = E.recommend(state(), { today: TODAY, tempC: 8 });
  return anyHas(res.outfits, "shoe-boot") ? null : "boots never suggested at 8 °C either";
});

check("a hot day still leaves something to wear", () => {
  const res = E.recommend(state(), { today: TODAY, tempC: 32 });
  const light = res.outfits.some((o) => has(o, "shorts-khaki") || has(o, "shoe-sneak"));
  return light ? null : "nothing light survived the hot-day filter";
});

check("a pinned item overrides the hot-day thickness rule", () => {
  const s = state();
  s.items.find((i) => i.id === "jeans-black").pinnedUntil = "2026-08-28";
  const res = E.recommend(s, { today: TODAY, tempC: 32 });
  if (!res.outfits.length) return "pinning thick jeans on a hot day left nothing";
  return allHave(res.outfits, (o) => has(o, "jeans-black")) ? null : "the pin was ignored";
});

// ================================================================= deck spread

check("the deck does not open with a run of near-identical outfits", () => {
  const res = E.recommend(state(), { today: TODAY, tempC: 20 });
  const spread = E.diversify(res.outfits, 2);
  for (let i = 1; i < Math.min(spread.length, 8); i++) {
    if (E.differenceCount(spread[i].ids, spread[i - 1].ids) < 2) {
      return `cards ${i - 1} and ${i} differ by one item only`;
    }
  }
  return null;
});

check("spreading the deck keeps every outfit, just reorders them", () => {
  const res = E.recommend(state(), { today: TODAY, tempC: 20 });
  const spread = E.diversify(res.outfits, 2);
  if (spread.length !== res.outfits.length) return `lost outfits: ${res.outfits.length} -> ${spread.length}`;
  const before = res.outfits.map((o) => o.key).sort().join("|");
  const after = spread.map((o) => o.key).sort().join("|");
  return before === after ? null : "the set of outfits changed";
});

check("the why-line does not congratulate a rule that had nothing to judge", () => {
  // Three neutrals cannot clash, so praising their colour harmony would be noise.
  const neutrals = [
    item({ id: "a", name: "A", slot: "top", layer: 1, warmth: 2, color: "#f0f0f0" }),
    item({ id: "b", name: "B", slot: "bottom", warmth: 3, color: "#202020" }),
    item({ id: "c", name: "C", slot: "shoes", warmth: 2, color: "#7a7a7a" })
  ];
  const ctx = { today: TODAY, tasteN: 0, tasteWeights: null, activityFactor: 0.6, cloOffset: 0 };
  const why = E.explain(neutrals, E.scoreOutfit(neutrals, ctx), ctx);
  if (/colours work together/.test(why)) return `credited harmony with nothing to judge: "${why}"`;
  const engaged = E.engagedRules(neutrals);
  if (engaged.harmony) return "harmony should not count as engaged with no non-neutral colours";
  if (engaged.focus) return "focus should not count as engaged with no accents";
  return null;
});

// ================================================================== ordering

check("outfits come back best first, deterministically", () => {
  const a = E.recommend(state(), { today: TODAY, tempC: 17 });
  const b = E.recommend(state(), { today: TODAY, tempC: 17 });
  for (let i = 1; i < a.outfits.length; i++) {
    if (a.outfits[i - 1].score < a.outfits[i].score - 1e-12) return "outfits are not sorted by score";
  }
  if (JSON.stringify(a.outfits.map((o) => o.key)) !== JSON.stringify(b.outfits.map((o) => o.key))) {
    return "two identical calls returned different orders";
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
console.log(`All ${total} wardrobe checks passed.`);
