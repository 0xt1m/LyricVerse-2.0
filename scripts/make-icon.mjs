// Renders the LyricVerse app icon to a 1024px PNG.
//
// The v1 icon only existed at 128px, which Tauri would have had to upscale for
// every macOS/Windows size. Drawing it from signed-distance functions instead
// keeps every generated size crisp, and needs no image library.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const SS = 3; // supersampling factor per axis

// --- Signed distance helpers (negative = inside) ---------------------------

const roundedRect = (px, py, cx, cy, halfW, halfH, radius) => {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
};

/** Distance to a capsule (a thick line with round caps). */
const capsule = (px, py, ax, ay, bx, by, radius) => {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lengthSq = abx * abx + aby * aby || 1;
  const t = Math.min(1, Math.max(0, (apx * abx + apy * aby) / lengthSq));
  return Math.hypot(apx - abx * t, apy - aby * t) - radius;
};

/** Turns a filled shape into an outline of the given thickness. */
const stroke = (distance, thickness) => Math.abs(distance) - thickness / 2;

/** 1px-wide analytic antialiasing on top of the supersampling. */
const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

const mix = (a, b, t) => a + (b - a) * t;
const hex = (value) => [(value >> 16) & 255, (value >> 8) & 255, value & 255];

// --- Scene -----------------------------------------------------------------

const GRADIENT_FROM = hex(0xf7bb45);
const GRADIENT_TO = hex(0xd45c17);
const INK = [255, 255, 255];

function sample(x, y) {
  const s = SIZE;
  const card = coverage(roundedRect(x, y, s / 2, s / 2, s / 2, s / 2, s * 0.225));
  if (card <= 0) return [0, 0, 0, 0];

  // Diagonal gradient across the card.
  const t = Math.min(1, Math.max(0, (x + y) / (2 * s)));
  const base = [
    mix(GRADIENT_FROM[0], GRADIENT_TO[0], t),
    mix(GRADIENT_FROM[1], GRADIENT_TO[1], t),
    mix(GRADIENT_FROM[2], GRADIENT_TO[2], t),
  ];

  // A projection screen holding two lines of lyric and a note.
  let ink = coverage(
    stroke(roundedRect(x, y, s / 2, s * 0.46, s * 0.30, s * 0.225, s * 0.055), s * 0.045),
  );

  for (const [x0, x1, yPos] of [
    [0.30, 0.70, 0.355],
    [0.345, 0.655, 0.44],
  ]) {
    ink = Math.max(ink, coverage(capsule(x, y, x0 * s, yPos * s, x1 * s, yPos * s, s * 0.024)));
  }

  const stem = capsule(x, y, 0.585 * s, 0.505 * s, 0.585 * s, 0.60 * s, s * 0.016);
  const head = capsule(x, y, 0.523 * s, 0.607 * s, 0.55 * s, 0.607 * s, s * 0.042);
  const flag = capsule(x, y, 0.585 * s, 0.505 * s, 0.645 * s, 0.552 * s, s * 0.018);
  ink = Math.max(ink, coverage(Math.min(stem, head, flag)));

  return [
    mix(base[0], INK[0], ink),
    mix(base[1], INK[1], ink),
    mix(base[2], INK[2], ink),
    card * 255,
  ];
}

// --- Render with supersampling --------------------------------------------

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [sr, sg, sb, sa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        const alpha = sa / 255;
        r += sr * alpha;
        g += sg * alpha;
        b += sb * alpha;
        a += alpha;
      }
    }
    const samples = SS * SS;
    const offset = (y * SIZE + x) * 4;
    // Un-premultiply so edges stay clean over any backdrop.
    const alpha = a / samples;
    pixels[offset] = alpha > 0 ? Math.round(r / a) : 0;
    pixels[offset + 1] = alpha > 0 ? Math.round(g / a) : 0;
    pixels[offset + 2] = alpha > 0 ? Math.round(b / a) : 0;
    pixels[offset + 3] = Math.round(alpha * 255);
  }
}

// --- Minimal PNG encoder ---------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "app-icon.png");
writeFileSync(out, png);
console.log(`[make-icon] wrote ${out} (${SIZE}x${SIZE})`);
