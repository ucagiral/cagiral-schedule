# Cryopreservation and frozen stocks — what the published protocols agree on

Written for the [Cell Stocks app](../cellstocks/), which tracks what is in the −80 °C freezer and,
later, in the nitrogen tank. Two questions decide how that app should behave, so they are answered
here with sources rather than from memory: **how long a vial can honestly sit at −80 °C**, and
**what has to be recorded about a vial for it to be worth thawing later**.

For how *we* actually freeze cells — Umut's own volumes, timings and preferences — see
[`../workflows.md`](../workflows.md). This file is the outside reference; that one is the record of
our practice, and anything stated there overrides a published range.

> **A note on sourcing.** The vendor protocol pages (ATCC, Thermo/Gibco, Sigma-Aldrich) are
> unreachable from this session's network, so the figures below were taken from search results
> quoting those pages, and each is linked to the page it came from. Where the sources disagree the
> spread is given. Anything marked *(range)* is worth confirming against the page itself before it
> is relied on for a decision.

## Sources

| # | Source | Used for |
|---|---|---|
| 1 | [ATCC — Cryogenic storage of animal cells](https://www.atcc.org/resources/technical-documents/cryogenic-storage-of-animal-cells) | freezing medium, cooling rate, liquid vs. vapour phase |
| 2 | [ATCC — Cryopreservation](https://www.atcc.org/cell-products/media-and-reagents/cryopreservation-of-cells) | DMSO concentration and toxicity |
| 3 | [Thermo Fisher / Gibco — Freezing cells](https://www.thermofisher.com/us/en/home/references/gibco-cell-culture-basics/cell-culture-protocols/freezing-cells.html) | cell density, freezing medium |
| 4 | [Thermo Fisher / Gibco — Thawing cells](https://www.thermofisher.com/us/en/home/references/gibco-cell-culture-basics/cell-culture-protocols/thawing-cells.html) | thaw speed |
| 5 | [Sigma-Aldrich — Cryopreservation and storage of cell lines](https://www.sigmaaldrich.com/US/en/technical-documents/technical-article/cell-culture-and-cell-culture-analysis/mammalian-cell-culture/cryopreservation-storage-cells) | −80 °C holding time, −130 °C threshold |
| 6 | [Sigma-Aldrich — Cryopreservation of cell lines](https://www.sigmaaldrich.com/US/en/technical-documents/protocol/cell-culture-and-cell-culture-analysis/mammalian-cell-culture/cryopreservation-of-cell-lines) | cell condition at freezing |
| 7 | [EuroMAbNet — Freezing and thawing of cell lines](https://www.euromabnet.com/protocols/freezing-thawing.php) | cells per vial, DMSO exposure |
| 8 | [Abcam — Cryopreservation of mammalian cell lines](https://www.abcam.com/en-us/technical-resources/protocols/cryopreservation-of-mammalian-cell-lines) | overall workflow |
| 9 | [Ajo-Franklin lab (LBL) — Cryopreservation of mammalian cells](https://cafgroup.lbl.gov/protocols/general-cell-biology/cryopreservation-of-mammalian-cells) | thaw speed |
| 10 | [Bielanski et al. — Contaminated liquid nitrogen vapour as a risk factor in pathogen transfer](https://www.sciencedirect.com/science/article/abs/pii/S0093691X08007978) | cross-contamination in storage |
| 11 | [Air Products — Vapour vs. liquid cryogenic storage](https://www.airproducts.expert/uk/biomedical/cryogenic-storage-liquid-storage) | liquid-phase seepage and rupture |
| 12 | [OPS Diagnostics — Contamination and temperature variation in cryogenic storage](https://opsdiagnostics.com/notes/cryogenicstorage.htm) | mechanical freezer vs. nitrogen |
| 13 | [Uphoff & Drexler — Detection of mycoplasma contaminations](https://pubmed.ncbi.nlm.nih.gov/15361652/) | testing cadence |
| 14 | [Nikfarjam & Farzaneh — Prevention and detection of mycoplasma contamination in cell culture](https://pmc.ncbi.nlm.nih.gov/articles/PMC3584481/) | testing cadence |

## The consensus

| Item | Common value | Range seen | Notes |
|---|---|---|---|
| Freezing medium | **Complete growth medium + 10% DMSO** | 5–10% DMSO *(range)* | ATCC freezes routinely with complete medium + 5–10% DMSO (1, 2). Serum-free equivalents exist. |
| DMSO toxicity | Non-toxic **at ≤10%** | — | ATCC tests each DMSO lot for non-toxicity at 10% or less (2). Exposure time matters as much as concentration: handling more than 10–20 vials at once already extends it too far (7). |
| Cells per vial | **1–5 × 10⁶** | 5 × 10⁵ – 1 × 10⁷ *(range)* | EuroMAbNet gives 2–5 × 10⁶ per vial (7); other protocols widen it (3). |
| Cell condition | **Log phase, healthy, ~5–8 × 10⁵ cells/mL** | — | Cells frozen out of log phase recover badly (6). |
| Cooling rate | **−1 °C per minute** | — | Near-universal. Achieved with an isopropanol or alcohol-free container in a −80 °C freezer overnight (1). |
| Time at −80 °C before transfer | **Overnight (≥4 h)** | — | Long enough to reach temperature at −1 °C/min; see [`durations.md`](durations.md). |
| Thaw | **Fast — under 1–2 min in a 37 °C water bath**, swirling, stopping while a small ice crystal remains | <1 min to 2 min *(range)* | Then dilute the DMSO out stepwise to avoid osmotic shock (4, 7, 9). |

## The two facts the app is built on

### 1. −80 °C is a staging area, not a store

This is the one with a real spread in the literature, and it matters because it decides whether the
nitrogen tank is a nicety or the actual home of a stock.

- The conservative reading: cells **should not be held at −80 °C for long periods (up to a week)**
  and should go to nitrogen whenever possible (5).
- The commonly practised reading: **under a month is fine**, and viability starts to fall somewhere
  around **5–6 months** (5).
- The mechanism, which is why every source points the same direction even when the numbers differ:
  at −80 °C a small fraction of the water is still unfrozen, so slow chemical reactions and **ice
  recrystallisation** continue. Loss is progressive and is made worse by thermal cycling — every
  time the freezer door opens (5, 12).
- **Full stability needs below −130 °C**, reached by liquid nitrogen (−196 °C), its vapour phase,
  or a −150 °C mechanical freezer (5).

**What we take:** a −80 °C vial is a working stock with a shelf life of **months, not years**, and
the number worth acting on is that viability is expected to decline past roughly **6 months**. A
stock that has to survive a project belongs in the tank. This is why the app records a freeze date
per vial and why an unconfirmed date is treated as a gap to be answered rather than a blank —
without a date, "how old is this vial" has no answer.

### 2. The tank's shape is a safety decision, not just a layout one

Relevant when the nitrogen tank is added to the app, because it decides what a "position" even is.

- **Liquid phase** holds more nitrogen and needs less topping up, but nitrogen seeps into vials
  through imperfect seals, and it then acts as a vehicle: viruses, bacteria, fungi and stray cells
  move between vials (1, 10, 11). A documented hepatitis B outbreak was traced to bone marrow and
  stem cells contaminated during liquid-phase storage, and HBV has been reported to stay infectious
  after two years in liquid nitrogen (10, 11).
- Trapped liquid nitrogen also **expands roughly 1:696 on warming**, which is what makes a
  submerged vial burst when it is pulled out (1, 11).
- **Vapour phase** avoids the liquid as a vehicle entirely, at the cost of a shallower temperature
  gradient up the tank — so a vial's height matters, and a tower position is a temperature as well
  as an address (10, 11, 12).

**What we take:** vapour phase, and the app should not treat a tower position as interchangeable
with any other — which is already how it works, since a location is a unit, a tower, a box and a
slot, never a loose label.

## What has to be recorded for a vial to be worth thawing

Drawn from what the sources above assume is known, and from what the app actually stores:

| Field | Why it has to be there |
|---|---|
| **Identity** (line, and the edit/clone that distinguishes it) | Everything else is worthless without it. In our sheet this is one typed name, from which origin, KO/OX, resistance, CASPEX and guide are all derived. |
| **Passage** | Phenotypic drift is passage-dependent, so it is the second question after identity. Ours comes in two incompatible flavours — absolute (`p11`) and relative to the last thaw (`p+2`) — and the app keeps them on separate scales for that reason. |
| **Date frozen** | The only way to apply the −80 shelf life above. |
| **Cells per vial** | Decides what to thaw into: ~1 × 10⁶ suits a T-25, ~5 × 10⁶ a T-75. |
| **Freezing medium** | Decides how fast the DMSO has to come off on thaw; it varies per freeze-down, not per line. |
| **Mycoplasma status *and date*** | "Untested" and "negative in March" are different facts, and a boolean cannot say the first. New lines and lines in continuous culture must be tested at regular intervals (13, 14); a vial banked before its test was done inherits the doubt. |
| **Who froze it** | The only way to ask. |

Our sheet carries the first three plus notes; `myco -` and `chip-` appear in the notes column often
enough to be a controlled vocabulary, which is why the app promotes them to searchable flags rather
than leaving them as free text.
