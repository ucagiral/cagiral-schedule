"""GEO HiC-Pro source: GSE118629 (RWPE1, C4-2B, 22Rv1 in situ Hi-C).

This is the CRPC-relevant dataset noted in protocols/chromatin-loops.md as
"known but unwired." It differs from every other source this tool reads in
three ways that earn it its own module rather than a branch in sources.py:

  1. Deposited as HiC-Pro sparse text matrices (bin1_id, bin2_id, count) plus
     a separate bin-index BED, not a `.hic`/`.mcool` file straw can open.
  2. Mapped to hg19. Every coordinate that leaves this module has already
     been lifted to hg38 -- nothing downstream needs to know hg19 exists.
  3. No deposited loop calls, so it can only ever feed layer 2 (raw contact),
     never layer 1.

File discovery is dynamic (the GEO supplementary directory is listed and
parsed at run time) because this module was written without network access
to that directory -- hard-coding filenames guessed from convention would be
exactly the kind of confident-but-unverified assumption this project has
already been burned by twice. If the naming scheme here turns out to be
wrong, `discover_geo_files` raises with the directory listing attached so the
mismatch is visible in the run log immediately, not as a silent empty result.

Only a local window around the queried loci is ever streamed off the sparse
matrix -- see `scan_matrix_file` -- so a genome-wide file never has to be
held in memory, and "expected" is estimated from that same local window's
pairs by genomic distance, the same distance-decay idea Juicer's own
expected vector encodes, just computed here instead of read off a header.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Sequence

from sources import PortalFile, SourceError, fetch, fetch_lines

GEO_SERIES = "GSE118629"
GEO_SUPPL_BASE = "https://ftp.ncbi.nlm.nih.gov/geo/series/{bucket}/{accession}/suppl/"

# Loose on purpose: filenames on GEO are whatever the depositing lab chose,
# not a controlled vocabulary. Each pattern is tried case-insensitively.
_CELL_PATTERNS: dict[str, re.Pattern[str]] = {
    "RWPE1": re.compile(r"RWPE-?1", re.I),
    "C4-2B": re.compile(r"C4-?2-?B", re.I),
    "22Rv1": re.compile(r"22[- ]?Rv1", re.I),
}
_RESOLUTION_PATTERN = re.compile(r"(\d+)\s*(kb|000)(?![a-zA-Z])", re.I)
_NORM_PATTERN = re.compile(r"(?<![a-zA-Z0-9])(iced?|ice|raw)(?![a-zA-Z0-9])", re.I)
_BED_PATTERN = re.compile(r"\.bed(\.gz)?$", re.I)
_MATRIX_PATTERN = re.compile(r"\.matrix(\.gz)?$", re.I)


def _geo_bucket(accession: str) -> str:
    """NCBI buckets GEO series by replacing the last 3 digits with 'nnn'."""
    if not re.fullmatch(r"GSE\d+", accession):
        raise SourceError(f"not a GSE accession: {accession!r}")
    return re.sub(r"\d{3}$", "nnn", accession)


def discover_geo_files(accession: str = GEO_SERIES) -> list[str]:
    """List every supplementary file URL for a GEO series.

    Parses the directory-index HTML NCBI serves at the suppl/ path; this is
    the only place in the tool that scrapes HTML rather than calling a REST
    API, because GEO's FTP mirror does not offer one for file listings.
    """
    base = GEO_SUPPL_BASE.format(bucket=_geo_bucket(accession), accession=accession)
    try:
        html = fetch(base, accept="text/html").decode("utf-8", errors="replace")
    except SourceError as exc:
        raise SourceError(f"could not list {base}: {exc}") from exc
    candidates = re.findall(r'href="([^"]*)"', html)
    # Keep plain filenames only: no directory traversal, no query strings, no
    # nested paths -- a suppl/ listing is flat, so anything else is chrome
    # around the listing (a parent-directory link, an anchor, a query param).
    names = sorted({c for c in candidates
                    if c and c not in ("..", "../") and not c.startswith(("?", "/", "#"))
                    and "/" not in c})
    if not names:
        raise SourceError(f"{base} listed no files (layout may have changed): "
                          f"{html[:300]!r}")
    return [base + name for name in names]


@dataclass(frozen=True)
class HiCProFilePair:
    cell_type: str
    resolution_bp: int
    normalisation: str          # "RAW" | "ICE"
    matrix_url: str
    bed_url: str


def classify_geo_files(urls: Sequence[str]) -> list[HiCProFilePair]:
    """Pair each matrix file on the listing with its bin-index BED file.

    A matrix and its BED share cell type and resolution but are two separate
    files, so this groups by that key rather than assuming any naming
    convention linking the two filenames directly.
    """
    matrices: dict[tuple[str, int, str], str] = {}
    beds: dict[tuple[str, int], list[str]] = {}
    unclassified: list[str] = []

    for url in urls:
        name = url.rsplit("/", 1)[-1]
        cell = next((c for c, pat in _CELL_PATTERNS.items() if pat.search(name)), None)
        res_match = _RESOLUTION_PATTERN.search(name)
        if cell is None or res_match is None:
            unclassified.append(name)
            continue
        value, unit = res_match.groups()
        resolution = int(value) * (1_000 if unit.lower() == "kb" else 1)

        if _MATRIX_PATTERN.search(name):
            norm_match = _NORM_PATTERN.search(name)
            norm = "ICE" if (norm_match and norm_match.group(1).lower().startswith("ice")) \
                else "RAW"
            matrices[(cell, resolution, norm)] = url
        elif _BED_PATTERN.search(name):
            beds.setdefault((cell, resolution), []).append(url)
        else:
            unclassified.append(name)

    pairs: list[HiCProFilePair] = []
    for (cell, resolution, norm), matrix_url in matrices.items():
        candidates = beds.get((cell, resolution), [])
        if not candidates:
            continue  # no bin index for this matrix; can't place it on the genome
        pairs.append(HiCProFilePair(cell, resolution, norm, matrix_url, candidates[0]))
    return pairs


def to_portal_files(pairs: Sequence[HiCProFilePair]) -> list[PortalFile]:
    """Wrap each matrix/BED pair as a PortalFile the rest of the tool understands.

    `genome` is set to "hg38" because that is what every coordinate leaving
    this module will actually be in after liftOver -- the original hg19
    source build is recorded in `file_type` instead, so the substitution is
    visible rather than silent.
    """
    files = []
    for pair in pairs:
        files.append(PortalFile(
            accession=f"{GEO_SERIES}:{pair.cell_type}:{pair.resolution_bp}:{pair.normalisation}",
            portal="GEO",
            url=pair.matrix_url,
            file_format="hicpro",
            file_type=f"HiC-Pro sparse matrix, {pair.resolution_bp // 1000} kb, "
                      f"{pair.normalisation} -- hg19, lifted to hg38",
            genome="hg38",
            cell_type=pair.cell_type,
            assay="in situ Hi-C (MboI)",
            dataset_url=f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={GEO_SERIES}",
            description=pair.bed_url,  # smuggled through: scan_matrix_file needs it
        ))
    return files


# --------------------------------------------------------------------------
# liftOver
# --------------------------------------------------------------------------

class LiftoverUnavailable(SourceError):
    """The hg19->hg38 chain file could not be loaded."""


def load_liftover(chain_path: str) -> Any:
    """Build a pyliftover LiftOver object from a local chain file.

    Imported lazily so nothing else in this module needs pyliftover installed
    to be tested; the chain file itself never gets fetched by this module --
    the workflow downloads it once (a ~1.2 MB UCSC file) and passes the path.
    """
    try:
        from pyliftover import LiftOver
    except ImportError as exc:
        raise LiftoverUnavailable("pyliftover is not installed") from exc
    try:
        return LiftOver(chain_path)
    except Exception as exc:  # noqa: BLE001 - pyliftover raises bare exceptions
        raise LiftoverUnavailable(f"could not load chain file {chain_path}: {exc}") from exc


def liftover_position(lo: Any, chrom: str, pos: int) -> int | None:
    """Lift one hg19 coordinate to hg38; None if it doesn't map (e.g. a gap).

    `lo` only needs a `.convert_coordinate(chrom, pos)` method returning the
    pyliftover shape (a list of (chrom, pos, strand, score) tuples, or a
    falsy value on failure) -- a plain stand-in object satisfying that is
    enough to unit test this without a real chain file.
    """
    chrom = chrom if chrom.startswith("chr") else "chr" + chrom
    hits = lo.convert_coordinate(chrom, pos)
    if not hits:
        return None
    # A liftOver hit crossing a chromosome should never be trusted silently.
    out_chrom, out_pos = hits[0][0], hits[0][1]
    if out_chrom != chrom:
        return None
    return out_pos


# --------------------------------------------------------------------------
# bin index + matrix scan
# --------------------------------------------------------------------------

def load_bin_index(bed_url: str, chrom: str, liftover: Callable[[str, int], int | None]
                   ) -> dict[int, tuple[int, int]]:
    """Read a HiC-Pro *_abs.bed file, keep one chromosome, lift each bin to hg38.

    Returns {bin_id: (hg38_start, hg38_end)}. A bin whose start fails to lift
    is dropped -- silently including it under a neighbouring bin's coordinate
    would misplace real data.
    """
    chrom = chrom if chrom.startswith("chr") else "chr" + chrom
    index: dict[int, tuple[int, int]] = {}
    dropped = 0
    for line in fetch_lines(bed_url):
        if not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) < 4:
            continue
        row_chrom = fields[0] if fields[0].startswith("chr") else "chr" + fields[0]
        if row_chrom != chrom:
            continue
        try:
            start, end, bin_id = int(fields[1]), int(fields[2]), int(fields[3])
        except ValueError:
            continue
        lifted_start = liftover(chrom, start)
        if lifted_start is None:
            dropped += 1
            continue
        index[bin_id] = (lifted_start, lifted_start + (end - start))
    if not index:
        raise SourceError(f"{bed_url} contributed no bins for {chrom} after liftOver "
                          f"({dropped} dropped)")
    return index


def scan_matrix_file(pf: PortalFile, query: Any, partner: Any,
                     window: int, resolution: int, liftover: Callable[[str, int], int | None]
                     ) -> list[dict[str, Any]]:
    """`query`/`partner` are `layers.Region`-shaped: anything with `.chrom` and `.mid`."""
    """Read the local window of one HiC-Pro sparse matrix around query/partner.

    Mirrors the row shape `layers.scan_matrix_file` produces for `.hic` files
    (same column set), so `pair_enrichment` and everything downstream needs
    no changes to consume either source.
    """
    bed_url = pf.description  # stashed there by to_portal_files
    bin_index = load_bin_index(bed_url, query.chrom, liftover)

    left = (max(0, query.mid - window), query.mid + window)
    right = left if partner is None else (max(0, partner.mid - window), partner.mid + window)
    lo_bound, hi_bound = min(left[0], right[0]), max(left[1], right[1])

    wanted_ids = {bin_id for bin_id, (start, end) in bin_index.items()
                 if end > lo_bound and start < hi_bound}
    if not wanted_ids:
        raise SourceError(f"no {query.chrom} bins for {pf.accession} fall in the "
                          f"queried window after liftOver")
    id_lo, id_hi = min(wanted_ids), max(wanted_ids)

    pairs: list[tuple[int, int, float]] = []
    for line in fetch_lines(pf.url):
        if not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) < 3:
            continue
        try:
            bin1, bin2 = int(fields[0]), int(fields[1])
        except ValueError:
            continue
        # Cheap integer bounds check first; only parse the float and hash-look
        # up the bin index for lines that could possibly matter.
        if bin1 < id_lo or bin1 > id_hi or bin2 < id_lo or bin2 > id_hi:
            continue
        if bin1 not in bin_index or bin2 not in bin_index:
            continue
        try:
            value = float(fields[2])
        except ValueError:
            continue
        pairs.append((bin1, bin2, value))

    if not pairs:
        raise SourceError(f"{pf.accession}: no contacts in the queried window")

    expected = _expected_by_distance(pairs, bin_index, resolution)

    rows: list[dict[str, Any]] = []
    for bin1, bin2, observed in pairs:
        start1, _ = bin_index[bin1]
        start2, _ = bin_index[bin2]
        distance = round(abs(start1 - start2) / resolution)
        exp = expected.get(distance)
        rows.append({
            "cell_type": pf.cell_type,
            "dataset": pf.accession,
            "portal": pf.portal,
            "normalisation": pf.file_type.split(",")[-1].strip().split(" ")[0],
            "resolution_bp": resolution,
            "chrom": query.chrom,
            "bin1_start": min(start1, start2),
            "bin2_start": max(start1, start2),
            "observed": observed,
            "expected": exp,
            "oe": (observed / exp) if exp else None,
            "source_url": pf.url,
        })
    return rows


def _expected_by_distance(pairs: Sequence[tuple[int, int, float]],
                          bin_index: dict[int, tuple[int, int]],
                          resolution: int) -> dict[int, float]:
    """Mean contact value at each bin-separation, estimated from this local window.

    A local estimate, not a genome-wide one -- read alongside the `.hic`
    layer's KR/oe track, which is genome-wide, this is the honest caveat to
    carry into the report for GEO-sourced rows.
    """
    totals: dict[int, list[float]] = {}
    for bin1, bin2, value in pairs:
        start1, _ = bin_index[bin1]
        start2, _ = bin_index[bin2]
        distance = round(abs(start1 - start2) / resolution)
        totals.setdefault(distance, []).append(value)
    return {distance: sum(values) / len(values) for distance, values in totals.items()}
