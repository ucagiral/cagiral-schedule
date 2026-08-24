# Chromosome looping — what the public data can and cannot tell us

Written to support [`tools/loops/`](../tools/loops/), which answers "is there looping at this
locus?" from public Hi-C, Micro-C and HiChIP data. This file is the outside reference: where the
data comes from, what each layer of evidence actually claims, and the rules for reading a report
without over-claiming. Generated reports live in [`../loops/`](../loops/).

The short version: **no single dataset answers the question.** A loop call is one caller's opinion
about one map at one resolution, and the honest answer stacks four kinds of evidence and says
where each is weak.

## How to run it

GitHub → **Actions → Chromatin looping query → Run workflow**. Also reachable from the GitHub
mobile app, which is the point — nothing installs locally and nothing large is downloaded.

| Input | Example | Notes |
|---|---|---|
| `locus` | `AR` or `chrX:67,543,900-67,548,900` | Gene symbols resolve to their **promoter** (TSS ±5 kb) |
| `partner` | `chrX:66,895,000-66,904,000` | Optional. Given, the question becomes "do these two touch?" |
| `cells` | `all`, or `LNCaP,GM12878` | Substring match against the portal's cell-type name |
| `build` | `hg38` | `hg19` also works; the portals hold less for it |
| `window` | `500kb` | Half-width of the contact submatrix around each locus |
| `gene_anchor` | `promoter` | `whole-gene` anchors on the full span instead |
| `resolution` | `10kb` | Bin size. Smaller means a bigger workbook, not a better answer |

**A gene symbol means its promoter.** Anchoring on the whole gene body lets any contact anywhere
in the span count as a hit — for AR that is 187 kb, and a report built that way reads as evidence
without being any. `whole-gene` exists for when the whole locus really is the question.

Two files come back, rendered from the same rows so they cannot disagree: a markdown report to
read, and an `.xlsx` workbook to plot from. Both are attached to the run and committed to
`loops/`, unless the workbook exceeds 10 MB, in which case only the artifact survives.

## Data sources

| Source | What we take | Access |
|---|---|---|
| 4D Nucleome Data Portal | Loop calls, `.hic` / `.mcool` contact matrices, insulation-derived domain boundaries | [REST API](https://data.4dnucleome.org/help/user-guide/rest-api), [programmatic access](https://data.4dnucleome.org/help/user-guide/programmatic-access) |
| ENCODE Portal | Loop calls (BEDPE), `.hic` matrices, CTCF ChIP-seq peaks | [REST API](https://www.encodeproject.org/help/rest-api/) |
| Ensembl | Gene symbol → coordinates | [REST API](https://rest.ensembl.org) |
| UCSC Genome Browser | Genomic sequence under CTCF peaks | [REST API](https://genome.ucsc.edu/goldenpath/help/api.html) |
| JASPAR | CTCF position frequency matrix, [MA0139.1](https://jaspar.elixir.no/matrix/MA0139.1/) | REST API |

4DN's Hi-C holdings include **LNCaP clone FGC**, which is the line that matters for AR-CasPEx —
see the [4DN Hi-C data overview](https://data.4dnucleome.org/hic-data-overview).

Contact matrices are read with [straw](https://github.com/aidenlab/straw)
([`hic-straw`](https://github.com/aidenlab/hic-straw)) over HTTP range requests. A `.hic` file is
tens of gigabytes; straw fetches only the blocks covering the queried window, so nothing is
downloaded whole and nothing persists after the run.

## The four layers

### 1. Called loops

Pre-computed loop calls, read as BEDPE and intersected with the queried locus. ENCODE's Hi-C
pipeline calls loops with HiCCUPS and contact domains with related Juicer utilities — see the
[ENCODE Hi-C standards](https://www.encodeproject.org/hic/). HiChIP studies typically use
FitHiChIP instead.

**Says**: somebody with the full map, at depth, called a loop here.
**Does not say**: that no loop exists where no call appears. Loop calling is depth-limited; a
shallow map cannot reach FDR no matter what is physically there. Treat an empty layer 1 as
"nobody has shown this", never as "this is absent".

### 2. Raw contact, observed over expected

The contact frequency between the two loci, divided by the average contact at the same genomic
separation on the same chromosome — Juicer's `oe` matrix, so the expectation is the file's own.

**Says**: contact is or is not elevated above what the distance alone predicts. This is the layer
that catches real contact the callers missed.
**Does not say**: that elevated contact is a loop. Compartment-level and domain-level effects
raise O/E without a discrete loop.

**The correction that matters here: copy number.** Distance-expected normalisation does not
correct for amplification. Where a locus sits in an amplicon, raw counts and therefore O/E are
inflated. **The AR locus is amplified in castration-resistant prostate cancer**, so O/E at AR in a
CRPC line is an overestimate of contact by an unknown factor. Layer 1 and layer 3 are the checks
against this; do not read a high O/E at AR as a loop on its own.

Matching is by overlap, not midpoint: a 9 kb element read at 5 kb spans two bins, so every bin
pair joining the two regions is considered and the strongest reported, with the count shown.

**The reported O/E is a maximum, not an average** — the single strongest bin pair out of however
many join the two regions. Read it alongside the bin-pair count: a high value drawn from twenty
pairs is a weaker statement than the same value drawn from one.

### 3. TAD context

Domain boundaries, from 4DN's precomputed insulation-score calls (cooltools, 100 kb window —
[method](https://data.4dnucleome.org/resources/data-analysis/insulation_compartment_scores)).

**Says**: whether a loop between the two points is physically permitted. Two loci inside one
domain can contact each other; a boundary in between argues they largely do not.
**Does not say**: that a boundary makes contact impossible. Boundaries are statistical, they
differ between cell types, and loops do cross them.

A boundary between the two loci is a reason to distrust a weak call in layers 1 and 2, not a
reason to overturn a strong one.

Boundaries are counted by distinct position, not by row. The same boundary called in ten files is
one boundary; counting rows would turn a file count into a biological claim.

### 4. CTCF anchors

CTCF ChIP-seq peaks at each anchor, with the MA0139.1 motif scanned on both strands of the
underlying sequence to recover its orientation.

[Rao et al., *Cell* 2014](https://www.cell.com/fulltext/S0092-8674(14)01497-4)
([PubMed 25497547](https://pubmed.ncbi.nlm.nih.gov/25497547/)) found CTCF sites at loop anchors
in a **convergent** orientation in >90% of cases — the motifs face one another. That is the
signature of cohesin extrusion stalling at CTCF.

**Says**: whether the pair carries the canonical extrusion signature.
**Does not say**: that a non-convergent pair is not a loop. Enhancer–promoter loops that do not
depend on CTCF exist. Convergence supports a mechanism; its absence removes support for that
mechanism and nothing more.

Orientation is judged by genomic position, not by which anchor was typed first.

If JASPAR cannot be reached the peaks are still reported and the orientation is left as unknown,
rather than guessed. A wrong strand here would be invisible and would corrupt the interpretation,
so it is refused instead.

## Reading a report

1. **Layer 1 positive, in a relevant cell type** — the strongest answer available. Note the
   resolution: a 5 kb call locates an anchor to 5 kb, not to a base.
2. **Layer 1 empty, layer 2 elevated** — real but uncalled contact, or a depth problem, or copy
   number. Check layer 3 and the amplicon caveat before believing it.
3. **Layer 1 empty, layer 2 flat** — no evidence of looping *in the data searched*. Say it that
   way. It is not evidence of absence unless the maps searched were deep enough to have found it.
4. **Anything positive with a boundary between the loci** — say so and treat it as weakened.
5. **Cell type is not transferable.** A loop in GM12878 says nothing about LNCaP without an
   argument. The report lists cell types precisely for this reason.

## Prostate-specific published maps

Relevant to AR-CasPEx, and worth reading alongside any generated report:

- [Takeda et al., *Cell* 2018](https://www.cell.com/cell/fulltext/S0092-8674(18)30649-4)
  ([PubMed 29909987](https://pubmed.ncbi.nlm.nih.gov/29909987/)) — the somatically acquired AR
  enhancer, ~650 kb centromeric to the AR TSS and ~9 kb wide, amplified in CRPC. Chromosome
  conformation capture showed it contacting the AR promoter. **This is the known-positive the
  tool is tested against**: a run over the AR promoter and enhancer that finds nothing in a
  prostate line means the pipeline is broken, not that the biology changed.
- [Rhie et al., *Nat Commun* 2019](https://www.nature.com/articles/s41467-019-12079-8) — Hi-C and
  H3K27ac HiChIP in LNCaP and PrEC; TADs and enhancer–promoter loops in the prostate cancer
  transcriptome.
- [Giambartolomei et al., 2021](https://pmc.ncbi.nlm.nih.gov/articles/PMC8715276/) — H3K27ac
  HiChIP across prostate lines, 126,280 FitHiChIP loops in LNCaP, linking risk loci to genes.
- [MYC reshapes CTCF-mediated chromatin architecture in prostate cancer, *Nat Commun* 2023](https://www.nature.com/articles/s41467-023-37544-3)
  — CTCF-anchored architecture specifically in prostate cancer.

**LuCaP-35CR has no public Hi-C.** Any CRPC statement is made through a proxy line, and the report
names which one. That substitution is an assumption, not a result.

**A CRPC-relevant Hi-C dataset is wired in: [GSE118629](https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE118629),**
in situ Hi-C (MboI), the [3D epigenomic map paper](https://www.nature.com/articles/s41467-019-12079-8)'s
companion series. `tools/loops/geo_hicpro.py` handles the three things that kept it out at first:

1. **Deposited as HiC-Pro sparse matrices** (`GSE118629_<cell>_HiC_<res>k.<raw|normalized>.matrix.txt.gz`
   + a **shared, resolution-only** bin index, `GSE118629_hg19_<res>k.bed.gz` — no cell name in the
   bed file at all, one per resolution, reused across every cell's matrix at that resolution).
   `hicstraw` cannot read this, so it has its own reader, dispatched to from
   `layers.scan_matrix_file` by `file_format == "hicpro"`. Normalisation is labelled `RAW`/`NORM`
   (the file literally says "normalized", not "iced" — don't relabel it ICE, that's a different
   algorithm making a different claim).
2. **Mapped to hg19.** Lifted to hg38 via `pyliftover` and a locally fetched UCSC chain file
   (`--chain-file`, supplied by the workflow, ~1.2 MB, fetched fresh each run rather than cached).
   No liftOver chain available → this source is skipped for that run, not broken.
3. **No deposited loop calls** — it only ever contributes to layer 2 (raw contact), never layer 1.
   "Expected" for its O/E is estimated **locally**, from the pairs inside the queried window only,
   not genome-wide the way the `.hic` layer's own KR/oe track is — read a GEO-sourced O/E as a
   local estimate, not the same kind of number as an ENCODE/4DN one.

**Only 22Rv1 has been found at the series level.** The series-level `suppl/` directory that
`discover_geo_files` scrapes lists processed matrices for 22Rv1 only; no RWPE1 or C4-2B matrix
appears there (confirmed against a live run's diagnostic log, not assumed). `RWPE1` and `C4-2B`
stay in `_CELL_PATTERNS` because the paper describes all three lines and a future series update,
or a look inside the bundled `GSE118629_RAW.tar` (untried — each GSM sample's own supplementary
files, not explored here), could surface them without any further code change. Until then, a
`cells` filter naming RWPE1 or C4-2B will simply find nothing from this source — check the run's
"Run notes" for what was actually searched before reading silence as a negative result.

**Cell-type meaning, not just spelling:** `22Rv1` and `C4-2B` are genuine CRPC lines. `RWPE1` is
**normal, non-malignant prostate epithelium** — a useful third reference point if it's ever found,
but neither a "PC" nor an "mCRPC" data point. Don't let it get folded into either bucket by an
unqualified `cells` filter; ask for it by name, and read its rows as "normal," not as a control
for either cancer state.

File discovery is dynamic (the GEO supplementary directory is scraped at run time, not a
hard-coded filename list) because this was written without network access to confirm exact
filenames — the naming convention above came from a live run's diagnostic log after the first
attempt (which assumed a generic `iced`/`abs.bed` HiC-Pro convention) matched nothing. If
`discover_geo` starts reporting "listed files but none matched" again, the log includes a sample
of the real filenames it saw — read those before touching the regexes in `geo_hicpro.py`.

### C1–C4: which downstream candidate enhancer is which

[Quigley et al., *JCI* 2024](https://www.jci.org/articles/view/178604) (DOI
10.1172/JCI178604) — **the paper Umut is working from for the C3/C4 question** — defines four
candidate AR-downstream regulatory elements from paired pre/post-ARSI mCRPC biopsies:

| | hg38 coordinates | This paper's looping finding |
|---|---|---|
| C1 | chrX:67,043,000-67,046,000 | no loop to AR promoter |
| C2 | chrX:67,104,300-67,106,900 | no loop to AR promoter |
| C3 | chrX:67,746,500-67,748,100 | **no loop to AR promoter** |
| C4 | chrX:67,787,800-67,793,300 | **loop to AR promoter**, via H3K27ac HiChIP in LNCaP |

**Read this carefully before trusting a "C3" result:** the paper's own HiChIP evidence for
looping is at **C4**, not C3 — C1–C3 specifically came back negative in that assay. The mCRPC
angle in this paper is **C4's copy number increasing after ARSI resistance develops**, not new
looping evidence generated specifically in mCRPC samples — the HiChIP itself was run in LNCaP,
which is androgen-sensitive, not CRPC. Extracted from search-engine summaries of the paper, not
read verbatim from the primary text (`jci.org` was not reachable from the Claude session that
first researched this) — worth checking the coordinates above against the paper's own figures or
supplementary tables before treating them as final.

## Known limits

- Cell types are matched by substring against portal names, which are not standardised. `LNCaP`
  catches `LNCaP clone FGC`; a differently spelled line will be missed.
- Cross-chromosome queries are rejected. Layers 2 and 3 are both intra-chromosomal, so a trans
  answer would rest on layer 1 alone and read as more confident than it is.
- Per-query file caps (60 loop files, 12 matrices, 20 boundary files, 12 CTCF files) keep a run to
  minutes. When a cap bites, the report says so; narrow `cells` to look further.
- The portals' file-type vocabularies are not stable across pipeline versions. Files are
  classified by pattern rather than by exact enum, and anything unclassified is logged to the run
  so the patterns can be tightened against evidence.
