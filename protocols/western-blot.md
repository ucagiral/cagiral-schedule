# Western blot — what the published protocols agree on

A survey of vendor and academic protocols, done to put realistic durations on the schedule
rather than guessing. Where protocols disagree the spread is given, so a step can be widened or
narrowed without re-reading everything.

For how *we* actually run it — our own timings and the reasons behind them — see
[`../workflows.md`](../workflows.md). This file is the outside reference; that one is the record of
our practice.

## Protocols surveyed

| # | Source | Used for |
|---|---|---|
| 1 | Abcam — western blot protocol, electrophoresis guide, stripping guide, ECL guide | run, transfer, blocking, stripping, detection |
| 2 | Bio-Rad — western blot protocol (PrecisionAb), *General Protocol for Western Blotting* (Bulletin 6376), immunodetection guide | blocking, antibodies, washes |
| 3 | Cell Signaling Technology — western blot procedure | denaturation, blocking, primary |
| 4 | Thermo Fisher / Pierce — western blot protocols, stripping & reprobing | transfer, stripping |
| 5 | R&D Systems / Bio-Techne — SDS-PAGE loading and running the gel | run conditions |
| 6 | Boster Bio — western blot protocol, blocking buffer optimization | blocking choice |
| 7 | Proteintech — western blot protocol | overall workflow |
| 8 | Novus Biologicals — SDS-PAGE & WB protocols, illustrated assay | transfer times |
| 9 | Atlas Antibodies — standard WB protocol, BSA-blocking WB protocol | BSA blocking, washes |
| 10 | Sigma-Aldrich / Merck — stripping and reprobing, chemiluminescence detection | stripping, ECL |
| 11 | Promega — ECL substrate technical manual (TM317) | ECL incubation |
| 12 | Addgene — western blot protocol, stripping and reprobing | overall workflow, stripping |
| 13 | Rockland — SDS-PAGE protocol, tips for biotin/avidin/streptavidin | biotin detection |
| 14 | Boston BioProducts — SDS-PAGE & western blot protocol | run and transfer |
| 15 | BioTechniques — *Sequential use of milk and BSA for streptavidin-probed western blot* | biotin blocking |
| 16 | Azure Biosystems, StarrLab (UMN) — stripping | stripping |

## The consensus

| Step | Common value | Range seen | Notes |
|---|---|---|---|
| Denature sample | **5 min at 95–100 °C**, cool on ice | 5–10 min | Near-universal. |
| Load gel | 10–15 min | — | Hands-on. |
| SDS-PAGE run | **~1–1.5 h at 100 V** | 1–2 h; some start 50 V for 5 min, then 100–150 V | Real endpoint is the dye front reaching the bottom, not the clock. |
| Wet (tank) transfer | **1–2 h**, commonly 1 h at 100 V | 30 min–2 h, or overnight at low power | Overnight low-power favoured for large proteins. |
| Blocking | **1 h at room temperature** | 30 min–2 h, or overnight at 4 °C | 3–5% BSA or 5% non-fat milk in TBS-T. |
| Primary antibody | **1 h at RT** *or* **overnight at 4 °C** | 30 min–overnight | Overnight 4 °C is the default in CST and Bio-Rad protocols. |
| Wash after primary | **3 × 5 min TBS-T** | 3 × 5 to 3 × 10 min | |
| Secondary antibody (HRP) | **1 h at RT** | — | Very consistent across sources. |
| Wash after secondary | **3–4 × 5 min TBS-T** | 3 × 5 to 4 × 5 min | |
| ECL + imaging | **1–5 min substrate**, image immediately | 1–5 min | Signal decays noticeably within an hour. |
| Stripping (mild buffer) | **20 min** (2 × 10 min, fresh buffer at 10 min) | 10 min–1 h | Glycine/SDS/Tween buffer. Rinse well, then **re-block** before reprobing. |

## Biotin targets with streptavidin-HRP

This comes up every time and is the most common way to ruin the blot:

- **Do not block in milk.** Milk carries endogenous biotin, which competes with the biotinylated
  target for streptavidin and gives high background and false positives.
- **Use 3–5% BSA in TBS-T** instead. Restrict any milk to a first blocking step only, if used at all.
- **Streptavidin-HRP is already conjugated** — there is no secondary antibody step. Block →
  streptavidin-HRP → wash → ECL.

## Practical shape of a day

Hands-on time is a small fraction of the elapsed time. Roughly:

- **Unattended stretches:** the gel run (~1.5 h), the transfer (2 h), blocking (1 h), each antibody
  incubation (1 h). These are where other bench work goes.
- **Hands-on:** sample prep and loading, assembling the transfer, washes, ECL and imaging.

A single-target blot from loading to image runs about **7 hours**. Adding a stripped reprobe on the
same day pushes it past 10 hours, which is why we split it across two days.

## Sources

- [Abcam — western blot protocol](https://www.abcam.com/en-us/technical-resources/protocols/western-blot)
- [Abcam — membrane stripping](https://www.abcam.com/en-us/technical-resources/guides/western-blot-guide/membrane-stripping-for-western-blot)
- [Abcam — electrophoresis: gel & run conditions](https://www.abcam.com/en-us/technical-resources/guides/western-blot-guide/electrophoresis)
- [Bio-Rad — general protocol for western blotting (Bulletin 6376)](https://www.bio-rad.com/webroot/web/pdf/lsr/literature/Bulletin_6376.pdf)
- [Bio-Rad — western blot protocol](https://www.bio-rad-antibodies.com/western-blot-protocol.html)
- [Bio-Rad — immunodetection: blocking and antibody incubation](https://www.bio-rad-antibodies.com/immunodetection-blocking-antibody-incubation-western-blotting.html)
- [Cell Signaling Technology — western blot procedure](https://www.cellsignal.com/learn-and-support/protocols/protocol-western)
- [Thermo Fisher — western blot protocols](https://www.thermofisher.com/us/en/home/life-science/protein-biology/protein-biology-learning-center/protein-gel-electrophoresis-information/western-blot-protocols.html)
- [Thermo Fisher — stripping and reprobing western blots](https://www.thermofisher.com/us/en/home/life-science/protein-biology/protein-biology-learning-center/protein-biology-resource-library/pierce-protein-methods/stripping-reprobing-western-blots.html)
- [R&D Systems — loading and running the gel](https://www.rndsystems.com/applications/western-blotting/western-blot-sds-page)
- [Boster Bio — western blot protocol](https://www.bosterbio.com/protocol-and-troubleshooting/western-blot-protocol)
- [Boster Bio — blocking buffer optimization](https://www.bosterbio.com/protocol-and-troubleshooting/western-blotting-optimization/blocking)
- [Proteintech — western blot protocol](https://www.ptglab.com/support/western-blot-protocol/western-blot-protocol/)
- [Novus Biologicals — SDS-PAGE & western blot protocol](https://novusbio.com/support/protocols/sds-page-&-western-blot-protocol-nbp1-54576.html)
- [Atlas Antibodies — western blot protocol, BSA blocking](https://www.atlasantibodies.com/knowledge-hub/protocols-for-antibody-applications/western-blot-protocol-bsa-blocking/)
- [Sigma-Aldrich — stripping and reprobing western blotting membranes](https://www.sigmaaldrich.com/US/en/technical-documents/protocol/protein-biology/western-blotting/stripping-and-reprobing-western-blotting-membranes)
- [Sigma-Aldrich — chemiluminescence detection](https://www.sigmaaldrich.com/US/en/technical-documents/protocol/protein-biology/western-blotting/chemiluminescence-detection)
- [Promega — ECL western blotting substrate protocol (TM317)](https://www.promega.com/-/media/files/resources/protocols/technical-manuals/101/ecl-western-blotting-substrate-protocol.pdf)
- [Addgene — western blot protocol](https://www.addgene.org/protocols/western-blot/)
- [Addgene — stripping and reprobing western blots](https://blog.addgene.org/how-to-strip-and-re-probe-a-western-blot)
- [Rockland — tips for biotin, avidin & streptavidin](https://www.rockland.com/resources/tips-for-biotin-avidin-and-streptavidin/)
- [Rockland — SDS-PAGE protocol](https://www.rockland.com/resources/sds-page-protocol/)
- [Boston BioProducts — SDS-PAGE and western blot protocol](https://www.bostonbioproducts.com/wp/wp-content/uploads/2025/07/BBP_SDS-PAGE_Western_Blot_Protocol.pdf)
- [BioTechniques — sequential use of milk and BSA for streptavidin-probed western blot](https://www.tandfonline.com/doi/full/10.2144/btn-2018-0006)
- [Azure Biosystems — how stripping buffer works](https://azurebiosystems.com/blog/stripping-and-western-blotting-factors-to-consider/)
- [StarrLab (UMN) — stripping and reprobing a western blot membrane](https://sites.google.com/a/umn.edu/starrlab/protocols/western-blot/stripping-and-reprobing-a-western-blot-membrane)
