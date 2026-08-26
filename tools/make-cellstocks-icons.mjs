// Icons for the cell stocks app. Same PNG writer as the other two apps' icons, a
// different picture: a cryovial, upright, with its cap and the frosted line where
// the contents sit. Three apps share a home screen, so the silhouette has to be
// readable at 60 px and impossible to confuse with a calendar or a t-shirt.
//
// Run:  node tools/make-cellstocks-icons.mjs
//
// Full-bleed cyan square (iOS rounds it itself, and Android's maskable crop stays
// safe because the vial sits inside the middle 80%). Shapes are sampled 4x4 per
// pixel and blended, because a rounded cap drawn with hard pixels looks ragged at
// 192 px.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { png } from "./png.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "cellstocks");

const BG = [8, 145, 178];         // #0891b2 — matches --accent and the manifest
const GLASS = [255, 255, 255];

// Everything in 0..1 coordinates so one description serves every size.
function roundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.min(x - x0, x1 - x);
  const dy = Math.min(y - y0, y1 - y);
  if (dx < r && dy < r) {
    const ddx = r - dx, ddy = r - dy;
    return ddx * ddx + ddy * ddy <= r * r;
  }
  return true;
}

function inVial(x, y) {
  // Cap: wider than the body, with a groove under it so the two read as separate
  // parts rather than one lozenge.
  const cap = roundRect(x, y, 0.335, 0.115, 0.665, 0.235, 0.04);
  const groove = roundRect(x, y, 0.30, 0.235, 0.70, 0.262, 0.0);
  // Body: straight sides, conical shoulder into the cap, rounded base.
  const body = roundRect(x, y, 0.375, 0.262, 0.625, 0.885, 0.075);
  if (!(cap || groove || body)) return false;
  return true;
}

// The contents: a band across the lower half, punched out of the glass so it reads
// as liquid behind the wall rather than a stripe painted on it.
function inFill(x, y) {
  return roundRect(x, y, 0.415, 0.545, 0.585, 0.845, 0.045);
}

const SAMPLES = 4;

function render(size) {
  const stride = size * 3;
  const px = Buffer.alloc(stride * size);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (pxi + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (inVial(x, y) && !inFill(x, y)) hits++;
        }
      }
      const t = hits / (SAMPLES * SAMPLES);
      const o = py * stride + pxi * 3;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(BG[c] + (GLASS[c] - BG[c]) * t);
    }
  }
  return px;
}

for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(join(ROOT, name), png(size, render(size)));
  console.log("wrote cellstocks/" + name, size + "x" + size);
}
