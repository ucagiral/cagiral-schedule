# Cloning

## Nek2(K37R) → YY1 swap in pCDH backbone

**Cancelled 2 Sep 2026, per Umut.** Everything below is the record of what actually ran, 31 Aug–1
Sep, kept for reference — nothing past that point (transformation onward) happened, and no calendar
events for it exist from 2 Sep on. If this swap comes back later it's a fresh planning pass, not a
resume of this one — check with Umut on cell/reagent state (the ligated product from 1 Sep, whether
the replacement-enzyme digest conditions above are still the right starting point) rather than
assuming this thread just continues.

Cutting Nek2(K37R) out of the `pCDH-Nek2(K37R)` plasmid and replacing it with a YY1 sequence
PCR-amplified from a MORF library template. Started 31 Aug 2026, first day back from vacation.

**Fully scheduled, 31 Aug–3 Sep.** Originally PCR through plating in one long Monday, ending ~21:45.
**Changed 30 Aug 2026, per Umut:** ligation now runs **overnight** instead of the same-day 2h RT,
specifically so he isn't in lab for transformation and plating that night. That pushes transformation
and plating to Tuesday afternoon, which pushes colony-picking to Wednesday, miniprep + diagnostic
digest to Thursday, and the results check to Friday — each downstream step slides exactly one day.
Monday itself also starts 45 min earlier (08:15 instead of 09:00) so ligation setup — now the day's
last hands-on step — finishes by ~16:40 rather than 18:05.

- **Mon 31 Aug:** PCR → digestion → gel check → dephosphorylation → ligation setup → ligation
  (originally planned to run overnight, done by ~16:40) — **superseded, see below.**

**One of the original restriction enzymes failed (found 31 Aug, end of day).** Umut ran the day as
planned but the digest didn't work — one of the enzyme pair wasn't cutting. Before leaving, he set
up a fresh backbone-only digest with a different, working enzyme pair; the original insert digest
was a write-off. **31 Aug's own calendar events were left exactly as they were run** — this is a
correction to the days *after*, not a rewrite of what already happened.

- **Tue 1 Sep** (redo, replaces the original Mon 31 Aug afternoon): insert **re-amplified by PCR**
  from scratch (the original digest consumed it), then digested with the replacement enzymes; backbone
  (already digested 31 Aug) gets AP treatment in parallel; fresh gel check, extraction, ligation setup
  → **ligation overnight** again, done by ~17:05. Last real step — the project was cancelled the
  next day, before transformation.

The rest of the plan as it stood when the project was cancelled, never scheduled or run:
transformation + SOC + plating (was going to be Wed 2 Sep), colony pick + overnight culture (Thu 3
Sep), miniprep + diagnostic digest + gel check (Fri 4 Sep).

**Insert digest duration for the replacement enzymes: standard ~1h @ 37°C** (Umut's call, 31 Aug
2026) — not his usual 4h override, which was specific to the original BamHI-EcoRI pair and doesn't
automatically carry over to a different enzyme pair. If the replacement enzymes turn out to need a
different time, that's a new value to record, not an extension of the old one.

**Still stale, independent of the redo:** Umut's own earlier phone edit to the (then) diagnostic-digest
block had already dropped the "send for Sanger sequencing" event and the "confirm clone" step — only
the "check sequencing results" reminder was left standing, still saying "submitted 2 Sep" and still
not attached to any actual submission event. Not touched by this pass either — needs Umut's own
decision on when/whether sequencing gets submitted this round.

**Standalone thread.** Not related to GATA6, AR-CasPEx, or LNCX/LUCX — no shared group, no shared
notes, nothing linking it to any of them. Also not tracked as a project: no `projects.md` entry, no
`project`/`phase` fields on its events. It's calendar events plus its own colour group (`Nek2→YY1`,
fuchsia `#d946ef`, see [`../workflows.md`](../workflows.md)) and nothing more.

### Method: restriction digest + ligation

Gibson/NEBuilder seamless assembly was offered and declined — primers with restriction-site tails
for YY1 were already in hand, so a classic digest-and-ligate route was faster to start.

1. PCR-amplify YY1 from the MORF library template with the existing restriction-site-tailed
   primers. Runs **first, alone** — nothing else starts until the PCR product exists.
2. Once the PCR product is in hand, the two digestions — YY1 insert and pCDH backbone — are set up
   **together and run simultaneously**, not staggered.
3. Backbone is dephosphorylated (Antarctic Phosphatase) straight after its digest, to suppress
   self-ligation background.
4. Both backbone and insert are isolated by gel extraction.
5. Ligation, then transformation with positive and negative controls.

### Parameters that are Umut's stated values, not published defaults

Per the working agreement, anything he states directly overrides a published range:

| Parameter | Value | Published default it overrides |
|---|---|---|
| Restriction digestion (original BamHI-EcoRI pair, insert and backbone) | **4 hours** | NEB HF "Time-Saver" enzymes are rated 5–15 min. **This enzyme pair failed 31 Aug 2026** — one of the two wasn't cutting — and was replaced. |
| Restriction digestion (replacement enzyme pair, 1 Sep redo) | **~1 hour @ 37°C** | Standard, not Time-Saver-rated — Umut's call for this specific pair, doesn't inherit the 4h value above |
| Ligation (T4 DNA ligase) | **overnight** (changed 30 Aug 2026, was 2h RT) | NEB's standard quick protocol is ~10 min RT; NEB recommends 16°C overnight, Promega 4°C overnight, both ~12-16h, for higher transformant yield than RT |

### Other fixed parameters

- **Gel clean-up kit recovery: ~30%.** This doesn't change any scheduled duration — elapsed time
  is the same regardless of yield — but it's the first thing to suspect if downstream
  ligation/transformation looks inefficient, before assuming the ligation itself failed.
- **Controls, added at the ligation/transformation stage:**
  - *Negative control*: an aliquot of the AP-treated, digested backbone carried through ligation
    without insert — measures self-religation background. No extra digest reaction; just a split
    at the ligation step.
  - *Positive control*: a small aliquot of the original, undigested `pCDH-Nek2(K37R)` stock,
    transformed directly (skipping ligation) — confirms the competent cells and heat-shock protocol
    work independent of the cloning itself.

### Sources

Timing baselines that Umut's values above supersede — see
[`durations.md`](durations.md#sources) for the full reference list (NEB Q5 PCR, NEB Faster Digests,
NEB Antarctic Phosphatase, Addgene gel electrophoresis, QIAGEN QIAquick handbook, NEB T4 ligation,
NEB high-efficiency transformation, Takara/Sigma colony PCR, GENEWIZ/Azenta Sanger sequencing).
