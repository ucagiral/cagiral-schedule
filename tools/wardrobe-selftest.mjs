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

// The agent's pure half. Its SDK import is lazy, so this loads with nothing
// installed.
const agent = await import("./wardrobe-agent.mjs");

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
    fabric: null, waterproof: false, lastWorn: null,
    pinnedUntil: null, guessed: []
  }, o);
}

function wardrobe() {
  return [
    item({ id: "tee-white",   name: "White tee",     slot: "top", layer: 1, warmth: 2, color: "#f0f0f0", formality: 2 }),
    item({ id: "tee-yellow",  name: "Yellow tee",    slot: "top", layer: 1, warmth: 2, color: "#e8c33a", formality: 1 }),
    item({ id: "tee-black",   name: "Black tee",     slot: "top", layer: 1, warmth: 2, color: "#202020", formality: 2 }),
    item({ id: "shirt-green", name: "Green shirt",   slot: "top", layer: 2, warmth: 3, color: "#2f7a4f", formality: 3 }),
    item({ id: "knit-grey",   name: "Grey sweater",  slot: "top", layer: 3, warmth: 4, color: "#7a7a7a", formality: 2 }),
    item({ id: "knit-red",    name: "Red sweater",   slot: "top", layer: 3, warmth: 4, color: "#c0392b", formality: 2, occasions: ["casual"] }),

    item({ id: "chino-beige", name: "Beige chinos",  slot: "bottom", warmth: 3, color: "#c8b48c", formality: 3 }),
    item({ id: "jeans-black", name: "Black jeans",   slot: "bottom", warmth: 4, color: "#202020", formality: 2 }),
    item({ id: "shorts-khaki",name: "Khaki shorts",  slot: "bottom", warmth: 1, color: "#b5a882", formality: 1 }),

    item({ id: "shoe-sneak",  name: "White sneakers",slot: "shoes", warmth: 2, color: "#efefef", formality: 1 }),
    item({ id: "shoe-boot",   name: "Brown boots",   slot: "shoes", warmth: 4, color: "#5b4632", formality: 3 }),
    item({ id: "shoe-suede",  name: "Suede loafers", slot: "shoes", warmth: 3, color: "#8a6a4a", formality: 3, fabric: "suede" }),

    item({ id: "coat-wool",   name: "Wool coat",     slot: "outer", warmth: 4, color: "#3a3a3a", formality: 3, waterproof: false }),
    item({ id: "parka-heavy", name: "Heavy parka",   slot: "outer", warmth: 5, color: "#2b3a4a", formality: 2, waterproof: false }),
    item({ id: "shell-rain",  name: "Rain shell",    slot: "outer", warmth: 2, color: "#33506b", formality: 2, waterproof: true }),

    item({ id: "scarf-wool",  name: "Wool scarf",    slot: "accessory", warmth: 4, color: "#8a2f2f", formality: 2 }),
    item({ id: "cap-navy",    name: "Navy cap",      slot: "accessory", warmth: 2, color: "#1f2d46", formality: 1 })
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

// ================================================================ no laundry

check("nothing is ever withheld for being unwashed", () => {
  // The laundry counter was removed deliberately: it asked a question about every
  // garment in the wardrobe to solve a problem that only arises for the few worn
  // several days running, and those get pinned instead.
  const s = state();
  s.items.forEach((i) => { i.wearsSinceWash = 99; i.washAfter = 1; });   // stale fields, if any linger
  const res = E.recommend(s, { today: TODAY, tempC: 22 });
  if (!res.outfits.length) return "leftover laundry fields still filter everything out";
  if ("dirty" in res.eliminated) return "the eliminated report still has a dirty bucket";
  return null;
});

check("no laundry concept survives anywhere in the engine's surface", () => {
  for (const name of ["isDirty", "defaultWashAfter"]) {
    if (name in E) return `${name} is still exported`;
  }
  if (E.RELAX_ORDER.includes("dirty")) return "the relax ladder still has a laundry rung";
  if ("washAfter" in E.GAP_PRIORITY) return "the gaps queue still asks how often to wash things";
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
  s.log = [{ date: "2026-08-20", items: ["tee-white"] }];
  const res = E.recommend(s, { today: TODAY, tempC: 20, relax: 3 });
  for (const rule of ["repeat", "occasion", "insulation"]) {
    if (res.relaxed.indexOf(rule) === -1) return `the last level did not report dropping ${rule}`;
  }
  return anyHas(res.outfits, "tee-white") ? null : "yesterday's tee still excluded at the last relax level";
});

check("elimination counts explain where the candidates went", () => {
  const s = state();
  s.log = [{ date: "2026-08-20", items: ["tee-white"] }];
  const res = E.recommend(s, { today: TODAY, tempC: 30, occasion: "lab" });
  if (!res.eliminated.repeat) return "repeat eliminations not counted";
  if (!res.eliminated.occasion) return "occasion eliminations not counted on a lab day";
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

// ========================================================= weather-free deck

check("the training deck ignores the weather entirely", () => {
  // Learning taste from only today's weather-appropriate outfits would teach the
  // model nothing about the other three seasons.
  const crit = { ignoreInsulation: true, occasionFilter: false, repeatDays: 0 };
  const res = E.recommend(state(), { today: TODAY, tempC: 30, criteria: crit });
  if (!anyHas(res.outfits, "parka-heavy")) return "a parka never appears in the training deck";
  if (!anyHas(res.outfits, "shorts-khaki")) return "shorts never appear in the training deck";
  if (res.eliminated.insulation) return "the insulation rule still eliminated candidates";
  if (res.eliminated.seasonal) return "the hot-day thickness rule still applied";
  return null;
});

check("the weather-free deck does not pile on every accessory", () => {
  const crit = { ignoreInsulation: true, occasionFilter: false, repeatDays: 0 };
  const res = E.recommend(state(), { today: TODAY, tempC: 30, criteria: crit });
  const overloaded = res.outfits.find((o) => o.items.filter((i) => i.slot === "accessory").length > 1);
  return overloaded ? `an outfit stacked accessories with no gap to fill: ${overloaded.key}` : null;
});

check("today's screen still respects the weather", () => {
  const res = E.recommend(state(), { today: TODAY, tempC: 30 });
  return anyHas(res.outfits, "parka-heavy") ? "a parka survived the 30 °C filter" : null;
});

// ============================================================= gaps relevance

check("the gaps queue only asks about things that change a suggestion", () => {
  // A queue that cries wolf gets ignored, and takes the thickness question with it.
  const complete = item({ id: "c", name: "C", slot: "top", layer: 1, warmth: 3, color: "#111",
                          pattern: "solid", formality: 2, occasions: null,
                          season: null, fit: null, guessed: [] });
  const gaps = E.gapsFor(complete).map((g) => g.field);
  if (gaps.length) return `a fully specified top still shows gaps: ${gaps.join(", ")}`;
  if (E.completeness(complete) !== 1) return "completeness should be 100% for that item";
  return null;
});

check("an empty occasions list is an answer, not a gap", () => {
  // Silence means the piece goes anywhere, and the engine treats it that way.
  const it = item({ id: "o", name: "O", slot: "top", warmth: 3, color: "#111", pattern: "solid",
                    formality: 2, occasions: null });
  if (E.gapsFor(it).some((g) => g.field === "occasions")) return "occasions was reported as a gap";
  return E.occasionOk(it, "lab") ? null : "an untagged item should pass the lab filter";
});

check("waterproofing is only asked about outerwear", () => {
  const tee = item({ id: "t", name: "T", slot: "top", warmth: 3, color: "#111", pattern: "solid", formality: 2 });
  delete tee.waterproof;
  const coat = item({ id: "k", name: "K", slot: "outer", warmth: 4, color: "#111", pattern: "solid", formality: 2 });
  delete coat.waterproof;
  if (E.gapsFor(tee).some((g) => g.field === "waterproof")) return "a t-shirt was asked whether it is waterproof";
  if (!E.gapsFor(coat).some((g) => g.field === "waterproof")) return "a coat was not asked whether it is waterproof";
  return null;
});

check("the demo wardrobe ships with nothing left to fill in", () => {
  // The demo exists to show the app working, not to hand over a to-do list.
  const demo = JSON.parse(readFileSync(join(ROOT, "wardrobe", "demo", "demo.json"), "utf8"));
  const queue = E.gapsQueue(demo.items);
  if (queue.length) {
    return queue.slice(0, 3).map((q) => `${q.item.name}: ${q.gaps.map((g) => g.field).join(", ")}`).join("; ");
  }
  return null;
});

check("the demo wardrobe can dress a hot day and a cold one", () => {
  const demo = JSON.parse(readFileSync(join(ROOT, "wardrobe", "demo", "demo.json"), "utf8"));
  const s = { items: demo.items, log: [], swipes: [], rejected: [], taste: { weights: {}, n: 0 }, settings: {} };
  for (const temp of [32, 24, 16, 8, 0]) {
    const res = E.recommend(s, { today: TODAY, tempC: temp });
    if (!res.outfits.length) return `the demo wardrobe produced nothing at ${temp} °C`;
  }
  const rain = E.recommend(s, { today: TODAY, tempC: 12, rain: true });
  return rain.outfits.length ? null : "the demo wardrobe produced nothing in the rain";
});

// ============================================================== agent boundary
//
// The agent's one promise is that it never overwrites an answer Umut gave. These
// feed it a reply built to break that promise.

function settledItem() {
  return item({
    id: "settled", name: "Grey wool jumper", slot: "top", layer: 3,
    warmth: 5, formality: 3, pattern: "solid", color: "#7a7a7a",
    fabric: "wool", occasions: ["smart"], waterproof: false,
    guessed: [], agentGuessed: {}
  });
}

check("the agent cannot overwrite anything answered by hand", () => {
  const w = { items: [settledItem()] };
  const before = JSON.stringify(w.items[0]);
  // A reply that tries to rewrite every single field.
  const hostile = [{ id: "settled", fields: {
    warmth:     { value: 1, confidence: 0.99, why: "looks thin" },
    formality:  { value: 1, confidence: 0.99, why: "looks sporty" },
    pattern:    { value: "patterned", confidence: 0.99, why: "sees a pattern" },
    color:      { value: "#ff0000", confidence: 0.99, why: "sees red" },
    fabric:     { value: "synthetic", confidence: 0.99, why: "looks synthetic" },
    waterproof: { value: true, confidence: 0.99, why: "looks coated" }
  } }];
  const report = agent.applyProposals(w, hostile, "2026-08-22");
  if (JSON.stringify(w.items[0]) !== before) {
    return "a hand-entered item was modified:\n    " + before + "\n    " + JSON.stringify(w.items[0]);
  }
  if (report.filled !== 0) return `wrote ${report.filled} field(s) it should have refused`;
  if (report.refusedSettled !== 6) return `expected 6 refusals, counted ${report.refusedSettled}`;
  return null;
});

check("the agent fills a genuine gap, but only as a proposal", () => {
  const it = settledItem();
  delete it.fabric;
  it.guessed = ["warmth"];
  const w = { items: [it] };
  const report = agent.applyProposals(w, [{ id: "settled", fields: {
    warmth: { value: 4, confidence: 0.7, why: "chunky ribbed knit" },
    fabric: { value: "wool", confidence: 0.8, why: "matted wool surface" }
  } }], "2026-08-22");

  if (report.filled !== 2) return `expected 2 proposals, got ${report.filled}`;
  // The real fields must still be untouched -- a proposal is not an answer.
  if (w.items[0].warmth !== 5) return "the agent changed the real warmth field";
  if (w.items[0].fabric !== undefined) return "the agent wrote the real fabric field";
  if (!w.items[0].agentGuessed.warmth) return "the proposal was not recorded";
  if (w.items[0].agentGuessed.warmth.value !== 4) return "the proposal lost its value";
  if (!w.items[0].agentGuessed.warmth.why) return "the proposal lost its reasoning";
  return null;
});

check("a proposal keeps the item in the gaps queue until it is accepted", () => {
  const it = settledItem();
  it.guessed = ["warmth"];
  const w = { items: [it] };
  agent.applyProposals(w, [{ id: "settled", fields: {
    warmth: { value: 4, confidence: 0.7, why: "chunky knit" } } }], "2026-08-22");
  const gaps = E.gapsFor(w.items[0]).find((g) => g.field === "warmth");
  if (!gaps) return "the item dropped out of the queue on an unaccepted proposal";
  return gaps.state === "agent" ? null : `expected state 'agent', got '${gaps.state}'`;
});

check("nonsense from the model is discarded rather than stored", () => {
  const it = settledItem();
  delete it.fabric; delete it.color;
  it.guessed = ["warmth", "pattern"];
  const w = { items: [it] };
  const report = agent.applyProposals(w, [{ id: "settled", fields: {
    warmth:   { value: 11, confidence: 0.9, why: "out of range" },
    pattern:  { value: "tie-dye", confidence: 0.9, why: "not one of the options" },
    fabric:   { value: "unobtainium", confidence: 0.9, why: "not a fabric" },
    color:    { value: "not-a-colour", confidence: 0.9, why: "not a hex value" },
    nonsense: { value: 1, confidence: 0.9, why: "not a field at all" }
  } }], "2026-08-22");
  if (report.filled !== 0) return `stored ${report.filled} invalid answer(s)`;
  if (report.refusedInvalid !== 5) return `expected 5 rejections, counted ${report.refusedInvalid}`;
  if (Object.keys(w.items[0].agentGuessed).length) return "an invalid answer reached agentGuessed";
  return null;
});

check("a proposal for an item that no longer exists is dropped", () => {
  const w = { items: [settledItem()] };
  const report = agent.applyProposals(w, [{ id: "deleted-since", fields: {
    warmth: { value: 3, confidence: 0.9, why: "..." } } }], "2026-08-22");
  return report.refusedUnknownItem === 1 && report.filled === 0 ? null : JSON.stringify(report);
});

check("the agent asks about exactly the gaps the app shows", () => {
  const it = item({ id: "q", name: "Q", slot: "top", layer: 1, warmth: null, color: "#111",
                    pattern: "solid", formality: 2, guessed: [] });
  it.fabric = null;
  const asked = agent.fieldsToAsk(it).sort();
  if (!asked.includes("warmth")) return "it would not ask about the thickness";
  if (!asked.includes("fabric")) return "it would not ask what the garment is made of";
  if (asked.includes("waterproof")) return "it would ask whether a t-shirt is waterproof";
  return null;
});

check("the agent does not re-ask something already awaiting review", () => {
  const it = item({ id: "r", name: "R", slot: "top", layer: 1, warmth: null, color: "#111",
                    pattern: "solid", formality: 2, fabric: "cotton",
                    guessed: [], agentGuessed: { warmth: { value: 3, confidence: 0.5, why: "x" } } });
  return agent.fieldsToAsk(it).includes("warmth")
    ? "it would spend another request re-asking a question already answered" : null;
});

check("accepting a proposal is what finally settles the field", () => {
  // Mirrors what acceptAgent does in the app.
  const it = settledItem();
  it.warmth = null; it.guessed = ["warmth"];
  const w = { items: [it] };
  agent.applyProposals(w, [{ id: "settled", fields: {
    warmth: { value: 4, confidence: 0.8, why: "chunky knit" } } }], "2026-08-22");

  const target = w.items[0];
  target.warmth = target.agentGuessed.warmth.value;
  target.guessed = target.guessed.filter((k) => k !== "warmth");
  target.agentGuessed = {};

  if (target.warmth !== 4) return "the accepted value did not land";
  if (E.gapsFor(target).some((g) => g.field === "warmth")) return "the item stayed in the queue after acceptance";
  return null;
});

// =========================================================== changing one piece

check("replacing a piece changes that piece and nothing else", () => {
  const s = state();
  const res = E.recommend(s, { today: TODAY, tempC: 16 });
  const outfit = res.outfits[0];
  const shoes = outfit.items.find((i) => i.slot === "shoes");
  const next = E.replacePiece(s, outfit, shoes.id, { today: TODAY, tempC: 16 });

  if (!next) return "no alternative found for the shoes";
  if (next.ids.includes(shoes.id)) return "the rejected piece came back";
  const kept = outfit.ids.filter((id) => id !== shoes.id);
  for (const id of kept) if (!next.ids.includes(id)) return `${id} was dropped, but only the shoes were rejected`;
  if (next.ids.length !== outfit.ids.length) return `the outfit changed size: ${outfit.ids.length} -> ${next.ids.length}`;
  const swapped = next.ids.find((id) => !outfit.ids.includes(id));
  const swappedItem = s.items.find((i) => i.id === swapped);
  return swappedItem.slot === "shoes" ? null : `the replacement was a ${swappedItem.slot}, not shoes`;
});

check("a held piece survives filters that would otherwise drop it", () => {
  // The user is looking at this outfit right now; nothing gets to remove a piece
  // they deliberately kept.
  const s = state();
  s.log = [{ date: "2026-08-20", items: ["chino-beige"] }];   // would trip the repeat rule
  const res = E.recommend(s, { today: TODAY, tempC: 16, criteria: { hold: ["chino-beige"] } });
  if (!res.outfits.length) return "holding a recently worn piece produced nothing";
  return allHave(res.outfits, (o) => has(o, "chino-beige")) ? null : "the held piece was filtered out";
});

check("replacing the only option of its kind returns nothing rather than a wrong answer", () => {
  const s = state();
  s.items = s.items.filter((i) => i.slot !== "bottom" || i.id === "chino-beige");
  const res = E.recommend(s, { today: TODAY, tempC: 16 });
  const next = E.replacePiece(s, res.outfits[0], "chino-beige", { today: TODAY, tempC: 16 });
  return next === null ? null : "invented a replacement where none exists: " + next.key;
});

// ============================================================ focused learning

function weightsFrom(swipes) {
  return E.trainTaste(swipes, E.indexById(wardrobe()), TODAY).weights;
}

check("rejecting one piece only moves that piece's weight", () => {
  // The whole point of per-piece swiping: the trousers you kept must not be
  // punished for the shoes you threw away.
  const outfit = ["tee-yellow", "chino-beige", "shoe-boot"];
  const focused = weightsFrom([{ at: TODAY + "T09:00:00Z", items: outfit, liked: false, focus: "shoe-boot" }]);

  if (!(focused["item:shoe-boot"] < 0)) return `the rejected piece was not penalised: ${focused["item:shoe-boot"]}`;
  for (const kept of ["tee-yellow", "chino-beige"]) {
    if ("item:" + kept in focused) return `${kept} picked up a weight despite being kept`;
  }
  return null;
});

check("an unfocused rejection still moves every piece, as before", () => {
  const outfit = ["tee-yellow", "chino-beige", "shoe-boot"];
  const whole = weightsFrom([{ at: TODAY + "T09:00:00Z", items: outfit, liked: false }]);
  for (const id of outfit) {
    if (!(whole["item:" + id] < 0)) return `${id} was not penalised by a whole-outfit rejection`;
  }
  return null;
});

check("a focused rejection still learns from the combination's rule scores", () => {
  // What was rejected really was that combination, so the colour and formality
  // rules should still hear about it -- only the item-level blame is narrowed.
  const focused = weightsFrom([
    { at: TODAY + "T09:00:00Z", items: ["tee-yellow", "chino-beige", "shoe-boot"], liked: false, focus: "shoe-boot" }
  ]);
  const ruleKeys = Object.keys(focused).filter((k) => k.startsWith("rule:"));
  return ruleKeys.length ? null : "no rule features were learned from a focused swipe";
});

check("focusing keeps the colour feature of the rejected piece's own slot", () => {
  const items = wardrobe();
  const byId = E.indexById(items);
  const chosen = ["tee-yellow", "chino-beige", "shoe-boot"].map((id) => byId[id]);
  const f = E.focusFeatures(E.featurise(chosen, TODAY), chosen, "chino-beige");
  const colourKeys = Object.keys(f).filter((k) => k.startsWith("colour:"));
  if (!colourKeys.some((k) => k.startsWith("colour:bottom:"))) return "the rejected piece's own colour slot was dropped";
  if (colourKeys.some((k) => k.startsWith("colour:top:"))) return "a kept piece's colour slot survived";
  return null;
});

check("undo still restores the model exactly, focused swipes included", () => {
  const a = { at: TODAY + "T09:00:00Z", items: ["tee-yellow", "chino-beige", "shoe-sneak"], liked: true };
  const b = { at: TODAY + "T09:05:00Z", items: ["tee-black", "jeans-black", "shoe-boot"], liked: false, focus: "shoe-boot" };
  const before = weightsFrom([a]);
  const withBoth = weightsFrom([a, b]);
  const afterUndo = weightsFrom([a]);
  if (JSON.stringify(withBoth) === JSON.stringify(before)) return "the focused swipe changed nothing";
  return JSON.stringify(afterUndo) === JSON.stringify(before) ? null : "undo did not restore the weights";
});

// ====================================================== rejecting a piece in context
//
// The measured failure these exist for: a rejected t-shirt came back in eight of
// the next eight cards, and still did after twenty more rejections.

function rejection(outfit, focusId) {
  return { at: TODAY + "T09:00:00Z", key: outfit.key, focus: focusId,
           context: outfit.ids.filter((id) => id !== focusId) };
}

check("white cotton and white fabric trousers count as the same context", () => {
  // The exact thing that has to hold: fabric is not a real change, colour is.
  const jeans = { id: "a", slot: "bottom", color: "#e1dfda", formality: 2 };
  const otherWhite = { id: "b", slot: "bottom", color: "#e6e3dd", formality: 2 };
  const navy = { id: "c", slot: "bottom", color: "#2b3a55", formality: 2 };
  const smartWhite = { id: "d", slot: "bottom", color: "#e1dfda", formality: 3 };
  if (!E.sameGarmentKind(jeans, otherWhite)) return "two off-white trousers were treated as different";
  if (E.sameGarmentKind(jeans, navy)) return "off-white and navy were treated as the same";
  if (E.sameGarmentKind(jeans, smartWhite)) return "formality was ignored";
  return null;
});

check("black and white are not the same neutral", () => {
  const black = { id: "a", slot: "shoes", color: "#151515", formality: 2 };
  const white = { id: "b", slot: "shoes", color: "#f2f2f2", formality: 2 };
  return E.sameGarmentKind(black, white) ? "black and white shoes were treated as interchangeable" : null;
});

check("a rejected piece never returns in the same context", () => {
  const s = state();
  const res = E.recommend(s, { today: TODAY, tempC: 18 });
  const outfit = res.outfits[0];
  const tee = outfit.items.find((i) => i.slot === "top");
  s.rejected = [rejection(outfit, tee.id)];

  const after = E.recommend(s, { today: TODAY, tempC: 18 });
  if (after.outfits.some((o) => o.key === outfit.key)) return "the exact outfit came back";
  const byId = E.indexById(s.items);
  for (const o of after.outfits) {
    if (!o.ids.includes(tee.id)) continue;
    const rest = o.items.filter((i) => i.id !== tee.id);
    const was = s.rejected[0].context.map((id) => byId[id]);
    if (E.sameContext(rest, was)) return `it came back in the same context: ${o.key}`;
  }
  if (!after.eliminated.context) return "no candidate was eliminated by context at all";
  return null;
});

check("the same piece is still fine somewhere genuinely different", () => {
  // One rejection is about one context. Banishing the garment outright would be an
  // overreaction to a single opinion.
  const s = state();
  const res = E.recommend(s, { today: TODAY, tempC: 18 });
  const outfit = res.outfits[0];
  const tee = outfit.items.find((i) => i.slot === "top");
  s.rejected = [rejection(outfit, tee.id)];
  const after = E.recommend(s, { today: TODAY, tempC: 18 });
  return after.outfits.some((o) => o.ids.includes(tee.id))
    ? null : "one rejection removed the garment from the wardrobe entirely";
});

check("persistent rejection does push a piece out of the running", () => {
  // The other half: keep saying no and it should stop appearing.
  const s = state();
  const ctx = { today: TODAY, tempC: 18, criteria: { ignoreInsulation: true, repeatDays: 0 } };
  let deck = E.diversify(E.recommend(s, ctx).outfits, 2);
  const victim = deck[0].items.find((i) => i.slot === "top");

  for (let i = 0; i < 10; i++) {
    const carrier = deck.find((o) => o.ids.includes(victim.id));
    if (!carrier) break;
    s.rejected.push(rejection(carrier, victim.id));
    s.swipes.push({ at: TODAY + "T09:00:00Z", items: carrier.ids, liked: false, focus: victim.id });
    const t = E.trainTaste(s.swipes, E.indexById(s.items), TODAY);
    s.taste = { weights: t.weights, n: t.n };
    deck = E.diversify(E.recommend(s, ctx).outfits, 2);
  }
  const top8 = deck.slice(0, 8).filter((o) => o.ids.includes(victim.id)).length;
  return top8 === 0 ? null : `after ten rejections it is still in ${top8} of the top 8`;
});

check("feedback moves the ranking while it is still fresh", () => {
  // The old curve gave the model 1% of the decision at one swipe and 14% at
  // twenty-one, which is why rejections felt ignored.
  if (!(1 - E.ruleWeightFor(5) > 0.15)) return `at five swipes the model still only has ${(1-E.ruleWeightFor(5)).toFixed(2)}`;
  if (!(1 - E.ruleWeightFor(1) > 0.02)) return "a single swipe counts for nothing";
  if (E.ruleWeightFor(100000) < 0.3 - 1e-9) return "the rules dropped below their floor";
  if (E.ruleWeightFor(0) !== 1) return "with no swipes the rules should decide everything";
  return null;
});

check("undoing a rejection lifts the block with it", () => {
  const s = state();
  const outfit = E.recommend(s, { today: TODAY, tempC: 18 }).outfits[0];
  const tee = outfit.items.find((i) => i.slot === "top");
  s.rejected = [rejection(outfit, tee.id)];
  const blocked = E.recommend(s, { today: TODAY, tempC: 18 });
  if (blocked.outfits.some((o) => o.key === outfit.key)) return "it was never blocked";
  s.rejected = [];
  const freed = E.recommend(s, { today: TODAY, tempC: 18 });
  return freed.outfits.some((o) => o.key === outfit.key) ? null : "the block outlived the rejection";
});

check("a context naming a deleted garment is ignored, not crashed on", () => {
  const s = state();
  const outfit = E.recommend(s, { today: TODAY, tempC: 18 }).outfits[0];
  const tee = outfit.items.find((i) => i.slot === "top");
  s.rejected = [rejection(outfit, tee.id)];
  s.items = s.items.filter((i) => i.id !== s.rejected[0].context[0]);
  const res = E.recommend(s, { today: TODAY, tempC: 18 });
  return res.outfits.length ? null : "a stale context wiped out every suggestion";
});

// ================================================== pairings and unwearable items

check("a pairing you approved lifts the outfit, one you rejected sinks it", () => {
  const items = wardrobe();
  const top = items.find((i) => i.id === "tee-yellow");
  const bottom = items.find((i) => i.id === "chino-beige");
  const pair = [top, bottom];
  const neutral = E.ruleScores(pair, TODAY, {}).pairing;
  const liked = E.ruleScores(pair, TODAY, { [E.pairKey(top.id, bottom.id)]: 1 }).pairing;
  const disliked = E.ruleScores(pair, TODAY, { [E.pairKey(top.id, bottom.id)]: -1 }).pairing;
  if (neutral !== 1) return `an unrated pair should say nothing, got ${neutral}`;
  if (liked !== 1) return `an approved pair should score full marks, got ${liked}`;
  if (disliked !== 0) return `a rejected pair should score zero, got ${disliked}`;
  return null;
});

check("an unrated pair is not treated as a bad one", () => {
  // Every rule with nothing to judge returns 1; pairing must not be the exception,
  // or every outfit would start life penalised until it was rated.
  const items = wardrobe();
  const pair = [items.find((i) => i.id === "tee-yellow"), items.find((i) => i.id === "chino-beige")];
  if (E.ruleScores(pair, TODAY, {}).pairing !== 1) return "an unrated pair scored below full marks";
  if (E.engagedRules(pair, {}).pairing) return "pairing counted as engaged with nothing rated";
  if (!E.engagedRules(pair, { [E.pairKey(pair[0].id, pair[1].id)]: 1 }).pairing) {
    return "pairing did not count as engaged once a pair was rated";
  }
  return null;
});

check("a rejected pairing pushes that combination down the deck", () => {
  const s = state();
  const before = E.recommend(s, { today: TODAY, tempC: 18 });
  const top = before.outfits[0].items.find((i) => i.slot === "top");
  const bottom = before.outfits[0].items.find((i) => i.slot === "bottom");
  const rankBefore = before.outfits.findIndex((o) => o.ids.includes(top.id) && o.ids.includes(bottom.id));

  s.pairs = { [E.pairKey(top.id, bottom.id)]: -1 };
  const after = E.recommend(s, { today: TODAY, tempC: 18 });
  const rankAfter = after.outfits.findIndex((o) => o.ids.includes(top.id) && o.ids.includes(bottom.id));
  if (rankAfter === -1) return null;                       // pushed out entirely, fine
  return rankAfter > rankBefore ? null : `rank did not fall: ${rankBefore} -> ${rankAfter}`;
});

check("an approved pairing is a preference, not a rule — unrated pairs still appear", () => {
  const s = state();
  const res0 = E.recommend(s, { today: TODAY, tempC: 18 });
  const top = res0.outfits[0].items.find((i) => i.slot === "top");
  const bottom = res0.outfits[0].items.find((i) => i.slot === "bottom");
  s.pairs = { [E.pairKey(top.id, bottom.id)]: 1 };
  const after = E.recommend(s, { today: TODAY, tempC: 18 });
  const others = after.outfits.filter((o) => !(o.ids.includes(top.id) && o.ids.includes(bottom.id)));
  return others.length ? null : "approving one pair silenced every other combination";
});

check("pairings reach the taste model as a feature", () => {
  const items = wardrobe();
  const pair = [items.find((i) => i.id === "tee-yellow"), items.find((i) => i.id === "chino-beige")];
  const f = E.featurise(pair, TODAY, { [E.pairKey(pair[0].id, pair[1].id)]: 1 });
  return "rule:pairing" in f ? null : "the model cannot learn to disagree with a pairing";
});

check("an unwearable item is not suggested, and comes back when the switch is off", () => {
  const s = state();
  const tee = s.items.find((i) => i.id === "tee-white");
  tee.unwearable = true;
  const out = E.recommend(s, { today: TODAY, tempC: 22 });
  if (anyHas(out.outfits, "tee-white")) return "an unwearable item was still suggested";
  if (!out.eliminated.unwearable) return "the elimination was not counted";
  tee.unwearable = false;
  return anyHas(E.recommend(s, { today: TODAY, tempC: 22 }).outfits, "tee-white")
    ? null : "it did not come back after the switch was turned off";
});

check("an unwearable item beats its own pin", () => {
  // Spilling something on the trousers you pinned for the week has to win.
  const s = state();
  const chino = s.items.find((i) => i.id === "chino-beige");
  chino.pinnedUntil = "2026-08-28";
  chino.unwearable = true;
  const res = E.recommend(s, { today: TODAY, tempC: 18 });
  if (!res.outfits.length) return "an unwearable pinned item left nothing to suggest";
  return anyHas(res.outfits, "chino-beige") ? "the pin overrode the unwearable switch" : null;
});

// ================================================================= keeping a piece

check("'this week' means the rest of this week, not seven days", () => {
  // 2026-08-18 is a Tuesday; the week it belongs to ends Sunday the 23rd.
  if (E.endOfWeek("2026-08-18") !== "2026-08-23") return "Tuesday -> " + E.endOfWeek("2026-08-18");
  if (E.endOfWeek("2026-08-17") !== "2026-08-23") return "Monday -> " + E.endOfWeek("2026-08-17");
  if (E.endOfWeek("2026-08-22") !== "2026-08-23") return "Saturday -> " + E.endOfWeek("2026-08-22");
  // On a Sunday it is already the end of the week, so it holds for today only.
  if (E.endOfWeek("2026-08-23") !== "2026-08-23") return "Sunday -> " + E.endOfWeek("2026-08-23");
  return null;
});

check("a piece kept until the end of the week is pinned through Sunday", () => {
  const tuesday = "2026-08-18";
  const it = item({ id: "p", name: "P", slot: "bottom", warmth: 3, color: "#111",
                    pinnedUntil: E.endOfWeek(tuesday) });
  if (!E.isPinned(it, "2026-08-21")) return "not pinned on the Friday";
  if (!E.isPinned(it, "2026-08-23")) return "not pinned on the Sunday itself";
  if (E.isPinned(it, "2026-08-24")) return "still pinned on the Monday after";
  return null;
});

check("the pair queue asks about the pairs the app would actually use", () => {
  const s = state();
  const q = E.pairQueue(s, { today: TODAY, tempC: 18, criteria: { ignoreInsulation: true, repeatDays: 0 } });
  if (!q.length) return "the queue was empty";
  if (!q.every((e) => e.top.slot === "top" && e.bottom.slot === "bottom")) return "a pair was not a top and a bottom";
  for (let i = 1; i < q.length; i++) {
    if (q[i - 1].uses < q[i].uses) return "the queue is not ordered by how often the pair is used";
  }
  return null;
});

check("the pair queue stops asking once a pair is rated", () => {
  const s = state();
  const ctx = { today: TODAY, tempC: 18, criteria: { ignoreInsulation: true, repeatDays: 0 } };
  const first = E.pairQueue(s, ctx)[0];
  s.pairs = { [first.key]: 1 };
  const again = E.pairQueue(s, ctx);
  return again.some((e) => e.key === first.key) ? "a rated pair was asked about again" : null;
});

check("logging today's outfit does not empty today's suggestions", () => {
  // The repeat rule is about consecutive days. Counting the entry you just wrote
  // makes an outfit disqualify itself, and on a narrow day the screen goes blank
  // the moment you say what you wore.
  const s = state();
  const before = E.recommend(s, { today: TODAY, tempC: 18, occasion: "lab" });
  if (!before.outfits.length) return "the fixture produced nothing to begin with";
  s.log = [{ date: TODAY, items: before.outfits[0].ids }];
  const after = E.recommend(s, { today: TODAY, tempC: 18, occasion: "lab" });
  if (!after.outfits.length) return "logging what you wore wiped out every suggestion";
  return after.outfits.some((o) => o.key === before.outfits[0].key)
    ? null : "the outfit you are actually wearing stopped being suggested today";
});

check("but yesterday's outfit is still held back today", () => {
  const s = state();
  s.log = [{ date: "2026-08-20", items: ["tee-white", "chino-beige"] }];
  const res = E.recommend(s, { today: TODAY, tempC: 20 });
  return anyHas(res.outfits, "tee-white") ? "yesterday's tee came back the next day" : null;
});

// ==================================================== suggestions from a comment

check("a comment suggestion is recorded, never applied", () => {
  const w = { items: [settledItem()], log: [], suggestions: [] };
  const entry = { date: "2026-08-22", comment: "the jumper was nowhere near warm enough", items: ["settled"] };
  const before = JSON.stringify(w.items[0]);
  const report = agent.recordSuggestions(w, entry, [
    { kind: "warmth", item: "settled", value: 3, confidence: 0.7, why: "he says it was not warm enough" }
  ]);
  if (report.added !== 1) return `expected one suggestion, got ${report.added}`;
  if (JSON.stringify(w.items[0]) !== before) return "the item was modified rather than a suggestion recorded";
  if (w.suggestions[0].value !== 3) return "the suggestion lost its value";
  if (!w.suggestions[0].quote) return "the suggestion does not carry the note it came from";
  return null;
});

check("a comment can contradict an answer, which is the point", () => {
  // applyProposals refuses anything already answered, and should keep doing so.
  // A note saying the coat was not warm enough is by definition a contradiction,
  // so it takes the other route and is labelled as a disagreement.
  const w = { items: [settledItem()], log: [], suggestions: [] };
  const refused = agent.applyProposals(w, [{ id: "settled", fields: {
    warmth: { value: 2, confidence: 0.9, why: "should be refused" } } }], "2026-08-22");
  if (refused.filled !== 0) return "applyProposals stopped refusing settled fields";
  agent.recordSuggestions(w, { date: "2026-08-22", comment: "froze in it", items: ["settled"] },
    [{ kind: "warmth", item: "settled", value: 2, confidence: 0.8, why: "he froze" }]);
  if (w.suggestions.length !== 1) return "the contradiction had nowhere to go";
  if (w.items[0].warmth !== 5) return "the contradiction was applied instead of suggested";
  return null;
});

check("nonsense in a comment suggestion is discarded", () => {
  const w = { items: [settledItem()], log: [], suggestions: [] };
  const report = agent.recordSuggestions(w, { date: "2026-08-22", comment: "x", items: [] }, [
    { kind: "warmth", item: "settled", value: 9, confidence: 0.9, why: "out of range" },
    { kind: "warmth", item: "no-such-item", value: 3, confidence: 0.9, why: "unknown item" },
    { kind: "offset", value: 5, confidence: 0.9, why: "out of range" },
    { kind: "fabric", item: "settled", value: "unobtainium", confidence: 0.9, why: "not a fabric" },
    { kind: "telepathy", item: "settled", value: 1, confidence: 0.9, why: "not a kind" },
    { kind: "pair", item: "settled", other: "ghost", value: 1, confidence: 0.9, why: "unknown partner" }
  ]);
  if (report.added !== 0) return `stored ${report.added} invalid suggestion(s)`;
  if (report.refusedInvalid !== 6) return `expected 6 rejections, counted ${report.refusedInvalid}`;
  return null;
});

check("a note is only read once", () => {
  const w = { items: [settledItem()], log: [
    { date: "2026-08-22", comment: "froze", items: ["settled"] },
    { date: "2026-08-21", comment: "", items: ["settled"] }
  ], suggestions: [] };
  if (agent.pendingComments(w).length !== 1) return "an empty comment was queued for reading";
  agent.recordSuggestions(w, w.log[0], []);
  return agent.pendingComments(w).length === 0 ? null : "the same note would be read again next run";
});

check("a note that says nothing actionable costs nothing", () => {
  const w = { items: [settledItem()], log: [], suggestions: [] };
  const report = agent.recordSuggestions(w, { date: "2026-08-22", comment: "nice day", items: [] }, []);
  if (report.added !== 0) return "invented a suggestion from nothing";
  if (w.suggestions.length !== 0) return "an empty suggestion list still wrote something";
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
