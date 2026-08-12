# CasPEx — locus-specific proximity labelling

The method behind the LNCX/LUCX project: a catalytically dead Cas9 fused to the engineered
ascorbate peroxidase APEX2, guided to one genomic locus, biotinylating whatever protein sits near
it. Streptavidin then enriches those proteins and mass spectrometry names them.

Published as **CasPEx / GLoPro** — Myers et al., *Nature Methods* 2018 — the outside reference our
practice is measured against. What Umut actually does is in [`../workflows.md`](../workflows.md);
this file is the published version.

---

## What the method does

dCas9 carries APEX2 to a locus chosen by the sgRNA. Add biotin-phenol, then a brief pulse of
H₂O₂: APEX2 converts the phenol to a radical that lives long enough to label only what is within a
few tens of nanometres. Everything further away is untouched. The radical's short life is the whole
point — it is what makes the labelling *local* rather than cell-wide.

No crosslinking and no genome engineering are needed, so the snapshot is of proteins genuinely at
the locus in living cells.

## The published reaction

| Step | Published | Note |
|---|---|---|
| Biotin-phenol | 500 µM – 2.5 mM, **30 min at 37 °C** | Concentration varies by protocol; the 30 min pre-incubation is consistent |
| H₂O₂ | 1 mM, **30 s – 1 min** | 1 min is enough to detect biotinylated protein; 3 min gives more. Timing is exact and matters |
| Quench | Immediate | PBS with 10 mM sodium ascorbate, 10 mM sodium azide, 5 mM Trolox |
| Enrichment | Streptavidin magnetic beads | Boil in Laemmli for a blot, or on-bead digest for LC-MS/MS |

**The quench is not a step you can be late for.** The reaction runs until ascorbate and Trolox stop
it, so labelling time is only as precise as the quench.

## Why a single locus is hard

A locus is one or two copies per cell against a whole proteome of background. Two consequences that
shape every experiment:

- **Endogenous biotin is a real background.** Carboxylases are biotinylated in every cell whether
  or not the reaction happens, so a parental-cell lane is not optional.
- **Specificity has to be demonstrated, not assumed.** A non-targeting sgRNA carrying the same
  fusion is the control that separates "proteins at the AR locus" from "proteins near dCas9".

This is also why the streptavidin blot must be **blocked in BSA, never milk** — milk carries
endogenous biotin and competes for the streptavidin. That rule is already recorded in
[`western-blot.md`](western-blot.md) and it exists because of this assay.

## Controls the method requires

| Control | What it rules out |
|---|---|
| Non-targeting sgRNA | Proteins near the fusion anywhere, rather than at the target |
| No H₂O₂ (or no biotin-phenol) | Signal that isn't from the labelling reaction |
| Parental / untransduced | Endogenous biotinylated carboxylases |
| No inducer | Background from the construct being present at all |

## Sources

- [Nature Methods — Discovery of proteins associated with a predefined genomic locus via dCas9–APEX-mediated proximity labeling](https://www.nature.com/articles/s41592-018-0007-1)
- [bioRxiv — CRISPR/Cas9-APEX-mediated proximity labeling enables discovery of proteins associated with a predefined genomic locus in living cells](https://www.biorxiv.org/content/10.1101/159517v1.full)
- [Methods in Enzymology — Adapting dCas9-APEX2 for subnuclear proteomic profiling](https://www.sciencedirect.com/science/article/abs/pii/S0076687918304452)
- [STAR Protocols — identifying endogenous interactors of RNA-binding proteins using APEX2 biotin labeling](https://www.cell.com/star-protocols/fulltext/S2666-1667(24)00533-1)
- [An optimized protocol for proximity biotinylation in confluent epithelial cell cultures using APEX2](https://www.sciencedirect.com/science/article/pii/S2666166720300617)
- [PMC — an APEX2 proximity ligation method for mapping interactions with the nuclear lamina](https://pmc.ncbi.nlm.nih.gov/articles/PMC7737704/)
