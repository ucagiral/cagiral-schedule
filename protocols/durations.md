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
| Freezing cells (to −80 °C) | ~30 min hands-on | ~30 min | 4 h+ in the freezer | Controlled −1 °C/min; ≥4 h at −80 °C before liquid nitrogen. See [`cryopreservation.md`](cryopreservation.md). |
| Thawing a frozen vial | ~30 min | all | — | Thaw fast (<1–2 min at 37 °C), then dilute the DMSO out stepwise and plate; the time is handling, not the thaw. See [`cryopreservation.md`](cryopreservation.md). |
| Recovery after a thaw | 24–48 h | ~15 min | rest | Medium change the next day once the cells have attached; not confluent enough to passage before then. |
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
| PCR amplification (Q5/HF polymerase, ~1.3 kb product) | ~55–60 min | ~15–20 min setup | ~35–40 min run | Q5 extension runs 20–30 s/kb for complex templates, faster for a simple plasmid template. |
| Restriction digestion (NEB HF enzyme, published default) | 5–15 min | all | — | HF enzymes are Time-Saver qualified — digest 1 µg substrate in 5–15 min. **Superseded for the Nek2→YY1 swap by Umut's 4 h value below.** |
| Backbone dephosphorylation (Antarctic Phosphatase, NEB M0289) | ~80–85 min | ~5 min setup | ~60 min @ 37 °C + ~20 min heat-inactivation @ 80 °C | Standard protocol: 1 h @ 37 °C, then heat-inactivate 20 min @ 80 °C. |
| Agarose gel casting (melt, pour, comb, solidify) | ~30–40 min | ~5–10 min | 20–30 min RT (10–15 min @ 4 °C) | Melting and pouring is a few minutes' hands-on; standard protocols quote 20–30 min at room temperature to fully solidify, or 10–15 min chilled at 4 °C. **A gel has to already exist before a "load gel" step — it is not implicit.** |
| Agarose gel run (1%, standard fragment sizes) | ~40 min | ~5 min load | ~35 min run | Common protocol: 1% gel, 40 min at 50 V. |
| Gel extraction / PCR cleanup (spin column) | ~20–25 min | all | — | Gel dissolve ~10 min @ 50 °C plus successive 1-min spins. **Umut flags ~30% recovery efficiency for the kit in use — a yield risk, not a time change.** |
| Ligation (T4 DNA ligase, sticky ends, published default) | 10 min | all | — | NEB's standard quick protocol: 10 min RT for cohesive ends. **Superseded for the Nek2→YY1 swap by Umut's 2 h value below.** |
| Bacterial transformation (heat shock + SOC recovery + plating) | ~75–90 min | ~15–20 min (heat shock, plating) | ~60 min SOC recovery | 30 s heat shock @ 42 °C, then 60 min SOC @ 37 °C shaking. |
| Colony PCR screening (+ quick gel check) | ~90 min | ~25 min setup/load | ~65 min (PCR run + gel run) | Fast master mixes screen ≤2 kb inserts in ~60 min; extension ≥1 min/kb for standard mixes. |
| Diagnostic restriction digest + gel check | ~60–65 min | ~15 min | ~45–50 min | Same digest + 1% gel sources as above. |
| Sanger sequencing turnaround | next business day | ~15 min submit | ~24 h off-site | Standard commercial turnaround: data back by the next business day. |

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
| Nek2→YY1: BamHI-EcoRI digestion (insert and backbone) | 4 h — **this enzyme pair failed 31 Aug 2026, replaced** |
| Nek2→YY1: replacement-enzyme digestion (1 Sep redo) | ~1 h @ 37°C, standard (not Time-Saver) — Umut's call, specific to this pair |
| Nek2→YY1: ligation | overnight (changed 30 Aug 2026, was 2 h RT) — 16°C or 4°C, ~12-16 h |

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
- [NEB — PCR using Q5 High-Fidelity DNA Polymerase](https://www.neb.com/en-us/protocols/pcr-using-q5-high-fidelity-dna-polymerase-m0491)
- [NEB — Faster Digests (Time-Saver qualified HF enzymes)](https://www.neb.com/en-us/products/restriction-endonucleases/hf-nicking-master-mix-time-saver-other/high-fidelity-restriction-enzymes/high-fidelity-restriction-endonucleases/faster-digests)
- [NEB — vector dephosphorylation protocol (Antarctic Phosphatase, M0289)](https://www.neb.com/protocols/0001/01/01/vector-dephosphorylation-protocol)
- [Addgene — how to run an agarose gel](https://www.addgene.org/protocols/gel-electrophoresis/)
- [BBS OER Lab Manual — protocol for preparing 1% agarose gels](https://ecampusontario.pressbooks.pub/biochem2l06/chapter/1-2-2-protocol-for-preparing-1-agarose-gels/)
- [Biology LibreTexts — casting agarose gel](https://bio.libretexts.org/Bookshelves/Biotechnology/Introduction_to_Biotechnology_Laboratory_Manual_(Barron)/06:_Restriction_Digest_and_Gel_Electrophoresis_(New)/6.04:_Part_II-_Casting_Agarose_Gel)
- [NEB — quick tip: ideal incubation temperature for ligation](https://www.neb.com/en-us/tools-and-resources/video-library/quick-tip-what-is-the-ideal-incubation-temperature-for-ligation)
- [NEB — T4 DNA Ligase (M0202)](https://www.neb.com/en-us/products/m0202-t4-dna-ligase)
- [QIAGEN — QIAquick Spin Handbook (PCR/gel cleanup)](https://www.qiagen.com/en-US/resources/download/Protocols/hb-0901-003-1114358-pcard-qq-pcr-gel-cleanup-kit-0718-ww)
- [NEB — DNA ligation with T4 DNA Ligase (M0202)](https://www.neb.com/en/protocols/dna-ligation-with-t4-dna-ligase-m0202?pdf=true)
- [NEB — high efficiency transformation protocol](https://www.neb.com/en/protocols/high-efficiency-transformation-protocol-c2987)
- [Takara — colony PCR in under an hour](https://www.takarabio.com/learning-centers/pcr/technical-notes/colony-pcr-in-under-an-hour)
- [Sigma-Aldrich — colony PCR](https://www.sigmaaldrich.com/US/en/technical-documents/technical-article/genomics/pcr/colony-pcr)
- [GENEWIZ/Azenta — Sanger sequencing services](https://www.genewiz.com/en-gb/public/services/sanger-sequencing)
