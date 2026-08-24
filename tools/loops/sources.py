"""Dataset discovery against the 4DN and ENCODE portals.

Both portals expose the same shape of REST search: a JSON envelope with an
"@graph" list of objects.  We ask each of them for the processed files that
could carry looping evidence (loop calls, contact matrices, domain boundaries,
CTCF peaks), normalise the two vocabularies into one `PortalFile` record, and
cache the result so repeat queries do not re-crawl.

Deliberately loose matching
---------------------------
The portals' `file_type` / `output_type` vocabularies are controlled but not
stable across pipeline versions, and they are not reachable from the
environment this module was written in.  Rather than hard-code enum strings
that may be wrong, every classifier below is a regex over the file's type and
description, and `discover()` records the full set of type strings it actually
saw in `unmatched_types`.  The first CI run therefore reports what the
vocabulary really is, and the patterns can be tightened against evidence
instead of memory.
"""

from __future__ import annotations

import gzip
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Iterable

USER_AGENT = "cagiral-schedule/loops (+https://github.com/ucagiral/cagiral-schedule)"

FOURDN = "https://data.4dnucleome.org"
ENCODE = "https://www.encodeproject.org"
ENSEMBL = "https://rest.ensembl.org"
ENSEMBL_GRCH37 = "https://grch37.rest.ensembl.org"
UCSC = "https://api.genome.ucsc.edu"
JASPAR = "https://jaspar.elixir.no/api/v1"

# The portals name the same assembly differently.
ASSEMBLY = {
    "hg38": {"4dn": "GRCh38", "encode": "GRCh38", "ucsc": "hg38"},
    "hg19": {"4dn": "GRCh37", "encode": "hg19", "ucsc": "hg19"},
}

# Minimum seconds between requests to one host.  ENCODE documents a 10 req/s
# ceiling per user; we stay an order of magnitude under it.
_THROTTLE = 0.12
_last_request: dict[str, float] = {}


class SourceError(RuntimeError):
    """A portal could not be reached or answered with something unusable."""


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def _throttle(url: str) -> None:
    host = urllib.parse.urlparse(url).netloc
    last = _last_request.get(host)
    if last is not None:
        wait = _THROTTLE - (time.monotonic() - last)
        if wait > 0:
            time.sleep(wait)
    _last_request[host] = time.monotonic()


def fetch(url: str, *, accept: str = "application/json", retries: int = 4,
          timeout: int = 120) -> bytes:
    """GET a URL, retrying on transient failures with exponential backoff."""
    delay = 2.0
    last_error: Exception | None = None
    for attempt in range(retries):
        _throttle(url)
        request = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": accept})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            # 4xx other than 429 will not improve by asking again.
            if exc.code != 429 and 400 <= exc.code < 500:
                raise SourceError(f"{url} -> HTTP {exc.code}") from exc
            last_error = exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
        if attempt < retries - 1:
            time.sleep(delay)
            delay *= 2
    raise SourceError(f"{url} unreachable after {retries} attempts: {last_error}")


def fetch_json(url: str, **kwargs: Any) -> Any:
    raw = fetch(url, **kwargs)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SourceError(f"{url} did not return JSON: {raw[:200]!r}") from exc


def fetch_lines(url: str) -> Iterable[str]:
    """Stream a text file, transparently gunzipping when it is compressed."""
    raw = fetch(url, accept="*/*")
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    for line in io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8", errors="replace"):
        yield line.rstrip("\n")


# --------------------------------------------------------------------------
# Normalised record
# --------------------------------------------------------------------------

def _as_text(value: Any) -> str:
    """Flatten a portal field to text.

    The portals are inconsistent about arity -- ENCODE returns
    `assay_term_name` as a bare string on some files and as a list on others --
    so every text field is normalised once, here, rather than at each use.
    """
    if value is None:
        return ""
    if isinstance(value, (list, tuple, set)):
        return " ".join(_as_text(item) for item in value if item is not None)
    return str(value)


@dataclass
class PortalFile:
    """One downloadable file, described the same way whichever portal it came from."""

    accession: str
    portal: str                  # "4DN" | "ENCODE"
    url: str
    file_format: str             # bedpe | bed | hic | mcool | bigBed ...
    file_type: str               # the portal's own type/output_type string
    genome: str                  # hg38 | hg19
    cell_type: str = "unknown"
    assay: str = "unknown"
    biosample_id: str = ""
    dataset_url: str = ""
    description: str = ""
    size: int = 0

    def __post_init__(self) -> None:
        for name in ("accession", "portal", "url", "file_format", "file_type",
                     "genome", "cell_type", "assay", "biosample_id",
                     "dataset_url", "description"):
            setattr(self, name, _as_text(getattr(self, name)))
        try:
            self.size = int(self.size or 0)
        except (TypeError, ValueError):
            self.size = 0

    @property
    def haystack(self) -> str:
        return " ".join((self.file_type, self.description, self.assay)).lower()

    def to_row(self, accessed: str) -> dict[str, Any]:
        return {
            "dataset": self.accession,
            "portal": self.portal,
            "cell_type": self.cell_type,
            "assay": self.assay,
            "genome": self.genome,
            "file_type": self.file_type,
            "file_format": self.file_format,
            "url": self.url,
            "accessed_utc": accessed,
        }


# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------

LOOP_PATTERN = re.compile(r"\bloop|dot[s]?\b|hiccups|chromatin interaction|"
                          r"significant interaction|contact[- ]domain", re.I)
MATRIX_PATTERN = re.compile(r"contact matrix|contact map|normalized matrix|"
                            r"juicebox|cooler", re.I)
BOUNDARY_PATTERN = re.compile(r"boundar|insulation|\btad\b|domain call", re.I)
CTCF_PATTERN = re.compile(r"\bctcf\b", re.I)
PEAK_PATTERN = re.compile(r"peak|idr|conservative|pseudoreplicated", re.I)


def is_loop_file(pf: PortalFile) -> bool:
    return pf.file_format in {"bedpe", "bed12"} and bool(LOOP_PATTERN.search(pf.haystack))


def is_contact_matrix(pf: PortalFile) -> bool:
    return pf.file_format in {"hic", "mcool", "cool"}


def is_boundary_file(pf: PortalFile) -> bool:
    return pf.file_format in {"bed", "bigBed", "bigwig", "bw"} and \
        bool(BOUNDARY_PATTERN.search(pf.haystack))


def is_ctcf_peaks(pf: PortalFile) -> bool:
    return pf.file_format.startswith("bed") and \
        bool(CTCF_PATTERN.search(pf.haystack + " " + pf.cell_type)) and \
        bool(PEAK_PATTERN.search(pf.haystack))


# --------------------------------------------------------------------------
# 4DN
# --------------------------------------------------------------------------

_4DN_FIELDS = [
    "accession", "file_format.file_format", "file_type", "file_type_detailed",
    "genome_assembly", "open_data_url", "href", "file_size", "description",
    "track_and_facet_info.biosource_name", "track_and_facet_info.assay_info",
    "track_and_facet_info.experiment_type", "dataset",
]


def _4dn_search(build: str, limit: str = "all") -> list[dict[str, Any]]:
    assembly = ASSEMBLY[build]["4dn"]
    params = [("type", "FileProcessed"), ("status", "released"),
              ("genome_assembly", assembly), ("limit", limit), ("format", "json")]
    params += [("field", f) for f in _4DN_FIELDS]
    url = f"{FOURDN}/search/?" + urllib.parse.urlencode(params)
    try:
        payload = fetch_json(url)
    except SourceError as exc:
        raise SourceError(f"4DN search failed: {exc}") from exc
    return payload.get("@graph", [])


def _4dn_to_portal_file(item: dict[str, Any], build: str) -> PortalFile | None:
    accession = item.get("accession")
    if not accession:
        return None
    fmt = (item.get("file_format") or {}).get("file_format", "")
    facets = item.get("track_and_facet_info") or {}
    url = item.get("open_data_url") or ""
    if not url:
        href = item.get("href")
        if not href:
            return None
        url = FOURDN + href
    return PortalFile(
        accession=accession,
        portal="4DN",
        url=url,
        file_format=fmt,
        file_type=item.get("file_type_detailed") or item.get("file_type") or "",
        genome=build,
        cell_type=facets.get("biosource_name") or "unknown",
        assay=facets.get("experiment_type") or facets.get("assay_info") or "unknown",
        dataset_url=f"{FOURDN}/files-processed/{accession}/",
        description=item.get("description") or "",
        size=int(item.get("file_size") or 0),
    )


# --------------------------------------------------------------------------
# ENCODE
# --------------------------------------------------------------------------

_ENCODE_FIELDS = [
    "accession", "file_format", "file_format_type", "output_type", "assembly",
    "href", "file_size", "dataset", "assay_term_name", "target.label",
    "biosample_ontology.term_name", "biosample_ontology.term_id",
]

# One search per slice keeps each response small enough to parse quickly. The
# bed slice is pinned to CTCF: an unrestricted bed search over ENCODE returns
# every peak file in the project, and none of the others are of any use here.
_ENCODE_SEARCHES: list[list[tuple[str, str]]] = [
    [("file_format", "bedpe")],
    [("file_format", "hic")],
    [("file_format", "bed"), ("target.label", "CTCF")],
    [("file_format", "bigBed"), ("target.label", "CTCF")],
]


def _encode_search(build: str) -> list[dict[str, Any]]:
    assembly = ASSEMBLY[build]["encode"]
    graph: list[dict[str, Any]] = []
    for slice_params in _ENCODE_SEARCHES:
        fmt = dict(slice_params)["file_format"]
        params = [("type", "File"), ("status", "released"), ("assembly", assembly),
                  ("limit", "all"), ("format", "json")]
        params += slice_params
        params += [("field", f) for f in _ENCODE_FIELDS]
        url = f"{ENCODE}/search/?" + urllib.parse.urlencode(params)
        try:
            payload = fetch_json(url)
        except SourceError as exc:
            # A format with no matches answers 404 on this portal; that is not
            # a failure of the search as a whole.
            if "HTTP 404" in str(exc):
                continue
            raise SourceError(f"ENCODE search failed for {fmt}: {exc}") from exc
        graph.extend(payload.get("@graph", []))
    return graph


def _encode_to_portal_file(item: dict[str, Any], build: str) -> PortalFile | None:
    accession = item.get("accession")
    href = item.get("href")
    if not accession or not href:
        return None
    ontology = item.get("biosample_ontology") or {}
    if isinstance(ontology, list):
        ontology = ontology[0] if ontology else {}
    dataset = item.get("dataset") or ""
    return PortalFile(
        accession=accession,
        portal="ENCODE",
        url=ENCODE + href,
        file_format=item.get("file_format") or "",
        file_type=item.get("output_type") or "",
        genome=build,
        cell_type=ontology.get("term_name") or "unknown",
        assay=item.get("assay_term_name") or "unknown",
        biosample_id=ontology.get("term_id") or "",
        dataset_url=ENCODE + dataset if dataset.startswith("/") else dataset,
        description=" ".join(filter(None, [
            _as_text(item.get("file_format_type")),
            _as_text((item.get("target") or {}).get("label")
                     if isinstance(item.get("target"), dict)
                     else item.get("target")),
        ])),
        size=int(item.get("file_size") or 0),
    )


# --------------------------------------------------------------------------
# GEO (GSE118629 -- RWPE1, C4-2B, 22Rv1 HiC-Pro matrices, hg19 -> hg38)
# --------------------------------------------------------------------------
#
# Wired in separately from the 4DN/ENCODE REST clients above because this
# source has nothing in common with them: no REST search, a sparse-matrix
# format straw cannot read, and a genome build that has to be lifted before
# any coordinate from it can sit next to the rest of the catalogue. It only
# ever contributes to layer 2 (raw contact) -- see protocols/chromatin-loops.md.
#
# Only wired for hg38 queries: the source is natively hg19, and lifting it
# to match an hg19 *query* would be a no-op worth skipping rather than a
# second code path worth maintaining for a build this tool already treats as
# second-class.

def discover_geo(build: str) -> tuple[list[PortalFile], list[str]]:
    """Find and catalogue GSE118629's HiC-Pro files. Never raises: a failure
    here is a missing source, not a reason to fail the whole crawl."""
    import geo_hicpro  # local: breaks the geo_hicpro <-> sources import cycle
    if build != "hg38":
        return [], []
    try:
        urls = geo_hicpro.discover_geo_files()
        pairs = geo_hicpro.classify_geo_files(urls)
        if not pairs:
            sample = [u.rsplit("/", 1)[-1] for u in urls[:25]]
            return [], [f"GEO {geo_hicpro.GEO_SERIES}: listing had {len(urls)} files "
                        f"but none matched the expected cell/resolution naming -- "
                        f"first {len(sample)}: {sample}"]
        return geo_hicpro.to_portal_files(pairs), []
    except SourceError as exc:
        return [], [f"GEO {geo_hicpro.GEO_SERIES} unavailable: {exc}"]


# --------------------------------------------------------------------------
# Discovery + cache
# --------------------------------------------------------------------------

@dataclass
class Catalogue:
    build: str
    fetched_utc: str
    loops: list[PortalFile] = field(default_factory=list)
    matrices: list[PortalFile] = field(default_factory=list)
    boundaries: list[PortalFile] = field(default_factory=list)
    ctcf: list[PortalFile] = field(default_factory=list)
    # Every type string seen but not classified, so the regexes above can be
    # tightened against what the portals actually emit.
    unmatched_types: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def all_files(self) -> list[PortalFile]:
        return self.loops + self.matrices + self.boundaries + self.ctcf

    def cell_types(self) -> list[str]:
        return sorted({pf.cell_type for pf in self.all_files()})


def discover(build: str = "hg38") -> Catalogue:
    """Crawl both portals and bucket the files by the evidence they can support."""
    if build not in ASSEMBLY:
        raise SourceError(f"unsupported genome build {build!r}; use hg38 or hg19")

    catalogue = Catalogue(build=build,
                          fetched_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    unmatched: set[str] = set()

    for name, search, convert in (
        ("4DN", _4dn_search, _4dn_to_portal_file),
        ("ENCODE", _encode_search, _encode_to_portal_file),
    ):
        try:
            items = search(build)
        except SourceError as exc:
            # One portal being down should not sink the whole query; the report
            # says which layers are therefore incomplete.
            catalogue.errors.append(str(exc))
            continue
        for item in items:
            pf = convert(item, build)
            if pf is None:
                continue
            if is_loop_file(pf):
                catalogue.loops.append(pf)
            elif is_contact_matrix(pf):
                catalogue.matrices.append(pf)
            elif is_boundary_file(pf):
                catalogue.boundaries.append(pf)
            elif is_ctcf_peaks(pf):
                catalogue.ctcf.append(pf)
            elif pf.file_type:
                unmatched.add(f"{name}:{pf.file_format}:{pf.file_type}")

    geo_files, geo_errors = discover_geo(build)
    catalogue.matrices.extend(geo_files)
    catalogue.errors.extend(geo_errors)

    catalogue.unmatched_types = sorted(unmatched)
    return catalogue


def _encode_catalogue(catalogue: Catalogue) -> dict[str, Any]:
    payload = asdict(catalogue)
    for key in ("loops", "matrices", "boundaries", "ctcf"):
        payload[key] = [asdict(pf) for pf in getattr(catalogue, key)]
    return payload


def _decode_catalogue(payload: dict[str, Any]) -> Catalogue:
    catalogue = Catalogue(build=payload["build"], fetched_utc=payload["fetched_utc"],
                          unmatched_types=payload.get("unmatched_types", []),
                          errors=payload.get("errors", []))
    for key in ("loops", "matrices", "boundaries", "ctcf"):
        setattr(catalogue, key, [PortalFile(**d) for d in payload.get(key, [])])
    return catalogue


def load_or_discover(cache_path: str, build: str = "hg38", *,
                     max_age_days: int = 30, refresh: bool = False) -> Catalogue:
    """Return a catalogue, reusing the on-disk cache while it is fresh enough."""
    if not refresh and os.path.exists(cache_path):
        try:
            payload = json.load(open(cache_path, encoding="utf-8"))
            if payload.get("build") == build:
                fetched = datetime.fromisoformat(payload["fetched_utc"])
                age = (datetime.now(timezone.utc) - fetched).days
                if age <= max_age_days:
                    return _decode_catalogue(payload)
        except (json.JSONDecodeError, KeyError, ValueError, OSError):
            pass  # A damaged cache is simply re-crawled.

    catalogue = discover(build)
    os.makedirs(os.path.dirname(cache_path) or ".", exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as handle:
        json.dump(_encode_catalogue(catalogue), handle, indent=2, sort_keys=True)
        handle.write("\n")
    return catalogue


# --------------------------------------------------------------------------
# Coordinate and sequence services
# --------------------------------------------------------------------------

def resolve_gene(symbol: str, build: str = "hg38") -> tuple[str, int, int, int]:
    """Look a gene symbol up in Ensembl.

    Returns (chrom, start, end, strand) with 0-based half-open coordinates and
    strand as +1 / -1, so a caller can anchor on the TSS instead of the whole
    span -- which for looping is almost always what is meant.
    """
    host = ENSEMBL if build == "hg38" else ENSEMBL_GRCH37
    url = f"{host}/lookup/symbol/homo_sapiens/{urllib.parse.quote(symbol)}?expand=0"
    payload = fetch_json(url)
    chrom = str(payload.get("seq_region_name", ""))
    if not chrom or "start" not in payload:
        raise SourceError(f"Ensembl returned no coordinates for {symbol!r}")
    if not chrom.startswith("chr"):
        chrom = "chr" + chrom
    # Ensembl is 1-based inclusive; the rest of this tool is 0-based half-open.
    strand = int(payload.get("strand", 1) or 1)
    return chrom, int(payload["start"]) - 1, int(payload["end"]), strand


def fetch_sequence(chrom: str, start: int, end: int, build: str = "hg38") -> str:
    """Pull genomic sequence from the UCSC REST API, uppercased."""
    genome = ASSEMBLY[build]["ucsc"]
    url = (f"{UCSC}/getData/sequence?genome={genome};chrom={chrom};"
           f"start={start};end={end}")
    payload = fetch_json(url)
    dna = payload.get("dna")
    if not dna:
        raise SourceError(f"UCSC returned no sequence for {chrom}:{start}-{end}")
    return dna.upper()


def fetch_ctcf_pfm(matrix_id: str = "MA0139.1") -> list[list[float]]:
    """Fetch the CTCF position frequency matrix from JASPAR.

    Fetched rather than embedded on purpose: a mis-transcribed PFM would not
    fail loudly, it would silently report the wrong motif strand, and strand is
    the whole point of the CTCF layer.  If JASPAR is unreachable the caller
    reports orientation as unknown instead of guessing.
    """
    payload = fetch_json(f"{JASPAR}/matrix/{matrix_id}/?format=json")
    pfm = payload.get("pfm")
    if not pfm:
        raise SourceError(f"JASPAR returned no pfm for {matrix_id}")
    rows = [pfm[base] for base in ("A", "C", "G", "T")]
    width = len(rows[0])
    if any(len(row) != width for row in rows):
        raise SourceError(f"JASPAR pfm for {matrix_id} is ragged")
    # Transpose to one list of four counts per position.
    return [[float(rows[b][i]) for b in range(4)] for i in range(width)]
