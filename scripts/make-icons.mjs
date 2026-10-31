/**
 * Generates the application and tray icons with a tiny, dependency-free
 * software rasterizer. Deterministic output, no build tooling required.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'resources');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
const mix = (a, b, t) => a + (b - a) * t;
const smoothCoverage = (signedDistance, feather = 1) =>
  clamp(0.5 - signedDistance / feather, 0, 1);

function blendPixel(buf, offset, r, g, b, a) {
  if (a <= 0) return;
  const dstA = buf[offset + 3] / 255;
  const srcA = clamp(a, 0, 1);
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  buf[offset] = Math.round(clamp((r * srcA + buf[offset] * dstA * (1 - srcA)) / outA, 0, 255));
  buf[offset + 1] = Math.round(clamp((g * srcA + buf[offset + 1] * dstA * (1 - srcA)) / outA, 0, 255));
  buf[offset + 2] = Math.round(clamp((b * srcA + buf[offset + 2] * dstA * (1 - srcA)) / outA, 0, 255));
  buf[offset + 3] = Math.round(outA * 255);
}

function makeCanvas(size) {
  return Buffer.alloc(size * size * 4);
}

/** App icon: a purple squircle with two concentric lavender discs. */
function drawAppIcon(size) {
  const buf = makeCanvas(size);
  const s = size / 1024;
  const cx = size / 2;
  const cy = size / 2;
  const half = 448 * s;
  const radius = 222 * s;
  const feather = Math.max(1, 1.25 * s);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      // Squircle (rounded rectangle) distance.
      const dx = Math.abs(px - cx) - (half - radius);
      const dy = Math.abs(py - cy) - (half - radius);
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
      const inside = Math.min(Math.max(dx, dy), 0);
      const sd = outside + inside - radius;
      const coverage = smoothCoverage(sd, feather);
      if (coverage <= 0) continue;

      const t = clamp(((px - cx) / size + 0.5) * 0.55 + ((py - cy) / size + 0.5) * 0.45, 0, 1);
      let r = Math.round(mix(0xb4, 0x78, t));
      let g = Math.round(mix(0x4d, 0x28, t));
      let b = Math.round(mix(0xf2, 0xd8, t));

      // Soft top-left bloom.
      const glow = Math.exp(-(((px - size * 0.32) ** 2 + (py - size * 0.26) ** 2) / (2 * (size * 0.32) ** 2)));
      r = Math.round(mix(r, 255, glow * 0.16));
      g = Math.round(mix(g, 255, glow * 0.16));
      b = Math.round(mix(b, 255, glow * 0.16));

      const offset = (y * size + x) * 4;
      buf[offset] = r;
      buf[offset + 1] = g;
      buf[offset + 2] = b;
      buf[offset + 3] = Math.round(255 * coverage);
    }
  }

  // Concentric discs, top-left slightly brighter, like the original mark.
  const discs = [
    { r: 292 * s, a: 0.26 },
    { r: 188 * s, a: 0.42 },
  ];
  for (const disc of discs) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * 4;
        if (buf[offset + 3] === 0) continue;
        const px = x + 0.5;
        const py = y + 0.5;
        const d = Math.hypot(px - cx, py - cy) - disc.r;
        const coverage = smoothCoverage(d, feather);
        if (coverage <= 0) continue;
        const glow = clamp(1.08 - ((px - cx) + (py - cy)) / (size * 1.6), 0.9, 1.08);
        const value = Math.round(255 * glow);
        blendPixel(buf, offset, value, value, value, disc.a * coverage);
      }
    }
  }

  return buf;
}

/** Tray mark: ring + core, tuned to survive 16 px downscaling. */
function drawTrayIcon(size, active) {
  const buf = makeCanvas(size);
  const s = size / 32;
  const cx = size / 2;
  const cy = size / 2;
  const feather = Math.max(1, 1.1 * s);
  const ringColor = active ? [174, 142, 240] : [142, 138, 158];
  const coreColor = active ? [246, 182, 46] : [142, 138, 158];

  const ringRadius = 10.2 * s;
  const ringHalf = 1.85 * s;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d = Math.hypot(px - cx, py - cy);
      const offset = (y * size + x) * 4;

      const ringCoverage = smoothCoverage(Math.abs(d - ringRadius) - ringHalf, feather);
      if (ringCoverage > 0) {
        blendPixel(buf, offset, ringColor[0], ringColor[1], ringColor[2], ringCoverage);
      }

      const coreCoverage = smoothCoverage(d - 3.9 * s, feather);
      if (coreCoverage > 0) {
        blendPixel(buf, offset, coreColor[0], coreColor[1], coreColor[2], coreCoverage);
      }
    }
  }
  return buf;
}

const icon = drawAppIcon(1024);
writeFileSync(join(outDir, 'icon.png'), encodePng(1024, 1024, icon));

const trayActive = drawTrayIcon(32, true);
writeFileSync(join(outDir, 'tray-active.png'), encodePng(32, 32, trayActive));

const trayIdle = drawTrayIcon(32, false);
writeFileSync(join(outDir, 'tray-idle.png'), encodePng(32, 32, trayIdle));

console.log('[icons] resources/icon.png (1024)');
console.log('[icons] resources/tray-active.png (32)');
console.log('[icons] resources/tray-idle.png (32)');
