// Generate the app icons as real PNG files, with no image libraries —
// just node's zlib plus a hand-rolled PNG container.
//
// Run:  node tools/make-icons.mjs
//
// Design: full-bleed blue square (iOS rounds it itself, and Android's maskable
// crop stays safe because the glyph sits well inside the middle 80%), with a
// simple calendar glyph — header bar, two binder tabs, a grid of day cells,
// and today highlighted.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const BG = [37, 99, 235];      // #2563eb — matches --accent
const PAPER = [255, 255, 255];
const DIM = [176, 200, 246];   // washed-out blue for non-today cells
const TODAY = [239, 68, 68];   // #ef4444

// ---- PNG plumbing -------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type 2 = truecolour RGB, no alpha
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw scanlines, each prefixed with filter type 0.
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---- drawing ------------------------------------------------------------
function render(size) {
  const stride = size * 3;
  const px = Buffer.alloc(stride * size);

  const set = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = y * stride + x * 3;
    px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2];
  };
  const rect = (x0, y0, w, h, rgb) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, rgb);
  };
  const roundRect = (x0, y0, w, h, r, rgb) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const dx = Math.min(x - x0, x0 + w - 1 - x);
        const dy = Math.min(y - y0, y0 + h - 1 - y);
        if (dx < r && dy < r) {
          const ddx = r - dx, ddy = r - dy;
          if (ddx * ddx + ddy * ddy > r * r) continue;   // outside the corner arc
        }
        set(x, y, rgb);
      }
    }
  };

  rect(0, 0, size, size, BG);

  const u = size / 100;                       // work in percentage units
  const cardX = Math.round(18 * u), cardY = Math.round(24 * u);
  const cardW = Math.round(64 * u), cardH = Math.round(58 * u);
  const radius = Math.max(2, Math.round(6 * u));

  // binder tabs above the card
  const tabW = Math.max(2, Math.round(6 * u)), tabH = Math.max(3, Math.round(10 * u));
  roundRect(cardX + Math.round(11 * u), cardY - Math.round(tabH * 0.62), tabW, tabH, Math.max(1, Math.round(tabW / 2)), PAPER);
  roundRect(cardX + cardW - Math.round(11 * u) - tabW, cardY - Math.round(tabH * 0.62), tabW, tabH, Math.max(1, Math.round(tabW / 2)), PAPER);

  // the card, then its header band
  roundRect(cardX, cardY, cardW, cardH, radius, PAPER);
  const headH = Math.round(cardH * 0.24);
  for (let y = cardY; y < cardY + headH; y++) {
    for (let x = cardX; x < cardX + cardW; x++) {
      const dx = Math.min(x - cardX, cardX + cardW - 1 - x);
      const dy = y - cardY;
      if (dx < radius && dy < radius) {
        const ddx = radius - dx, ddy = radius - dy;
        if (ddx * ddx + ddy * ddy > radius * radius) continue;
      }
      set(x, y, BG);
    }
  }

  // 3 x 3 day cells, with the middle one as "today"
  const pad = Math.round(cardW * 0.13);
  const gridTop = cardY + headH + Math.round(cardH * 0.13);
  const avail = cardW - pad * 2;
  const gap = Math.round(avail * 0.13);
  const cell = Math.floor((avail - gap * 2) / 3);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cx = cardX + pad + c * (cell + gap);
      const cy = gridTop + r * (cell + gap);
      if (cy + cell > cardY + cardH - Math.round(cardH * 0.08)) continue;
      const isToday = r === 1 && c === 1;
      roundRect(cx, cy, cell, cell, Math.max(1, Math.round(cell * 0.28)), isToday ? TODAY : DIM);
    }
  }

  return px;
}

for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(join(ROOT, name), png(size, render(size)));
  console.log("wrote", name, size + "x" + size);
}
