#!/usr/bin/env python3
"""Ask whether a genomic locus takes part in chromosome looping.

Usage:
    python3 tools/loops/query.py --locus AR \
        --partner chrX:66,895,000-66,904,000 --cells all

Writes two files into --out-dir, both rendered from the same rows:
    <slug>.md    the report, for reading
    <slug>.xlsx  the numbers, for plotting

No layer is authoritative on its own; the verdict says which ones carried it
and where the evidence is thin.  See protocols/chromatin-loops.md.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any, Sequence

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import layers  # noqa: E402
import workbook as workbook_module  # noqa: E402
from layers import Region, orientation_verdict  # noqa: E402
from sources import SourceError, load_or_discover, resolve_gene  # noqa: E402

# An O/E at or above this is treated as contact worth reporting even when no
# caller flagged a loop.  Chosen to sit clearly above distance-driven
# background without demanding the strength of a called dot.
ENRICHED_OE = 2.0

# A looping question about a gene almost always means its promoter. Using the
# whole gene body as an anchor lets any contact anywhere in a 187 kb span (AR,
# for one) count as a hit, which reads as evidence and is not.
PROMOTER_FLANK = 5_000

_SPAN = re.compile(r"^\s*([\d.,]+)\s*(bp|kb|mb)?\s*$", re.I)
_LOCUS = re.compile(r"^\s*(chr[\w]+|[\dXYMT]+)\s*[:\-]\s*([\d,_]+)\s*[-–]\s*([\d,_]+)\s*$", re.I)


def parse_span(text: str) -> int:
    match = _SPAN.match(text)
    if not match:
        raise ValueError(f"cannot read {text!r} as a length; try 500kb or 250000")
    value = float(match.group(1).replace(",", ""))
    unit = (match.group(2) or "bp").lower()
    return int(value * {"bp": 1, "kb": 1_000, "mb": 1_000_000}[unit])


def parse_locus(text: str, build: str,
                gene_anchor: str = "promoter") -> tuple[Region, str]:
    """Accept explicit coordinates or a gene symbol; return the anchor region.

    A gene symbol resolves to its promoter by default -- the TSS plus or minus
    PROMOTER_FLANK -- because that is what a looping question about a gene
    means. Pass gene_anchor="whole-gene" to anchor on the full span instead.
    """
    match = _LOCUS.match(text)
    if match:
        chrom = match.group(1)
        if not chrom.lower().startswith("chr"):
            chrom = "chr" + chrom
        start = int(match.group(2).replace(",", "").replace("_", ""))
        end = int(match.group(3).replace(",", "").replace("_", ""))
        if end <= start:
            raise ValueError(f"{text!r} ends at or before it starts")
        return Region(chrom, start, end), "coordinates"

    symbol = text.strip()
    chrom, start, end, strand = resolve_gene(symbol, build)
    if gene_anchor == "whole-gene":
        return Region(chrom, start, end), f"Ensembl gene {symbol}, whole span"
    tss = start if strand >= 0 else end
    sign = "+" if strand >= 0 else "-"
    return (Region(chrom, max(0, tss - PROMOTER_FLANK), tss + PROMOTER_FLANK),
            f"Ensembl gene {symbol} promoter — TSS {tss:,} on the {sign} strand, "
            f"±{PROMOTER_FLANK // 1000} kb")


def slugify(locus: str, partner: str | None) -> str:
    parts = [locus] + ([partner] if partner else [])
    raw = "-vs-".join(parts)
    slug = re.sub(r"[^A-Za-z0-9]+", "-", raw).strip("-").lower()
    return (slug or "query")[:80]


def parse_cells(text: str) -> list[str]:
    if not text or text.strip().lower() in {"all", "any", "*"}:
        return []
    return [part.strip() for part in text.split(",") if part.strip()]


# --------------------------------------------------------------------------
# Verdict
# --------------------------------------------------------------------------

def build_verdict(loop_rows: Sequence[dict[str, Any]],
                  enrichment: Sequence[dict[str, Any]],
                  tad_rows: Sequence[dict[str, Any]],
                  ctcf_rows: Sequence[dict[str, Any]],
                  query: Region, partner: Region | None,
                  loop_cells_searched: Sequence[str] = ()) -> list[str]:
    lines: list[str] = []
    cells_with_loops = sorted({row["cell_type"] for row in loop_rows})

    if partner is None:
        if loop_rows:
            lines.append(
                f"{len(loop_rows)} called loop(s) have an anchor at {query}, "
                f"across {len(cells_with_loops)} cell type(s): "
                f"{', '.join(cells_with_loops[:6])}"
                + ("…" if len(cells_with_loops) > 6 else "") + ".")
        else:
            lines.append(f"No called loop has an anchor at {query} in the "
                         f"datasets searched.")
    else:
        if cells_with_loops:
            separations = {row["separation_bp"] for row in loop_rows}
            lines.append(
                f"Yes in {', '.join(cells_with_loops)} — a called loop joins "
                f"{query} and {partner} (separation "
                f"{min(separations):,}–{max(separations):,} bp).")
        else:
            best = enrichment[0] if enrichment else None
            if best and (best["oe"] or 0) >= ENRICHED_OE:
                lines.append(
                    f"No caller flagged a loop between {query} and {partner}, "
                    f"but contact is {best['oe']:.1f}× the distance expectation "
                    f"in {best['cell_type']} ({best['dataset']}) — elevated "
                    f"contact without a called dot.")
            else:
                lines.append(
                    f"No called loop and no elevated contact between {query} "
                    f"and {partner} in the datasets searched.")

    # Name the lines that were looked at and came back empty. Silence here
    # reads as "no loop", when it often means "nobody has called loops in this
    # line" — a different statement entirely.
    empty = [cell for cell in loop_cells_searched if cell not in cells_with_loops]
    if empty:
        lines.append(f"No called loop in {', '.join(empty[:6])}"
                     + ("…" if len(empty) > 6 else "")
                     + " — their loop-call files were searched and had nothing "
                       "at this locus.")

    if partner is not None:
        # Count distinct positions, not rows: the same boundary called in ten
        # files is one boundary, and counting rows turns a file count into a
        # biological claim.
        between = {(row["chrom"], row["start"], row["end"]) for row in tad_rows
                   if row["between_query_and_partner"]}
        shared = [row for row in tad_rows
                  if row["contains_query"] and row["contains_partner"]]
        if shared:
            lines.append(f"Both loci sit inside one domain in "
                         f"{len(sorted({r['cell_type'] for r in shared}))} "
                         f"cell type(s) — a loop is physically permitted.")
        elif between:
            lines.append(f"{len(between)} distinct domain boundary/boundaries lie "
                         f"between the two loci — treat any loop call here with "
                         f"suspicion.")

    orientation = orientation_verdict(ctcf_rows)
    if orientation == "convergent":
        lines.append("CTCF motifs at the two anchors are convergent — the "
                     "canonical cohesin-extrusion anchor signature.")
    elif orientation in {"divergent", "tandem"}:
        lines.append(f"CTCF motifs at the anchors are {orientation}, not "
                     f"convergent. That is not evidence against the loop, but "
                     f"it argues against plain CTCF/cohesin extrusion.")

    return lines


# --------------------------------------------------------------------------
# Markdown
# --------------------------------------------------------------------------

def _fmt(value: Any, digits: int = 3) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        if value != value:  # NaN
            return "—"
        return f"{value:.{digits}g}"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def _table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> list[str]:
    if not rows:
        return ["_Nothing found._", ""]
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(_fmt(cell) for cell in row) + " |" for row in rows]
    out.append("")
    return out


def render_markdown(*, title: str, query: Region, partner: Region | None,
                    origin: str, build: str, catalogue_size: int,
                    cell_count: int, verdict: Sequence[str],
                    loop_rows: Sequence[dict[str, Any]],
                    enrichment: Sequence[dict[str, Any]],
                    tad_rows: Sequence[dict[str, Any]],
                    ctcf_rows: Sequence[dict[str, Any]],
                    notes: Sequence[str], counts: dict[str, int],
                    workbook_name: str, generated: str) -> str:
    lines = [f"# {title}", ""]
    where = f"{query}" + (f"  ↔  {partner}" if partner else "")
    lines += [f"**Query**: {where}  ({build}, from {origin})",
              f"**Run**: {generated} · {catalogue_size} files searched · "
              f"{cell_count} cell types",
              f"**Numbers**: [`{workbook_name}`](./{workbook_name})", "",
              "## Verdict", ""]
    lines += [f"- {line}" for line in verdict] or ["- No evidence either way."]
    lines.append("")

    lines += ["## 1. Called loops", ""]
    lines += _table(
        ["Cell", "Assay", "Caller", "Anchor 1", "Anchor 2", "Sep.", "Score", "FDR", "Dataset"],
        [[r["cell_type"], r["assay"], r["caller"],
          f'{r["chrom1"]}:{r["start1"]:,}-{r["end1"]:,}',
          f'{r["chrom2"]}:{r["start2"]:,}-{r["end2"]:,}',
          r["separation_bp"], r["score"], r["fdr"], r["dataset"]]
         for r in loop_rows[:25]])
    if len(loop_rows) > 25:
        lines += [f"_{len(loop_rows) - 25} further loops are in the workbook._", ""]

    lines += ["## 2. Raw contact enrichment (observed / distance-expected)", "",
              "_Best O/E is the strongest single bin pair joining the two "
              "regions, out of the bin pairs counted in the last column — a "
              "maximum, not an average._", ""]
    lines += _table(
        ["Cell", "Dataset", "Norm.", "Res.", "Observed", "Expected", "Best O/E", "Bin pairs"],
        [[r["cell_type"], r["dataset"], r["normalisation"], r["resolution_bp"],
          r["observed"], r["expected"], r["oe"], r["bin_pairs"]]
         for r in enrichment[:15]])

    lines += ["## 3. TAD context", ""]
    lines += _table(
        ["Cell", "Kind", "Interval", "Span", "Holds query", "Holds partner", "Between"],
        [[r["cell_type"], r["kind"], f'{r["chrom"]}:{r["start"]:,}-{r["end"]:,}',
          r["span_bp"], r["contains_query"], r["contains_partner"],
          r["between_query_and_partner"]] for r in tad_rows[:20]])

    lines += ["## 4. CTCF anchors", ""]
    lines += _table(
        ["Anchor", "Cell", "Peak", "Signal", "Motif", "Strand", "Rel. score", "Dataset"],
        [[r["anchor"], r["cell_type"],
          f'{r["peak_chrom"]}:{r["peak_start"]:,}-{r["peak_end"]:,}',
          r["signal"], r["motif"] or "—", r["strand"], r["motif_rel_score"],
          r["dataset"]] for r in ctcf_rows[:20]])

    lines += ["## Caveats", ""]
    lines += [
        "- **A called loop is a claim about one dataset at one resolution.** "
        "Absence of a call is not absence of a loop — loop calling is limited "
        "by sequencing depth, and shallow maps simply cannot reach FDR.",
        "- Contacts shorter than the reported resolution are invisible to it.",
        "- Cell types are matched by name, not by biology. A loop in one line "
        "does not transfer to another without argument.",
        "- **Copy number inflates raw contact counts.** Distance-expected "
        "normalisation does not correct for amplification, so O/E is "
        "overstated wherever a queried locus sits in an amplicon — which "
        "includes the AR locus in castration-resistant prostate cancer.",
    ]
    lines.append("")

    if notes:
        lines += ["## Run notes", ""]
        lines += [f"- {note}" for note in notes]
        lines.append("")

    lines += ["## Sources", ""]
    seen: set[str] = set()
    for row in list(loop_rows) + list(enrichment) + list(tad_rows) + list(ctcf_rows):
        url = row.get("source_url")
        dataset = row.get("dataset")
        if not url or dataset in seen:
            continue
        seen.add(dataset)
        lines.append(f"- `{dataset}` — {row.get('cell_type', 'unknown')} — <{url}>")
    if not seen:
        lines.append("- No dataset returned data for this query.")
    lines += ["",
              "Workbook sheet sizes: " +
              ", ".join(f"`{k}` {v:,}" for k, v in counts.items()) + ".",
              "",
              "Method and interpretation rules: "
              "[`protocols/chromatin-loops.md`](../protocols/chromatin-loops.md)."]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--locus", required=True,
                        help="gene symbol or chrX:start-end")
    parser.add_argument("--partner", default="",
                        help="optional second locus; asks whether the two touch")
    parser.add_argument("--cells", default="all",
                        help="comma-separated cell-type filter, or 'all'")
    parser.add_argument("--build", default="hg38", choices=["hg38", "hg19"])
    parser.add_argument("--gene-anchor", default="promoter",
                        choices=["promoter", "whole-gene"],
                        help="what a gene symbol resolves to (default: its "
                             "promoter, TSS ±5 kb)")
    parser.add_argument("--window", default="500kb",
                        help="half-width of the contact matrix around each locus")
    parser.add_argument("--resolution", default="10kb",
                        help="contact matrix bin size")
    parser.add_argument("--out-dir", default="loops")
    parser.add_argument("--cache", default="loops/_datasets.json")
    parser.add_argument("--refresh", action="store_true",
                        help="re-crawl the portals instead of using the cache")
    parser.add_argument("--max-contact-rows", type=int, default=200_000)
    parser.add_argument("--summary-file", default=os.environ.get("GITHUB_STEP_SUMMARY", ""))
    args = parser.parse_args(argv)

    try:
        window = parse_span(args.window)
        resolution = parse_span(args.resolution)
        query, origin = parse_locus(args.locus, args.build, args.gene_anchor)
        partner = None
        if args.partner.strip():
            partner, _ = parse_locus(args.partner, args.build, args.gene_anchor)
            if layers.normalise_chrom(partner.chrom) != layers.normalise_chrom(query.chrom):
                parser.error("cross-chromosome queries are not supported: the "
                             "contact and TAD layers are both intra-chromosomal")
    except (ValueError, SourceError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    wanted_cells = parse_cells(args.cells)
    print(f"Query {query}" + (f" vs {partner}" if partner else ""), file=sys.stderr)

    catalogue = load_or_discover(args.cache, args.build, refresh=args.refresh)
    notes: list[str] = list(catalogue.errors)
    if catalogue.unmatched_types:
        print(f"unclassified portal file types seen: "
              f"{catalogue.unmatched_types[:40]}", file=sys.stderr)

    print(f"catalogue: {len(catalogue.loops)} loop files, "
          f"{len(catalogue.matrices)} matrices, "
          f"{len(catalogue.boundaries)} boundary files, "
          f"{len(catalogue.ctcf)} CTCF files", file=sys.stderr)

    def timed(label: str, fn):
        started = time.monotonic()
        rows, layer_notes = fn()
        print(f"{label}: {len(rows)} rows in "
              f"{time.monotonic() - started:.1f}s", file=sys.stderr)
        return rows, layer_notes

    loop_rows, loop_notes = timed("called loops", lambda: layers.layer_called_loops(
        catalogue.loops, query, partner, wanted_cells))
    contact_rows, contact_notes = timed("raw contact", lambda: layers.layer_raw_contact(
        catalogue.matrices, query, partner, wanted_cells, window, resolution,
        args.max_contact_rows))
    tad_rows, tad_notes = timed("TAD context", lambda: layers.layer_tad_context(
        catalogue.boundaries, query, partner, wanted_cells))

    anchors = {"query": query}
    if partner is not None:
        anchors["partner"] = partner
    ctcf_rows, ctcf_notes = timed("CTCF anchors", lambda: layers.layer_ctcf_anchors(
        catalogue.ctcf, anchors, wanted_cells, args.build))

    notes += loop_notes + contact_notes + tad_notes + ctcf_notes

    enrichment = layers.pair_enrichment(contact_rows, query, partner) \
        if partner is not None else []

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    dataset_rows = [pf.to_row(generated) for pf in catalogue.all_files()
                    if pf.accession in {r.get("dataset") for r in
                                        list(loop_rows) + list(contact_rows) +
                                        list(tad_rows) + list(ctcf_rows)}]

    os.makedirs(args.out_dir, exist_ok=True)
    slug = slugify(args.locus, args.partner or None)
    workbook_path = os.path.join(args.out_dir, f"{slug}.xlsx")
    report_path = os.path.join(args.out_dir, f"{slug}.md")

    counts = workbook_module.write_workbook(
        workbook_path, loops=loop_rows, contact_matrix=contact_rows,
        tads=tad_rows, ctcf=ctcf_rows, datasets=dataset_rows)

    problems = workbook_module.verify_workbook(workbook_path, counts)
    if problems:
        print("workbook verification failed:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    if counts["loops"] != len(loop_rows):
        print(f"error: workbook holds {counts['loops']} loops but the report "
              f"describes {len(loop_rows)}", file=sys.stderr)
        return 1

    title = args.locus if not args.partner else f"{args.locus} ↔ {args.partner}"
    verdict = build_verdict(loop_rows, enrichment, tad_rows, ctcf_rows, query,
                            partner,
                            layers.cells_scanned(catalogue.loops, wanted_cells,
                                                 layers.MAX_LOOP_FILES))
    report = render_markdown(
        title=title, query=query, partner=partner, origin=origin,
        build=args.build, catalogue_size=len(catalogue.all_files()),
        cell_count=len(catalogue.cell_types()), verdict=verdict,
        loop_rows=loop_rows, enrichment=enrichment, tad_rows=tad_rows,
        ctcf_rows=ctcf_rows, notes=notes, counts=counts,
        workbook_name=os.path.basename(workbook_path), generated=generated)

    with open(report_path, "w", encoding="utf-8") as handle:
        handle.write(report)

    summary = "\n".join([f"## {title}", ""] + [f"- {line}" for line in verdict] +
                        ["", f"Report: `{report_path}` · Workbook: `{workbook_path}`"])
    print(summary)
    if args.summary_file:
        with open(args.summary_file, "a", encoding="utf-8") as handle:
            handle.write(summary + "\n")

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as handle:
            handle.write(f"slug={slug}\n")
            handle.write(f"report={report_path}\n")
            handle.write(f"workbook={workbook_path}\n")

    print(f"\nwrote {report_path} and {workbook_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
