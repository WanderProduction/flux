/**
 * Draws the FLUX icons and writes real PNG and ICO files.
 *
 *   node scripts/make-icons.mjs
 *
 * Everything is generated from code — no binary assets in the repo, no image
 * tooling to install, and the mark can be adjusted by editing numbers. Shapes
 * are rasterised at 4x and box-filtered down, which is what keeps the curves
 * clean at 16px where a Windows file icon actually lives.
 *
 * Produces:
 *   build/icon.png        512px, the app icon for packaging
 *   build/icon.ico        multi-size Windows app icon
 *   build/document.ico    multi-size icon for .flux files
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build')
const SS = 4 // supersampling factor

// The palette from src/styles/theme.css, so the icons match the app.
const BG = [13, 14, 18, 255] // --flux-bg
const EDGE = [51, 57, 73, 255] // --flux-border-strong
const CYAN = [76, 194, 255, 255] // --flux-accent
const VIOLET = [160, 107, 255, 255] // --flux-driver
const PAPER = [222, 226, 236, 255]
const PAPER_EDGE = [150, 158, 178, 255]

// ── tiny raster ───────────────────────────────────────────────

function canvas(size) {
  return { size, data: new Uint8ClampedArray(size * size * 4) }
}

function put(c, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return
  const i = (y * c.size + x) * 4
  if (a === 255) {
    c.data[i] = r
    c.data[i + 1] = g
    c.data[i + 2] = b
    c.data[i + 3] = 255
    return
  }
  // Source-over, so the mark can sit on the plate with soft edges.
  const sa = a / 255
  const da = c.data[i + 3] / 255
  const oa = sa + da * (1 - sa)
  if (oa === 0) return
  c.data[i] = (r * sa + c.data[i] * da * (1 - sa)) / oa
  c.data[i + 1] = (g * sa + c.data[i + 1] * da * (1 - sa)) / oa
  c.data[i + 2] = (b * sa + c.data[i + 2] * da * (1 - sa)) / oa
  c.data[i + 3] = oa * 255
}

/** Fills every pixel where `inside(x, y)` is true. */
function fill(c, inside, colour) {
  for (let y = 0; y < c.size; y++) {
    for (let x = 0; x < c.size; x++) {
      if (inside(x + 0.5, y + 0.5)) put(c, x, y, colour)
    }
  }
}

const roundedRect = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

/**
 * Point-in-polygon by ray casting.
 *
 * Not the cheaper "same side of every edge" test: that only works for convex
 * shapes, and the chevron here has a notch. Using the convex test rendered it
 * as a diamond — the intersection of its half-planes — which is a good reminder
 * that a wrong shape still draws happily.
 */
const polygon =
  (points) =>
  (x, y) => {
    let inside = false
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i]
      const [xj, yj] = points[j]
      const crosses = yi > y !== yj > y
      if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }

/** Box-filter down from the supersampled buffer. */
function downsample(big, size) {
  const out = canvas(size)
  const f = big.size / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < f; sy++) {
        for (let sx = 0; sx < f; sx++) {
          const i = ((y * f + sy) * big.size + (x * f + sx)) * 4
          const pa = big.data[i + 3] / 255
          r += big.data[i] * pa
          g += big.data[i + 1] * pa
          b += big.data[i + 2] * pa
          a += pa
        }
      }
      const n = f * f
      const o = (y * size + x) * 4
      out.data[o] = a > 0 ? r / a : 0
      out.data[o + 1] = a > 0 ? g / a : 0
      out.data[o + 2] = a > 0 ? b / a : 0
      out.data[o + 3] = (a / n) * 255
    }
  }
  return out
}

// ── PNG encoding ──────────────────────────────────────────────

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, body) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([len, typed, crc])
}

function encodePng(c) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(c.size, 0)
  ihdr.writeUInt32BE(c.size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // Each scanline is prefixed with a filter byte; 0 means "none", which keeps
  // this encoder short and costs a little size on icons this small.
  const raw = Buffer.alloc((c.size * 4 + 1) * c.size)
  for (let y = 0; y < c.size; y++) {
    raw[y * (c.size * 4 + 1)] = 0
    Buffer.from(c.data.buffer, y * c.size * 4, c.size * 4).copy(
      raw,
      y * (c.size * 4 + 1) + 1,
    )
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** ICO holding PNG-compressed images, which Windows has accepted since Vista. */
function encodeIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(pngs.length, 4)

  const entries = []
  let offset = 6 + pngs.length * 16
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e[4] = 1 // colour planes
    e[6] = 32 // bits per pixel
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += data.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

// ── the marks ─────────────────────────────────────────────────

/**
 * The app icon: a dark plate with a cyan chevron flowing into a violet bar.
 * The chevron reads as motion and as "play" at any size; the bar keeps the
 * composition from looking like a media player's button.
 */
function drawApp(size) {
  const c = canvas(size)
  const u = size / 100

  fill(c, roundedRect(6 * u, 6 * u, 94 * u, 94 * u, 22 * u), BG)
  // A 1px-ish inner edge so the plate has a rim on dark backgrounds.
  fill(c, roundedRect(6 * u, 6 * u, 94 * u, 94 * u, 22 * u), [0, 0, 0, 0])
  fill(
    c,
    (x, y) =>
      roundedRect(6 * u, 6 * u, 94 * u, 94 * u, 22 * u)(x, y) &&
      !roundedRect(8.5 * u, 8.5 * u, 91.5 * u, 91.5 * u, 20 * u)(x, y),
    EDGE,
  )
  fill(c, roundedRect(8.5 * u, 8.5 * u, 91.5 * u, 91.5 * u, 20 * u), BG)

  fill(
    c,
    polygon([
      [30 * u, 24 * u],
      [56 * u, 50 * u],
      [30 * u, 76 * u],
      [30 * u, 60 * u],
      [40 * u, 50 * u],
      [30 * u, 40 * u],
    ]),
    CYAN,
  )
  fill(c, roundedRect(62 * u, 24 * u, 74 * u, 76 * u, 6 * u), VIOLET)
  return c
}

/**
 * The document icon: a page with a folded corner carrying the same mark, so a
 * .flux file is recognisably FLUX's without being mistaken for the app itself.
 */
function drawDocument(size) {
  const c = canvas(size)
  const u = size / 100

  const fold = 26
  fill(
    c,
    (x, y) =>
      roundedRect(16 * u, 6 * u, 84 * u, 94 * u, 7 * u)(x, y) &&
      // Cut the top-right corner away to make the fold.
      !polygon([
        [(84 - fold) * u, 4 * u],
        [86 * u, 4 * u],
        [86 * u, (6 + fold) * u],
      ])(x, y),
    PAPER,
  )
  // The folded flap, a shade darker so it reads as turned over.
  fill(
    c,
    polygon([
      [(84 - fold) * u, 6 * u],
      [84 * u, (6 + fold) * u],
      [(84 - fold) * u, (6 + fold) * u],
    ]),
    PAPER_EDGE,
  )

  fill(
    c,
    polygon([
      [34 * u, 42 * u],
      [54 * u, 62 * u],
      [34 * u, 82 * u],
      [34 * u, 70 * u],
      [42 * u, 62 * u],
      [34 * u, 54 * u],
    ]),
    CYAN,
  )
  fill(c, roundedRect(59 * u, 42 * u, 68 * u, 82 * u, 4.5 * u), VIOLET)
  return c
}

// ── output ────────────────────────────────────────────────────

function render(draw, size) {
  return downsample(draw(size * SS), size)
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

await fs.mkdir(OUT_DIR, { recursive: true })

const appPng512 = encodePng(render(drawApp, 512))
await fs.writeFile(path.join(OUT_DIR, 'icon.png'), appPng512)

await fs.writeFile(
  path.join(OUT_DIR, 'icon.ico'),
  encodeIco(ICO_SIZES.map((size) => ({ size, data: encodePng(render(drawApp, size)) }))),
)

await fs.writeFile(
  path.join(OUT_DIR, 'document.ico'),
  encodeIco(ICO_SIZES.map((size) => ({ size, data: encodePng(render(drawDocument, size)) }))),
)

// A PNG of the document mark too, for docs and the launcher.
await fs.writeFile(path.join(OUT_DIR, 'document.png'), encodePng(render(drawDocument, 512)))

console.log('wrote build/icon.png, build/icon.ico, build/document.ico, build/document.png')
