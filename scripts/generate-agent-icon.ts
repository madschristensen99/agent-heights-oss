/**
 * Generate a marketplace icon PNG from an agent's CharAppearance.
 * Renders a single idle frame using the procedural sprite system,
 * upscales with nearest-neighbor for crisp pixel art, and saves as
 * transparent PNG. Optionally updates the DB image_url.
 *
 * Usage:
 *   pnpm tsx scripts/generate-agent-icon.ts                          # Robinhood default
 *   pnpm tsx scripts/generate-agent-icon.ts --name "My Agent" \
 *     --skin 0 --hairStyle 0 --hair 0 --shirt 0 --pants 0 \
 *     --accessory 0 --accent 0 --beard 0 --eyeColor 0 --headFeature 0
 */
import { PNG } from "pngjs";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

import {
  drawChar,
  mix,
  type CharPalette,
  type DrawSurface,
  CW,
  CH,
} from "../shared/char-draw";
import {
  type CharAppearance,
  SKIN_TONES,
  HAIR_STYLES,
  HAIR_COLORS,
  SHIRT_COLORS,
  PANTS_COLORS,
  ACCESSORIES,
  BEARD_STYLES,
  EYE_COLORS,
  HEAD_FEATURES,
} from "../shared/types";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load .env (same pattern as other scripts in this directory)
try {
  const envContent = readFileSync(resolve(ROOT, ".env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const OUT_DIR = join(ROOT, "client", "public", "assets", "agents");

// =============================================================== DrawSurface (Node)

class Sheet implements DrawSurface {
  png: PNG;
  clip: { x: number; y: number; w: number; h: number } | null = null;
  texProvider: undefined;
  componentProvider: undefined;

  constructor(public w: number, public h: number) {
    this.png = new PNG({ width: w, height: h });
  }

  get width() { return this.w; }
  get height() { return this.h; }

  private inClip(x: number, y: number) {
    if (!this.clip) return true;
    return x >= this.clip.x && x < this.clip.x + this.clip.w && y >= this.clip.y && y < this.clip.y + this.clip.h;
  }

  set(x: number, y: number, hex: string) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    if (!this.inClip(x, y)) return;
    const i = (y * this.w + x) * 4;
    const d = this.png.data;
    d[i] = parseInt(hex.slice(1, 3), 16);
    d[i + 1] = parseInt(hex.slice(3, 5), 16);
    d[i + 2] = parseInt(hex.slice(5, 7), 16);
    d[i + 3] = 255;
  }

  setAlpha(x: number, y: number, hex: string, a: number) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    if (!this.inClip(x, y)) return;
    const i = (y * this.w + x) * 4;
    const d = this.png.data;
    d[i] = Math.round(d[i] * (1 - a) + parseInt(hex.slice(1, 3), 16) * a);
    d[i + 1] = Math.round(d[i + 1] * (1 - a) + parseInt(hex.slice(3, 5), 16) * a);
    d[i + 2] = Math.round(d[i + 2] * (1 - a) + parseInt(hex.slice(5, 7), 16) * a);
  }

  rect(x: number, y: number, w: number, h: number, hex: string) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, hex);
  }

  fillCircle(cx: number, cy: number, r: number, hex: string) {
    cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
    if (r <= 0) { this.set(cx, cy, hex); return; }
    for (let y = -r; y <= r; y++) {
      const w = Math.floor(Math.sqrt(r * r - y * y));
      this.rect(cx - w, cy + y, w * 2 + 1, 1, hex);
    }
  }

  fillCircleAlpha(cx: number, cy: number, r: number, hex: string, a: number) {
    cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
    if (r <= 0) { this.setAlpha(cx, cy, hex, a); return; }
    for (let y = -r; y <= r; y++) {
      const w = Math.floor(Math.sqrt(r * r - y * y));
      for (let x = -w; x <= w; x++) this.setAlpha(cx + x, cy + y, hex, a);
    }
  }

  fillEllipse(cx: number, cy: number, rx: number, ry: number, hex: string) {
    cx = Math.round(cx); cy = Math.round(cy); rx = Math.round(rx); ry = Math.round(ry);
    if (rx <= 0 || ry <= 0) { this.set(cx, cy, hex); return; }
    for (let y = -ry; y <= ry; y++) {
      const w = Math.floor(rx * Math.sqrt(1 - (y * y) / (ry * ry)));
      this.rect(cx - w, cy + y, w * 2 + 1, 1, hex);
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, hex: string) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
      this.set(x0, y0, hex);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  lineThick(x0: number, y0: number, x1: number, y1: number, hex: string, thick: number) {
    const half = Math.floor(thick / 2);
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
      this.rect(x0 - half, y0 - half, thick, thick, hex);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, hex: string) {
    const pts = [[x0, y0], [x1, y1], [x2, y2]].sort((a, b) => a[1] - b[1]);
    const [ax, ay] = pts[0], [bx, by] = pts[1], [cx, cy] = pts[2];
    const totalH = cy - ay;
    if (totalH === 0) { this.set(ax, ay, hex); return; }
    for (let y = ay; y <= cy; y++) {
      const t1 = (y - ay) / totalH;
      const t2 = y < by ? (y - ay) / (by - ay || 1) : (y - by) / (cy - by || 1);
      const lx = Math.round(ax + (cx - ax) * t1);
      const rx2 = y < by ? Math.round(ax + (bx - ax) * t2) : Math.round(bx + (cx - bx) * t2);
      this.rect(Math.min(lx, rx2), y, Math.abs(rx2 - lx) + 1, 1, hex);
    }
  }

  fillRoundedRect(x: number, y: number, w: number, h: number, r: number, hex: string) {
    r = Math.min(r, Math.floor(w / 2), Math.floor(h / 2));
    this.rect(x + r, y, w - 2 * r, h, hex);
    this.rect(x, y + r, w, h - 2 * r, hex);
    this.fillCircle(x + r, y + r, r, hex);
    this.fillCircle(x + w - r - 1, y + r, r, hex);
    this.fillCircle(x + r, y + h - r - 1, r, hex);
    this.fillCircle(x + w - r - 1, y + h - r - 1, r, hex);
  }

  flipH(x: number, y: number, w: number, h: number) {
    const d = this.png.data;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = 0; xx < Math.floor(w / 2); xx++) {
        const a = (yy * this.w + x + xx) * 4;
        const b = (yy * this.w + x + w - 1 - xx) * 4;
        for (let c = 0; c < 4; c++) { const t = d[a + c]; d[a + c] = d[b + c]; d[b + c] = t; }
      }
    }
  }

  toBuffer(): Buffer { return PNG.sync.write(this.png); }
}

// =============================================================== palette

function appearanceToPalette(ap: CharAppearance): CharPalette {
  return {
    skin: SKIN_TONES[ap.skin % SKIN_TONES.length],
    hair: HAIR_COLORS[ap.hair % HAIR_COLORS.length],
    shirt: SHIRT_COLORS[ap.shirt % SHIRT_COLORS.length],
    shirtShade: mix(SHIRT_COLORS[ap.shirt % SHIRT_COLORS.length], "#000000", 0.2),
    pants: PANTS_COLORS[ap.pants % PANTS_COLORS.length],
    hairStyle: HAIR_STYLES[ap.hairStyle % HAIR_STYLES.length],
    accessory: ACCESSORIES[ap.accessory % ACCESSORIES.length],
    eyeColor: EYE_COLORS[ap.eyeColor % EYE_COLORS.length],
    headFeature: HEAD_FEATURES[ap.headFeature % HEAD_FEATURES.length],
    beard: BEARD_STYLES[ap.beard % BEARD_STYLES.length],
    bodyType: ap.bodyType,
  };
}

// =============================================================== defaults

const ROBINHOOD_APPEARANCE: CharAppearance = {
  skin: 1,
  hairStyle: 5,
  hair: 0,
  shirt: 12,
  pants: 1,
  accessory: 4,
  accent: 12,
  beard: 0,
  eyeColor: 0,
  headFeature: 0,
};

const COINBASE_APPEARANCE: CharAppearance = {
  skin: 1,
  hairStyle: 8, // bald
  hair: 0,
  shirt: 1,     // Coinbase blue
  pants: 5,      // dark professional
  accessory: 1,  // glasses
  accent: 9,     // blue accent
  beard: 0,      // clean-shaven
  eyeColor: 0,   // dark eyes
  headFeature: 0,
};

// =============================================================== arg parsing

interface Args {
  name: string;
  appearance: CharAppearance;
  scale: number;
  updateDb: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    name: "Robinhood Trading Agent",
    appearance: { ...ROBINHOOD_APPEARANCE },
    scale: 6,
    updateDb: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--name" && v) { args.name = v; i++; }
    if (a === "--scale" && v) { args.scale = parseInt(v); i++; }
    if (a === "--no-db") { args.updateDb = false; }
    if (a === "--skin" && v) { args.appearance.skin = parseInt(v); i++; }
    if (a === "--hairStyle" && v) { args.appearance.hairStyle = parseInt(v); i++; }
    if (a === "--hair" && v) { args.appearance.hair = parseInt(v); i++; }
    if (a === "--shirt" && v) { args.appearance.shirt = parseInt(v); i++; }
    if (a === "--pants" && v) { args.appearance.pants = parseInt(v); i++; }
    if (a === "--accessory" && v) { args.appearance.accessory = parseInt(v); i++; }
    if (a === "--accent" && v) { args.appearance.accent = parseInt(v); i++; }
    if (a === "--beard" && v) { args.appearance.beard = parseInt(v); i++; }
    if (a === "--eyeColor" && v) { args.appearance.eyeColor = parseInt(v); i++; }
    if (a === "--headFeature" && v) { args.appearance.headFeature = parseInt(v); i++; }
  }

  // Select preset appearance based on agent name (unless individual flags were passed)
  if (args.name === "Coinbase Solana Agent") {
    args.appearance = { ...COINBASE_APPEARANCE };
  }

  return args;
}

// =============================================================== main

async function main() {
  const args = parseArgs();
  const slug = args.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const outPath = join(OUT_DIR, `${slug}.png`);

  console.log(`Generating icon for: ${args.name}`);
  console.log(`  Appearance: ${JSON.stringify(args.appearance)}`);
  console.log(`  Output: ${outPath} (${CW * args.scale}×${CH * args.scale})`);

  // 1. Render single idle frame (down-facing, pose 6)
  const pal = appearanceToPalette(args.appearance);
  const sheet = new Sheet(CW, CH);
  drawChar(sheet, 0, 0, pal, "down", 6);
  const rawBuf = sheet.toBuffer();

  // 2. Upscale with nearest-neighbor for crisp pixel art
  const upscaled = await sharp(rawBuf)
    .resize(CW * args.scale, CH * args.scale, { fit: "fill", kernel: "nearest" })
    .png()
    .toBuffer();

  // 3. Save
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(outPath, upscaled);
  console.log(`  Saved: ${outPath}`);

  // 4. Update DB
  if (args.updateDb) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.warn("  [SKIP DB] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    } else {
      const sb = createClient(url, key);
      const imageUrl = `/assets/agents/${slug}.png`;
      const { error } = await sb
        .from("heights_cloud_agents")
        .update({ image_url: imageUrl })
        .eq("name", args.name);

      if (error) {
        console.error(`  [DB ERROR] ${error.message}`);
      } else {
        console.log(`  DB updated: image_url = "${imageUrl}" for "${args.name}"`);
      }
    }
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
