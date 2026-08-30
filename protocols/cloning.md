# Cloning

## Nek2(K37R) → YY1 swap in pCDH backbone

Cutting Nek2(K37R) out of the `pCDH-Nek2(K37R)` plasmid and replacing it with a YY1 sequence
PCR-amplified from a MORF library template. Started 31 Aug 2026, first day back from vacation.

**Fully scheduled, 31 Aug–3 Sep.** Originally PCR through plating in one long Monday, ending ~21:45.
**Changed 30 Aug 2026, per Umut:** ligation now runs **overnight** instead of the same-day 2h RT,
specifically so he isn't in lab for transformation and plating that night. That pushes transformation
and plating to Tuesday afternoon, which pushes colony-picking to Wednesday, miniprep + diagnostic
digest to Thursday, and the results check to Friday — each downstream step slides exactly one day.
Monday itself also starts 45 min earlier (08:15 instead of 09:00) so ligation setup — now the day's
last hands-on step — finishes by ~16:40 rather than 18:05.

- **Mon 31 Aug:** PCR → digestion → gel check → dephosphorylation → ligation setup → **ligation runs
  overnight**, done by ~16:40.
- **Tue 1 Sep:** transformation + SOC + plating, fit around that day's other bookings (afternoon).
- **Wed 2 Sep:** colony pick + overnight culture.
- **Thu 3 Sep:** miniprep + diagnostic digest + gel check.

**Still stale from before this change:** Umut's own recent phone edit to the (then) Wed 2 Sep
diagnostic-digest block had already dropped the "send for Sanger sequencing" event and the Thu 3 Sep
"confirm clone" step — only the "check sequencing results" reminder (dated Thu 3 Sep, saying
"submitted 2 Sep") was left standing. That reminder wasn't touched by this pass, since there's no
submission event anymore to hang it off and it isn't this change's call to make — it now shares
Thursday with the miniprep/digest work rather than a quiet "just check email" day. Needs Umut's own
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
| Restriction digestion (BamHI-EcoRI, insert and backbone) | **4 hours** | NEB HF "Time-Saver" enzymes are rated 5–15 min |
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
