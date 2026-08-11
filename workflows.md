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
| Virus prep | teal | HEK293T seeding, pLentiGuide transfection, virus medium change, harvest |
| Western — biotin | red | every `Western — …` step plus the protein boil |
| ATF3 qPCR | amber | RNA isolation, cDNA conversion, qPCR prep, qPCR run |
| CuAdapt | green | copper treatment, passage, freeze, thaw, medium change |
| Cloning | violet | bacterial culture, miniprep, plasmids to sequencing |
| SRB assay | pink | seeding, copper/cisplatin treatment, TCA fixation and wash, pelleting |
| LNCX/LUCX | indigo | thaw, seed, transduction, hygromycin selection |
| ATF3 mutants | slate | thaw and medium change for the HEK/Huh7 mutants |

Colours are pinned in `_groups` rather than left to the name hash, because *Cloning* would otherwise
collide with *CuAdapt* and *SRB assay* with *ATF3 qPCR*. Any of them can be changed in the app's
colour dropdown. Passive events keep their pale treatment, tinted with the group's colour.

Meetings, Zoom calls and vacation stay ungrouped and keep their category colours.

## Estimating durations

**Every event that gets created or re-timed gets a web-searched duration — every time, no
exceptions, including procedures that have been looked up before.** Findings land in
[`protocols/durations.md`](protocols/durations.md) with their sources, so the table grows into a
reference; it is a record of what was found, not a substitute for looking again.

- Anything Umut has stated directly beats a published range, and gets recorded as our value.
- The split between hands-on and unattended time matters as much as the total, since it decides
  what else can be scheduled on top.
- Events already on the calendar are left alone — this applies to new and re-timed events only.

## Scheduling conventions

- `active` = has to be attended, blocks the day. `passive` = runs unattended, does not block.
- Other bench work is placed **inside** the passive stretches of long protocols, never overlapping
  another active step.
- Repeating commitments are stored as individual dated events — there is no recurrence engine, so
  they need regenerating when they run past their last date.
- Days should not run past roughly **18:00** unless there is no alternative.
