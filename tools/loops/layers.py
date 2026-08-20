"""The four evidence layers.

Each layer answers a different question and none of them answers it alone:

  1. called loops    -- has somebody already called a loop here?
  2. raw contact     -- is the contact elevated over what the distance predicts?
  3. TAD context     -- is a loop between these two points even permitted?
  4. CTCF anchors    -- does the pair carry the canonical extrusion signature?

Every layer returns a flat list of dicts.  The markdown report and the Excel
workbook are both rendered from these same lists, so the two outputs cannot
disagree with each other.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Sequence

from sources import (PortalFile, SourceError, fetch_ctcf_pfm, fetch_lines,
                     fetch_sequence)

# How many remote files one query may pull.  Keeps a CI run to minutes and the
# portals unbothered; the report says when a cap bit.
MAX_LOOP_FILES = 60
MAX_MATRIX_FILES = 12
MAX_BOUNDARY_FILES = 20
MAX_CTCF_FILES = 12

NORMALISATIONS = ("KR", "SCALE", "VC", "VC_SQRT", "NONE")


@dataclass(frozen=True)
class Region:
    chrom: str
    start: int
    end: int

    @property
    def mid(self) -> int:
        return (self.start + self.end) // 2

    def overlaps(self, chrom: str, start: int, end: int, slop: int = 0) -> bool:
        return (normalise_chrom(chrom) == normalise_chrom(self.chrom)
                and start - slop < self.end and end + slop > self.start)

    def __str__(self) -> str:
        return f"{self.chrom}:{self.start:,}-{self.end:,}"


def normalise_chrom(name: str) -> str:
    """Compare chromosomes regardless of the `chr` prefix and MT/M spelling."""
    name = str(name).strip()
    if name.lower().startswith("chr"):
        name = name[3:]
    return "M" if name.upper() == "MT" else name.upper()


def matches_cells(pf: PortalFile, wanted: Sequence[str]) -> bool:
    if not wanted:
        return True
    haystack = pf.cell_type.lower()
    return any(w.lower() in haystack for w in wanted)


def _select(files: Sequence[PortalFile], wanted: Sequence[str],
            cap: int) -> tuple[list[PortalFile], bool]:
    """Pick files to download: requested cell types first, then spread the cap.

    When the cap bites it is spread round-robin across cell types rather than
    taken as an alphabetical prefix. A flat truncation silently drops every line
    whose name sorts late -- which is exactly how LNCaP vanishes from an
    unfiltered query, turning "we stopped looking" into a confident "no loop".
    """
    chosen = [pf for pf in files if matches_cells(pf, wanted)]
    chosen.sort(key=lambda pf: (pf.cell_type.lower(), pf.accession))
    if len(chosen) <= cap:
        return chosen, False

    by_cell: dict[str, list[PortalFile]] = {}
    for pf in chosen:
        by_cell.setdefault(pf.cell_type.lower(), []).append(pf)

    picked: list[PortalFile] = []
    depth = 0
    while len(picked) < cap:
        added = False
        for cell in sorted(by_cell):
            bucket = by_cell[cell]
            if depth < len(bucket):
                picked.append(bucket[depth])
                added = True
                if len(picked) >= cap:
                    break
        if not added:
            break
        depth += 1
    return picked, True


def cells_scanned(files: Sequence[PortalFile], wanted: Sequence[str],
                  cap: int) -> list[str]:
    """The cell types whose files a layer would actually read, given the cap."""
    chosen, _ = _select(files, wanted, cap)
    return sorted({pf.cell_type for pf in chosen})


# --------------------------------------------------------------------------
# Layer 1 -- called loops
# --------------------------------------------------------------------------

_FDR_COLUMN = re.compile(r"^(fdr|q[_-]?val|qvalue|padj)", re.I)
_SCORE_COLUMN = re.compile(r"^(score|obs|observed|counts?)$", re.I)


def _parse_bedpe_header(line: str) -> dict[str, int] | None:
    """Map column names to indices for a header row, commented or bare."""
    fields = line.lstrip("#").split("\t")
    if len(fields) < 6:
        return None
    return {name.strip().lower(): i for i, name in enumerate(fields)}


def _pick_numeric(fields: Sequence[str], header: dict[str, int] | None,
                  pattern: re.Pattern[str]) -> float | None:
    if not header:
        return None
    for name, index in header.items():
        if pattern.match(name) and index < len(fields):
            try:
                return float(fields[index])
            except ValueError:
                continue
    return None


def scan_loop_file(pf: PortalFile, query: Region, partner: Region | None,
                   slop: int) -> list[dict[str, Any]]:
    """Return the loops in one BEDPE file that touch the query (and partner)."""
    rows: list[dict[str, Any]] = []
    header: dict[str, int] | None = None
    for line in fetch_lines(pf.url):
        if not line.strip():
            continue
        if line.startswith(("#", "track", "browser")):
            if header is None:
                header = _parse_bedpe_header(line)
            continue
        fields = line.split("\t")
        if len(fields) < 6:
            continue
        try:
            s1, e1 = int(fields[1]), int(fields[2])
            s2, e2 = int(fields[4]), int(fields[5])
        except ValueError:
            # Coordinates that will not parse mean this is a bare header row.
            if header is None:
                header = _parse_bedpe_header(line)
            continue
        c1, c2 = fields[0], fields[3]

        hit1 = query.overlaps(c1, s1, e1, slop)
        hit2 = query.overlaps(c2, s2, e2, slop)
        if not (hit1 or hit2):
            continue
        if partner is not None:
            paired = (hit1 and partner.overlaps(c2, s2, e2, slop)) or \
                     (hit2 and partner.overlaps(c1, s1, e1, slop))
            if not paired:
                continue

        rows.append({
            "cell_type": pf.cell_type,
            "assay": pf.assay,
            "caller": pf.file_type or "unknown",
            "dataset": pf.accession,
            "portal": pf.portal,
            "genome": pf.genome,
            "chrom1": c1, "start1": s1, "end1": e1,
            "chrom2": c2, "start2": s2, "end2": e2,
            "separation_bp": abs(((s2 + e2) // 2) - ((s1 + e1) // 2)),
            "resolution_bp": max(e1 - s1, e2 - s2),
            "score": _pick_numeric(fields, header, _SCORE_COLUMN),
            "fdr": _pick_numeric(fields, header, _FDR_COLUMN),
            "anchor1_hits_query": hit1,
            "anchor2_hits_query": hit2,
            "source_url": pf.url,
        })
    return rows


def layer_called_loops(files: Sequence[PortalFile], query: Region,
                       partner: Region | None, wanted_cells: Sequence[str],
                       slop: int = 10_000) -> tuple[list[dict[str, Any]], list[str]]:
    chosen, capped = _select(files, wanted_cells, MAX_LOOP_FILES)
    notes: list[str] = []
    if capped:
        notes.append(f"Loop-call scan capped at {MAX_LOOP_FILES} files; "
                     f"narrow `cells` to widen coverage of the rest.")
    rows: list[dict[str, Any]] = []
    for pf in chosen:
        try:
            rows.extend(scan_loop_file(pf, query, partner, slop))
        except SourceError as exc:
            notes.append(f"Skipped loop file {pf.accession}: {exc}")
    rows.sort(key=lambda r: (r["cell_type"].lower(), r["separation_bp"]))
    return rows, notes


# --------------------------------------------------------------------------
# Layer 2 -- raw contact
# --------------------------------------------------------------------------

def _open_hic(url: str):
    import hicstraw  # imported lazily so the other layers work without it
    return hicstraw.HiCFile(url)


def _hic_chrom_name(hic, chrom: str) -> str | None:
    target = normalise_chrom(chrom)
    for record in hic.getChromosomes():
        if normalise_chrom(record.name) == target:
            return record.name
    return None


def _best_resolution(hic, wanted: int) -> int:
    available = sorted(hic.getResolutions())
    if not available:
        raise SourceError("file advertises no resolutions")
    exact = [r for r in available if r == wanted]
    if exact:
        return exact[0]
    coarser = [r for r in available if r >= wanted]
    return coarser[0] if coarser else available[-1]


def scan_matrix_file(pf: PortalFile, query: Region, partner: Region | None,
                     window: int, resolution: int) -> tuple[list[dict[str, Any]], str]:
    """Read one remote .hic over range requests; return long-format O/E rows.

    Nothing is downloaded whole: straw fetches only the blocks covering the two
    windows asked for.
    """
    hic = _open_hic(pf.url)
    chrom = _hic_chrom_name(hic, query.chrom)
    if chrom is None:
        raise SourceError(f"{query.chrom} absent from {pf.accession}")
    res = _best_resolution(hic, resolution)

    left = (max(0, query.mid - window), query.mid + window)
    right = left if partner is None else (max(0, partner.mid - window), partner.mid + window)

    observed: dict[tuple[int, int], float] = {}
    oe: dict[tuple[int, int], float] = {}
    used_norm = ""
    for norm in NORMALISATIONS:
        try:
            matrix = hic.getMatrixZoomData(chrom, chrom, "observed", norm, "BP", res)
            expected_zoom = hic.getMatrixZoomData(chrom, chrom, "oe", norm, "BP", res)
            obs_records = matrix.getRecords(left[0], left[1], right[0], right[1])
            oe_records = expected_zoom.getRecords(left[0], left[1], right[0], right[1])
        except Exception:  # noqa: BLE001 - straw raises bare exceptions per norm
            continue
        observed = {(r.binX, r.binY): r.counts for r in obs_records}
        oe = {(r.binX, r.binY): r.counts for r in oe_records}
        used_norm = norm
        break
    if not used_norm:
        raise SourceError(f"no usable normalisation in {pf.accession}")

    rows: list[dict[str, Any]] = []
    for key, obs in sorted(observed.items()):
        ratio = oe.get(key)
        expected = (obs / ratio) if ratio else None
        rows.append({
            "cell_type": pf.cell_type,
            "dataset": pf.accession,
            "portal": pf.portal,
            "normalisation": used_norm,
            "resolution_bp": res,
            "chrom": query.chrom,
            "bin1_start": key[0],
            "bin2_start": key[1],
            "observed": obs,
            "expected": expected,
            "oe": ratio,
            "source_url": pf.url,
        })
    return rows, used_norm


def pair_enrichment(rows: Sequence[dict[str, Any]], query: Region,
                    partner: Region) -> list[dict[str, Any]]:
    """Collapse the submatrix down to the bins the two queried loci occupy.

    Matching is by overlap, not by midpoint: a 9 kb enhancer read at 5 kb lands
    across two bins, and a locus that straddles a bin edge would otherwise be
    scored against the wrong one.  Every bin pair joining the two regions is
    considered and the strongest is reported, with the count kept so the report
    can say how wide a block that best came from.
    """
    best: dict[tuple[str, int], dict[str, Any]] = {}
    for row in rows:
        res = row["resolution_bp"]
        chrom = row["chrom"]
        b1, b2 = row["bin1_start"], row["bin2_start"]
        joins = ((query.overlaps(chrom, b1, b1 + res)
                  and partner.overlaps(chrom, b2, b2 + res))
                 or (partner.overlaps(chrom, b1, b1 + res)
                     and query.overlaps(chrom, b2, b2 + res)))
        if not joins:
            continue
        key = (row["dataset"], res)
        candidate = {
            "cell_type": row["cell_type"],
            "dataset": row["dataset"],
            "normalisation": row["normalisation"],
            "resolution_bp": res,
            "observed": row["observed"],
            "expected": row["expected"],
            "oe": row["oe"],
            "bin_pairs": 1,
            "source_url": row["source_url"],
        }
        current = best.get(key)
        if current is None:
            best[key] = candidate
            continue
        current["bin_pairs"] += 1
        if (row["oe"] or 0) > (current["oe"] or 0):
            candidate["bin_pairs"] = current["bin_pairs"]
            best[key] = candidate
    return sorted(best.values(), key=lambda r: -(r["oe"] or 0))


def layer_raw_contact(files: Sequence[PortalFile], query: Region,
                      partner: Region | None, wanted_cells: Sequence[str],
                      window: int, resolution: int,
                      row_budget: int) -> tuple[list[dict[str, Any]], list[str]]:
    chosen, capped = _select(files, wanted_cells, MAX_MATRIX_FILES)
    notes: list[str] = []
    if capped:
        notes.append(f"Contact-matrix scan capped at {MAX_MATRIX_FILES} files.")

    rows: list[dict[str, Any]] = []
    for pf in chosen:
        if len(rows) >= row_budget:
            notes.append(f"Contact matrix truncated at {row_budget:,} rows; "
                         f"raise `resolution` or narrow `cells` for full coverage.")
            break
        try:
            new_rows, _ = scan_matrix_file(pf, query, partner, window, resolution)
        except SourceError as exc:
            notes.append(f"Skipped matrix {pf.accession}: {exc}")
            continue
        except Exception as exc:  # noqa: BLE001 - straw failure modes are untyped
            notes.append(f"Skipped matrix {pf.accession}: {type(exc).__name__}: {exc}")
            continue
        rows.extend(new_rows)
    return rows, notes


# --------------------------------------------------------------------------
# Layer 3 -- TAD context
# --------------------------------------------------------------------------

# Anything longer than this is treated as a domain call, anything shorter as a
# boundary marker.  4DN publishes boundaries as narrow intervals and domains as
# wide ones, but does not always say which a file is in its type string.
DOMAIN_MIN_SPAN = 100_000


def scan_boundary_file(pf: PortalFile, query: Region,
                       partner: Region | None) -> list[dict[str, Any]]:
    lo, hi = (query.mid, query.mid) if partner is None else \
        (min(query.mid, partner.mid), max(query.mid, partner.mid))
    rows: list[dict[str, Any]] = []
    for line in fetch_lines(pf.url):
        if not line.strip() or line.startswith(("#", "track", "browser")):
            continue
        fields = line.split("\t")
        if len(fields) < 3:
            continue
        try:
            chrom, start, end = fields[0], int(fields[1]), int(fields[2])
        except ValueError:
            continue
        if normalise_chrom(chrom) != normalise_chrom(query.chrom):
            continue
        span = end - start
        is_domain = span >= DOMAIN_MIN_SPAN
        contains_query = start <= query.mid < end
        contains_partner = partner is not None and start <= partner.mid < end
        between = (not is_domain) and lo < ((start + end) // 2) < hi
        if not (contains_query or contains_partner or between):
            continue
        strength = None
        if len(fields) >= 5:
            try:
                strength = float(fields[4])
            except ValueError:
                strength = None
        rows.append({
            "cell_type": pf.cell_type,
            "dataset": pf.accession,
            "portal": pf.portal,
            "kind": "domain" if is_domain else "boundary",
            "chrom": chrom,
            "start": start,
            "end": end,
            "span_bp": span,
            "boundary_strength": strength,
            "contains_query": contains_query,
            "contains_partner": contains_partner,
            "between_query_and_partner": between,
            "source_url": pf.url,
        })
    return rows


def layer_tad_context(files: Sequence[PortalFile], query: Region,
                      partner: Region | None,
                      wanted_cells: Sequence[str]) -> tuple[list[dict[str, Any]], list[str]]:
    chosen, capped = _select(files, wanted_cells, MAX_BOUNDARY_FILES)
    notes: list[str] = []
    if capped:
        notes.append(f"Boundary scan capped at {MAX_BOUNDARY_FILES} files.")
    rows: list[dict[str, Any]] = []
    for pf in chosen:
        try:
            rows.extend(scan_boundary_file(pf, query, partner))
        except SourceError as exc:
            notes.append(f"Skipped boundary file {pf.accession}: {exc}")
    rows.sort(key=lambda r: (r["cell_type"].lower(), r["start"]))
    return rows, notes


# --------------------------------------------------------------------------
# Layer 4 -- CTCF anchors
# --------------------------------------------------------------------------

_COMPLEMENT = str.maketrans("ACGTN", "TGCAN")
_BASES = "ACGT"


def _pwm_from_pfm(pfm: Sequence[Sequence[float]],
                  pseudocount: float = 0.8) -> list[list[float]]:
    """Log-odds PWM against a uniform background."""
    import math
    pwm = []
    for column in pfm:
        total = sum(column) + pseudocount
        pwm.append([math.log2(((count + pseudocount / 4) / total) / 0.25)
                    for count in column])
    return pwm


def _score(sequence: str, pwm: Sequence[Sequence[float]]) -> float:
    total = 0.0
    for offset, base in enumerate(sequence):
        index = _BASES.find(base)
        if index < 0:
            return float("-inf")
        total += pwm[offset][index]
    return total


def best_motif(sequence: str, pwm: Sequence[Sequence[float]]) -> tuple[float, int, str, float]:
    """Best-scoring PWM hit on either strand.

    Returns (score, offset, strand, relative_score) where relative_score is the
    JASPAR-style 0..1 position of the score between the worst and best the
    matrix can produce.
    """
    width = len(pwm)
    best = (float("-inf"), -1, ".")
    reverse = sequence.translate(_COMPLEMENT)[::-1]
    for strand, strand_seq in (("+", sequence), ("-", reverse)):
        for offset in range(len(strand_seq) - width + 1):
            score = _score(strand_seq[offset:offset + width], pwm)
            if score > best[0]:
                # Express the offset in forward-strand coordinates either way.
                forward_offset = offset if strand == "+" else len(sequence) - offset - width
                best = (score, forward_offset, strand)
    lowest = sum(min(column) for column in pwm)
    highest = sum(max(column) for column in pwm)
    span = highest - lowest
    relative = (best[0] - lowest) / span if span and best[0] != float("-inf") else 0.0
    return best[0], best[1], best[2], relative


def _peaks_by_anchor(pf: PortalFile, anchors: dict[str, Region]
                     ) -> dict[str, list[tuple[int, int, float | None]]]:
    """Read one peak file once and bucket its hits by anchor.

    Fetching per anchor instead would download the same file for every anchor
    in the query -- twice over for the usual locus/partner pair.
    """
    hits: dict[str, list[tuple[int, int, float | None]]] = {
        label: [] for label in anchors}
    for line in fetch_lines(pf.url):
        if not line.strip() or line.startswith(("#", "track", "browser")):
            continue
        fields = line.split("\t")
        if len(fields) < 3:
            continue
        try:
            chrom, start, end = fields[0], int(fields[1]), int(fields[2])
        except ValueError:
            continue
        signal = None
        if len(fields) >= 7:
            try:
                signal = float(fields[6])
            except ValueError:
                signal = None
        for label, anchor in anchors.items():
            if anchor.overlaps(chrom, start, end):
                hits[label].append((start, end, signal))
    return hits


def layer_ctcf_anchors(files: Sequence[PortalFile], anchors: dict[str, Region],
                       wanted_cells: Sequence[str],
                       build: str) -> tuple[list[dict[str, Any]], list[str]]:
    chosen, capped = _select(files, wanted_cells, MAX_CTCF_FILES)
    notes: list[str] = []
    if capped:
        notes.append(f"CTCF scan capped at {MAX_CTCF_FILES} files.")

    pwm: list[list[float]] | None = None
    try:
        pwm = _pwm_from_pfm(fetch_ctcf_pfm())
    except SourceError as exc:
        notes.append(f"JASPAR unreachable ({exc}); CTCF peaks are reported but "
                     f"motif orientation is left unknown rather than guessed.")

    # One sequence fetch per distinct peak interval, however many files call it.
    sequences: dict[tuple[str, int, int], str | None] = {}

    def sequence_for(anchor: Region, start: int, end: int) -> str | None:
        key = (anchor.chrom, start, end)
        if key not in sequences:
            try:
                sequences[key] = fetch_sequence(anchor.chrom, start, end, build)
            except SourceError as exc:
                notes.append(f"No sequence for {anchor.chrom}:{start}-{end}: {exc}")
                sequences[key] = None
        return sequences[key]

    rows: list[dict[str, Any]] = []
    for pf in chosen:
        try:
            by_anchor = _peaks_by_anchor(pf, anchors)
        except SourceError as exc:
            notes.append(f"Skipped CTCF file {pf.accession}: {exc}")
            continue
        for label, peaks in by_anchor.items():
            anchor = anchors[label]
            for start, end, signal in peaks:
                row = {
                    "anchor": label,
                    "cell_type": pf.cell_type,
                    "dataset": pf.accession,
                    "portal": pf.portal,
                    "peak_chrom": anchor.chrom,
                    "peak_start": start,
                    "peak_end": end,
                    "signal": signal,
                    "motif": "MA0139.1" if pwm else "",
                    "motif_start": None,
                    "motif_end": None,
                    "strand": "?",
                    "motif_score": None,
                    "motif_rel_score": None,
                    "source_url": pf.url,
                }
                if pwm:
                    sequence = sequence_for(anchor, start, end)
                    if sequence:
                        score, offset, strand, relative = best_motif(sequence, pwm)
                        if offset >= 0:
                            row.update({
                                "motif_start": start + offset,
                                "motif_end": start + offset + len(pwm),
                                "strand": strand,
                                "motif_score": round(score, 3),
                                "motif_rel_score": round(relative, 4),
                            })
                rows.append(row)
    rows.sort(key=lambda r: (r["anchor"], r["cell_type"].lower(),
                             -(r["motif_rel_score"] or 0)))
    return rows, notes


def orientation_verdict(ctcf_rows: Sequence[dict[str, Any]]) -> str:
    """Summarise whether the two anchors carry convergent CTCF motifs.

    Convergence is a statement about genomic order, so the anchors are ranked by
    position -- not by their labels, which say nothing about which comes first.
    """
    by_anchor: dict[str, dict[str, Any]] = {}
    for row in ctcf_rows:
        if row["strand"] not in {"+", "-"}:
            continue
        current = by_anchor.get(row["anchor"])
        if current is None or (row["motif_rel_score"] or 0) > (current["motif_rel_score"] or 0):
            by_anchor[row["anchor"]] = row
    if len(by_anchor) < 2:
        return "unknown"
    ordered = sorted(by_anchor.values(), key=lambda r: r["peak_start"])
    upstream, downstream = ordered[0], ordered[-1]
    if upstream["strand"] == "+" and downstream["strand"] == "-":
        return "convergent"
    if upstream["strand"] == "-" and downstream["strand"] == "+":
        return "divergent"
    return "tandem"
