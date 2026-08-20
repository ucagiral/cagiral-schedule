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

**A CRPC-relevant Hi-C dataset exists but is not wired in: [GSE118629](https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE118629),**
in situ Hi-C (MboI) for RWPE1, C4-2B and 22Rv1 — the [3D epigenomic map paper](https://www.nature.com/articles/s41467-019-12079-8)'s
companion series. Three specific reasons it isn't in `tools/loops/sources.py` today, so the next
attempt doesn't have to re-discover them:

1. **Deposited as HiC-Pro sparse matrices** (`.matrix` + `.bed` bin files, raw and ICE-normalised,
   10/20/40/100 kb), not `.hic` or `.cool`. `hicstraw` cannot read this format — layer 2 would
   need a second matrix reader alongside the one it already has.
2. **Mapped to hg19, not hg38.** Using it means lifting over either the query coordinates or the
   whole matrix; nothing in this tool does coordinate liftOver today.
3. **No evidence of deposited loop calls** — layer 1 would likely stay empty for these lines even
   after the above two are solved; only layer 2 (raw contact) would gain anything.

Net: this is a second matrix format plus a genome-build conversion, not another REST client like
the 4DN/ENCODE ones — closer in size to a new source than an extra search query. Worth doing if a
question specifically needs 22Rv1 or C4-2B contact data; not a quick add otherwise.

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
