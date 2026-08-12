# Duration estimates

Every event that gets created or re-timed is given a duration backed by a web lookup, not a guess.
This file is where those lookups land, so the same procedure doesn't have to be researched from
scratch each time — but it is a record, not a shortcut: the search still happens, and if a newer or
better source disagrees, the row gets updated.

**Hands-on vs. unattended is recorded separately**, because that is what decides whether other work
can be scheduled on top. A 2 h transfer costs 15 minutes of attention; a 30 min miniprep costs 30.

| Procedure | Total | Hands-on | Unattended | Source basis |
|---|---|---|---|---|
| Plasmid miniprep (spin column) | 30–45 min | all | — | Kits advertise 30 min or less; PureLink quotes 30–45 min. |
| Bacterial culture (overnight) | 12–16 h | ~10 min | rest | Standard overnight growth. |
| RNA isolation (spin column) | 25–40 min | all | — | Column kits quote 25–40 min; often "within 30 minutes". |
| cDNA / reverse transcription | ~60–65 min | ~15 min | ~50 min | 60 min at 48 °C plus a 5 min 85 °C inactivation. |
| qPCR plate setup | ~30 min | all | — | ~30 min for a full 384-well plate by hand or robot. |
| qPCR run (40 cycles) | ~2 h | ~5 min | rest | Facilities book 2 h on the instrument. |
| Cell passaging / trypsinisation | 20–30 min | all | — | Trypsin 1–3 min; the time is handling, spin and counting. |
| Cell seeding | 20–30 min | all | — | As above, plus counting and plating. |
| Freezing cells (to −80 °C) | ~30 min hands-on | ~30 min | 4 h+ in the freezer | Controlled −1 °C/min; ≥4 h at −80 °C before liquid nitrogen. |
| Lentivirus — transfection | ~1 h | all | — | Morning of day 1, then medium change 6 h later. |
| Lentivirus — medium change | ~30 min | all | — | 6 h post-transfection in most protocols; some at ~42 h. |
| Lentivirus — harvest | ~1 h | all | — | 48–72 h post-transfection is the usual window; often harvested twice. |
| Western blot | see [`western-blot.md`](western-blot.md) | | | Surveyed separately, 16 protocols. |
| gRNA design (in silico) | ~3–4 h | all | — | Desk work, no measured bench figure published. Current Protocols' CHOPCHOP walkthrough runs design → off-target review → oligo ordering as one sitting. Treat as a half-day, not an hour. |
| In vitro Cas9 cleavage assay | ~2.5 h | ~1 h | ~1.5 h | 60 min RNP + target at 37 °C is the common incubation (10 min at the fast end), then Proteinase K and an agarose gel. The incubation and the gel run are unattended. |
| Lentiviral transduction | ~1 h | all | 48–72 h after | Hands-on is adding virus; the infection itself sits 48–72 h before selection starts. |
| Antibiotic selection (puro/blast/hygro) | **10–14 days** | ~30 min per feed | rest | Selection begins 48 h post-transduction and runs 3–10 days, re-fed every 2–3 days until the untransduced control is dead. Schedule the feeds, not one block. **Umut's hygromycin window is 5–7 days, 6 standard** — his value wins. |
| APEX2 biotinylation (labelling day) | ~1.5 h | all | — | 30 min biotin-phenol at 37 °C, H₂O₂ for 30 s–1 min, immediate quench, then washes. The H₂O₂ minute is exact and the quench can't be late. Scale multiplies the hands-on, not the clock. |
| Dox + Shield-1 induction | **2 days before labelling** | ~20 min to dose | rest | Umut's value. Makes a labelling date a three-day commitment. |
| Streptavidin pulldown + on-bead digest | ~1 day hands-on, overnight digest | ~4–5 h | overnight | Bead capture and washes are a long bench day; the tryptic digest runs overnight. |
| ChIP-qPCR (to the plate) | **2–3 days** | ~5–6 h total | 2 overnights | 10 min formaldehyde crosslink + glycine, lysis, sonication to 150–200 bp, **overnight IP at 4 °C**, elution 65 °C, then reverse-crosslink ≥5 h or overnight, cleanup, qPCR. Not a one-day assay. |
| FACS sorting (mCherry) | ~2–4 h | all | — | Instrument time plus prep; needs booking, and cells need recovery afterwards. |
| Nuclear / cytoplasmic fractionation | ~2–3 h | ~2.5 h | — | Kit protocols quote under 2 h; a full stepwise fractionation runs to ~3 h with ~2.5 h hands-on. Ice incubations of 15–20 min and low-speed spins throughout. |
| Colony formation — fixation | **15 min** | all | — | **Umut's value.** Published fixations sit in the same range: ice-cold methanol 10 min, or methanol/acetic acid. Glutaraldehyde 6% is the other common choice. |
| Colony formation — drying | ~4 h | ~5 min | rest | Air-dry at room temperature. Protocols quote ~4 h, and plates can be left "up to a few days" without harm — so the block marks the day, not a deadline. |

## Protocol-specific timings we've fixed

These came from Umut directly and override any published range — see
[`../workflows.md`](../workflows.md):

| Step | Our value |
|---|---|
| Boil protein samples | 30 min: 15 active + 15 passive |
| Wet transfer | 2 h |
| Western block | 1 h |
| Western primary / secondary antibody | 1 h each |
| Western strip | 20 min |
| Virus medium change | 6.5 mL per vessel |

## Sources

- [Promega — PureYield plasmid miniprep system](https://www.promega.com/products/nucleic-acid-extraction/plasmid-purification/pureyield-plasmid-miniprep-system/)
- [Thermo Fisher — PureLink Quick Plasmid Miniprep Kit](https://www.thermofisher.com/order/catalog/product/K210011)
- [Thermo Fisher — spin column purification](https://www.thermofisher.com/us/en/home/life-science/dna-rna-purification-analysis/spin-column-purification.html)
- [Thermo Fisher — five steps to optimal cDNA synthesis](https://www.thermofisher.com/us/en/home/life-science/pcr/reverse-transcription/5steps-cDNA.html)
- [Sigma-Aldrich — Transcriptor High Fidelity cDNA Synthesis Kit](https://www.sigmaaldrich.com/deepweb/assets/sigmaaldrich/product/documents/318/886/thificdnaro.pdf)
- [Integra Biosciences — setting up a 384-well qRT-PCR plate by hand](https://www.integra-biosciences.com/united-states/en/applications/setting-384-well-qrt-pcr-assay-viiatm-7-using-viaflo-and-voyager-electronic-pipettes)
- [EPFL Gene Expression Core Facility — standard qPCR](https://www.epfl.ch/research/facilities/gene-expression-core-facility/page-112636-en-html/standard-qpcr)
- [Ubigene — practical HEK293 cell culture protocols](https://www.ubigene.us/application/hek293-cell-culture.html)
- [HEK293.com — cryopreservation](https://hek293.com/hek293-cryopreservation/)
- [BYU Tessem lab — HEK293T tissue culture protocols](https://ndfs.byu.edu/tessem-lab/hek-293t-tissue-culture-protocols)
- [Current Protocols in Molecular Biology — optimized transgene delivery using third-generation lentiviruses](https://currentprotocols.onlinelibrary.wiley.com/doi/10.1002/cpmb.125)
- [Acta Biochim Biophys Sin — simple protocol for producing high-titer lentivirus](https://academic.oup.com/abbs/article/45/12/1079/1198)
- [Roswell Park — SOP for lentivirus production using HEK293T cells](https://www.roswellpark.org/sites/default/files/2021-11/sop-for-lentiviral-packaging.doc)
- [Current Protocols — CRISPR genome editing made easy through the CHOPCHOP website](https://currentprotocols.onlinelibrary.wiley.com/doi/10.1002/cpz1.46)
- [Bio-protocol — in vitro cleavage and electrophoretic mobility shift assays](https://bio-protocol.org/en/bpdetail?id=4138&type=0)
- [Chemical Science — Cas9 cleavage assay for pre-screening of sgRNAs](https://pubs.rsc.org/sc/article/7/8/4951/545870/Cas9-cleavage-assay-for-pre-screening-of-sgRNAs)
- [Addgene — generating stable cell lines](https://www.addgene.org/protocols/generating-stable-cell-lines/)
- [Creative Biogene — guide to stable lentiviral cell line construction](https://www.creative-biogene.com/support/comprehensive-guide-to-stable-lentiviral-cell-line-construction.html)
- [GeneMedi — lentivirus infection protocol for stable cell line development](https://www.genemedi.net/i/lentivirus-infection-protocol-for-cld)
- [Nature Methods — dCas9–APEX proximity labeling at a predefined genomic locus (CasPEx / GLoPro)](https://www.nature.com/articles/s41592-018-0007-1)
- [An optimized protocol for proximity biotinylation using APEX2](https://www.sciencedirect.com/science/article/pii/S2666166720300617)
- [STAR Protocols — APEX2 biotin-labeling in mammalian cells](https://www.cell.com/star-protocols/fulltext/S2666-1667(24)00533-1)
- [Rockland — chromatin immunoprecipitation (ChIP) protocol](https://www.rockland.com/globalassets/documents/protocols/chromatin-immunoprecipitation-chip-protocol.pdf)
- [Antibodies.com — ChIP protocol](https://www.antibodies.com/applications/chromatin-immunoprecipitation/chip-protocol)
- [Thermo Fisher — NE-PER nuclear and cytoplasmic extraction reagents](https://www.thermofisher.com/order/catalog/product/78833)
- [Abcam — nuclear extraction and fractionation protocol](https://www.abcam.com/en-us/technical-resources/protocols/nuclear-extraction-and-fractionation)
- [STAR Protocols — nucleo-cytoplasmic fractionation of mammalian cells](https://www.cell.com/star-protocols/fulltext/S2666-1667(25)00671-9)
- [Abcam — colony formation assay: studying cell survival](https://www.abcam.com/en-us/knowledge-center/cell-biology/colony-formation-assay)
- [Bio-protocol — clonogenic assay](https://bio-protocol.org/en/bpdetail?id=187&type=0)
- [Bio-protocol — colony-forming assay stained with crystal violet](https://bio-protocol.org/bio101/r9868896)
