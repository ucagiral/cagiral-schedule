# Working agreement

This file is read automatically at the start of every session, so it is where standing instructions
belong. Notes buried in other files may not be read before work starts; anything that must shape
behaviour from the first message goes here.

The repo is Umut's lab schedule: `claudeAgent.json` is the source of truth, `index.html` is the app,
`schedule.ics` is generated. See `README.md` for the mechanics.

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
