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

## GATA6 KO HEK293T cells

**Goal**: Create stable GATA6 knockout HEK293T cell line for downstream ATF3 studies.

**Status**: Planning Phase 1

### Phase 1: Guide design & validation
**What it achieves**: Identify the most efficient CRISPR guide RNAs targeting GATA6.
**Verification**: Off-target assessment passed, in vitro cutting efficiency >70%.

Sub-steps:
- Design 3–5 gRNA candidates (Cas-OFFinder, CHOPCHOP)
- Order oligos and receive them
- Test cutting efficiency in vitro (guide + Cas9 + target DNA)
- Assess off-target binding (CHOPCHOP analysis)
- Select best guide (highest efficiency, lowest off-targets)

**Duration estimate**: 1–2 weeks  
**Depends on**: None (starting point)  
**Sources**: 
- Cas-OFFinder: http://cas-offinder.kbio.info
- CHOPCHOP: http://chopchop.cbu.uib.no

### Phase 2: Cloning
**What it achieves**: Verified lentiviral construct carrying GATA6 guide + Cas9.
**Verification**: Plasmid sequencing confirms construct, no unwanted deletions.

Sub-steps:
- Order or synthesize gRNA insert
- Clone into lentiviral backbone (pLentiCRISPR-v2 or equivalent)
- Verify with restriction digest
- Transform into competent bacteria
- Miniprep and send for sequencing
- Maxiprep for packaging

**Duration estimate**: 1–2 weeks  
**Depends on**: Phase 1  
**Sources**: Addgene pLentiCRISPR-v2

### Phase 3: Virus generation
**What it achieves**: High-titer lentiviral particles carrying GATA6 guide.
**Verification**: Viral titer ≥10^7 TU/mL, no contamination.

Sub-steps:
- Transfect HEK293T with packaging plasmids (Gag/Pol, Rev, VSV-G, construct)
- Collect media 48h and 72h post-transfection
- Concentrate and titer virus
- Store aliquots at −80 °C

**Duration estimate**: 3–5 days active, 2 weeks passive (incubations)  
**Depends on**: Phase 2  
**Sources**: Addgene lentiviral packaging protocol

### Phase 4: Transduction
**What it achieves**: HEK293T cells carrying stable GATA6 knockout construct.
**Verification**: PCR of genomic DNA shows Cas9-induced cuts.

Sub-steps:
- Transduce HEK293T with GATA6 lentivirus (MOI 1–5)
- Select with blasticidin (10 µg/mL) or hygromycin (100 µg/mL)
- Expand selected population
- Freeze backup stock

**Duration estimate**: 2–3 weeks (selection takes time)  
**Depends on**: Phase 3  
**Sources**: Standard lentiviral transduction

### Phase 5: KO validation
**What it achieves**: Confirm complete GATA6 knockout at DNA and protein level.
**Verification**: No GATA6 protein by Western; no WT DNA sequence at edit site.

Sub-steps:
- Extract genomic DNA, PCR across Cas9 cut site
- Sequence PCR product (GATA6 junction)
- Extract protein, run Western blot for GATA6
- qPCR for off-target sites (if available)

**Duration estimate**: 1–2 weeks  
**Depends on**: Phase 4  
**Sources**: Standard molecular validation

### Phase 6: Further experiments
**What it achieves**: Downstream work on GATA6 KO cells (ATF3 studies, growth assays, etc.).
**Verification**: Project-specific; update as needed.

Sub-steps:
- Cell viability and growth assays
- Cytokine profiling if relevant
- ATF3 induction experiments

**Duration estimate**: Ongoing  
**Depends on**: Phase 5  
**Sources**: Your research plan
