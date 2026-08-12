# Projects

Active projects and their phases. As each phase completes, check it off and plan the next one via the app.

---

## Template: [Project Name]

**Goal**: [One-sentence description of what you're building or validating]

**Status**: [Not started / Planning Phase N / Phase N in progress / Phase N complete]

### Phase 1: [Phase title]
**What it achieves**: [What you'll know or have after this phase]  
**Verification**: [How you confirm it worked]

Sub-steps:
- [Sub-step 1]
- [Sub-step 2]
- [Sub-step 3]

**Duration estimate**: [X days/weeks]  
**Depends on**: [Any prior phases or external factors]  
**Sources**: [Links to protocols, papers, or expert notes]

### Phase 2: [Phase title]
[Same structure...]

---

## How to add a new project

1. In the app, click **Plan Project**
2. Describe your goal (e.g., "GATA6 KO HEK293T cells")
3. Agent asks clarifying questions, researches methods, drafts a full breakdown
4. Review the breakdown (phases, reasoning, sources)
5. If it looks good: approve → generate calendar events for Phase 1
6. If you want changes: edit the breakdown directly in this file, then re-generate

---

## How to plan a phase

1. Click **Plan Project** → pick your project
2. Select which phase to plan
3. Agent generates calendar events, you review and confirm
4. Events land in the schedule and are linked to this project

---

## How to track progress

1. Mark events done on the calendar as you work
2. When a whole phase is done, update the status here
3. Click **Plan Project** again to auto-suggest the next phase

---

## AR locus CasPEx proteomics (LNCX / LUCX)

**Goal**: Name the proteins sitting at the AR promoter and AR enhancer in LNCaP and LuCaP-35CR, by
dCas9–APEX2 proximity labelling, and find what differs between the androgen-sensitive and the
castration-resistant line.

**Status**: Phase 1 in progress — guide virus due 14 Aug 2026

**Method**: [`protocols/caspex.md`](protocols/caspex.md) · **Practice**:
[`workflows.md`](workflows.md)

**Why this shape**: the expensive, irreversible step is the mass spec. Everything before it exists
to make sure that when samples are submitted, the guides are the right ones and the fusion is
demonstrably at the locus. The two gates before Phase 6 are deliberate — a negative proteomics
result is only worth having if occupancy was proven first.

### Phase 1: Guide virus in hand
**What it achieves**: 8 guide viruses — 4 AR promoter, 4 AR enhancer — ready to transduce.
**Verification**: Virus collected and stored; guides sequence-confirmed in the hygro vector.

Sub-steps:
- [x] Design 8 guides (4 promoter, 4 enhancer)
- [x] Clone guides into the hygromycin guide vector
- [ ] Generate and harvest guide virus
- [ ] Aliquot and store virus at −80 °C

**Duration estimate**: complete by 14 Aug 2026
**Depends on**: nothing outstanding
**Sources**: existing Virus prep thread on the calendar

### Phase 2: Transduce and select the guide lines
**What it achieves**: LNCX and LUCX each carrying each of the 8 guides — 16 selected populations.
**Verification**: Untransduced control dead by the day-6 hygromycin check.

Sub-steps:
- [ ] Thaw LNCX and LUCX (labmate, ~28 Aug)
- [ ] Count and seed for transduction (31 Aug)
- [ ] Transduce both lines with all 8 guide viruses
- [ ] Day-1 medium change after transduction
- [ ] Start hygromycin selection
- [ ] Day-6 hygromycin check against the untransduced control
- [ ] Freeze a backup vial of every selected line

**Duration estimate**: ~2 weeks — selection is 5–7 days, 6 standard
**Depends on**: Phase 1
**Sources**: [`workflows.md`](workflows.md) — hygromycin 5–7 days is our value, not the published 10–14

### Phase 3: Expand to labelling scale
**What it achieves**: Enough cells of all 16 populations, plus controls, to label at a few 15 cm
dishes per condition.
**Verification**: Dish counts reached with cells still in healthy passage range.

Sub-steps:
- [ ] Expand all 16 selected populations
- [ ] Expand the non-targeting sgRNA control lines
- [ ] Confirm mCherry still positive after selection

**Duration estimate**: 1–2 weeks after selection
**Depends on**: Phase 2

### Phase 4: Replicate 1 — choose the guides
**What it achieves**: The two best promoter guides and two best enhancer guides, per line.
**Verification**: Guide-dependent shift on the streptavidin blot, above the non-targeting control.
**This replicate does not go to mass spec.** It exists only to pick guides.

Sub-steps:
- [ ] Add doxycycline + Shield-1, 2 days before labelling
- [ ] Biotin-phenol 30 min, H₂O₂ exactly 1 min, immediate quench — all 8 guides, both lines
- [ ] Run the no-H₂O₂ and no-Shield-1 controls alongside
- [ ] Streptavidin blot on every condition, blocked in BSA
- [ ] Rank guides and pick 2 promoter + 2 enhancer

**Duration estimate**: ~1 week including the 2-day induction lead-in
**Depends on**: Phase 3
**Sources**: [`protocols/caspex.md`](protocols/caspex.md)

### Phase 5: Occupancy gate — ChIP-qPCR
**What it achieves**: Direct evidence that dCas9–APEX2 is at the AR locus with the chosen guides.
**Verification**: FLAG ChIP-qPCR enriched at target over the non-targeting guide and a control region.

Sub-steps:
- [ ] Crosslink, lyse and sonicate to 150–200 bp
- [ ] FLAG immunoprecipitation, overnight at 4 °C
- [ ] Elute and reverse-crosslink
- [ ] qPCR across target and control regions
- [ ] Decide go/no-go for mass spec

**Duration estimate**: 2–3 days per round, two overnights
**Depends on**: Phase 4
**Sources**: [`protocols/durations.md`](protocols/durations.md)

### Phase 6: Replicates 2 and 3, and mass spec
**What it achieves**: Three biological replicates of the 4 chosen guides per line, enriched and
submitted.
**Verification**: Blot confirms labelling in every replicate before it is enriched.

Sub-steps:
- [ ] Replicate 2 — 2 promoter + 2 enhancer guides, both lines
- [ ] Replicate 3 — run concurrently with submission
- [ ] Streptavidin pulldown, in-house
- [ ] On-bead digest, overnight
- [ ] Submit peptides to the core facility
- [ ] Wait on the facility queue

**Duration estimate**: several weeks of bench work, then weeks of facility turnaround
**Depends on**: Phase 5 passing both gates
**Sources**: [`workflows.md`](workflows.md)

### Phase 7: Analysis and the actual question
**What it achieves**: The AR-locus proteome of each line, and the difference between them.
**Verification**: Known AR-locus factors recovered in the targeted samples and absent from
non-targeting — the internal check that the whole thing worked.

Sub-steps:
- [ ] Filter against non-targeting and no-H₂O₂ backgrounds
- [ ] Remove endogenous biotinylated carboxylases
- [ ] Compare LNCaP against LuCaP-35CR
- [ ] Pick candidates worth validating
- [ ] Validate the strongest candidates independently

**Duration estimate**: ongoing
**Depends on**: Phase 6

---

## GATA6 KO HEK293T cells

**Goal**: Create stable GATA6 knockout HEK293T cell line for downstream ATF3 studies.

**Status**: Planning Phase 1

### Phase 1: Guide design & validation
**What it achieves**: Identify the most efficient CRISPR guide RNAs targeting GATA6.
**Verification**: Off-target assessment passed, in vitro cutting efficiency >70%.

Sub-steps:
- [ ] Design 3–5 gRNA candidates (Cas-OFFinder, CHOPCHOP)
- [ ] Order oligos and receive them
- [ ] Test cutting efficiency in vitro (guide + Cas9 + target DNA)
- [ ] Assess off-target binding (CHOPCHOP analysis)
- [ ] Select best guide (highest efficiency, lowest off-targets)

**Duration estimate**: 1–2 weeks  
**Depends on**: None (starting point)  
**Sources**: 
- Cas-OFFinder: http://cas-offinder.kbio.info
- CHOPCHOP: http://chopchop.cbu.uib.no

### Phase 2: Cloning
**What it achieves**: Verified lentiviral construct carrying GATA6 guide + Cas9.
**Verification**: Plasmid sequencing confirms construct, no unwanted deletions.

Sub-steps:
- [ ] Order or synthesize gRNA insert
- [ ] Clone into lentiviral backbone (pLentiCRISPR-v2 or equivalent)
- [ ] Verify with restriction digest
- [ ] Transform into competent bacteria
- [ ] Miniprep and send for sequencing
- [ ] Maxiprep for packaging

**Duration estimate**: 1–2 weeks  
**Depends on**: Phase 1  
**Sources**: Addgene pLentiCRISPR-v2

### Phase 3: Virus generation
**What it achieves**: High-titer lentiviral particles carrying GATA6 guide.
**Verification**: Viral titer ≥10^7 TU/mL, no contamination.

Sub-steps:
- [ ] Transfect HEK293T with packaging plasmids (Gag/Pol, Rev, VSV-G, construct)
- [ ] Collect media 48h and 72h post-transfection
- [ ] Concentrate and titer virus
- [ ] Store aliquots at −80 °C

**Duration estimate**: 3–5 days active, 2 weeks passive (incubations)  
**Depends on**: Phase 2  
**Sources**: Addgene lentiviral packaging protocol

### Phase 4: Transduction
**What it achieves**: HEK293T cells carrying stable GATA6 knockout construct.
**Verification**: PCR of genomic DNA shows Cas9-induced cuts.

Sub-steps:
- [ ] Transduce HEK293T with GATA6 lentivirus (MOI 1–5)
- [ ] Select with blasticidin (10 µg/mL) or hygromycin (100 µg/mL)
- [ ] Expand selected population
- [ ] Freeze backup stock

**Duration estimate**: 2–3 weeks (selection takes time)  
**Depends on**: Phase 3  
**Sources**: Standard lentiviral transduction

### Phase 5: KO validation
**What it achieves**: Confirm complete GATA6 knockout at DNA and protein level.
**Verification**: No GATA6 protein by Western; no WT DNA sequence at edit site.

Sub-steps:
- [ ] Extract genomic DNA, PCR across Cas9 cut site
- [ ] Sequence PCR product (GATA6 junction)
- [ ] Extract protein, run Western blot for GATA6
- [ ] qPCR for off-target sites (if available)

**Duration estimate**: 1–2 weeks  
**Depends on**: Phase 4  
**Sources**: Standard molecular validation

### Phase 6: Further experiments
**What it achieves**: Downstream work on GATA6 KO cells (ATF3 studies, growth assays, etc.).
**Verification**: Project-specific; update as needed.

Sub-steps:
- [ ] Cell viability and growth assays
- [ ] Cytokine profiling if relevant
- [ ] ATF3 induction experiments

**Duration estimate**: Ongoing  
**Depends on**: Phase 5  
**Sources**: Your research plan
