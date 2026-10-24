#!/usr/bin/env Rscript
#
# AR promoter looping at the C1-C4 downstream candidate enhancers (Quigley
# et al., JCI 2024, DOI 10.1172/JCI178604): PC (LNCaP) vs mCRPC (22Rv1) at
# C3 (chrX:67,746,500-67,748,100, negative for looping in that paper's own
# HiChIP) and C4 (chrX:67,787,800-67,793,300, the one that was positive).
#
# Reads four small CSVs already committed to loops/ by the repo's looping
# query tool (tools/loops/query.py, run via GitHub Actions) -- nothing here
# fetches raw Hi-C data or downloads anything. Base R graphics only: no
# package is required to be pre-installed, and every package this script
# does use is installed on demand if missing (see ensure_package() below).
#
# Run from the repository root:
#   Rscript tools/loops/plot_c3_c4_pc_vs_mcrpc.R
#
# Output: loops/c3-c4-pc-vs-mcrpc.png
#
# What the figure shows and does not show is spelled out in the caveats
# printed at the end of this script and in protocols/chromatin-loops.md --
# read those before quoting a number out of the figure.

ensure_package <- function(pkg) {
  if (!requireNamespace(pkg, quietly = TRUE)) {
    message(sprintf("Installing required package '%s'...", pkg))
    install.packages(pkg, repos = "https://cloud.r-project.org")
  }
  if (!requireNamespace(pkg, quietly = TRUE)) {
    stop(sprintf(
      "Package '%s' could not be installed automatically. Install it by hand\n",
      "  (install.packages(\"%s\")) and re-run this script.", pkg, pkg
    ))
  }
}
# Deliberately none yet: every plotting element below uses only the graphics,
# grDevices and stats packages R ships with. If a future edit adds a real
# dependency, call ensure_package("name") for it right here, and nowhere else.

# ---------------------------------------------------------------------------
# Locate the input files
# ---------------------------------------------------------------------------

find_loops_dir <- function() {
  candidates <- c("loops", file.path("..", "..", "loops"),
                   file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(), value = TRUE))), "..", "..", "loops"))
  for (candidate in candidates) {
    if (dir.exists(candidate) &&
        file.exists(file.path(candidate, "c3-c4-pair-oe.csv"))) {
      return(normalizePath(candidate))
    }
  }
  stop(paste(
    "Could not find the loops/ directory with c3-c4-*.csv in it.",
    "Run this script from the repository root:",
    "  Rscript tools/loops/plot_c3_c4_pc_vs_mcrpc.R",
    sep = "\n"
  ))
}

loops_dir <- find_loops_dir()
message("Reading input data from: ", loops_dir)

read_input <- function(name) {
  path <- file.path(loops_dir, name)
  if (!file.exists(path)) {
    stop(sprintf("Expected input file is missing: %s", path))
  }
  read.csv(path, stringsAsFactors = FALSE)
}

contact   <- read_input("c3-c4-contact-matrix.csv")
pair_oe   <- read_input("c3-c4-pair-oe.csv")
summary_d <- read_input("c3-c4-pc-vs-mcrpc-summary.csv")

LOCI          <- c("C3", "C4")
GROUPS        <- c("PC", "mCRPC")
GROUP_LABELS  <- c(PC = "PC (LNCaP)", mCRPC = "mCRPC (22Rv1)")
LOCUS_LABELS  <- c(C3 = "C3  chrX:67,746,500-67,748,100",
                   C4 = "C4  chrX:67,787,800-67,793,300")

# ---------------------------------------------------------------------------
# Build one dense local-contact matrix per (locus, group), averaged across
# that group's replicate datasets at 10 kb -- the one resolution both PC and
# mCRPC data share, so the four heatmap panels are directly comparable.
# ---------------------------------------------------------------------------

build_matrix <- function(locus, group) {
  rows <- contact[contact$locus == locus & contact$group == group &
                   contact$resolution_bp == 10000, ]
  if (nrow(rows) == 0) {
    return(NULL)
  }
  # Average O/E for a bin pair across that group's replicate datasets, so two
  # LNCaP files or 22Rv1's RAW/NORM pair collapse to one clean value per cell.
  agg <- aggregate(oe ~ bin1_start + bin2_start, data = rows, FUN = mean)

  bins <- sort(unique(c(agg$bin1_start, agg$bin2_start)))
  n <- length(bins)
  index_of <- setNames(seq_along(bins), as.character(bins))

  m <- matrix(NA_real_, nrow = n, ncol = n, dimnames = list(bins, bins))
  for (i in seq_len(nrow(agg))) {
    a <- index_of[[as.character(agg$bin1_start[i])]]
    b <- index_of[[as.character(agg$bin2_start[i])]]
    m[a, b] <- agg$oe[i]
    m[b, a] <- agg$oe[i]  # symmetric: the matrix is undirected contact
  }
  list(bins = bins, m = m)
}

matrices <- list()
for (locus in LOCI) {
  for (group in GROUPS) {
    matrices[[paste(locus, group)]] <- build_matrix(locus, group)
  }
}

# log2(O/E) heatmap colour scale, centred on 0 (= O/E of 1, i.e. exactly the
# distance expectation): teal below, paper at the centre, crimson above.
# Built with colorRampPalette() -- part of base grDevices, no package needed.
heat_palette <- colorRampPalette(c("#2E6E71", "#F4F3EE", "#B23A2E"))(101)

# One cap shared by all four panels: each panel colour-scaled to its own max
# would make "dark red" mean a different absolute O/E in every panel, which
# defeats the point of a PC-vs-mCRPC comparison figure.
global_cap <- local({
  vals <- unlist(lapply(matrices, function(entry) {
    if (is.null(entry)) return(NULL)
    v <- log2(entry$m)
    v[is.finite(v)]
  }))
  cap <- max(abs(vals), na.rm = TRUE)
  if (!is.finite(cap) || cap == 0) 1 else cap
})

draw_heatmap <- function(entry, title) {
  if (is.null(entry)) {
    plot.new()
    title(main = title, cex.main = 0.85)
    text(0.5, 0.5, "no 10 kb data", col = "grey45", cex = 0.85)
    return(invisible(NULL))
  }
  m <- log2(entry$m)
  nr <- nrow(m); nc <- ncol(m)
  # A bin pair with no recorded contact is NA, and image() simply skips NA
  # cells -- leaving whatever was drawn underneath. Left alone, "no data"
  # and "data present, O/E close to 1" would both read as pale/blank, which
  # is exactly the distinction this figure needs to keep visible: LNCaP's
  # sparse ENCODE coverage in this window has far more true gaps than 22Rv1's
  # denser GEO matrix does. A distinct grey fill drawn first makes a gap read
  # as a gap rather than as "nothing going on here."
  plot(NA, xlim = c(0.5, nr + 0.5), ylim = c(0.5, nc + 0.5),
      axes = FALSE, xlab = "", ylab = "", main = title, cex.main = 0.85)
  rect(0.5, 0.5, nr + 0.5, nc + 0.5, col = "grey78", border = NA)
  # image() plots [row, col] with row as x -- transpose so bin1 runs left to
  # right and bin2 runs bottom to top, matching how the axis labels are read.
  image(x = seq_len(nr), y = seq_len(nc), z = t(m),
        zlim = c(-global_cap, global_cap), col = heat_palette,
        axes = FALSE, add = TRUE)
  box(col = "grey40")
}

# ---------------------------------------------------------------------------
# Render: 2x2 heatmap grid (rows = locus, columns = PC/mCRPC) on top, one
# summary bar panel underneath. All in one PNG, base graphics layout() only.
# ---------------------------------------------------------------------------

out_path <- file.path(loops_dir, "c3-c4-pc-vs-mcrpc.png")
png(out_path, width = 1500, height = 1900, res = 200)

layout(matrix(c(1, 2,
               3, 4,
               5, 5), nrow = 3, byrow = TRUE),
      heights = c(1, 1, 1.1))
par(mar = c(2.5, 2.5, 2.5, 1.5), oma = c(0, 0, 3, 0))

for (locus in LOCI) {
  for (group in GROUPS) {
    draw_heatmap(matrices[[paste(locus, group)]],
                title = paste0(locus, " — ", GROUP_LABELS[[group]]))
  }
}

# --- summary bar panel ------------------------------------------------------
par(mar = c(4, 4.5, 3, 1.5))
bar_data <- matrix(NA_real_, nrow = 2, ncol = 2,
                   dimnames = list(GROUPS, LOCI))
for (locus in LOCI) {
  for (group in GROUPS) {
    bar_data[group, locus] <- pair_oe$oe[pair_oe$locus == locus & pair_oe$group == group] |>
      mean()
  }
}

bar_colors <- c(PC = "#2E6E71", mCRPC = "#B23A2E")
mids <- barplot(bar_data, beside = TRUE, col = bar_colors[GROUPS],
                border = NA, ylim = c(0, max(bar_data, na.rm = TRUE) * 1.35),
                ylab = "Observed / distance-expected (10 kb)",
                main = "PC vs mCRPC contact enrichment at the AR promoter",
                cex.main = 0.95, las = 1)

# individual replicate points, jittered slightly, so the n=2 behind each bar
# is visible rather than implied.
#
# barplot(beside=TRUE) does not carry the input matrix's dimnames onto the
# midpoint matrix it returns, only its shape -- index mids by position
# (row = group, column = locus, matching bar_data's own layout) rather than
# by name.
for (li in seq_along(LOCI)) {
  locus <- LOCI[li]
  for (gi in seq_along(GROUPS)) {
    group <- GROUPS[gi]
    vals <- pair_oe$oe[pair_oe$locus == locus & pair_oe$group == group]
    x <- mids[gi, li]
    points(jitter(rep(x, length(vals)), amount = 0.08), vals,
          pch = 21, bg = "white", col = "grey20", cex = 1.1)
  }
}

# ratio annotation between each locus's PC/mCRPC pair
for (li in seq_along(LOCI)) {
  locus <- LOCI[li]
  ratio <- summary_d$pc_over_mcrpc_ratio[summary_d$locus == locus]
  x_mid <- mean(mids[, li])
  y_top <- max(bar_data[, locus], na.rm = TRUE)
  text(x_mid, y_top * 1.18, sprintf("PC/mCRPC = %.1fx", ratio),
      cex = 0.85, font = 2)
}

legend("topright", legend = GROUP_LABELS[GROUPS], fill = bar_colors[GROUPS],
      border = NA, bty = "n", cex = 0.85)

title_lines <- strwrap(
  "AR promoter vs C3/C4 (Quigley et al. 2024): C3 was negative for looping in that paper, C4 positive",
  width = 100)
mtext(title_lines, outer = TRUE, cex = 0.85, font = 2,
     line = rev(seq_along(title_lines) - 1) + 0.3, adj = 0.5)

dev.off()

message("Wrote ", out_path)

# ---------------------------------------------------------------------------
# Caveats -- read before quoting a number from the figure
# ---------------------------------------------------------------------------
message("\n--- Caveats ---")
message("- These are raw observed/distance-expected values, not called loops:")
message("  no caller flagged a loop at either C3 or C4 in the datasets searched.")
message("- LNCaP (PC) is androgen-sensitive, not mCRPC; 22Rv1 (mCRPC) is a real")
message("  castration-resistant line, but neither is LuCaP-35CR.")
message("- AR is copy-number amplified in castration-resistant disease. O/E is")
message("  not corrected for amplification and should be read as an upper bound,")
message("  especially for any mCRPC-line value.")
message("- 22Rv1 data is from GSE118629 (HiC-Pro, hg19, lifted to hg38 here);")
message("  its 'expected' is a local estimate from the queried window, not the")
message("  genome-wide track the ENCODE .hic files carry -- not the same kind")
message("  of number as the LNCaP values, only comparable in a broad sense.")
message("- Full method and sources: protocols/chromatin-loops.md,")
message("  loops/ar-vs-chrx-67-746-500-67-748-100.md (C3),")
message("  loops/ar-vs-chrx-67-787-800-67-793-300.md (C4).")
