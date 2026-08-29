# Working agreement

This file is read automatically at the start of every session, so it is where standing instructions
belong. Notes buried in other files may not be read before work starts; anything that must shape
behaviour from the first message goes here.

The repo is Umut's lab schedule: `claudeAgent.json` is the source of truth, `index.html` is the app,
`schedule.ics` is generated. See `README.md` for the mechanics.

It also hosts **two more, unrelated apps** — `wardrobe/` picks what to wear, and `cellstocks/` keeps
track of the frozen cell stocks in the −80 °C freezer — plus `phd-prep/`, which isn't an app at all,
just markdown running Umut's doctoral qualifying exam preparation. Everything below is about the
schedule unless it says otherwise; §6 covers the wardrobe, §7 the cell stocks, §8 the exam prep.
When a request is about clothes, weather or outfits none of the scheduling rules apply; when it is
about vials, boxes or freezers, §7 applies; when it's about the qualifying exam, jury questions or
study topics, §8 applies — and the scheduling rules still don't.

---

## 1. Ask before building

**Default to asking.** When Umut asks for something, the useful move is usually a few sharp
questions first, not an immediate half-right implementation. A wrong guess costs a rebuild and
erodes trust in the schedule; a question costs thirty seconds.

Ask when:

- the request could reasonably mean two different things,
- a duration, order or dependency isn't stated and the answer changes the plan,
- the change touches a day that is already full, or work already marked done,
- there's a trade-off worth his call (finish late today vs. split across two days).

Don't ask when the answer is already written down here, in `workflows.md`, or in `protocols/` —
look it up instead. Don't ask permission for the obvious mechanical step.

Prefer a small number of concrete, answerable questions over an open "what do you want?".

## 2. Write everything down, automatically

**Any new protocol, term, timing, quantity, preference or correction that comes up in conversation
gets recorded — without being asked.** The conversation is not storage; the md files are. If Umut
has to repeat himself, the notes failed.

This includes casual remarks: "boiling is 15 minutes active", "medium change is 6.5 mL", "don't run
past 18:00", "I did that already". All of it lands in a file.

Where things go:

| What | File |
|---|---|
| How Umut runs a protocol — his durations, volumes, orderings, preferences | `workflows.md` |
| Published protocol consensus, with sources | `protocols/<topic>.md` |
| Researched durations per procedure, hands-on vs. unattended | `protocols/durations.md` |
| Standing instructions about how to work | this file |
| App behaviour and data shape | `README.md` |
| How warm a garment is, why, with sources | `protocols/clothing-insulation.md` |
| What goes with what, and why | `protocols/outfit-matching.md` |
| How long a frozen vial keeps, and what has to be recorded about it | `protocols/cryopreservation.md` |

New topics get a new file under `protocols/` rather than being crammed into an existing one.

**Back factual claims with real sources.** Vendor protocols, published methods, manufacturer
documentation — cited by link in the file. Not memory, not a plausible-sounding number. When
sources disagree, record the range and say which end we take and why. Anything Umut states directly
beats a published range, and gets written down as our value.

If something he says is ambiguous enough that it can't be recorded accurately, ask — a wrong entry
is worse than a missing one, because it will be trusted later.

## 3. Durations are researched, every time

Every event created or re-timed gets a web-searched duration — every time, including procedures
looked up before. Findings land in `protocols/durations.md` with sources. Record hands-on and
unattended time separately: that is what decides whether other work can be scheduled on top.

Events already on the calendar are left alone unless asked. This applies to new and re-timed events.

## 4. Landing changes

The calendar feed only rebuilds from `main`, so a change that stops at a branch never reaches
Apple Calendar. Work on a branch, open a PR, merge it — don't leave it sitting.

Before editing, re-read `claudeAgent.json` from `origin/main`: Umut edits from his phone
mid-session, and those edits are real. If he marked something done, it is done.

Rebuild the feed with `node tools/build-ics.mjs` and commit the result alongside the JSON.

## 5. Scheduling rules that keep biting

- `active` blocks the day; `passive` runs unattended. Other work goes **inside** passive stretches,
  never overlapping another active step. Verify this programmatically before claiming a day works.
- Dependencies are real: boil before loading, transfer before any antibody, cDNA before qPCR prep.
- Don't push a day past roughly 18:00 without saying so and offering the split.

## 6. The wardrobe app

`wardrobe/` is a separate app that happens to live in this repo. It shares the Pages host, the
GitHub token and the PWA pattern; it shares no data and no rules with the schedule. It only ever
*reads* `claudeAgent.json`, to tell a lab day from a meeting.

- **Every rule lives in `wardrobe/engine.js`**, as pure functions with no DOM and no clock. The
  browser loads that file and `tools/wardrobe-selftest.mjs` runs the same file in node. Change a
  rule there, not in the app, and add a check — the suite exists so claims about the rules can be
  verified instead of believed. Run it before claiming anything works.
- **Warmth is in clo**, from the published tables, never invented. A garment's thickness step maps
  onto that garment type's own range. Anything Umut states about a specific garment beats the table.
- **Say when something is a guess.** A thickness the app inferred is marked as one, on the item and
  on the outfit card. Never present an inferred value as though it were answered.
- **The agent never writes a field.** `tools/wardrobe-agent.mjs` writes proposals to `agentGuessed`;
  only Umut accepting one in the app settles it. Do not add a path around that.
- **Only the name is required** when adding a garment. Do not add a second mandatory field.
- **There is no laundry tracking, and that is not an oversight.** It was removed because it asked a
  question about every garment to solve a problem that affects a few. Multi-day wear is one
  mechanism — pinning a piece, from the outfit itself. Do not reintroduce a wear counter.
- **A per-piece rejection blames only that piece.** `trainTaste` skips the item-level features of
  everything he kept when a swipe carries a `focus`. Losing that quietly turns his sharpest signal
  back into his vaguest one.
- **A rejection is about a context.** It is stored with the rest of the outfit and blocks that piece
  only while the company is equivalent — same slot, similar colour, same formality; fabric and cut
  are not differences. Do not widen this into a blanket ban on the garment.
- **Feedback has to be visible in the ranking.** The model's early influence was once so low that a
  rejected garment came back in eight of the next eight cards. If `ruleWeightFor` is ever retuned,
  measure that number rather than reasoning about the curve.
- **The agent has two channels and they are not interchangeable.** `applyProposals` fills blanks and
  refuses anything answered by hand; `recordSuggestions` carries corrections read out of his written
  notes, which may contradict an answer and therefore quote the sentence and wait for acceptance.
- New wardrobe facts — a garment's real warmth, a preference about what he will and won't wear,
  a correction — get written down the same as anything else, into the table above.

---

## 7. The cell stocks app

`cellstocks/` is a separate app that happens to live in this repo. **It is not related to anything
else in here.** It shares the Pages host and nothing else — not the data, not the rules, not even
the browser storage: its own token, device name, theme and offline cache, all under `cst_*` keys.
Do not "reuse" a helper from another app in it, and do not factor anything out of it into shared
code. The only unavoidable overlap is that one origin means one Cache Storage, which each service
worker handles by sweeping only its own prefix.

- **Every rule lives in `cellstocks/engine.js`**, as pure functions with no DOM, no fetch and no
  clock — ids, timestamps and "today" are always arguments. The browser loads that file and
  `tools/cellstocks-selftest.mjs` runs the same file in node. Change a rule there, not in the app,
  and add a check. Run the suite before claiming anything works.
- **A row holds one kind of cell, and that is the placement rule.** The grouping key is the
  **origin** facet, not the line: KO, OX, CASPEX and guide of one cell all share a row. A different
  cell never takes a free slot beside it — it starts a fresh row, and failing that a fresh box.
  This is not tidiness; it is how the freezer already is (of the 43 rows in use, 42 hold exactly
  one cell). One freeze-down stays in one row where a row can hold it, and in one box where a box can.
  Do not "optimise" this into first-free-slot packing.
- **The name is the only thing typed.** Origin, KO/OX, resistance, CASPEX and guide are derived
  from it by `classify()`, which is the spreadsheet's five formulas — and **the rules are data in
  `cellstocks.json`, never code**. Umut said he may define new common labels; that has to stay a
  Rules-screen edit. A facet he has set by hand is never recomputed.
- **`cellstocks.json` is the inventory. `cell-stocks.xlsx` is generated from it on every save** and
  committed in the same commit, never the reverse. A hand edit to the workbook is thrown away by
  the next save; do not add a path that reads it back.
- **Two stored vials in one slot is an error, not a warning.** `validate()` returns it as one and
  the save is refused. Do not downgrade it, and do not add a code path that places a vial without
  going through `validate` first.
- **Withdrawal does not delete a vial.** It sets `status:"withdrawn"`, clears the location and logs
  a snapshot of where it was. History is not optional in a lab inventory. Undo restores the vial
  only if its slot is still free.
- **Freezer geometry is data, not code.** Never hardcode 9×9, a rack count or a position format. A
  nitrogen tank and a freezer share one model and differ only by `type` and `childLabel`; the
  positions in a box come from its own `rows`, `cols` and `scheme`.
- **The placement proposal is a proposal.** The override path stays — but even an override may not
  mix two cells in one row, and a plan never part-fills silently. If it cannot describe a run
  honestly it lists the slots instead.
- **A row that already mixes two cells is a warning, not an error.** One row does — UMUT CAA CELLS
  A, one Du145 among eight HEK293T. It is listed for review; it does not block a save, and nothing
  is moved to fix it without being asked.
- **Anything the sheet did not say is surfaced, not filled in.** Ambiguous dates, missing passages,
  an implausible passage, a mixed row: all listed under Review for Umut to answer through the vial
  editor. A facet he pins by hand is never recomputed.
- **Nothing is repaired behind his back.** The import queues ambiguous dates rather than swapping
  them, reports every row where the corrected rules disagree with the sheet, and needs an explicit
  tick before it throws any row away. `#N/A` is not a value and is never imported as one.
- **Absolute and relative passages are separate scales.** `p+2` must never be comparable with `p2`,
  and the 68 vials marked `p?` must never vanish from a search without the UI saying so.
- Only Umut's own `UMUT -80` sheet is in the app. The other nine people's sheets in that shared
  workbook are out of scope — this repository is public, and that is their call, not ours.
- New cryopreservation facts — how long a vial keeps, a medium, a preference, a correction — get
  written down the same as anything else, into the table above.

---

## 8. The PhD qualifying exam prep

`phd-prep/` runs Umut's doctoral qualifying exam preparation for KUTTAM CAA Lab. It has nothing to
do with the schedule, the wardrobe or the cell stocks — it never touches `claudeAgent.json` or
`schedule.ics`, and study blocks are never scheduled as real calendar events, only tracked in this
folder's files.

- **All the rules live in [`phd-prep/CLAUDE.md`](phd-prep/CLAUDE.md)** — role, jury members, weekly
  planning, question types, constraints. Read it before acting on anything exam-related.
- **Weekly progress goes in `phd-prep/progress.md`**, appended every week, never overwritten.
- **Topic and question history goes in `phd-prep/topics-log.md`** — this is what stops a rejected
  topic from being suggested again.
- New exam facts — a jury change, a topic preference, a correction to an answer — get written down
  the same as anything else, into those files.
