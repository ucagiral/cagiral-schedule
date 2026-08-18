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

## AR-CasPEx

**One project, one name.** "LNCX/LUCX" and "the AR-CasPEx project" are the same thing — `LNCX` and
`LUCX` are the two cell lines inside it, not a separate piece of work. The calendar still carries
the older group name.

The published method is in [`protocols/caspex.md`](protocols/caspex.md). This is how Umut runs it.

### The system

- **Construct:** `dd-CasPEx-mCherry` — dCas9–APEX2, FLAG-tagged, carrying a destabilising domain,
  with mCherry as the sort marker.
- **Two switches, not one.** Expression needs **doxycycline *and* Shield-1**, both added
  **2 days before biotinylation**. Every labelling day therefore has a fixed two-day lead-in, and
  a labelling date is really a three-day commitment.
- **Lines:** `LNCX` = LNCaP-CasPEx, `LUCX` = LuCaP-35CR-CasPEx. Both grow in **standard 2D
  culture** and both sit at the same stage. Names are the shorthand used on the calendar.
- **Two independent markers:** CasPEx came in with mCherry and was **sorted**; the guide vector
  carries **hygromycin**. So a guide-transduced line is sorted once and selected once.

### Target and guides

The target is the **AR locus** — androgen receptor, the axis that separates LNCaP from the
castration-resistant LuCaP-35CR.

**8 guides: 4 against the promoter, 4 against the enhancer.** The replicates are a funnel, and —
importantly — **they are not the same assay**:

| Replicate | Induction | Biotinylation? | Readout | Purpose |
|---|---|---|---|---|
| 1 | dox + Shield-1 | **no** | ChIP-qPCR | Choose the guides. **Not sent to mass spec.** |
| 2 | dox + Shield-1 | **no** | ChIP-qPCR | Confirm the choice: 2 best promoter + 2 best enhancer |
| 3 | dox + Shield-1 | **yes** | Nuclear fraction → streptavidin → MS | Runs **at the same time as the submission** |

**Biotinylation is not needed before ChIP-qPCR.** The fusion has to be *expressed* to be
immunoprecipitated; it does not have to have *labelled* anything for ChIP to report where it sits.
So replicates 1 and 2 need only dox and Shield-1, and guides are chosen on **occupancy**, not on
blot signal.

This matters for the calendar as much as for the biology: the APEX2 reaction, with its exact
one-minute H₂O₂ step and immediate quench, is run **once**, on replicate 3 only. Screening 8 guides
across 2 lines is a ChIP week, not a labelling marathon.

Three biological replicates per condition for the proteomics. A few 15 cm dishes per condition.
Batch size is not a constraint — there are people to help.

### Labelling — replicate 3 only

Standard APEX2: biotin-phenol 30 min, then H₂O₂ for **exactly 1 minute**, then immediate quench.

**The nuclear fraction is isolated before the streptavidin pulldown.** The question is about
proteins at a genomic locus, so carrying the cytoplasm into the enrichment only adds background —
including the endogenous biotinylated carboxylases, which are largely mitochondrial and cytosolic.

Controls alongside: **non-targeting sgRNA**, **no H₂O₂ / no biotin-phenol**, **no Shield-1**.

### Before samples go to mass spec

**Occupancy must be confirmed by FLAG ChIP-qPCR** — that is what replicates 1 and 2 are for. The
core facility is too expensive to spend on a guide that was never shown to be at the locus, and a
negative result from an unverified guide says nothing.

APEX2 activity itself is already established: the **no-guide biotin Western** has been shown.

### Downstream

- **Nuclear fractionation, streptavidin pulldown and digest are done in-house**; peptides or beads
  go to the facility.
- Mass spec is an **external core facility**, rolling submission, **weeks** of turnaround.
- **Freeze a backup of every selected line before experiments.** Everything upstream —
  transduction, selection, expansion — is weeks of work to recreate.

### Timings that bind the schedule

| Step | Our value |
|---|---|
| Doxycycline + Shield-1 before biotinylation | **2 days** |
| Hygromycin selection | **5–7 days, 6 standard** — not the 10–14 day published range |
| Expansion after selection, before labelling | **1–2 weeks** |
| Biotinylation | **replicate 3 only** — replicates 1 and 2 are ChIP-qPCR on dox + Shield-1 alone |
| Nuclear fractionation | before the streptavidin pulldown, replicate 3 |

## Cell culture

### The thaw-cell rule

**Nothing is scheduled on a thaw day, and the day after a thaw is a mandatory medium change.**
Cells coming out of storage are recovering; an experiment on top of that is wasted. This rule is
already why several calendar events sit where they do.

- **Virus medium change:** add **6.5 mL** per vessel.
- **CuAdapt line:** recurring passage on **Mondays and Thursdays**. Copper treatment and passage are
  separate events, with a ~10 min gap between them.
- A missed passage is caught up as a one-off event and does not shift the recurring Mon/Thu rhythm.

---

## Colony formation

- **Fixation is 15 minutes**, and it repeats across consecutive days as plates come due — not one
  block at the end.
- **Drying happens once**, after the last fixation, and is unattended. Room temperature; protocols
  quote about 4 hours but plates keep for days, so the block marks the day rather than a deadline.
- Staining and counting are separate steps and are not assumed — they go on the calendar when Umut
  says so.

## qPCR track

Dependency chain, each step feeding the next:

**Seed cells → RNA isolation → LunaScript cDNA conversion → qPCR prep → qPCR run**

- RNA isolation: 1 h
- LunaScript cDNA conversion: 1 h, run straight off the isolation
- qPCR prep: 1 h. Done **the day before** the run and the plate kept in the fridge, so the run day
  stays light. It must fall after the cDNA conversion it depends on.
  - When a prep slips, it moves to the run day and goes **before** the run rather than being
    dropped — the dependency is what matters, the day-before is only the preference. This happened
    on 13 Aug 2026.
- qPCR run: 2 h

---

## Colour groups

Related work shares one colour across the week through the event's `group` field, so a whole
experiment thread reads as a single strand on the grid. The twelve in use:

| Group | Colour | Covers |
|---|---|---|
| Virus prep | teal `#14b8a6` | HEK293T seeding, pLentiGuide transfection, virus medium change, harvest |
| Western — biotin | red `#ef4444` | every `Western — …` step plus the protein boil |
| ATF3 qPCR | amber `#f59e0b` | RNA isolation, cDNA conversion, qPCR prep, qPCR run |
| CuAdapt | green `#22c55e` | copper treatment, passage, freeze, thaw, medium change |
| Cloning | violet `#8b5cf6` | bacterial culture, miniprep, plasmids to sequencing |
| SRB assay | pink `#ec4899` | seeding, copper/cisplatin treatment, TCA fixation and wash, pelleting |
| LNCX/LUCX | indigo `#6366f1` | the **AR-CasPEx** work — thaw, seed, transduction, hygromycin selection. The group still carries the old name on the calendar; renaming it would retag the five existing events and change the feed, so it is left until asked. |
| ATF3 mutants | cyan `#06b6d4` | thaw and medium change for the HEK/Huh7 mutants |
| Zoom — Wednesday | purple `#a855f7` | the standing Wednesday 21:10 Zoom |
| Weekly meeting | lime `#84cc16` | the standing Friday 09:30 meeting |
| Colony formation | orange `#f97316` | fixation across consecutive days, then drying |
| Nek2→YY1 | fuchsia `#d946ef` | swapping Nek2(K37R) out of the pCDH backbone for a PCR-amplified YY1 insert. Standalone thread, not related to any other group — including the generic "Cloning" group above, which only tags unrelated one-off plasmid-prep steps. Not tracked as a project either. |

**Every event carries a group, so no block falls back to a category colour.** That matters because
the category palette overlaps the group palette — `personal` green is CuAdapt's green and `meeting`
red is the Western red, which is exactly how the Wednesday Zoom and the Friday meeting ended up
looking like experiments. Grouping them fixes it at the root.

All twelve colours are pinned in `_groups` and are distinct from one another. The Wednesday Zoom's
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

A row wins a step only on real overlap: either a word distinctive enough to stand alone, or words
covering most of what makes that row's name specific. Six letters of "select" shared between
*Select best guide* and *Antibiotic selection* is a collision, not a match, and inheriting the
wrong timing there would read as researched when it isn't — so ties go to flagging.

**Anything measured in days is not a block.** A 10–14 day antibiotic selection is a series of feeds;
the planner places a placeholder for the first visit and says the repeats still need scheduling,
rather than drawing a two-week bar across the calendar.

Steps are **ticked off in the app**, and the tick is written straight back to `projects.md` as
`- [x]`. Ticked steps are skipped the next time that phase is planned, so re-planning always
proposes only what is actually left. A device with no token shows the boxes but can't change them.

The planner proposes; nothing is written until the events are reviewed and accepted.

## Scheduling conventions

- `active` = has to be attended, blocks the day. `passive` = runs unattended, does not block.
- Other bench work is placed **inside** the passive stretches of long protocols, never overlapping
  another active step.
- Repeating commitments are stored as individual dated events — there is no recurrence engine, so
  they need regenerating when they run past their last date.
- Days should not run past roughly **18:00** unless there is no alternative.
