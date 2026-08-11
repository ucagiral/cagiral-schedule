# How Umut runs things

The record of our actual bench practice — the timings, quantities and orderings that get used when
building the schedule. Published protocols give ranges; this file says which point in the range we
take, and why.

**This file is kept up to date as we talk.** Whenever a protocol detail comes up in conversation —
a duration, a volume, which step is hands-on, what has to come before what — it gets written down
here so the next schedule is built from it instead of from a guess.

For the outside reference this is measured against, see
[`protocols/western-blot.md`](protocols/western-blot.md).

---

## Western blot

Split across two days. One day for the first target, the next day for the second after stripping.

### Day 1 — gel to first image

| Step | Duration | Hands-on? |
|---|---|---|
| Boil protein samples | 30 min total: **15 min active, 15 min passive** | first half |
| Load gel | 15 min | yes |
| SDS-PAGE run | ~1.5 h | **no** — passive once loaded |
| Assemble wet transfer | 15 min | yes |
| Wet transfer | **2 h** | **no** |
| Block | 1 h | **no** |
| Streptavidin-HRP (or primary) | 1 h | **no** |
| Washes | 30 min | yes |
| ECL + image | 20 min | yes |

Ordering that matters:

- **Antibodies never come before the transfer.** Gel → transfer → block → antibody. Nothing
  antibody-related can be scheduled while the gel is still running or transferring.
- The 15 passive minutes of the protein boil are used for **sending plasmids to sequencing** —
  that errand fits exactly in the gap.
- After loading, the gel is unattended, so cell work goes here.
- The membrane goes to **4 °C overnight** after the first image rather than stripping the same
  evening. Finishing a strip-and-reprobe on day 1 runs past 20:00, which is too late.

### Day 2 — strip and reprobe

| Step | Duration | Hands-on? |
|---|---|---|
| Strip | **20 min** | yes |
| Block | **1 h** | **no** |
| Primary antibody | **1 h** | **no** |
| Washes | 15 min | yes |
| Secondary antibody | **1 h** | **no** |
| Washes | 15 min | yes |
| ECL + image | 20 min | yes |

Day 2 uses a **primary + secondary** pair, unlike day 1's conjugated streptavidin-HRP.

### Standing notes

- **Biotin targets: block in BSA, never milk.** Milk carries endogenous biotin and will compete
  with the target for streptavidin.
- Streptavidin-HRP is conjugated, so day 1 has no secondary antibody step.
- The Western needs a **booked appointment/reservation** for the equipment — check before planning
  the day around it.

---

## Cell culture

- **Virus medium change:** add **6.5 mL** per vessel.
- **CuAdapt line:** recurring passage on **Mondays and Thursdays**. Copper treatment and passage are
  separate events, with a ~10 min gap between them.
- A missed passage is caught up as a one-off event and does not shift the recurring Mon/Thu rhythm.

---

## qPCR track

Dependency chain, each step feeding the next:

**Seed cells → RNA isolation → LunaScript cDNA conversion → qPCR prep → qPCR run**

- RNA isolation: 1 h
- LunaScript cDNA conversion: 1 h, run straight off the isolation
- qPCR prep: 1 h. Done **the day before** the run and the plate kept in the fridge, so the run day
  stays light. It must fall after the cDNA conversion it depends on.
- qPCR run: 2 h

---

## Colour groups

Related work shares one colour across the week through the event's `group` field, so a whole
experiment thread reads as a single strand on the grid. The eight in use:

| Group | Colour | Covers |
|---|---|---|
| Virus prep | teal `#14b8a6` | HEK293T seeding, pLentiGuide transfection, virus medium change, harvest |
| Western — biotin | red `#ef4444` | every `Western — …` step plus the protein boil |
| ATF3 qPCR | amber `#f59e0b` | RNA isolation, cDNA conversion, qPCR prep, qPCR run |
| CuAdapt | green `#22c55e` | copper treatment, passage, freeze, thaw, medium change |
| Cloning | violet `#8b5cf6` | bacterial culture, miniprep, plasmids to sequencing |
| SRB assay | pink `#ec4899` | seeding, copper/cisplatin treatment, TCA fixation and wash, pelleting |
| LNCX/LUCX | indigo `#6366f1` | thaw, seed, transduction, hygromycin selection |
| ATF3 mutants | cyan `#06b6d4` | thaw and medium change for the HEK/Huh7 mutants |
| Zoom — Wednesday | purple `#a855f7` | the standing Wednesday 21:10 Zoom |
| Weekly meeting | lime `#84cc16` | the standing Friday 09:30 meeting |
| Vacation | slate `#64748b` | vacation days |

**Every event carries a group, so no block falls back to a category colour.** That matters because
the category palette overlaps the group palette — `personal` green is CuAdapt's green and `meeting`
red is the Western red, which is exactly how the Wednesday Zoom and the Friday meeting ended up
looking like experiments. Grouping them fixes it at the root.

All eleven colours are pinned in `_groups` and are distinct from one another. The Wednesday Zoom's
purple and the Friday meeting's lime are used by nothing else. Any of them can be changed from the
app's colour dropdown. Passive events keep their pale treatment, tinted with the group's colour.

**A new recurring commitment gets its own group and its own unused colour**, rather than being left
on a category colour where it will collide with an experiment.

## Things that complete themselves

The Wednesday Zoom carries `autoDone`, so it flips to done once 22:10 passes — it happens whether or
not it gets ticked, so ticking it is busywork. Nothing else is set up this way; ask before adding it
to anything where "the hour passed" doesn't actually mean "the work is finished".

## Estimating durations

**Every event that gets created or re-timed gets a web-searched duration — every time, no
exceptions, including procedures that have been looked up before.** Findings land in
[`protocols/durations.md`](protocols/durations.md) with their sources, so the table grows into a
reference; it is a record of what was found, not a substitute for looking again.

- Anything Umut has stated directly beats a published range, and gets recorded as our value.
- The split between hands-on and unattended time matters as much as the total, since it decides
  what else can be scheduled on top.
- Events already on the calendar are left alone — this applies to new and re-timed events only.

## Projects and the planner

A project is a research goal written down in [`projects.md`](projects.md) as an ordered set of
phases — each with what it achieves, what verifies it, its sub-steps, and its sources. The app's
**Project** button turns one phase at a time into calendar events.

What the planner guarantees, checked in code rather than by eye:

- Nothing is placed on top of an **active** block already on the calendar, with 10 minutes of
  clearance either side so it doesn't trip the conflict warning.
- Nothing lands **before tomorrow** — today is already part-spent.
- Nothing runs past **18:00**, and no more than three generated blocks land on one day.
- A step whose hands-on share is under half its total is created as **passive**, so it doesn't
  block the day.

Durations come from [`protocols/durations.md`](protocols/durations.md), matched against the
sub-step's wording, and the top of a published range is taken so a day is never under-booked. A
step with no row there is given a **placeholder hour and flagged in the dialog** — the planner says
so rather than quietly inventing a number. Those flagged steps are the queue for the next research
pass; once looked up they go into `durations.md` and the planner stops guessing.

The planner proposes; nothing is written until the events are reviewed and accepted.

## Scheduling conventions

- `active` = has to be attended, blocks the day. `passive` = runs unattended, does not block.
- Other bench work is placed **inside** the passive stretches of long protocols, never overlapping
  another active step.
- Repeating commitments are stored as individual dated events — there is no recurrence engine, so
  they need regenerating when they run past their last date.
- Days should not run past roughly **18:00** unless there is no alternative.
