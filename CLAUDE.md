# Working agreement

This file is read automatically at the start of every session, so it is where standing instructions
belong. Notes buried in other files may not be read before work starts; anything that must shape
behaviour from the first message goes here.

The repo is Umut's lab schedule: `claudeAgent.json` is the source of truth, `index.html` is the app,
`schedule.ics` is generated. See `README.md` for the mechanics.

It also hosts a **second, unrelated app** under `wardrobe/` — it picks what to wear, and has nothing
to do with the lab. Everything below is about the schedule unless it says otherwise; §6 covers the
wardrobe. When a request is about clothes, weather or outfits, none of the scheduling rules apply.

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
- New wardrobe facts — a garment's real warmth, a preference about what he will and won't wear,
  a correction — get written down the same as anything else, into the table above.
