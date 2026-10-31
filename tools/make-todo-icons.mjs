// Icons for the Reminders app: a white check mark on a dark square. Same PNG writer as the
// other apps. Run: node tools/make-todo-icons.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { png } from "./png.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "todo");
const BG = [37, 99, 235], FG = [255, 255, 255];

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
const inMark = (x, y) => distSeg(x, y, 0.28, 0.52, 0.44, 0.68) < 0.055 || distSeg(x, y, 0.44, 0.68, 0.74, 0.34) < 0.055;

const S = 4;
function render(size) {
  const stride = size * 3, px = Buffer.alloc(stride * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let hits = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++)
      if (inMark((i + (sx + 0.5) / S) / size, (j + (sy + 0.5) / S) / size)) hits++;
    const t = hits / (S * S), o = j * stride + i * 3;
    for (let c = 0; c < 3; c++) px[o + c] = Math.round(BG[c] + (FG[c] - BG[c]) * t);
  }
  return px;
}
for (const [n, s] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(join(ROOT, n), png(s, render(s)));
  console.log("wrote todo/" + n);
}
