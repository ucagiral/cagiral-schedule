// Every rule the Cell Stocks app has, as pure functions.
//
// Deliberately a plain script rather than a module: the app loads it with a <script>
// tag, with no build step, and tools/cellstocks-selftest.mjs evaluates this same file
// in node. One copy of the rules, tested where it runs.
//
// Everything here is a pure function of the state you pass in. No fetch, no DOM, no
// clock -- "today", ids and timestamps are always arguments, so tests can assert
// byte-identical output.
//
// The one thing worth understanding before changing anything: in Umut's sheet, the
// cell NAME is the only thing he types. Origin, KO/OX, resistance, CASPEX and guide
// are all formulas over that one string. classify() is those formulas, except the
// rules are data (state.rules) rather than code, so a new common label is an edit in
// the app and not a commit here.
(function (root) {
  "use strict";

  // =====================================================================
  // Small helpers
  // =====================================================================

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function isStr(x) { return typeof x === "string"; }
  function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }

  function indexById(list) {
    var out = {};
    (list || []).forEach(function (x) { if (x && x.id) out[x.id] = x; });
    return out;
  }

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // =====================================================================
  // Grid geometry
  //
  // A box is rows x cols. "grid" boxes label positions A1..I9; "linear" boxes label
  // them 1..81. Both live in the data, because a -80 rack and a nitrogen tower are
  // numbered differently and neither should be hardcoded.
  // =====================================================================

  function rowLabel(i) {
    var s = "", n = i + 1;
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function rowIndexFromLabel(label) {
    var n = 0;
    for (var i = 0; i < label.length; i++) {
      var c = label.charCodeAt(i);
      if (c < 65 || c > 90) return -1;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  function capacity(box) {
    if (!box) return 0;
    var r = Number(box.rows) || 0, c = Number(box.cols) || 0;
    return r > 0 && c > 0 ? r * c : 0;
  }

  // index is 0-based, row-major.
  function positionLabel(box, index) {
    if (!box || index < 0 || index >= capacity(box)) return null;
    if (box.scheme === "linear") return String(index + 1);
    var cols = Number(box.cols);
    return rowLabel(Math.floor(index / cols)) + String((index % cols) + 1);
  }

  // Accepts "A4", "A 4", "a-4" and, for linear boxes, "17". Returns null for anything
  // outside the grid -- "J1" in a nine-row box is a mistake, not slot 0.
  function parsePosition(box, text) {
    if (!box || text === null || text === undefined) return null;
    var s = String(text).trim().toUpperCase().replace(/[\s\-_.]+/g, "");
    if (!s) return null;
    var rows = Number(box.rows), cols = Number(box.cols);
    if (!(rows > 0 && cols > 0)) return null;

    if (box.scheme === "linear") {
      if (!/^\d+$/.test(s)) return null;
      var n = Number(s);
      if (n < 1 || n > rows * cols) return null;
      return { index: n - 1, row: Math.floor((n - 1) / cols), col: (n - 1) % cols, label: String(n) };
    }

    var m = /^([A-Z]+)(\d+)$/.exec(s);
    if (!m) return null;
    var r = rowIndexFromLabel(m[1]);
    var c = Number(m[2]) - 1;
    if (r < 0 || r >= rows || c < 0 || c >= cols) return null;
    return { index: r * cols + c, row: r, col: c, label: rowLabel(r) + String(c + 1) };
  }

  function allPositions(box) {
    var out = [], n = capacity(box);
    for (var i = 0; i < n; i++) out.push(positionLabel(box, i));
    return out;
  }

  function eachBox(state, fn) {
    var units = (state && state.storage && state.storage.units) || [];
    units.forEach(function (unit) {
      (unit.racks || []).forEach(function (rack) {
        (rack.boxes || []).forEach(function (box) { fn(box, rack, unit); });
      });
    });
  }

  function findBox(state, boxId) {
    var found = null;
    eachBox(state, function (box, rack, unit) {
      if (!found && box.id === boxId) found = { box: box, rack: rack, unit: unit };
    });
    return found;
  }

  function findUnit(state, unitId) {
    var units = (state && state.storage && state.storage.units) || [];
    for (var i = 0; i < units.length; i++) if (units[i].id === unitId) return units[i];
    return null;
  }

  // "-80 Freezer -> Rack 1 -> ONGOING -> C4", and the very same code prints "Tower"
  // for the nitrogen tank, because that word is data (unit.childLabel) too.
  function locationPath(state, loc) {
    if (!loc || !loc.boxId) return "";
    var f = findBox(state, loc.boxId);
    if (!f) return loc.position ? "(unknown box) -> " + loc.position : "(unknown box)";
    var parts = [f.unit.name, f.rack.name, f.box.name];
    if (loc.position) parts.push(loc.position);
    return parts.filter(Boolean).join(" → ");
  }

  function storedVials(state) {
    return (state.vials || []).filter(function (v) { return v.status !== "withdrawn"; });
  }

  function occupancy(state, boxId) {
    var f = findBox(state, boxId);
    if (!f) return null;
    var box = f.box, cap = capacity(box);
    var slots = [];
    for (var i = 0; i < cap; i++) slots.push({ index: i, position: positionLabel(box, i), vial: null });
    storedVials(state).forEach(function (v) {
      if (!v.location || v.location.boxId !== boxId) return;
      var p = parsePosition(box, v.location.position);
      if (!p) return;
      // A collision is a validate() error; occupancy just keeps the first so the grid
      // still renders instead of throwing on a broken import.
      if (!slots[p.index].vial) slots[p.index].vial = v;
    });
    var used = slots.filter(function (s) { return !!s.vial; }).length;
    return { boxId: boxId, box: box, rack: f.rack, unit: f.unit, capacity: cap, used: used, free: cap - used, slots: slots };
  }

  // Contiguous free runs in row-major order, longest first. Freezing five vials at
  // once should put them side by side, not scattered across the box.
  function freeRuns(state, boxId) {
    var occ = occupancy(state, boxId);
    if (!occ) return [];
    var runs = [], cur = null;
    occ.slots.forEach(function (s) {
      if (s.vial) { cur = null; return; }
      if (!cur) { cur = { start: s.index, positions: [] }; runs.push(cur); }
      cur.positions.push(s.position);
    });
    return runs.sort(function (a, b) { return b.positions.length - a.positions.length || a.start - b.start; });
  }

  function unitSummary(state, unitId) {
    var unit = findUnit(state, unitId);
    if (!unit) return null;
    var cap = 0, used = 0, boxes = [];
    (unit.racks || []).forEach(function (rack) {
      (rack.boxes || []).forEach(function (box) {
        var occ = occupancy(state, box.id);
        if (!occ) return;
        cap += occ.capacity; used += occ.used;
        boxes.push({ boxId: box.id, name: box.name, rack: rack.name, capacity: occ.capacity, used: occ.used, free: occ.free });
      });
    });
    return { unitId: unitId, name: unit.name, capacity: cap, used: used, free: cap - used, boxes: boxes };
  }

  // =====================================================================
  // Classification -- the five sheet formulas, driven by data
  // =====================================================================

  var FACETS = ["origin", "koox", "resistance", "caspex", "guide"];

  // The rules as they should be, which is not quite as the sheet has them. Five
  // defects were found by running the sheet's own formulas over its own 350 rows;
  // each fix is marked, and the import reports every row it changes rather than
  // quietly rewriting history.
  var DEFAULT_RULES = {
    origin: [
      { match: "HEK", value: "HEK293T" },
      // Umut's answer for the 19 vials the sheet left as #N/A: the LCC-* series and
      // LNC478 are both LnCap. The sheet itself half-says so -- it carries both
      // "LNC478 #2 98%" and "LnCap478 #2 98%" for the same cell.
      { match: "LCC", value: "LnCap" },
      { match: "LNC", value: "LnCap" },
      { match: "LNCX", value: "LnCap" },
      { match: "LUCX", value: "LuCap35CR" },
      { match: "LuCap", value: "LuCap35CR" },
      { match: "LnCap", value: "LnCap" },
      { match: "Huh", value: "Huh7" },
      { match: "HepG", value: "HepG2" },
      { match: "MDA", value: "MDA-MB-231" },
      { match: "Du", value: "Du145" }
    ],
    koox: [
      // Fix: no letter immediately before the token. The sheet's bare "KO|OX" finds
      // the OX inside "TOX4", so "Du145 TOX4 KO" was filed as an overexpression.
      // A plain \b will not do: it would also reject "ATF3KO10" and "KO20", which
      // really are knockouts. Only a preceding LETTER means the match is a passenger.
      // Fix: this runs BEFORE the CASPEX branch, so a name that is both keeps its
      // KO/OX -- the caspex facet already records CASPEX on its own.
      { extract: "(?<![A-Za-z])(?:KO|OX|3xFLAG)" },
      { match: "CASP", value: "CASPEX" },
      { value: "WT" }
    ],
    resistance: [
      { match: "EnzaR", value: "EnzaR" },
      // Fix: word boundary. A bare "ER" matched inside mChERry and sortER.
      { match: "ER", value: "EnzaR", wordBoundary: true, caseSensitive: true },
      // Fix: notInOrigin. "CR" in LuCap35CR is part of the line's name, not a
      // resistance, and 12 vials were tagged for it.
      { extract: "DtxR|50CR|CR", notInOrigin: true },
      { value: "-" }
    ],
    caspex: [
      { match: "CASP", value: "CASPEX" },
      { value: "-" }
    ],
    guide: [
      // Fix: the sheet's alternation lost the sub-clone digit (g2.2 -> g2) and its
      // "DSg.12" branch could never fire, because "." is a wildcard in a regex.
      { extract: "(DS)?g\\d+(\\.\\d+)?|gNT|g[PC]\\d+", longest: true },
      { value: "-" }
    ]
  };

  function ruleRegex(rule) {
    var src, flags = "";
    if (rule.extract) {
      src = rule.extract;
      if (rule.wordBoundary) src = "\\b(?:" + src + ")\\b";
    } else {
      src = escapeRe(rule.match);
      if (rule.wordBoundary) src = "\\b" + src + "\\b";
    }
    // Substring rules are case-insensitive like Excel's SEARCH; extraction rules are
    // case-sensitive like REGEXEXTRACT, which is what keeps "HepG2" from reading as
    // a guide "g2".
    var insensitive = rule.caseSensitive === true ? false
      : (rule.caseSensitive === false ? true : !rule.extract);
    if (insensitive) flags += "i";
    return new RegExp(src, flags);
  }

  // Split a regex on its top-level | so `longest` can compare alternatives instead of
  // taking whichever the engine happened to try first.
  function topLevelAlternatives(src) {
    var out = [], depth = 0, cur = "", inClass = false;
    for (var i = 0; i < src.length; i++) {
      var ch = src[i];
      if (ch === "\\") { cur += ch + (src[i + 1] || ""); i++; continue; }
      if (inClass) { cur += ch; if (ch === "]") inClass = false; continue; }
      if (ch === "[") { inClass = true; cur += ch; continue; }
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "|" && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  function applyRule(rule, name, ctx) {
    if (rule.match !== undefined && rule.value !== undefined) {
      var re = ruleRegex(rule);
      var m = re.exec(name);
      return m ? { value: rule.value, matched: m[0] } : null;
    }
    if (rule.extract) {
      var best = null;
      var alts = rule.longest ? topLevelAlternatives(rule.extract) : [rule.extract];
      alts.forEach(function (alt) {
        var r = ruleRegex({ extract: alt, wordBoundary: rule.wordBoundary, caseSensitive: rule.caseSensitive });
        var mm = r.exec(name);
        if (!mm) return;
        if (rule.notInOrigin && ctx && ctx.origin && ctx.origin.toLowerCase().indexOf(mm[0].toLowerCase()) !== -1) return;
        if (!best || mm[0].length > best.matched.length ||
            (mm[0].length === best.matched.length && mm.index < best.index)) {
          best = { value: rule.value !== undefined ? rule.value : mm[0], matched: mm[0], index: mm.index };
        }
      });
      return best;
    }
    if (rule.value !== undefined) return { value: rule.value, matched: null, fallback: true };
    return null;
  }

  // classify(name, rules) -> { origin, koox, resistance, caspex, guide, unmatched }
  // Pure in (name, rules). `unmatched` lists the facets no rule covered -- the sheet
  // wrote #N/A there, which reads like a value and is not one.
  function classify(name, rules) {
    var r = rules || DEFAULT_RULES;
    var out = { unmatched: [] };
    var ctx = {};
    var text = String(name || "");
    FACETS.forEach(function (facet) {
      var list = r[facet] || [];
      var hit = null;
      for (var i = 0; i < list.length && !hit; i++) hit = applyRule(list[i], text, ctx);
      if (hit) { out[facet] = hit.value; if (facet === "origin") ctx.origin = hit.value; }
      else { out[facet] = null; out.unmatched.push(facet); }
    });
    return out;
  }

  // A facet set by hand is never recomputed. A rule may fill a blank; it may not
  // overwrite an answer somebody has already given.
  function facetsFor(vial, rules) {
    var derived = classify(vial.name, rules);
    var out = {};
    FACETS.forEach(function (f) {
      out[f] = (vial.facetsSetByHand && vial.facetsSetByHand[f] !== undefined)
        ? vial.facetsSetByHand[f] : derived[f];
    });
    out.unmatched = derived.unmatched.filter(function (f) {
      return !(vial.facetsSetByHand && vial.facetsSetByHand[f] !== undefined);
    });
    return out;
  }

  // Every vial whose derived facet differs from what the sheet said. This is the
  // import review list, and it is also the live preview when a rule is edited.
  function classifyAll(state, rules) {
    var r = rules || state.rules || DEFAULT_RULES;
    var diffs = [], gaps = [];
    (state.vials || []).forEach(function (v) {
      var f = facetsFor(v, r);
      var changed = {};
      FACETS.forEach(function (facet) {
        var sheet = v.facetsFromSheet ? v.facetsFromSheet[facet] : undefined;
        if (sheet !== undefined && sheet !== null && sheet !== f[facet]) {
          changed[facet] = { sheet: sheet, now: f[facet] };
        }
      });
      if (Object.keys(changed).length) diffs.push({ vialId: v.id, name: v.name, changed: changed });
      if (f.unmatched.length) gaps.push({ vialId: v.id, name: v.name, facets: f.unmatched });
    });
    return { diffs: diffs, gaps: gaps };
  }

  // =====================================================================
  // Passage
  //
  // Three forms, and only two of them are numbers on the same axis:
  //   p11, p102  absolute
  //   p+2, p+21  relative -- N passages since the thaw
  //   p?         unknown  -- 65 of the 350 vials
  // A slider that averaged these would be lying, so the kind travels with the number.
  // =====================================================================

  function parsePassage(raw) {
    var s = String(raw === null || raw === undefined ? "" : raw).trim();
    if (!s || /^p?\s*\?+$/i.test(s)) return { raw: s, number: null, kind: "unknown" };
    // Tolerant of the stray separators that creep into a hand-typed column
    // ("p|+7" is a p+7 with a mis-hit key), but never of a missing number.
    var m = /^p?[^0-9+]*([+])?\s*(\d+)/i.exec(s);
    if (!m) return { raw: s, number: null, kind: "unknown" };
    return { raw: s, number: Number(m[2]), kind: m[1] ? "relative" : "absolute" };
  }

  function passageLabel(p) {
    if (!p || p.kind === "unknown") return "p?";
    return "p" + (p.kind === "relative" ? "+" : "") + p.number;
  }

  // =====================================================================
  // Dates
  //
  // The sheet was typed dd-mm-yy throughout. Google Sheets turned into real dates
  // exactly those cells it could also read as mm/dd -- so every converted cell has
  // its day and month swapped, and every cell it left as text is unambiguous
  // (its first component is always 13..31).
  //
  // This function does NOT guess. When both readings are possible it says so and
  // offers the swap; the app queues those for Umut rather than rewriting 135 dates
  // behind his back.
  // =====================================================================

  function twoDigitYear(n) { return n < 70 ? 2000 + n : 1900 + n; }

  function ymd(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;  // 31 Feb
    return y + "-" + pad(m, 2) + "-" + pad(d, 2);
  }

  function parseDate(raw) {
    var s = String(raw === null || raw === undefined ? "" : raw).trim();
    var base = { raw: s, iso: null, asWritten: null, proposed: null, needsReview: true, note: "" };
    if (!s) { base.note = "empty"; return base; }

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      var y0 = Number(s.slice(0, 4)), m0 = Number(s.slice(5, 7)), d0 = Number(s.slice(8, 10));
      var iso0 = ymd(y0, m0, d0);
      if (iso0) return { raw: s, iso: iso0, asWritten: iso0, proposed: null, needsReview: false, note: "iso" };
    }

    var parts = s.split(/[-\/.]/).map(function (x) { return x.trim(); });
    if (parts.length !== 3 || !parts.every(function (x) { return /^\d+$/.test(x); })) {
      base.note = "unparseable";
      return base;
    }
    var a = Number(parts[0]), b = Number(parts[1]), c = Number(parts[2]);
    var year, first, second;
    if (parts[0].length === 4) { year = a; first = b; second = c; }
    else { year = parts[2].length === 4 ? c : twoDigitYear(c); first = a; second = b; }

    var dmy = ymd(year, second, first);   // first component is the day
    var mdy = ymd(year, first, second);   // first component is the month

    if (dmy && !mdy) return { raw: s, iso: dmy, asWritten: dmy, proposed: null, needsReview: false, note: "day-first" };
    if (mdy && !dmy) return { raw: s, iso: mdy, asWritten: mdy, proposed: null, needsReview: false, note: "month-first" };
    if (!dmy && !mdy) { base.note = "impossible"; return base; }
    // Both readings work. The sheet displays m/d/yyyy, so asWritten is that; the
    // proposal is the day-first reading, which is how it was typed.
    return { raw: s, iso: null, asWritten: mdy, proposed: dmy, needsReview: true, note: "ambiguous" };
  }

  // =====================================================================
  // Notes -> flags
  //
  // A handful of notes are really a controlled vocabulary hiding in free text.
  // Promoting them to flags makes them searchable; the raw note is kept regardless.
  // =====================================================================

  var FLAG_RULES = [
    { flag: "myco-negative", test: /myco\s*[-–]/i },
    { flag: "myco-positive", test: /myco\s*\+/i },
    { flag: "chip-negative", test: /chip\s*[-–]/i },
    { flag: "chip-positive", test: /chip\s*\+/i },
    { flag: "to-do", test: /to-?do|thaw/i },
    { flag: "do-not-use", test: /no use|kullanma/i },
    { flag: "move-me", test: /yerini de(g|ğ)i(s|ş)tir/i }
  ];

  function flagsFrom(notes) {
    var s = String(notes || "");
    return FLAG_RULES.filter(function (r) { return r.test.test(s); }).map(function (r) { return r.flag; });
  }

  // =====================================================================
  // Lines
  //
  // "Keep the same line together" needs an identity that survives
  // "DuDtxR CASPEX g1.1" vs "DuDtxR CASPEX g1.1 (eski)". The derived facets do most
  // of the work: two vials sharing origin + KO/OX + resistance + guide are almost
  // always the same line.
  // =====================================================================

  // Bracketed text is NOT thrown away wholesale. "HEK gNT (10)" and "HEK gNT (20)"
  // are two different clones, and stripping every parenthesis merged them into one
  // line -- which would then have put them in the same box under one name. Only
  // brackets whose entire content is a known noise word are dropped.
  var NOISE_BRACKET = /\((?:\s*(?:eski|old|new|yeni|no\s*sort|no\s*use|no\s*select|sorted)\s*)\)/gi;
  var NOISE_WORDS = /\b(?:eski|no\s*sort|no\s*use|no\s*select)\b/gi;

  function lineKey(name, rules) {
    var f = classify(name, rules);
    var base = String(name || "").toLowerCase()
      .replace(NOISE_BRACKET, " ")
      .replace(NOISE_WORDS, " ")
      .replace(/[^a-z0-9+.()]+/g, " ").trim().replace(/\s+/g, " ");
    return [f.origin || "?", f.koox || "?", f.resistance || "-", f.caspex || "-", f.guide || "-", base].join("|");
  }

  // The id is a slug of the normalised base name, not of the whole key: the base has
  // already had "(eski)", "(no sort)" and punctuation removed, so the variants that
  // lineKey groups together produce the same slug anyway -- and a readable id beats a
  // 60-character one in a diff.
  function lineIdFor(name, rules) {
    var key = lineKey(name, rules);
    var base = key.split("|").pop();
    var slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
    return "l-" + (slug || "unnamed");
  }

  function vialsOfLine(state, lineId) {
    return storedVials(state).filter(function (v) { return v.lineId === lineId; });
  }

  function stockCounts(state) {
    var by = {};
    (state.vials || []).forEach(function (v) {
      var k = v.lineId || ("name:" + v.name);
      if (!by[k]) by[k] = { lineId: v.lineId, name: v.name, stored: 0, withdrawn: 0, boxes: {} };
      if (v.status === "withdrawn") by[k].withdrawn++;
      else {
        by[k].stored++;
        if (v.location && v.location.boxId) by[k].boxes[v.location.boxId] = true;
      }
    });
    return Object.keys(by).map(function (k) {
      var e = by[k];
      return { lineId: e.lineId, name: e.name, stored: e.stored, withdrawn: e.withdrawn, boxes: Object.keys(e.boxes).length };
    }).sort(function (x, y) { return y.stored - x.stored || (x.name < y.name ? -1 : 1); });
  }

  // =====================================================================
  // Search
  //
  // The schedule app matches a step against a duration table with two gates: one
  // stem distinctive enough to stand alone, or enough coverage of what makes the
  // row specific (index.html, durationFor). The same shape works here, inverted:
  // there the table row is the short specific thing and the query is long prose;
  // here the QUERY is the short specific thing, so coverage is measured over the
  // query's tokens. Measuring it over the record would mean a vial with a long note
  // could never clear the bar.
  //
  // The other difference from the schedule's tokeniser: digits and short tokens are
  // kept. "p12", "KO" and "g5.1" are the most discriminating words in a freezer, and
  // a >=5-letter filter would throw all of them away.
  // =====================================================================

  // Above this, an absolute passage number is not a passage.
  var IMPLAUSIBLE_PASSAGE = 200;

  var STRONG_TOKEN = 6;
  var COVERAGE = 0.6;
  var FIELD_WEIGHTS = { name: 3, origin: 2, koox: 2, resistance: 2, caspex: 2, guide: 3,
                        passage: 2, flags: 2, notes: 1, location: 1 };

  function normaliseText(s) {
    return String(s === null || s === undefined ? "" : s)
      .normalize ? String(s === null || s === undefined ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
                 : String(s || "").toLowerCase();
  }

  function stemToken(t) {
    return t.length >= 5 ? t.replace(/(ation|ing|ion|es|s)$/, "") : t;
  }

  var SYNONYMS = {
    knockout: "ko", "knock-out": "ko", overexpression: "ox", overexpress: "ox",
    hek: "hek293t", hek293: "hek293t", lncap: "lncap", lucap: "lucap35cr",
    passage: "p", myco: "myco", mycoplasma: "myco"
  };

  function tokenise(text, aliases) {
    var out = [];
    var s = normaliseText(text).replace(/\(.*?\)/g, " ");
    // "passage 12" / "p.12" / "p 12" all mean p12; "clone 2a" means c2a.
    s = s.replace(/\bpassage\s*\+?\s*(\d+)/g, "p$1").replace(/\bp\s*[.\-]?\s*(\+?)(\d+)/g, "p$1$2");
    s = s.replace(/\bclone\s*([0-9a-z]+)/g, "c$1");
    s.split(/[^a-z0-9+.]+/).forEach(function (raw) {
      var t = raw.replace(/^\.+|\.+$/g, "");
      if (!t) return;
      if (aliases && aliases[t]) t = normaliseText(aliases[t]);
      if (SYNONYMS[t]) t = SYNONYMS[t];
      if (t.length < 1) return;
      out.push(t);
    });
    return out;
  }

  function fieldTokens(vial, state, rules) {
    var f = facetsFor(vial, rules);
    var fields = {
      name: vial.name || "",
      origin: f.origin || "", koox: f.koox || "", resistance: f.resistance || "",
      caspex: f.caspex || "", guide: f.guide || "",
      passage: vial.passage || "",
      flags: (vial.flags || []).join(" "),
      notes: vial.notes || "",
      location: state ? locationPath(state, vial.location) : ""
    };
    var bag = {};   // token -> best weight
    Object.keys(fields).forEach(function (key) {
      var w = FIELD_WEIGHTS[key] || 1;
      tokenise(fields[key], state && state.settings && state.settings.aliases).forEach(function (t) {
        if (!bag[t] || bag[t] < w) bag[t] = w;
        var st = stemToken(t);
        if (st !== t && (!bag[st] || bag[st] < w)) bag[st] = w;
      });
    });
    return bag;
  }

  function tokenHits(bag, qt) {
    if (bag[qt] !== undefined) return { weight: bag[qt], length: qt.length };
    var st = stemToken(qt);
    if (bag[st] !== undefined) return { weight: bag[st], length: st.length };
    // Prefix tolerance, but only for tokens long enough to mean something. "du"
    // must not match "dudtxr"; "caspe" may match "caspex".
    if (qt.length >= 4) {
      var keys = Object.keys(bag);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf(qt) === 0) return { weight: bag[keys[i]], length: qt.length };
      }
    }
    return null;
  }

  function matchScore(vial, queryTokens, state, rules) {
    if (!queryTokens.length) return { score: 0, matched: [], missed: [], accept: true };
    var bag = fieldTokens(vial, state, rules);
    var score = 0, matched = [], missed = [];
    queryTokens.forEach(function (qt) {
      var hit = tokenHits(bag, qt);
      if (!hit) { missed.push(qt); return; }
      matched.push(qt);
      score += hit.weight * hit.length;
    });
    var coverage = matched.length / queryTokens.length;
    // Coverage is always required, no matter how strongly any single word matched:
    // a synonym-expanded token (e.g. "hek" -> "hek293t") used to be enough on its own
    // to accept a vial that shared no other word with the query ("hek caspex" hitting
    // every HEK293T-origin vial regardless of "caspex"). See tools/cellstocks-selftest.mjs.
    return { score: score, matched: matched, missed: missed, coverage: coverage,
             accept: matched.length > 0 && coverage >= COVERAGE };
  }

  // The bounds the sliders need. Passage is reported per kind, because the two kinds
  // are different axes; dates report how many vials are still unconfirmed, so the UI
  // can say what a toggle is holding back instead of losing them silently.
  function searchExtents(state) {
    var frozen = { min: null, max: null, dated: 0, unconfirmed: 0 };
    var passage = { absolute: { min: null, max: null, count: 0 },
                    relative: { min: null, max: null, count: 0 }, unknown: 0 };
    storedVials(state).forEach(function (v) {
      if (v.frozenOn) {
        frozen.dated++;
        if (!frozen.min || v.frozenOn < frozen.min) frozen.min = v.frozenOn;
        if (!frozen.max || v.frozenOn > frozen.max) frozen.max = v.frozenOn;
      } else frozen.unconfirmed++;

      var kind = v.passageKind || "unknown";
      if (kind === "unknown" || v.passageNumber === null || v.passageNumber === undefined) passage.unknown++;
      else {
        var slot = passage[kind];
        if (!slot) { passage.unknown++; return; }
        slot.count++;
        if (slot.min === null || v.passageNumber < slot.min) slot.min = v.passageNumber;
        if (slot.max === null || v.passageNumber > slot.max) slot.max = v.passageNumber;
      }
    });
    return { frozen: frozen, passage: passage };
  }

  function search(state, query) {
    var q = query || {};
    var rules = state.rules || DEFAULT_RULES;
    var tokens = tokenise(q.query || "", state.settings && state.settings.aliases);
    var pool = (state.vials || []).filter(function (v) {
      return q.includeWithdrawn ? true : v.status !== "withdrawn";
    });

    var results = [];
    pool.forEach(function (v) {
      // Filters run BEFORE scoring, so dragging a slider only ever removes rows.
      if (q.unitId && (!v.location || v.location.unitId !== q.unitId)) return;
      if (q.boxId && (!v.location || v.location.boxId !== q.boxId)) return;

      if (q.frozenFrom || q.frozenTo) {
        if (!v.frozenOn) { if (!q.includeUndated) return; }
        else {
          if (q.frozenFrom && v.frozenOn < q.frozenFrom) return;
          if (q.frozenTo && v.frozenOn > q.frozenTo) return;
        }
      }

      var kind = v.passageKind || "unknown";
      if (q.passageKind && q.passageKind !== "any") {
        if (kind === "unknown") { if (!q.includeUnknownPassage) return; }
        else if (kind !== q.passageKind) return;
        else {
          if (q.passageMin !== undefined && q.passageMin !== null && v.passageNumber < q.passageMin) return;
          if (q.passageMax !== undefined && q.passageMax !== null && v.passageNumber > q.passageMax) return;
        }
      }

      if (q.flag && (v.flags || []).indexOf(q.flag) === -1) return;

      var m = matchScore(v, tokens, state, rules);
      if (!m.accept) return;
      results.push({
        vial: v, score: m.score, matched: m.matched, missed: m.missed,
        path: locationPath(state, v.location)
      });
    });

    results.sort(function (a, b) {
      // Status outranks score. A vial that has been taken out cannot be fetched, so
      // however well it matches it belongs below everything that is still in a box.
      var aw = a.vial.status === "withdrawn" ? 1 : 0, bw = b.vial.status === "withdrawn" ? 1 : 0;
      if (aw !== bw) return aw - bw;
      if (b.score !== a.score) return b.score - a.score;
      var af = a.vial.frozenOn || "", bf = b.vial.frozenOn || "";
      if (af !== bf) return af < bf ? 1 : -1;               // most recent first
      return a.vial.id < b.vial.id ? -1 : 1;                // deterministic tail
    });
    return results;
  }

  // One card per (line, box): "ONGOING, 4 vials at C4-C7" beats four identical rows.
  function searchGroups(results) {
    var groups = [], byKey = {};
    results.forEach(function (r) {
      var key = (r.vial.lineId || r.vial.name) + "|" + ((r.vial.location && r.vial.location.boxId) || "-");
      if (!byKey[key]) {
        byKey[key] = { key: key, name: r.vial.name, lineId: r.vial.lineId, path: r.path,
                       boxId: r.vial.location && r.vial.location.boxId,
                       score: r.score, matched: r.matched, missed: r.missed, results: [] };
        groups.push(byKey[key]);
      }
      var g = byKey[key];
      g.results.push(r);
      if (r.score > g.score) g.score = r.score;
    });
    groups.forEach(function (g) {
      g.count = g.results.length;
      g.positions = g.results.map(function (r) { return r.vial.location && r.vial.location.position; })
                             .filter(Boolean).sort();
    });
    return groups.sort(function (a, b) { return b.score - a.score || b.count - a.count || (a.key < b.key ? -1 : 1); });
  }

  // =====================================================================
  // Placement
  //
  // A ROW is the unit, and a row holds one kind of cell.
  //
  // This is not a tidiness preference, it is how the freezer is actually laid out:
  // in the sheet this inventory came from, every row of every box is a single cell
  // origin -- nine HEK293T, nine Du145, nine Huh7 -- and the only rows that mix are
  // the ones holding vials no origin rule covers yet. So HEK never goes next to Huh7
  // just because there is a gap. If the origin's own rows are full, the vials start a
  // fresh row; if the box has no free row, they go to another box.
  //
  // The grouping key is the ORIGIN facet, not the line: KO, OX, CASPEX and guide all
  // share a row, because they are all the same cell.
  //
  // Never a partial silent placement -- if it does not fit, say so.
  // =====================================================================

  var NO_ORIGIN = "(no origin rule yet)";

  function originOfVial(vial, rules) {
    return facetsFor(vial, rules).origin || NO_ORIGIN;
  }

  function originForRequest(state, request, rules) {
    if (request.origin) return request.origin;
    if (request.name) return classify(request.name, rules).origin || NO_ORIGIN;
    return NO_ORIGIN;
  }

  function boxesFor(state, unitId) {
    var out = [];
    eachBox(state, function (box, rack, unit) {
      if (box.archived) return;
      if (unitId && unit.id !== unitId) return;
      out.push({ box: box, rack: rack, unit: unit });
    });
    return out;
  }

  // Every row of a box, with what lives in it. `origins` is the set of distinct cell
  // origins the row holds -- empty for a free row, one entry for a row doing its job,
  // more than one for a row that needs sorting out.
  function rowsOf(state, boxId, rules) {
    var occ = occupancy(state, boxId);
    if (!occ) return [];
    var cols = occ.box.cols, out = [];
    for (var r = 0; r < occ.box.rows; r++) {
      var slots = occ.slots.slice(r * cols, (r + 1) * cols);
      var counts = {};
      slots.forEach(function (s) {
        if (!s.vial) return;
        var o = originOfVial(s.vial, rules || state.rules || DEFAULT_RULES);
        counts[o] = (counts[o] || 0) + 1;
      });
      out.push({
        index: r, label: rowLabel(r),
        positions: slots.map(function (s) { return s.position; }),
        free: slots.filter(function (s) { return !s.vial; }).map(function (s) { return s.position; }),
        used: slots.filter(function (s) { return !!s.vial; }).length,
        counts: counts, origins: Object.keys(counts)
      });
    }
    return out;
  }

  // Rows that may take this origin: an empty one, or one already holding it and
  // nothing else.
  function rowTakes(row, origin) {
    if (!row.free.length) return false;
    if (!row.origins.length) return true;
    return row.origins.length === 1 && row.origins[0] === origin;
  }

  function segmentFor(state, entry, positions) {
    // Positions are grouped by the row they sit in, because that is the unit the
    // freezer is organised by and it is how the plan should read back: "C4-C8 and
    // D1-D3", not one invented range spanning both.
    var byRow = {};
    positions.forEach(function (p) {
      var parsed = parsePosition(entry.box, p);
      if (!parsed) return;
      if (!byRow[parsed.row]) byRow[parsed.row] = [];
      byRow[parsed.row].push({ p: p, i: parsed.index });
    });
    var runs = Object.keys(byRow).map(Number).sort(function (a, b) { return a - b; }).map(function (r) {
      var list = byRow[r].sort(function (a, b) { return a.i - b.i; });
      // A row with gaps in it -- a withdrawal took a slot out of the middle -- can
      // still take vials, but calling that "C2-C8" would describe a block that is
      // not there, and someone would open the box looking for one.
      var contiguous = list.every(function (x, i) { return i === 0 || x.i === list[i - 1].i + 1; });
      return { row: r, label: rowLabel(r), positions: list.map(function (x) { return x.p; }), contiguous: contiguous };
    });
    return {
      unitId: entry.unit.id, rackId: entry.rack.id, boxId: entry.box.id,
      boxName: entry.box.name, positions: positions, runs: runs,
      contiguous: runs.length === 1 && runs[0].contiguous,
      path: entry.unit.name + " → " + entry.rack.name + " → " + entry.box.name
    };
  }

  function describeRun(run) {
    var p = run.positions;
    if (p.length === 1) return p[0];
    if (run.contiguous) return p[0] + "–" + p[p.length - 1];
    return p.join(" ");
  }

  function summarise(segments) {
    return segments.map(function (s) {
      return s.boxName + ", " + s.runs.map(describeRun).join(" and ");
    }).join(" + ");
  }

  // Grouping strategies a user can pick in Settings (see mergeDefaults). "category-row"
  // is the only one suggestPlacement() itself has ever implemented -- the one-cell-
  // per-row rule this file has been about from the start, and what the real freezer's
  // real data is checked against. "random" is the one other strategy actually wired in
  // below: no grouping constraint at all, first free slot found. "box" (confine a whole
  // category to one box) and "keyword" (group by a hand-assigned tag rather than the
  // derived origin) are recorded as valid settings values -- mergeDefaults will not
  // reject them -- but are not implemented yet; a request under either currently falls
  // back to "random" rather than silently pretending to group by something it doesn't.
  var GROUPING_STRATEGIES = ["category-row", "box", "random", "keyword"];
  var IMPLEMENTED_GROUPING_STRATEGIES = ["category-row", "random"];

  function groupingStrategyFor(state) {
    var s = state && state.settings && state.settings.groupingStrategy;
    return GROUPING_STRATEGIES.indexOf(s) !== -1 ? s : "category-row";
  }

  function suggestPlacement(state, request) {
    var req = request || {};
    var strategy = groupingStrategyFor(state);
    if (IMPLEMENTED_GROUPING_STRATEGIES.indexOf(strategy) === -1) strategy = "random";
    if (strategy === "random") return suggestPlacementRandom(state, req);
    return suggestPlacementCategoryRow(state, req);
  }

  // No grouping constraint: the first free slot(s) found, box by box, row by row. Still
  // prefers one box over splitting across several when one can hold the whole request --
  // that preference is about not scattering a freeze-down, not about grouping cells.
  function suggestPlacementRandom(state, req) {
    var count = Math.max(1, Number(req.count) || 1);
    var unitId = req.unitId || (state.settings && state.settings.defaultUnitId) || null;
    var boxes = boxesFor(state, unitId).filter(function (entry) {
      return req.boxId ? entry.box.id === req.boxId : true;
    });
    if (!boxes.length) {
      return { ok: false, strategy: "random", reason: req.boxId
        ? "That box is not in this unit."
        : "There are no boxes to put anything in yet. Add one in Setup first." };
    }
    var perBox = boxes.map(function (entry, boxOrder) {
      var occ = occupancy(state, entry.box.id);
      var free = occ ? occ.slots.filter(function (s) { return !s.vial; }).map(function (s) { return s.position; }) : [];
      return { entry: entry, boxOrder: boxOrder, free: free };
    });
    var totalFree = perBox.reduce(function (n, b) { return n + b.free.length; }, 0);
    if (totalFree < count) {
      return { ok: false, strategy: "random",
        reason: "No room for " + count + " vial" + (count === 1 ? "" : "s") + ": only " + totalFree +
                " free slot" + (totalFree === 1 ? "" : "s") + " in total." };
    }
    var whole = perBox.filter(function (b) { return b.free.length >= count; })
      .sort(function (x, y) { return x.boxOrder - y.boxOrder; });
    var pool = whole.length ? [whole[0]] : perBox.slice().sort(function (x, y) { return x.boxOrder - y.boxOrder; });

    var need = count, byBox = {}, order = [];
    for (var i = 0; i < pool.length && need > 0; i++) {
      var b = pool[i];
      var take = b.free.slice(0, need);
      if (!take.length) continue;
      need -= take.length;
      var id = b.entry.box.id;
      byBox[id] = { entry: b.entry, positions: take };
      order.push(id);
    }
    var segments = order.map(function (id) { return segmentFor(state, byBox[id].entry, byBox[id].positions); });
    var allowSplit = !(state.settings && state.settings.placement && state.settings.placement.allowSplit === false);
    if (segments.length > 1 && !allowSplit && !req.boxId) {
      return { ok: false, strategy: "random",
        reason: "This would have to be split across " + segments.length + " boxes, and splitting is switched off." };
    }
    return {
      ok: true, strategy: "random", segments: segments, summary: summarise(segments),
      reason: "No grouping rule is applied for this freezer, so this is simply the first free " +
              (segments.length > 1 ? "space -- split across " + segments.length + " boxes." : "space found.")
    };
  }

  function suggestPlacementCategoryRow(state, req) {
    var count = Math.max(1, Number(req.count) || 1);
    var unitId = req.unitId || (state.settings && state.settings.defaultUnitId) || null;
    var rules = state.rules || DEFAULT_RULES;
    var origin = originForRequest(state, req, rules);

    var boxes = boxesFor(state, unitId).filter(function (entry) {
      return req.boxId ? entry.box.id === req.boxId : true;
    });
    if (!boxes.length) {
      return { ok: false, origin: origin, reason: req.boxId
        ? "That box is not in this unit."
        : "There are no boxes to put anything in yet. Add one in Setup first." };
    }

    // Every row that could take this origin, grouped by box.
    var perBox = boxes.map(function (entry, boxOrder) {
      var rows = rowsOf(state, entry.box.id, rules).filter(function (row) { return rowTakes(row, origin); });
      var hasOrigin = rowsOf(state, entry.box.id, rules).some(function (r) { return r.counts[origin] > 0; });
      return {
        entry: entry, boxOrder: boxOrder, hasOrigin: hasOrigin, rows: rows,
        free: rows.reduce(function (n, r) { return n + r.free.length; }, 0)
      };
    });

    var freeForOrigin = perBox.reduce(function (n, b) { return n + b.free; }, 0);
    if (freeForOrigin < count) {
      var blocked = 0;
      boxes.forEach(function (entry) {
        rowsOf(state, entry.box.id, rules).forEach(function (row) {
          if (!rowTakes(row, origin)) blocked += row.free.length;
        });
      });
      return { ok: false, origin: origin,
               reason: "No room for " + count + " vial" + (count === 1 ? "" : "s") + " of " + origin +
                       ": " + freeForOrigin + " free slot" + (freeForOrigin === 1 ? "" : "s") +
                       " in rows that could take it" +
                       (blocked ? ", and the other " + blocked + " are in rows holding a different cell" : "") + ".",
               freeForOrigin: freeForOrigin, blockedByOtherCells: blocked };
    }

    // Prefer to stay inside one box. Splitting a freeze-down across boxes is worse
    // than opening a fresh row, so a box that can take the whole lot wins outright --
    // one that already holds this cell first.
    var whole = perBox.filter(function (b) { return b.free >= count; })
      .sort(function (x, y) {
        if (x.hasOrigin !== y.hasOrigin) return x.hasOrigin ? -1 : 1;
        return x.boxOrder - y.boxOrder;
      });
    var pool = whole.length ? [whole[0]] : perBox;

    // Rank the rows of the chosen pool. Ascending, lexicographic:
    //   1. a row already holding this cell beats a fresh one -- that is the rule;
    //   2. among fresh rows, one in a box that already has this cell;
    //   3. among this cell's own rows, the fullest first, so gaps close before
    //      new rows open;
    //   4. then box order, then row order, so the same state gives the same plan.
    var options = [];
    pool.forEach(function (b) {
      b.rows.forEach(function (row) {
        var mine = row.counts[origin] > 0;
        options.push({ entry: b.entry, row: row, mine: mine, boxOrder: b.boxOrder,
                       key: [mine ? 0 : 1, b.hasOrigin ? 0 : 1, mine ? row.free.length : 0, b.boxOrder, row.index] });
      });
    });
    options.sort(function (x, y) {
      for (var i = 0; i < x.key.length; i++) if (x.key[i] !== y.key[i]) return x.key[i] - y.key[i];
      return 0;
    });

    // One freeze-down belongs in one row whenever a row can hold it. Only a request
    // wider than a row -- or a freezer with nothing but gaps left -- spreads out.
    var single = options.filter(function (o) { return o.row.free.length >= count; });
    var picked = single.length ? [single[0]] : options;

    var need = count, byBox = {}, order = [], usedRows = [], openedRow = false;
    picked.forEach(function (o) {
      if (need <= 0) return;
      var take = o.row.free.slice(0, need);
      need -= take.length;
      if (!o.mine) openedRow = true;
      usedRows.push({ boxId: o.entry.box.id, box: o.entry.box.name, label: o.row.label,
                      mine: o.mine, n: take.length });
      var id = o.entry.box.id;
      if (!byBox[id]) { byBox[id] = { entry: o.entry, positions: [] }; order.push(id); }
      byBox[id].positions = byBox[id].positions.concat(take);
    });

    var segments = order.map(function (id) { return segmentFor(state, byBox[id].entry, byBox[id].positions); });

    var allowSplit = !(state.settings && state.settings.placement &&
                       state.settings.placement.allowSplit === false);
    var openedBox = segments.length > 1;
    if (openedBox && !allowSplit && !req.boxId) {
      return { ok: false, origin: origin,
               reason: "This would have to be split across " + segments.length +
                       " boxes, and splitting is switched off." };
    }

    var strategy = req.boxId ? "chosen"
      : (!openedRow ? "same-row" : (openedBox ? "split" : "new-row"));

    // Name each row with its own box: "rows D and E" reads as one box, and two of
    // them were not.
    function nameRows(list) {
      var oneBox = list.every(function (r) { return r.boxId === list[0].boxId; });
      if (oneBox) {
        return (list.length === 1 ? "row " : "rows ") +
               list.map(function (r) { return r.label; }).join(" and ") + " of " + list[0].box;
      }
      return list.map(function (r) { return r.box + " " + r.label; }).join(" and ");
    }
    function upperFirst(t) { return t.charAt(0).toUpperCase() + t.slice(1); }

    var mineRows = usedRows.filter(function (r) { return r.mine; });
    var freshRows = usedRows.filter(function (r) { return !r.mine; });
    var bits = [];
    if (mineRows.length) {
      bits.push(upperFirst(nameRows(mineRows)) + " already " + (mineRows.length === 1 ? "holds" : "hold") +
                " " + origin + ".");
    }
    if (freshRows.length) {
      bits.push((mineRows.length ? "The rest start on " : "Starting on ") +
                (freshRows.length === 1 ? "a fresh " : "fresh ") + nameRows(freshRows) +
                " — a row never holds two different cells.");
    }
    if (openedBox) bits.push("It does not fit in one box, so it is split across " + segments.length + ".");

    return { ok: true, origin: origin, strategy: strategy, segments: segments,
             summary: summarise(segments), rows: usedRows, reason: bits.join(" ") };
  }

  // ids and timestamps are arguments, never generated here -- that is what lets the
  // selftest assert the same input gives byte-identical output.
  function applyPlacement(state, plan, template, ctx) {
    if (!plan || !plan.ok) throw new Error("applyPlacement needs a successful plan.");
    var c = ctx || {};
    var ids = (c.ids || []).slice();
    var rules = state.rules || DEFAULT_RULES;
    var next = clone(state);
    var made = [];
    var n = 0;

    plan.segments.forEach(function (seg) {
      seg.positions.forEach(function (position) {
        var id = ids[n] !== undefined ? ids[n] : ("v-" + seg.boxId + "-" + position);
        n++;
        var passage = parsePassage(template.passage);
        var date = template.frozenOn ? parseDate(template.frozenOn) : parseDate("");
        var vial = {
          id: id,
          name: template.name || "",
          lineId: template.lineId || lineIdFor(template.name, rules),
          passage: passage.raw, passageNumber: passage.number, passageKind: passage.kind,
          frozenRaw: template.frozenOn || "",
          frozenOn: date.iso,
          notes: template.notes || "",
          flags: flagsFrom(template.notes || ""),
          location: { unitId: seg.unitId, rackId: seg.rackId, boxId: seg.boxId, position: position },
          status: "stored",
          addedAt: c.now || null,
          addedBy: c.by || null
        };
        if (template.facetsSetByHand) vial.facetsSetByHand = clone(template.facetsSetByHand);
        next.vials.push(vial);
        made.push(vial);
      });
    });

    next.lines = ensureLine(next, template.name, made[0] && made[0].lineId, rules);
    return { state: next, vials: made };
  }

  function ensureLine(state, name, lineId, rules) {
    var lines = (state.lines || []).slice();
    if (!lineId) return lines;
    for (var i = 0; i < lines.length; i++) if (lines[i].id === lineId) return lines;
    var f = classify(name, rules || state.rules || DEFAULT_RULES);
    lines.push({ id: lineId, name: name, aliases: [], facets: {
      origin: f.origin, koox: f.koox, resistance: f.resistance, caspex: f.caspex, guide: f.guide
    }, notes: "" });
    return lines;
  }

  // =====================================================================
  // Withdrawal
  //
  // Taking a vial out is not a delete. The record stays, marked withdrawn with no
  // location, and the log keeps a snapshot of where it was so it still reads
  // correctly after a box is renamed.
  // =====================================================================

  function withdraw(state, vialIds, options) {
    var o = options || {};
    var ids = Array.isArray(vialIds) ? vialIds : [vialIds];
    var next = clone(state);
    var byId = indexById(next.vials);
    var freed = [], warnings = [];
    var logIds = (o.ids || []).slice();

    ids.forEach(function (id, i) {
      var v = byId[id];
      if (!v) { warnings.push("No vial with id " + id + "."); return; }
      if (v.status === "withdrawn") { warnings.push(v.name + " was already taken out."); return; }
      var from = v.location ? clone(v.location) : null;
      v.status = "withdrawn";
      v.location = null;
      next.withdrawals.push({
        id: logIds[i] !== undefined ? logIds[i] : ("w-" + id),
        vialId: id, name: v.name, from: from,
        date: o.date || null, by: o.by || null,
        purpose: o.purpose || "thaw", notes: o.notes || ""
      });
      freed.push({ vialId: id, from: from, path: from ? locationPath(state, from) : "" });
    });

    return { state: next, freed: freed, warnings: warnings };
  }

  // Restores a vial to the slot it came from -- but only if that slot is still free.
  // A mis-tap must never overwrite somebody else's vial.
  function undoWithdrawal(state, withdrawalId) {
    var next = clone(state);
    var idx = -1;
    for (var i = 0; i < next.withdrawals.length; i++) {
      if (next.withdrawals[i].id === withdrawalId) { idx = i; break; }
    }
    if (idx === -1) return { ok: false, reason: "That withdrawal is not in the log.", state: state };
    var w = next.withdrawals[idx];
    var v = indexById(next.vials)[w.vialId];
    if (!v) return { ok: false, reason: "The vial that log entry refers to is gone.", state: state };
    if (!w.from || !w.from.boxId) return { ok: false, reason: "That entry has no recorded slot to go back to.", state: state };

    var occ = occupancy(next, w.from.boxId);
    if (!occ) return { ok: false, reason: "That box no longer exists.", state: state };
    var p = parsePosition(occ.box, w.from.position);
    if (!p) return { ok: false, reason: w.from.position + " is not a position in " + occ.box.name + " any more.", state: state };
    if (occ.slots[p.index].vial) {
      return { ok: false, state: state,
               reason: occ.box.name + " " + p.label + " now holds " + occ.slots[p.index].vial.name +
                       ". Put this one somewhere else instead." };
    }

    v.status = "stored";
    v.location = clone(w.from);
    next.withdrawals.splice(idx, 1);
    return { ok: true, state: next, vial: v };
  }

  // =====================================================================
  // Validation
  //
  // Two stored vials in one slot is an ERROR. The whole app exists to stop that, so
  // it blocks the save rather than showing a badge.
  // =====================================================================

  // Rows holding more than one kind of cell. Reported rather than repaired: which
  // vial is the odd one out, and where it should go instead, is not this code's call.
  function mixedRows(state) {
    var rules = state.rules || DEFAULT_RULES;
    var out = [];
    eachBox(state, function (box) {
      rowsOf(state, box.id, rules).forEach(function (row) {
        if (row.origins.length > 1) {
          out.push({ boxId: box.id, box: box.name, label: row.label, index: row.index,
                     origins: row.origins.slice(), counts: row.counts });
        }
      });
    });
    return out;
  }

  function validate(state) {
    var problems = [];
    function err(code, message, ref) { problems.push({ level: "error", code: code, message: message, ref: ref || null }); }
    function warn(code, message, ref) { problems.push({ level: "warning", code: code, message: message, ref: ref || null }); }

    var boxIds = {}, unitIds = {}, rackIds = {};
    eachBox(state, function (box, rack, unit) {
      if (boxIds[box.id]) err("duplicate-box", "Two boxes share the id " + box.id + ".", box.id);
      boxIds[box.id] = { box: box, rack: rack, unit: unit };
      unitIds[unit.id] = true; rackIds[rack.id] = true;
      if (capacity(box) <= 0) err("bad-grid", box.name + " has no rows or columns set.", box.id);
    });

    var vialIds = {};
    var occupied = {};
    (state.vials || []).forEach(function (v) {
      if (vialIds[v.id]) err("duplicate-vial", "Two vials share the id " + v.id + ".", v.id);
      vialIds[v.id] = true;

      if (v.status === "withdrawn") {
        if (v.location) err("withdrawn-with-location", v.name + " is marked taken out but still holds a slot.", v.id);
        return;
      }
      if (!v.location || !v.location.boxId) { err("no-location", v.name + " has no location.", v.id); return; }

      var entry = boxIds[v.location.boxId];
      if (!entry) { err("unknown-box", v.name + " points at a box that does not exist (" + v.location.boxId + ").", v.id); return; }
      if (v.location.unitId && v.location.unitId !== entry.unit.id) {
        err("unit-mismatch", v.name + " names a unit its box does not belong to.", v.id);
      }

      var p = parsePosition(entry.box, v.location.position);
      if (!p) {
        err("bad-position", v.name + ": " + v.location.position + " is not a position in " +
            entry.box.name + " (" + entry.box.rows + "×" + entry.box.cols + ").", v.id);
        return;
      }
      var key = v.location.boxId + "!" + p.index;
      if (occupied[key]) {
        err("slot-collision", entry.box.name + " " + p.label + " holds two vials: " +
            occupied[key] + " and " + v.name + ".", v.id);
      } else occupied[key] = v.name;
    });

    (state.withdrawals || []).forEach(function (w) {
      if (!vialIds[w.vialId]) warn("orphan-withdrawal", "A log entry refers to a vial that is gone (" + w.vialId + ").", w.id);
    });

    // A row is supposed to hold one kind of cell. The imported sheet has a handful
    // that do not -- mostly rows of vials no origin rule covers yet -- so this is a
    // warning to work through, not an error that would block every save.
    mixedRows(state).forEach(function (m) {
      warn("mixed-row", m.box + " row " + m.label + " holds " + m.origins.join(" and ") +
           ". A row is meant to hold one kind of cell.", m.boxId);
    });

    // A passage of 45769 is an Excel date serial that landed in the wrong column, and
    // one of them is enough to stretch the passage slider until it is useless. Flag
    // it rather than clamping it, because the fix belongs in the data.
    (state.vials || []).forEach(function (v) {
      if (v.passageKind === "absolute" && v.passageNumber > IMPLAUSIBLE_PASSAGE) {
        warn("implausible-passage", v.name + " has passage " + v.passage +
             ". That is almost certainly a mistyped or pasted value.", v.id);
      }
    });

    return problems;
  }

  function errorsOnly(problems) {
    return problems.filter(function (p) { return p.level === "error"; });
  }

  // Refuses a geometry change that would strand a vial, and says which vials are in
  // the way rather than just "no".
  function canResizeBox(state, boxId, rows, cols) {
    var occ = occupancy(state, boxId);
    if (!occ) return { ok: false, reason: "No such box." };
    if (!(rows > 0 && cols > 0)) return { ok: false, reason: "Rows and columns both have to be at least 1." };
    var probe = { rows: rows, cols: cols, scheme: occ.box.scheme };
    var blocked = [];
    occ.slots.forEach(function (s) {
      if (!s.vial) return;
      if (!parsePosition(probe, s.position)) blocked.push({ position: s.position, name: s.vial.name, vialId: s.vial.id });
    });
    if (blocked.length) {
      return { ok: false, blocked: blocked,
               reason: rows + "×" + cols + " would leave " + blocked.length + " vial" +
                       (blocked.length === 1 ? "" : "s") + " outside the box: " +
                       blocked.slice(0, 4).map(function (b) { return b.position + " " + b.name; }).join(", ") +
                       (blocked.length > 4 ? ", …" : "") + "." };
    }
    return { ok: true };
  }

  // =====================================================================
  // Import from a parsed sheet
  //
  // Takes the rows XlsxLite.readWorkbook produced plus a column map, and returns a
  // state plus a report. Writes nothing and decides nothing that needs a human:
  // ambiguous dates and changed facets come back as queues.
  // =====================================================================

  var ROLES = ["box", "position", "name", "passage", "date", "notes",
               "origin", "koox", "resistance", "caspex", "guide", "ignore"];

  // Guess what each column is, from its header and its content. The mapping screen
  // shows the guess and lets it be overridden -- it is a starting point, not a claim.
  function guessColumns(rows, headerRowIndex, merges) {
    var header = rows[headerRowIndex || 0] || [];
    var guesses = [];
    var byHeader = [
      [/cell\s*name|name|hucre|hücre/i, "name"],
      [/passage|pasaj/i, "passage"],
      [/date|tarih/i, "date"],
      [/cell\s*origin|origin|parent/i, "origin"],
      [/ko\s*\/?\s*ox|edit/i, "koox"],
      [/resistan|direnc|direnç/i, "resistance"],
      [/caspex/i, "caspex"],
      [/guide|grna|sgrna/i, "guide"],
      [/note|not/i, "notes"],
      [/position|pos|slot|yer/i, "position"],
      [/box|kutu|rack/i, "box"]
    ];
    var width = rows.reduce(function (m, r) { return Math.max(m, (r || []).length); }, 0);
    var mergedColumns = {};
    (merges || []).forEach(function (m) {
      if (m.startCol === m.endCol && m.endRow - m.startRow >= 2) mergedColumns[m.startCol] = true;
    });
    for (var c = 0; c < width; c++) {
      var head = header[c] && header[c].text ? String(header[c].text).trim() : "";
      var role = "ignore";
      for (var i = 0; i < byHeader.length; i++) {
        if (head && byHeader[i][0].test(head)) { role = byHeader[i][1]; break; }
      }
      // A column carrying tall vertical merges is a block label -- one merged cell
      // per box, which is how a freezer sheet is usually laid out. This is the only
      // place the box column announces itself: its header is blank and 80 of its 81
      // cells are empty, so nothing about its CONTENT would ever give it away.
      if (role === "ignore" && mergedColumns[c]) role = "box";

      if (role === "ignore" && !head) {
        // Unheaded columns: the position column gives itself away.
        var looksPosition = 0, seen = 0;
        for (var r2 = (headerRowIndex || 0) + 1; r2 < Math.min(rows.length, (headerRowIndex || 0) + 40); r2++) {
          var cell = (rows[r2] || [])[c];
          var t = cell && cell.text ? String(cell.text).trim() : "";
          if (!t) continue;
          seen++;
          if (/^[A-Za-z]+\s*\d+$/.test(t)) looksPosition++;
        }
        if (seen && looksPosition / seen > 0.8) role = "position";
      }
      guesses.push({ index: c, letter: root.XlsxLite ? root.XlsxLite.colName(c) : String(c + 1), header: head, role: role });
    }
    return guesses;
  }

  // Merged labels in the box column mark the blocks. Where a sheet uses one merged
  // cell per box (as Umut's does), the geometry is in the data and must not be
  // assumed: derive rows and cols from the positions actually present.
  function blocksFrom(rows, merges, boxColumn, firstRow) {
    var blocks = [];
    (merges || []).forEach(function (m) {
      if (m.startCol !== boxColumn || m.endCol !== boxColumn) return;
      var label = ((rows[m.startRow - 1] || [])[boxColumn] || {}).text || "";
      blocks.push({ label: String(label).trim(), startRow: m.startRow, endRow: m.endRow });
    });
    if (blocks.length) return blocks.sort(function (a, b) { return a.startRow - b.startRow; });
    // No merges: one label per row, blocks change when the label changes.
    var cur = null;
    for (var r = firstRow; r <= rows.length; r++) {
      var t = String((((rows[r - 1] || [])[boxColumn]) || {}).text || "").trim();
      if (t && (!cur || cur.label !== t)) { cur = { label: t, startRow: r, endRow: r }; blocks.push(cur); }
      else if (cur) cur.endRow = r;
    }
    return blocks;
  }

  function gridFromPositions(positions) {
    var maxRow = 0, maxCol = 0, ok = true;
    positions.forEach(function (p) {
      var m = /^([A-Za-z]+)\s*(\d+)$/.exec(String(p).trim());
      if (!m) { ok = false; return; }
      maxRow = Math.max(maxRow, rowIndexFromLabel(m[1].toUpperCase()) + 1);
      maxCol = Math.max(maxCol, Number(m[2]));
    });
    if (!ok || !maxRow || !maxCol) return null;
    return { rows: maxRow, cols: maxCol, scheme: "grid" };
  }

  function importSheet(sheet, options) {
    var o = options || {};
    var rules = o.rules || DEFAULT_RULES;
    var headerRow = o.headerRow || 1;
    var map = o.columns || {};             // role -> column index
    var rows = sheet.rows || [];
    var report = { rows: 0, imported: 0, skipped: [], dateQueue: 0, uncalculated: 0,
                   facetDiffs: 0, gaps: [], boxes: [], collisions: [] };

    var boxCol = map.box !== undefined ? map.box : null;
    var blocks = boxCol === null ? [{ label: o.boxName || "Box 1", startRow: headerRow + 1, endRow: rows.length }]
                                 : blocksFrom(rows, sheet.merges, boxCol, headerRow + 1);

    var unitId = o.unitId || "u-f80";
    var rackId = o.rackId || "r-1";
    var boxes = [], vials = [];
    var seen = {};

    blocks.forEach(function (block, bi) {
      var label = block.label || (o.unnamedBoxName || ("Box " + (bi + 1)));
      var boxId = "b-" + String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!boxId || boxId === "b-") boxId = "b-" + (bi + 1);
      var base = boxId, n = 2;
      while (seen[boxId]) { boxId = base + "-" + n; n++; }
      seen[boxId] = true;

      var positions = [];
      for (var r = block.startRow; r <= block.endRow; r++) {
        var cell = (rows[r - 1] || [])[map.position];
        if (cell && cell.text) positions.push(cell.text);
      }
      var grid = gridFromPositions(positions) || { rows: o.defaultRows || 9, cols: o.defaultCols || 9, scheme: "grid" };
      var box = { id: boxId, name: label, rows: grid.rows, cols: grid.cols, scheme: grid.scheme, note: "", archived: false };
      boxes.push(box);
      report.boxes.push({ id: boxId, name: label, rows: grid.rows, cols: grid.cols, slots: block.endRow - block.startRow + 1 });

      var takenHere = {};
      for (var rr = block.startRow; rr <= block.endRow; rr++) {
        var row = rows[rr - 1] || [];
        function cellText(role) {
          var i = map[role];
          if (i === undefined || i === null) return "";
          var c2 = row[i];
          if (!c2) return "";
          if (c2.type === "uncalculated") { report.uncalculated++; return ""; }
          return c2.text === null || c2.text === undefined ? "" : String(c2.text).trim();
        }
        report.rows++;
        var name = cellText("name");
        if (!name) continue;

        var positionText = cellText("position");
        var p = parsePosition(box, positionText);
        if (!p) {
          report.skipped.push({ row: rr, name: name, why: "position \"" + positionText + "\" is not inside " + label });
          continue;
        }
        if (takenHere[p.index]) {
          report.collisions.push({ row: rr, name: name, position: p.label, box: label, alsoRow: takenHere[p.index] });
          continue;
        }
        takenHere[p.index] = rr;

        var passage = parsePassage(cellText("passage"));
        var dateRaw = cellText("date");
        var date = parseDate(dateRaw);
        if (date.needsReview) report.dateQueue++;
        var notes = cellText("notes");

        var fromSheet = {};
        ["origin", "koox", "resistance", "caspex", "guide"].forEach(function (facet) {
          var t = cellText(facet);
          // "#N/A" and "-" are what the sheet writes when a formula found nothing.
          // They are not values, so they are not imported as ones.
          if (t && t !== "#N/A" && t !== "-") fromSheet[facet] = t;
        });

        var vial = {
          id: o.idPrefix ? (o.idPrefix + "-" + rr) : ("v-" + rr),
          name: name,
          lineId: lineIdFor(name, rules),
          passage: passage.raw, passageNumber: passage.number, passageKind: passage.kind,
          frozenRaw: dateRaw,
          frozenOn: date.iso,
          notes: notes,
          flags: flagsFrom(notes),
          location: { unitId: unitId, rackId: rackId, boxId: boxId, position: p.label },
          status: "stored",
          importedFrom: (o.sourceName || "workbook") + "!" + sheet.name + "!row " + rr
        };
        // Nothing else is stored about an ambiguous date: frozenRaw is kept, frozenOn
        // is left null, and everything else (the proposal, the as-written reading,
        // why it is ambiguous) comes back from parseDate whenever it is needed.
        // A field that can be recomputed is a field that can go stale.
        if (Object.keys(fromSheet).length) vial.facetsFromSheet = fromSheet;
        vials.push(vial);
        report.imported++;
      }
    });

    var lines = [];
    var lineSeen = {};
    vials.forEach(function (v) {
      if (lineSeen[v.lineId]) { lineSeen[v.lineId].aliases.push(v.name); return; }
      var f = classify(v.name, rules);
      var line = { id: v.lineId, name: v.name, aliases: [],
                   facets: { origin: f.origin, koox: f.koox, resistance: f.resistance,
                             caspex: f.caspex, guide: f.guide }, notes: "" };
      lineSeen[v.lineId] = line;
      lines.push(line);
    });
    lines.forEach(function (l) {
      var uniq = {};
      l.aliases = l.aliases.filter(function (a) {
        if (a === l.name || uniq[a]) return false;
        uniq[a] = true; return true;
      });
    });

    var state = {
      storage: { units: [{ id: unitId, name: o.unitName || "-80 °C Freezer", type: o.unitType || "freezer",
                           childLabel: o.childLabel || "Rack",
                           racks: [{ id: rackId, name: o.rackName || "Rack 1", boxes: boxes }] }] },
      lines: lines, vials: vials, withdrawals: [],
      rules: clone(rules),
      settings: { defaultUnitId: unitId, placement: { allowSplit: true }, aliases: {} },
      _meta: { savedBy: null, savedAt: null }
    };

    var ca = classifyAll(state, rules);
    report.facetDiffs = ca.diffs.length;
    report.diffs = ca.diffs;
    report.gaps = ca.gaps;
    report.problems = validate(state);
    return { state: state, report: report };
  }

  // =====================================================================
  // Export to sheets (the workbook the app rewrites on every save)
  // =====================================================================

  function vialsToSheets(state) {
    var rules = state.rules || DEFAULT_RULES;

    var vialRows = [["unit", "rack", "box", "position", "name", "passage", "passage_kind",
                     "frozen", "frozen_raw", "needs_review", "origin", "ko_ox", "resistance",
                     "caspex", "guide", "flags", "notes", "status", "vial_id"]];
    (state.vials || []).slice().sort(function (a, b) {
      var ap = a.location ? locationPath(state, a.location) : "zzz";
      var bp = b.location ? locationPath(state, b.location) : "zzz";
      return ap < bp ? -1 : ap > bp ? 1 : (a.id < b.id ? -1 : 1);
    }).forEach(function (v) {
      var f = facetsFor(v, rules);
      var box = v.location ? findBox(state, v.location.boxId) : null;
      vialRows.push([
        box ? box.unit.name : "", box ? box.rack.name : "", box ? box.box.name : "",
        v.location ? v.location.position : "",
        v.name, v.passage || "", v.passageKind || "",
        v.frozenOn || "", v.frozenRaw || "", v.frozenOn ? "" : "yes",
        f.origin || "", f.koox || "", f.resistance || "", f.caspex || "", f.guide || "",
        (v.flags || []).join(", "), v.notes || "", v.status || "stored", v.id
      ]);
    });

    var stockRows = [["line", "origin", "ko_ox", "guide", "stored", "withdrawn", "boxes"]];
    var linesById = indexById(state.lines);
    stockCounts(state).forEach(function (s) {
      var line = s.lineId ? linesById[s.lineId] : null;
      var f = line && line.facets ? line.facets : {};
      stockRows.push([s.name, f.origin || "", f.koox || "", f.guide || "", s.stored, s.withdrawn, s.boxes]);
    });

    var wRows = [["date", "name", "unit", "rack", "box", "position", "by", "purpose", "notes", "vial_id"]];
    (state.withdrawals || []).slice().sort(function (a, b) {
      return String(b.date || "") < String(a.date || "") ? -1 : 1;
    }).forEach(function (w) {
      var box = w.from ? findBox(state, w.from.boxId) : null;
      wRows.push([w.date || "", w.name || "",
                  box ? box.unit.name : "", box ? box.rack.name : "", box ? box.box.name : "",
                  w.from ? w.from.position : "", w.by || "", w.purpose || "", w.notes || "", w.vialId]);
    });

    var sRows = [["unit", "type", "rack", "box", "scheme", "rows", "cols", "capacity", "used", "free"]];
    eachBox(state, function (box, rack, unit) {
      var occ = occupancy(state, box.id);
      sRows.push([unit.name, unit.type || "", rack.name, box.name, box.scheme || "grid",
                  box.rows, box.cols, occ ? occ.capacity : 0, occ ? occ.used : 0, occ ? occ.free : 0]);
    });

    return [
      { name: "vials", rows: vialRows },
      { name: "stock", rows: stockRows },
      { name: "withdrawals", rows: wRows },
      { name: "storage", rows: sRows }
    ];
  }

  // =====================================================================
  // State shape
  // =====================================================================

  // The inventory is written with empty fields left out -- a vial with no note simply
  // has no `notes` key. Every reader guards with (v.x || default), so absent and empty
  // mean the same thing, and dropping them keeps an edit's diff to the fields that
  // actually changed instead of re-inflating a hundred `"notes": ""` lines.
  //
  // This is the shape the file is committed in, so it lives here rather than in the
  // app: the selftest can then prove that loading the file and writing it back is a
  // no-op, which is what stops the app and the committed inventory drifting apart.
  function slim(state) {
    var copy = clone(state);
    function strip(obj, keep) {
      Object.keys(obj).forEach(function (k) {
        if (keep.indexOf(k) !== -1) return;
        var v = obj[k];
        if (v === "" || v === null || v === undefined || (Array.isArray(v) && !v.length)) delete obj[k];
      });
    }
    (copy.vials || []).forEach(function (v) { strip(v, ["id", "name"]); });
    (copy.lines || []).forEach(function (l) { strip(l, ["id", "name"]); });
    eachBox(copy, function (box) { strip(box, ["id", "name", "rows", "cols"]); });
    return copy;
  }

  // Exactly what the app commits, so "what would be written" is one call everywhere.
  function serialise(state) {
    return JSON.stringify(slim(state), null, 2) + "\n";
  }

  // A stored item's kind -- "cell", eventually "plasmid", "reagent", etc, as the lab-wide
  // expansion adds them. Missing on every item today because only cells exist so far; never
  // written to a vial just to fill the field in, so the real inventory's bytes don't move
  // for no reason. Read it through this helper rather than `vial.kind` directly.
  var DEFAULT_KIND = "cell";
  function kindOf(item) { return (item && item.kind) || DEFAULT_KIND; }

  // rulesByKind is the forward-looking shape: one ruleset per item kind, so a plasmid or a
  // reagent can eventually get its own facets without touching the cell rules. It is
  // computed on read, never written into the state mergeDefaults returns -- adding a new
  // top-level field there would change what serialise() commits on the very next save, and
  // nothing should move in the real inventory's bytes just for this scaffolding to exist.
  // A file that genuinely carries its own state.rulesByKind (a future export from a
  // multi-kind inventory) is read as-is; state.rules stays the cell entry either way, and
  // nothing here changes how classify(), search() or placement read it for cell items,
  // which is all that exists in real data right now. Wiring a second kind's rules into
  // classify/search/placement is deliberately not done yet: there is no real ruleset for a
  // plasmid or a reagent to test against until Umut defines one (CLAUDE.md: rules are data
  // he confirms, never invented).
  function rulesForKind(state, kind) {
    if (kind === DEFAULT_KIND || !kind) return (state && state.rules) || DEFAULT_RULES;
    return (state && state.rulesByKind && state.rulesByKind[kind]) || null;
  }

  function blankState() {
    return {
      storage: { units: [] },
      lines: [], vials: [], withdrawals: [],
      rules: clone(DEFAULT_RULES),
      settings: { defaultUnitId: null, defaultOperator: "", placement: { allowSplit: true }, aliases: {}, columnMap: {} },
      _meta: { savedBy: null, savedAt: null }
    };
  }

  // Normalises an older or partial file against the blank shape, so a hand-edited or
  // half-written JSON still opens instead of throwing on the first property access.
  function mergeDefaults(state) {
    var base = blankState();
    var s = state && typeof state === "object" ? clone(state) : {};
    if (!s.storage || typeof s.storage !== "object") s.storage = base.storage;
    if (!Array.isArray(s.storage.units)) s.storage.units = [];
    ["lines", "vials", "withdrawals"].forEach(function (k) { if (!Array.isArray(s[k])) s[k] = []; });
    if (!s.rules || typeof s.rules !== "object") s.rules = base.rules;
    FACETS.forEach(function (f) { if (!Array.isArray(s.rules[f])) s.rules[f] = clone(DEFAULT_RULES[f]); });
    if (!s.settings || typeof s.settings !== "object") s.settings = base.settings;
    if (!s.settings.placement) s.settings.placement = { allowSplit: true };
    if (!s.settings.aliases) s.settings.aliases = {};
    if (!s._meta) s._meta = base._meta;
    if (!s.settings.defaultUnitId && s.storage.units.length) s.settings.defaultUnitId = s.storage.units[0].id;
    return s;
  }

  // Everything the review queue still owes an answer on.
  function reviewQueue(state) {
    var dates = (state.vials || []).filter(function (v) {
      // Anything without a confirmed date: the ambiguous ones, the unparseable one,
      // and the handful that were simply left blank.
      return v.status !== "withdrawn" && !v.frozenOn;
    }).map(function (v) {
      return { vial: v, date: parseDate(v.frozenRaw) };
    });
    var ca = classifyAll(state);
    var passages = (state.vials || []).filter(function (v) {
      return v.status !== "withdrawn" && v.passageKind === "absolute" && v.passageNumber > IMPLAUSIBLE_PASSAGE;
    });
    var rows = mixedRows(state);
    // Vials the sheet never recorded a passage for. Not an error and not urgent, but
    // it is missing information and the app should say so rather than let 68 vials
    // sit behind a "p?" nobody ever gets around to.
    var unknownPassage = (state.vials || []).filter(function (v) {
      return v.status !== "withdrawn" && (v.passageKind || "unknown") === "unknown";
    });
    return { dates: dates, facets: ca.diffs, gaps: ca.gaps, passages: passages, rows: rows,
             unknownPassage: unknownPassage,
             total: dates.length + ca.diffs.length + ca.gaps.length + passages.length +
                    rows.length + unknownPassage.length };
  }

  function confirmDate(state, vialId, iso) {
    var next = clone(state);
    var v = indexById(next.vials)[vialId];
    if (!v) return { ok: false, reason: "No such vial.", state: state };
    var parsed = parseDate(iso);
    if (!parsed.iso) return { ok: false, reason: "\"" + iso + "\" is not a date I can read.", state: state };
    v.frozenOn = parsed.iso;
    return { ok: true, state: next, vial: v };
  }

  root.CellStocksEngine = {
    // geometry
    rowLabel: rowLabel, rowIndexFromLabel: rowIndexFromLabel, capacity: capacity,
    positionLabel: positionLabel, parsePosition: parsePosition, allPositions: allPositions,
    eachBox: eachBox, findBox: findBox, findUnit: findUnit, locationPath: locationPath,
    occupancy: occupancy, freeRuns: freeRuns, unitSummary: unitSummary,
    // classification
    FACETS: FACETS, DEFAULT_RULES: DEFAULT_RULES, classify: classify, facetsFor: facetsFor,
    classifyAll: classifyAll, parsePassage: parsePassage, passageLabel: passageLabel,
    // item kind (lab-wide expansion scaffolding -- see mergeDefaults/rulesForKind comments)
    DEFAULT_KIND: DEFAULT_KIND, kindOf: kindOf, rulesForKind: rulesForKind,
    parseDate: parseDate, flagsFrom: flagsFrom, FLAG_RULES: FLAG_RULES,
    // lines
    lineKey: lineKey, lineIdFor: lineIdFor, vialsOfLine: vialsOfLine, stockCounts: stockCounts,
    // search
    STRONG_TOKEN: STRONG_TOKEN, COVERAGE: COVERAGE, FIELD_WEIGHTS: FIELD_WEIGHTS,
    IMPLAUSIBLE_PASSAGE: IMPLAUSIBLE_PASSAGE,
    normaliseText: normaliseText, tokenise: tokenise, matchScore: matchScore,
    searchExtents: searchExtents, search: search, searchGroups: searchGroups,
    // placement
    NO_ORIGIN: NO_ORIGIN, originOfVial: originOfVial, rowsOf: rowsOf, rowTakes: rowTakes,
    mixedRows: mixedRows, suggestPlacement: suggestPlacement, applyPlacement: applyPlacement,
    GROUPING_STRATEGIES: GROUPING_STRATEGIES, IMPLEMENTED_GROUPING_STRATEGIES: IMPLEMENTED_GROUPING_STRATEGIES,
    groupingStrategyFor: groupingStrategyFor,
    // withdrawal
    withdraw: withdraw, undoWithdrawal: undoWithdrawal,
    // integrity
    validate: validate, errorsOnly: errorsOnly, canResizeBox: canResizeBox,
    // import / export
    ROLES: ROLES, guessColumns: guessColumns, blocksFrom: blocksFrom,
    gridFromPositions: gridFromPositions, importSheet: importSheet, vialsToSheets: vialsToSheets,
    // state
    blankState: blankState, mergeDefaults: mergeDefaults, indexById: indexById,
    slim: slim, serialise: serialise,
    reviewQueue: reviewQueue, confirmDate: confirmDate
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
