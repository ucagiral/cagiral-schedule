// Icons for the wardrobe app. Same PNG writer as the schedule's icons, a
// different picture: a flat t-shirt so the two apps are told apart at a glance
// on a home screen.
//
// Run:  node tools/make-wardrobe-icons.mjs
//
// Full-bleed purple square (iOS rounds it itself, and Android's maskable crop
// stays safe because the shirt sits inside the middle 80%). Shapes are sampled
// 4x4 per pixel and blended, because a neckline drawn with hard pixels looks
// ragged at 192 px.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { png } from "./png.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "wardrobe");

const BG = [124, 58, 237];        // #7c3aed — matches --accent and the manifest
const SHIRT = [255, 255, 255];

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

function inShirt(x, y) {
  const sleeves = roundRect(x, y, 0.10, 0.295, 0.90, 0.515, 0.055);
  const body = roundRect(x, y, 0.305, 0.295, 0.695, 0.845, 0.05);
  if (!sleeves && !body) return false;
  // Neckline, scooped out of the shoulders.
  const nx = x - 0.5, ny = y - 0.25;
  if (nx * nx + ny * ny < 0.118 * 0.118) return false;
  return true;
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
          if (inShirt(x, y)) hits++;
        }
      }
      const t = hits / (SAMPLES * SAMPLES);
      const o = py * stride + pxi * 3;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(BG[c] + (SHIRT[c] - BG[c]) * t);
    }
  }
  return px;
}

for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(join(ROOT, name), png(size, render(size)));
  console.log("wrote wardrobe/" + name, size + "x" + size);
}
