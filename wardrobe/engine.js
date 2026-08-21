// Wardrobe engine — all the decision logic, and nothing that touches a screen.
//
// Deliberately a plain script rather than a module: the app loads it with a
// <script> tag (no build step, same as the schedule app) and tools/wardrobe-selftest.mjs
// evaluates this same file in node. One copy of the rules, tested where it runs.
//
// Everything here is a pure function of the state you pass in. No fetch, no DOM,
// no clock — "today" is always an argument, so tests can pick a day.

(function (root) {
  "use strict";

  // ---------------------------------------------------------------- insulation
  //
  // clo is the real unit for clothing insulation: 1 clo keeps a resting person
  // comfortable at 21 °C. Garment values come from the ISO 9920 / ASHRAE 55
  // tables (see protocols/clothing-insulation.md) — a t-shirt is ~0.10, a
  // long-sleeved sweater 0.20-0.40, trousers 0.25-0.35.
  //
  // Umut enters a 1-5 thickness step per item rather than a clo number, so each
  // slot gets its own ladder across that slot's published range. A "very thick"
  // t-shirt and a "very thick" parka are nowhere near the same number, which is
  // exactly why the ladder is per slot instead of one shared scale.

  var CLO_LADDER = {
    "top:1":    [0.06, 0.09, 0.12, 0.16, 0.20],  // base layer — vest to heavy tee
    "top:2":    [0.15, 0.20, 0.25, 0.30, 0.35],  // shirt / mid layer
    "top:3":    [0.20, 0.26, 0.32, 0.38, 0.45],  // sweater / overshirt
    "bottom":   [0.15, 0.21, 0.27, 0.33, 0.40],  // shorts to lined trousers
    "outer":    [0.20, 0.40, 0.65, 1.00, 1.50],  // shell to heavy parka
    "shoes":    [0.02, 0.04, 0.06, 0.08, 0.10],
    "accessory":[0.01, 0.03, 0.05, 0.08, 0.10]
  };

  // Comfort model. The slope is the standard rule of thumb — above freezing you
  // need roughly 0.16 clo more for every 1 °C you lose.
  var CLO_PER_DEGREE = 0.16;
  var BASE_TEMP_C = 21;      // where 1 clo is comfortable, at rest
  var MIN_REQUIRED_CLO = 0.15;

  // Being on your feet and outdoors needs far less insulation than sitting
  // still, which is what the 1 clo / 21 °C reference assumes. This factor is a
  // starting point, not a measurement — cloOffset below is what actually makes
  // the model fit Umut, learned from his own cold/warm feedback.
  var DEFAULT_ACTIVITY_FACTOR = 0.6;

  function ladderFor(item) {
    if (item.slot === "top") return CLO_LADDER["top:" + (item.layer || 1)] || CLO_LADDER["top:1"];
    return CLO_LADDER[item.slot] || CLO_LADDER.accessory;
  }

  // An item's clo: an explicit value wins, otherwise the thickness step, otherwise
  // the middle of the slot's range.
  function cloFor(item) {
    if (typeof item.clo === "number" && isFinite(item.clo)) return item.clo;
    var ladder = ladderFor(item);
    var step = item.warmth;
    if (typeof step !== "number" || step < 1 || step > 5) step = 3;
    return ladder[Math.round(step) - 1];
  }

  function totalClo(items) {
    var sum = 0;
    for (var i = 0; i < items.length; i++) sum += cloFor(items[i]);
    return Math.round(sum * 1000) / 1000;
  }

  function requiredClo(tempC, opts) {
    opts = opts || {};
    var activity = typeof opts.activityFactor === "number" ? opts.activityFactor : DEFAULT_ACTIVITY_FACTOR;
    var offset = typeof opts.cloOffset === "number" ? opts.cloOffset : 0;
    var seated = 1.0 + (BASE_TEMP_C - tempC) * CLO_PER_DEGREE;
    return Math.max(MIN_REQUIRED_CLO, seated * activity - offset);
  }

  // The inverse, so a candidate can say "good down to ~8 °C" instead of "1.42 clo".
  // An abstract number nobody can check is worth less than a temperature he can.
  function comfortTemp(clo, opts) {
    opts = opts || {};
    var activity = typeof opts.activityFactor === "number" ? opts.activityFactor : DEFAULT_ACTIVITY_FACTOR;
    var offset = typeof opts.cloOffset === "number" ? opts.cloOffset : 0;
    var seated = (clo + offset) / activity;
    return Math.round((BASE_TEMP_C - (seated - 1.0) / CLO_PER_DEGREE) * 10) / 10;
  }

  // Cold hurts more than warm, so the two sides are not the same width: an outfit
  // may run warmer than needed by more than it may run colder.
  var TOLERANCE_COLD = 0.25;
  var TOLERANCE_WARM = 0.45;

  // Footwear and accessories are a small share of whole-body insulation, so the
  // clo sum can barely tell winter boots from summer sandals — it would happily
  // put boots on a 32 °C day. This rule works per item instead of on the total:
  // once the day needs almost no insulation, the thickest things in any category
  // are out regardless of what the arithmetic allows. The threshold works out at
  // roughly 22 °C.
  var THICK_STEP = 4;
  var NO_THICK_BELOW_CLO = 0.5;

  function thicknessStep(item) {
    if (typeof item.warmth === "number" && item.warmth >= 1 && item.warmth <= 5) return Math.round(item.warmth);
    var ladder = ladderFor(item), clo = cloFor(item), best = 3, bestD = Infinity;
    for (var i = 0; i < ladder.length; i++) {
      var d = Math.abs(ladder[i] - clo);
      if (d < bestD) { bestD = d; best = i + 1; }
    }
    return best;
  }

  function tooThickForToday(item, required) {
    return required < NO_THICK_BELOW_CLO && thicknessStep(item) >= THICK_STEP;
  }

  // ------------------------------------------------------------------- colour

  function hexToHsl(hex) {
    if (typeof hex !== "string") return null;
    var m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    var r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }

  // Neutrals are the colours that go with everything, so they never take a
  // penalty anywhere in the colour rules. Greys and near-black/near-white fall
  // out of low saturation; navy, denim and the beige/tan/brown family have to be
  // named, because they are saturated enough to look like accents otherwise.
  function isNeutral(hsl) {
    if (!hsl) return true;                                  // unknown colour: don't punish it
    if (hsl.s < 0.20) return true;                          // grey scale
    if (hsl.l < 0.14 || hsl.l > 0.90) return true;          // black, white
    if (hsl.h >= 200 && hsl.h <= 250 && hsl.l < 0.38) return true;                 // navy
    if (hsl.h >= 195 && hsl.h <= 235 && hsl.s <= 0.60 && hsl.l >= 0.28 && hsl.l <= 0.62) return true; // denim
    if (hsl.h >= 18 && hsl.h <= 52 && hsl.s <= 0.55) return true;                  // beige, tan, khaki, brown
    return false;
  }

  function colourClass(hex) {
    var hsl = hexToHsl(hex);
    if (isNeutral(hsl)) return "neutral";
    return hsl.s >= 0.50 ? "accent" : "secondary";
  }

  function hueDistance(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  // Roughly how much of the outfit each slot accounts for by eye. Only the
  // outermost top counts as "the top" — anything worn under it is mostly hidden.
  function areaWeight(item, ctx) {
    if (item.slot === "bottom") return 35;
    if (item.slot === "outer") return 25;
    if (item.slot === "shoes") return 7;
    if (item.slot === "accessory") return 3;
    if (item.slot === "top") return item.id === ctx.outermostTopId ? 30 : 5;
    return 5;
  }

  // The 60-30-10 guideline: about 60% of an outfit neutral, 30% a secondary
  // colour, 10% an accent. Deviations are not symmetric — too much neutral is
  // safe and barely penalised, too much accent is loud and fully penalised.
  function balanceScore(items) {
    var outermostTopId = null, maxLayer = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].slot === "top" && (items[i].layer || 1) > maxLayer) {
        maxLayer = items[i].layer || 1;
        outermostTopId = items[i].id;
      }
    }
    var ctx = { outermostTopId: outermostTopId };
    var share = { neutral: 0, secondary: 0, accent: 0 }, total = 0;
    for (var j = 0; j < items.length; j++) {
      var w = areaWeight(items[j], ctx);
      share[colourClass(items[j].color)] += w;
      total += w;
    }
    if (!total) return 1;
    var n = share.neutral / total * 100, s = share.secondary / total * 100, a = share.accent / total * 100;
    var dev = Math.max(0, 60 - n) * 1.0 + Math.max(0, n - 60) * 0.25
            + Math.abs(s - 30) * 0.5
            + Math.max(0, a - 10) * 1.0 + Math.max(0, 10 - a) * 0.3;
    return clamp01(1 - dev / 100);
  }

  // Colours next to each other on the wheel (analogous) or opposite it
  // (complementary) work; the middle distances are the ones that clash.
  // Neutrals are not in this calculation at all.
  function harmonyScore(items) {
    var hues = [];
    for (var i = 0; i < items.length; i++) {
      var hsl = hexToHsl(items[i].color);
      if (hsl && !isNeutral(hsl)) hues.push(hsl.h);
    }
    if (hues.length < 2) return 1;                     // nothing can clash
    var sum = 0, pairs = 0;
    for (var a = 0; a < hues.length; a++) {
      for (var b = a + 1; b < hues.length; b++) {
        var d = hueDistance(hues[a], hues[b]), v;
        if (d <= 30) v = 1;
        else if (d >= 150) v = 1;
        else if (d >= 60 && d <= 140) v = -1;
        else if (d < 60) v = 1 - (d - 30) / 30 * 2;    // 30->1 fading to 60->-1
        else v = -1 + (d - 140) / 10 * 2;              // 140->-1 rising to 150->1
        sum += v; pairs++;
      }
    }
    return clamp01((sum / pairs + 1) / 2);
  }

  // Some light/dark separation between top and bottom reads better than two
  // mid-tones sitting flat against each other.
  function contrastScore(items) {
    var top = null, bottom = null, maxLayer = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].slot === "top" && (items[i].layer || 1) > maxLayer) { maxLayer = items[i].layer || 1; top = items[i]; }
      if (items[i].slot === "bottom") bottom = items[i];
    }
    var a = top && hexToHsl(top.color), b = bottom && hexToHsl(bottom.color);
    if (!a || !b) return 1;
    var d = Math.abs(a.l - b.l);
    if (d >= 0.20) return 1;
    return clamp01(0.4 + d / 0.20 * 0.6);
  }

  // One loud piece is a focal point; three are a fight.
  function focusScore(items) {
    var accents = 0;
    for (var i = 0; i < items.length; i++) if (colourClass(items[i].color) === "accent") accents++;
    if (accents <= 1) return 1;
    if (accents === 2) return 0.7;
    return clamp01(0.7 - (accents - 2) * 0.3);
  }

  // Sports shoes under smart trousers is the classic mismatch. Items with no
  // formality recorded sit this one out rather than dragging the score around.
  function formalityScore(items) {
    var vals = [];
    for (var i = 0; i < items.length; i++) {
      if (typeof items[i].formality === "number") vals.push(items[i].formality);
    }
    if (vals.length < 2) return 1;
    var spread = Math.max.apply(null, vals) - Math.min.apply(null, vals);
    if (spread <= 0) return 1;
    if (spread === 1) return 0.75;
    return 0.3;
  }

  // Of every rule here this is the one that earns its keep most often: never put
  // two patterned pieces together.
  function patternScore(items) {
    var patterned = 0;
    for (var i = 0; i < items.length; i++) if (items[i].pattern === "patterned") patterned++;
    if (patterned <= 1) return 1;
    if (patterned === 2) return 0.25;
    return 0;
  }

  // Nudge the wardrobe's forgotten corners back into rotation.
  function freshnessScore(items, today) {
    var sum = 0, n = 0;
    for (var i = 0; i < items.length; i++) {
      var days = daysBetween(items[i].lastWorn, today);
      if (days === null) { sum += 1; n++; continue; }     // never worn
      sum += clamp01(0.2 + Math.min(days, 30) / 30 * 0.8);
      n++;
    }
    return n ? sum / n : 1;
  }

  var RULE_WEIGHTS = {
    balance:   0.22,
    harmony:   0.20,
    contrast:  0.08,
    focus:     0.10,
    formality: 0.18,
    pattern:   0.14,
    freshness: 0.08
  };

  var RULE_LABELS = {
    balance:   "colour balance",
    harmony:   "colour harmony",
    contrast:  "light/dark contrast",
    focus:     "one focal piece",
    formality: "consistent formality",
    pattern:   "pattern mix",
    freshness: "not worn recently"
  };

  function ruleScores(items, today) {
    return {
      balance:   balanceScore(items),
      harmony:   harmonyScore(items),
      contrast:  contrastScore(items),
      focus:     focusScore(items),
      formality: formalityScore(items),
      pattern:   patternScore(items),
      freshness: freshnessScore(items, today)
    };
  }

  // Which rules actually had something to judge. A rule with nothing to say
  // scores a harmless 1, and without this the "why this?" line would keep
  // congratulating an all-neutral outfit on its colour harmony.
  function engagedRules(items) {
    var nonNeutral = 0, accents = 0, patterned = 0, formalities = 0, top = false, bottom = false;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var hsl = hexToHsl(it.color);
      if (hsl && !isNeutral(hsl)) nonNeutral++;
      if (colourClass(it.color) === "accent") accents++;
      if (it.pattern === "patterned") patterned++;
      if (typeof it.formality === "number") formalities++;
      if (it.slot === "top") top = true;
      if (it.slot === "bottom") bottom = true;
    }
    return {
      balance:   true,
      harmony:   nonNeutral >= 2,
      contrast:  top && bottom,
      focus:     accents >= 1,
      formality: formalities >= 2,
      pattern:   patterned >= 1,
      freshness: true
    };
  }

  function combineRules(parts) {
    var sum = 0;
    for (var k in RULE_WEIGHTS) if (RULE_WEIGHTS.hasOwnProperty(k)) sum += parts[k] * RULE_WEIGHTS[k];
    return sum;
  }

  // -------------------------------------------------------------- taste model
  //
  // Online logistic regression over the rule scores plus one weight per item.
  // Feeding the rule scores in as features is the point: if Umut keeps rejecting
  // the complementary-colour outfits the book likes, the model can learn a
  // negative weight on harmony and overrule the book.

  function featurise(items, today) {
    var parts = ruleScores(items, today);
    var f = {};
    for (var k in parts) if (parts.hasOwnProperty(k)) f["rule:" + k] = parts[k] - 0.5;
    for (var i = 0; i < items.length; i++) {
      f["item:" + items[i].id] = 1;
      if (items[i].slot === "top" || items[i].slot === "bottom" || items[i].slot === "outer") {
        f["colour:" + items[i].slot + ":" + colourClass(items[i].color)] = 1;
      }
    }
    f["clo"] = (totalClo(items) - 1.0) / 2;
    return f;
  }

  function dot(weights, f) {
    var s = weights.__bias || 0;
    for (var k in f) if (f.hasOwnProperty(k)) s += (weights[k] || 0) * f[k];
    return s;
  }

  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

  function predictTaste(weights, f) { return sigmoid(dot(weights || {}, f)); }

  var LEARNING_RATE = 0.15;

  // Trained by replaying the whole swipe log, not by mutating weights in place.
  // That is what makes undo honest: drop a swipe from the log, retrain, and the
  // model is exactly what it would have been had that swipe never happened.
  function trainTaste(swipes, itemsById, today) {
    var w = { __bias: 0 };
    if (!swipes) return { weights: w, n: 0 };
    for (var pass = 0; pass < 3; pass++) {
      for (var i = 0; i < swipes.length; i++) {
        var items = resolveItems(swipes[i].items, itemsById);
        if (items.length === 0) continue;
        var f = featurise(items, swipes[i].at ? swipes[i].at.slice(0, 10) : today);
        var p = sigmoid(dot(w, f));
        var err = (swipes[i].liked ? 1 : 0) - p;
        w.__bias += LEARNING_RATE * err;
        for (var k in f) if (f.hasOwnProperty(k)) w[k] = (w[k] || 0) + LEARNING_RATE * err * f[k];
      }
    }
    return { weights: w, n: swipes.length };
  }

  // How much say the book still has. Starts as pure rules and hands over to the
  // learned model as swipes accumulate, but never fully — the rules stay as a
  // floor so a run of odd swipes can't wreck every suggestion.
  function ruleWeightFor(n) { return Math.max(0.3, 1 - (n || 0) / 150); }

  // ------------------------------------------------------------------ scoring

  function scoreOutfit(items, ctx) {
    var parts = ruleScores(items, ctx.today);
    var ruleScore = combineRules(parts);
    var w = ruleWeightFor(ctx.tasteN);
    var model = ctx.tasteWeights ? predictTaste(ctx.tasteWeights, featurise(items, ctx.today)) : 0.5;
    var total = w * ruleScore + (1 - w) * model;
    return { total: total, rule: ruleScore, model: model, ruleWeight: w, parts: parts };
  }

  // The "why this?" line.
  //
  // Naming whichever rule scored highest sounds informative and isn't: most rules
  // sit at a harmless 1 for most outfits, so every single suggestion ends up
  // praised for the same thing. Only a rule that actually had something to judge,
  // and did something notable with it, earns a mention. An outfit with nothing
  // particular to say about it just gets its temperature.
  function explain(items, score, ctx) {
    var bits = [];
    var clo = totalClo(items);
    var parts = score.parts, engaged = engagedRules(items);

    bits.push(comfortTemp(clo, ctx) + " °C outfit");

    var praise = null;
    if (engaged.harmony && parts.harmony >= 0.9) praise = "colours work together";
    else if (engaged.focus && parts.focus === 1) praise = "one piece carries it";
    else if (engaged.formality && parts.formality === 1) praise = "formality lines up";
    else if (parts.freshness >= 0.9) praise = "not worn in a while";
    if (praise) bits.push(praise);

    var worst = null;
    for (var k in parts) {
      if (!parts.hasOwnProperty(k) || !engaged[k]) continue;
      if (worst === null || parts[k] < parts[worst]) worst = k;
    }
    if (worst && parts[worst] < 0.6) bits.push("weak on " + RULE_LABELS[worst]);

    if (score.ruleWeight < 0.6) bits.push("mostly your taste");

    var pinned = items.filter(function (it) { return isPinned(it, ctx.today); });
    if (pinned.length) bits.push(pinned.map(function (it) { return it.name; }).join(", ") + " pinned");

    var guessed = countGuessedWarmth(items);
    if (guessed) bits.push(guessed + (guessed === 1 ? " item's" : " items'") + " thickness is a guess");
    return bits.join(" · ");
  }

  // Ranked purely by score, the top of the deck is a run of near-identical
  // outfits — the same trousers and shoes with a different plain tee, which the
  // rules cannot tell apart. Swiping through those teaches the model nothing and
  // reads as a broken app, so spread them out: an outfit that only differs from
  // one already shown by a single item waits its turn.
  function diversify(outfits, minDifference) {
    var need = minDifference || 2;
    var picked = [], held = [];
    for (var i = 0; i < outfits.length; i++) {
      var ok = true;
      for (var j = 0; j < picked.length; j++) {
        if (differenceCount(outfits[i].ids, picked[j].ids) < need) { ok = false; break; }
      }
      if (ok) picked.push(outfits[i]); else held.push(outfits[i]);
    }
    return picked.concat(held);
  }

  function differenceCount(a, b) {
    var seen = {}, i, n = 0;
    for (i = 0; i < b.length; i++) seen[b[i]] = true;
    for (i = 0; i < a.length; i++) if (!seen[a[i]]) n++;
    for (i = 0; i < b.length; i++) if (a.indexOf(b[i]) === -1) n++;
    return n;
  }

  function countGuessedWarmth(items) {
    var n = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var isGuess = (it.guessed && it.guessed.indexOf("warmth") !== -1)
                 || (it.agentGuessed && it.agentGuessed.warmth);
      if (isGuess) n++;
    }
    return n;
  }

  // -------------------------------------------------------------- hard rules
  //
  // These eliminate rather than score. Each one records why, so the end-of-deck
  // "show what was filtered out" can say exactly what it is relaxing.

  var RELAX_ORDER = ["repeat", "occasion", "insulation", "dirty"];

  function isPinned(item, today) {
    return !!(item.pinnedUntil && item.pinnedUntil >= today);
  }

  function isDirty(item) {
    var limit = typeof item.washAfter === "number" ? item.washAfter : defaultWashAfter(item);
    return (item.wearsSinceWash || 0) >= limit;
  }

  function defaultWashAfter(item) {
    if (item.slot === "top") return (item.layer || 1) === 1 ? 1 : 3;
    if (item.slot === "bottom") return 5;
    if (item.slot === "outer") return 20;
    if (item.slot === "shoes") return 60;
    return 10;
  }

  // No occasions recorded means "goes anywhere". Only the name is mandatory when
  // adding an item, so silence has to mean permissive — otherwise a freshly
  // added item would be filtered out of everything.
  function occasionOk(item, occasion) {
    if (!occasion) return true;
    if (!item.occasions || !item.occasions.length) return true;
    return item.occasions.indexOf(occasion) !== -1;
  }

  function wornRecently(item, log, today, days) {
    if (!log || !days) return false;
    var cutoff = shiftDate(today, -days);
    for (var i = log.length - 1; i >= 0; i--) {
      if (log[i].date <= cutoff) break;
      if (log[i].date <= today && log[i].items && log[i].items.indexOf(item.id) !== -1) return true;
    }
    return false;
  }

  function outfitKey(items) {
    return items.map(function (i) { return i.id; }).sort().join("+");
  }

  // ------------------------------------------------------- candidate assembly

  var MAX_CANDIDATES = 1200;

  function recommend(state, ctx) {
    ctx = ctx || {};
    var settings = state.settings || {};
    var today = ctx.today;
    var relax = ctx.relax || 0;
    var criteria = ctx.criteria || {};

    // The training deck deliberately ignores the weather: its job is to learn
    // taste, and only showing today's weather-appropriate outfits would teach
    // the model nothing about the other three seasons.
    var ignoreInsulation = criteria.ignoreInsulation === true;
    var allowDirty = relax >= 4 || criteria.includeDirty === true;
    var applyOccasion = !(relax >= 2) && criteria.occasionFilter !== false;
    var repeatDays = relax >= 1 ? 0
      : (typeof criteria.repeatDays === "number" ? criteria.repeatDays
        : (typeof settings.repeatDays === "number" ? settings.repeatDays : 3));
    var tolScale = relax >= 3 ? 2 : 1;
    var usePins = criteria.usePins !== false;

    var cloOpts = {
      activityFactor: typeof settings.activityFactor === "number" ? settings.activityFactor : DEFAULT_ACTIVITY_FACTOR,
      cloOffset: typeof settings.cloOffset === "number" ? settings.cloOffset : 0
    };
    var need = typeof ctx.requiredClo === "number" ? ctx.requiredClo
      : requiredClo(typeof ctx.tempC === "number" ? ctx.tempC : BASE_TEMP_C, cloOpts);
    var tolCold = (typeof criteria.toleranceCold === "number" ? criteria.toleranceCold : TOLERANCE_COLD) * tolScale;
    var tolWarm = (typeof criteria.toleranceWarm === "number" ? criteria.toleranceWarm : TOLERANCE_WARM) * tolScale;

    var eliminated = { dirty: 0, occasion: 0, repeat: 0, insulation: 0, seasonal: 0, rain: 0, rejected: 0 };

    // Item-level filters first — they shrink the pools before any combining.
    var pools = { base: [], mid: [], over: [], bottom: [], shoes: [], outer: [], accessory: [] };
    var pinnedBy = {};
    var items = state.items || [];

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.archived) continue;
      if (!allowDirty && isDirty(it)) { eliminated.dirty++; continue; }
      if (applyOccasion && !occasionOk(it, ctx.occasion)) { eliminated.occasion++; continue; }
      var pinned = usePins && isPinned(it, today);
      // A pinned item is exempt from the repeat rule — being worn several days
      // running is the entire point of pinning it.
      if (!pinned && repeatDays && wornRecently(it, state.log, today, repeatDays)) { eliminated.repeat++; continue; }
      if (ctx.rain && it.slot === "shoes" && it.fabric === "suede") { eliminated.rain++; continue; }
      if (!pinned && relax < 3 && !ignoreInsulation && tooThickForToday(it, need)) { eliminated.seasonal++; continue; }
      var key = poolKey(it);
      if (!pools[key]) continue;
      pools[key].push(it);
      if (pinned) (pinnedBy[key] = pinnedBy[key] || []).push(it);
    }

    // A pin collapses its pool to the pinned item, so every outfit must contain it.
    for (var pk in pinnedBy) {
      if (pinnedBy.hasOwnProperty(pk) && pinnedBy[pk].length) pools[pk] = pinnedBy[pk];
    }

    var rejectedKeys = {};
    if (state.rejected && !criteria.ignoreRejected) {
      for (var r = 0; r < state.rejected.length; r++) rejectedKeys[state.rejected[r].key] = true;
    }

    var tasteWeights = ctx.tasteWeights || (state.taste && state.taste.weights) || null;
    var tasteN = typeof ctx.tasteN === "number" ? ctx.tasteN : ((state.taste && state.taste.n) || 0);
    var scoreCtx = {
      today: today, tasteWeights: tasteWeights, tasteN: tasteN,
      activityFactor: cloOpts.activityFactor, cloOffset: cloOpts.cloOffset
    };

    var results = [];
    var seen = {};
    var budget = MAX_CANDIDATES;

    // Core is top + bottom + shoes; outer and extra tops are added only when the
    // day actually calls for the insulation, which keeps the combinations sane.
    var outerOptions = pools.outer.slice();
    if (!pinnedBy.outer) outerOptions.unshift(null);
    var midOptions = pools.mid.slice(); if (!pinnedBy.mid) midOptions.unshift(null);
    var overOptions = pools.over.slice(); if (!pinnedBy.over) overOptions.unshift(null);

    for (var b = 0; b < pools.bottom.length && budget > 0; b++) {
      for (var t = 0; t < pools.base.length && budget > 0; t++) {
        for (var s = 0; s < pools.shoes.length && budget > 0; s++) {
          for (var m = 0; m < midOptions.length && budget > 0; m++) {
            for (var o = 0; o < overOptions.length && budget > 0; o++) {
              for (var x = 0; x < outerOptions.length && budget > 0; x++) {
                var combo = [pools.bottom[b], pools.base[t], pools.shoes[s]];
                if (midOptions[m]) combo.push(midOptions[m]);
                if (overOptions[o]) combo.push(overOptions[o]);
                if (outerOptions[x]) combo.push(outerOptions[x]);

                budget--;

                // Rain needs a shell that actually keeps water out.
                if (ctx.rain && outerOptions[x] && outerOptions[x].waterproof !== true) { eliminated.rain++; continue; }

                var warmth = totalClo(combo);
                var accessories = pickAccessories(pools.accessory, ignoreInsulation ? 0 : need - warmth, today, usePins);
                var withAcc = combo.concat(accessories);
                warmth = totalClo(withAcc);

                if (!ignoreInsulation){
                  if (need - warmth > tolCold) { eliminated.insulation++; continue; }
                  if (warmth - need > tolWarm) { eliminated.insulation++; continue; }
                }
                if (ctx.rain && !outerOptions[x]) { eliminated.rain++; continue; }

                var key = outfitKey(withAcc);
                if (seen[key]) continue;
                if (rejectedKeys[key]) { eliminated.rejected++; continue; }
                seen[key] = true;

                var score = scoreOutfit(withAcc, scoreCtx);
                results.push({
                  key: key,
                  items: withAcc,
                  ids: withAcc.map(function (it2) { return it2.id; }),
                  clo: warmth,
                  requiredClo: need,
                  comfortTemp: comfortTemp(warmth, scoreCtx),
                  score: score.total,
                  detail: score,
                  why: explain(withAcc, score, scoreCtx)
                });
              }
            }
          }
        }
      }
    }

    results.sort(function (p, q) { return q.score - p.score || (p.key < q.key ? -1 : 1); });
    return {
      outfits: results,
      eliminated: eliminated,
      requiredClo: need,
      exhausted: budget <= 0,
      relaxed: RELAX_ORDER.slice(0, relax)
    };
  }

  function poolKey(item) {
    if (item.slot !== "top") return item.slot;
    var layer = item.layer || 1;
    return layer === 1 ? "base" : (layer === 2 ? "mid" : "over");
  }

  // Accessories are pulled in to close a remaining insulation gap (a scarf on a
  // cold day), or worn if pinned. They are not combined exhaustively — that
  // would multiply the search for very little decision value.
  function pickAccessories(pool, gap, today, usePins) {
    var chosen = [], i;
    for (i = 0; i < pool.length; i++) if (usePins && isPinned(pool[i], today)) chosen.push(pool[i]);
    if (gap <= 0) return chosen;
    var rest = pool.filter(function (it) { return chosen.indexOf(it) === -1; })
                   .sort(function (a, b) { return cloFor(b) - cloFor(a); });
    for (i = 0; i < rest.length && gap > 0; i++) { chosen.push(rest[i]); gap -= cloFor(rest[i]); }
    return chosen;
  }

  // ----------------------------------------------------- personal calibration
  //
  // The comfort model above is generic. This is what makes it Umut's: after
  // wearing an outfit he taps cold / right / warm, and the offset shifts so the
  // same conditions ask for more or less insulation next time.

  var FEEDBACK_STEP = 0.08;
  var MAX_OFFSET = 0.8;

  function applyFeedback(cloOffset, feedback) {
    var v = typeof cloOffset === "number" ? cloOffset : 0;
    // Felt cold => he needs MORE insulation than the model asked for => lower the
    // offset, which raises required clo.
    if (feedback === "cold") v -= FEEDBACK_STEP;
    else if (feedback === "warm") v += FEEDBACK_STEP;
    else return v;
    return Math.round(Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, v)) * 1000) / 1000;
  }

  // ------------------------------------------------------------- gaps queue
  //
  // Ordered by how much the missing field distorts a decision, not alphabetically:
  // a wrong thickness makes him cold, a missing fabric makes almost no difference.

  var GAP_PRIORITY = { warmth: 100, pattern: 60, formality: 45, color: 40, occasions: 25, waterproof: 20, washAfter: 15, fabric: 10, season: 8, fit: 5 };

  function gapsFor(item) {
    var gaps = [];
    var guessed = item.guessed || [];
    for (var k in GAP_PRIORITY) {
      if (!GAP_PRIORITY.hasOwnProperty(k)) continue;
      var missing = item[k] === null || item[k] === undefined || (k === "occasions" && (!item[k] || !item[k].length));
      var isGuess = guessed.indexOf(k) !== -1 || (item.agentGuessed && item.agentGuessed[k]);
      if (missing || isGuess) {
        gaps.push({
          field: k,
          priority: GAP_PRIORITY[k],
          state: missing ? "missing" : (item.agentGuessed && item.agentGuessed[k] ? "agent" : "guessed")
        });
      }
    }
    return gaps.sort(function (a, b) { return b.priority - a.priority; });
  }

  function gapsQueue(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var gaps = gapsFor(items[i]);
      if (!gaps.length) continue;
      var weight = 0;
      for (var g = 0; g < gaps.length; g++) weight += gaps[g].priority;
      out.push({ item: items[i], gaps: gaps, weight: weight });
    }
    return out.sort(function (a, b) { return b.weight - a.weight || (a.item.id < b.item.id ? -1 : 1); });
  }

  function completeness(item) {
    var total = 0, filled = 0;
    for (var k in GAP_PRIORITY) {
      if (!GAP_PRIORITY.hasOwnProperty(k)) continue;
      total++;
      var missing = item[k] === null || item[k] === undefined || (k === "occasions" && (!item[k] || !item[k].length));
      var isGuess = (item.guessed || []).indexOf(k) !== -1 || (item.agentGuessed && item.agentGuessed[k]);
      if (!missing && !isGuess) filled++;
    }
    return total ? filled / total : 1;
  }

  // ------------------------------------------------------------------- utils

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function resolveItems(ids, itemsById) {
    var out = [];
    if (!ids) return out;
    for (var i = 0; i < ids.length; i++) if (itemsById[ids[i]]) out.push(itemsById[ids[i]]);
    return out;
  }

  function indexById(items) {
    var map = {};
    for (var i = 0; i < items.length; i++) map[items[i].id] = items[i];
    return map;
  }

  function daysBetween(fromISO, toISO) {
    if (!fromISO || !toISO) return null;
    var a = Date.parse(fromISO + "T00:00:00Z"), b = Date.parse(toISO + "T00:00:00Z");
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  function shiftDate(iso, days) {
    var t = Date.parse(iso + "T00:00:00Z");
    if (isNaN(t)) return iso;
    return new Date(t + days * 86400000).toISOString().slice(0, 10);
  }

  // Weather to context. Open-Meteo's apparent temperature already folds in wind
  // and humidity, so there is no separate wind chill correction here.
  function contextFromWeather(weather, opts) {
    opts = opts || {};
    var hours = (weather && weather.hourly) || [];
    var day = hours.filter(function (h) { return h.time && h.time.slice(0, 10) === opts.today; });
    var relevant = day.filter(function (h) {
      var hh = parseInt(h.time.slice(11, 13), 10);
      return hh >= 7 && hh <= 21;
    });
    if (!relevant.length) relevant = day;
    var apparent = relevant.map(function (h) { return h.apparent; }).filter(isNum);
    var actual = relevant.map(function (h) { return h.temp; }).filter(isNum);
    var rainChance = Math.max.apply(null, [0].concat(relevant.map(function (h) { return h.precipProb || 0; })));
    var morning = relevant.filter(function (h) { var hh = +h.time.slice(11, 13); return hh >= 7 && hh <= 10; });
    var midday = relevant.filter(function (h) { var hh = +h.time.slice(11, 13); return hh >= 12 && hh <= 16; });
    var mMin = morning.length ? Math.min.apply(null, morning.map(function (h) { return h.apparent; })) : null;
    var dMax = midday.length ? Math.max.apply(null, midday.map(function (h) { return h.apparent; })) : null;
    return {
      tempC: apparent.length ? Math.min.apply(null, apparent) : null,
      tempMaxC: apparent.length ? Math.max.apply(null, apparent) : null,
      actualC: actual.length ? actual[0] : null,
      rain: rainChance >= 50,
      rainChance: rainChance,
      swing: (mMin !== null && dMax !== null) ? Math.round((dMax - mMin) * 10) / 10 : null,
      morningC: mMin, middayC: dMax
    };
  }

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  // A day that warms up a lot is not one temperature. Rather than splitting the
  // difference and being wrong twice, dress for the morning and name the layer
  // to shed at midday.
  var SWING_THRESHOLD = 6;

  function shedLayer(outfit, weatherCtx) {
    if (!weatherCtx || weatherCtx.swing === null || weatherCtx.swing < SWING_THRESHOLD) return null;
    var candidates = outfit.items.filter(function (it) {
      return it.slot === "outer" || (it.slot === "top" && (it.layer || 1) > 1) || it.slot === "accessory";
    }).sort(function (a, b) { return cloFor(b) - cloFor(a); });
    if (!candidates.length) return null;
    return { item: candidates[0], swing: weatherCtx.swing, middayC: weatherCtx.middayC };
  }

  root.WardrobeEngine = {
    CLO_LADDER: CLO_LADDER,
    CLO_PER_DEGREE: CLO_PER_DEGREE,
    BASE_TEMP_C: BASE_TEMP_C,
    DEFAULT_ACTIVITY_FACTOR: DEFAULT_ACTIVITY_FACTOR,
    TOLERANCE_COLD: TOLERANCE_COLD,
    TOLERANCE_WARM: TOLERANCE_WARM,
    NO_THICK_BELOW_CLO: NO_THICK_BELOW_CLO,
    THICK_STEP: THICK_STEP,
    RELAX_ORDER: RELAX_ORDER,
    RULE_LABELS: RULE_LABELS,
    RULE_WEIGHTS: RULE_WEIGHTS,
    GAP_PRIORITY: GAP_PRIORITY,
    SWING_THRESHOLD: SWING_THRESHOLD,

    cloFor: cloFor,
    ladderFor: ladderFor,
    totalClo: totalClo,
    requiredClo: requiredClo,
    comfortTemp: comfortTemp,

    hexToHsl: hexToHsl,
    isNeutral: isNeutral,
    colourClass: colourClass,
    hueDistance: hueDistance,

    ruleScores: ruleScores,
    engagedRules: engagedRules,
    thicknessStep: thicknessStep,
    tooThickForToday: tooThickForToday,
    combineRules: combineRules,
    scoreOutfit: scoreOutfit,
    explain: explain,
    diversify: diversify,
    differenceCount: differenceCount,

    featurise: featurise,
    trainTaste: trainTaste,
    predictTaste: predictTaste,
    ruleWeightFor: ruleWeightFor,

    recommend: recommend,
    outfitKey: outfitKey,
    isPinned: isPinned,
    isDirty: isDirty,
    defaultWashAfter: defaultWashAfter,
    occasionOk: occasionOk,
    wornRecently: wornRecently,

    applyFeedback: applyFeedback,
    gapsFor: gapsFor,
    gapsQueue: gapsQueue,
    completeness: completeness,

    contextFromWeather: contextFromWeather,
    shedLayer: shedLayer,

    indexById: indexById,
    daysBetween: daysBetween,
    shiftDate: shiftDate
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
