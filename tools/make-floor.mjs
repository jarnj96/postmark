// make-floor.mjs — compose the outside ground as one floor image:
// tiled night grass + the river ribbon (the atlas's own WATER_WAYPOINTS,
// scaled) + soft region washes with names. Placeholder-quality on purpose;
// the geometry is canonical, the paint is v0.
//
// Coordinate source: PROJECTS/build-the-town/atlas/render-town.mjs (the
// atlas map, 1200x1600 portrait) — scaled here onto the room floor.
// sharp is borrowed from the site's node_modules (PoC-local hack).

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire("G:/content-creation/starforge-site/package.json");
const sharp = require("sharp");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const W = 1400, H = 850; // room floor canvas

// the atlas's river, verbatim (render-town.mjs WATER_WAYPOINTS, 1200x1600)
const WATER = [
  { x: 190, y: -20, w: 0 }, { x: 210, y: 80, w: 24 }, { x: 240, y: 180, w: 34 },
  { x: 280, y: 300, w: 46 }, { x: 335, y: 430, w: 60 }, { x: 395, y: 560, w: 80 },
  { x: 445, y: 670, w: 108 }, { x: 485, y: 760, w: 148 }, { x: 515, y: 860, w: 118 },
  { x: 550, y: 970, w: 122 }, { x: 590, y: 1080, w: 130 }, { x: 635, y: 1200, w: 142 },
  { x: 685, y: 1320, w: 158 }, { x: 740, y: 1440, w: 178 }, { x: 790, y: 1560, w: 200 },
  { x: 815, y: 1630, w: 222 },
];
// region washes (render-town.mjs REGION_LAYOUT + threshold terraces, same canvas)
const REGIONS = [
  { name: "the Trueing Terrace", cx: 670, cy: 280, rx: 175, ry: 150, wash: "#7d8f86" },
  { name: "the Lanternseed Gardens", cx: 670, cy: 560, rx: 175, ry: 145, wash: "#7a9c5a" },
  { name: "the Long Run", cx: 1010, cy: 1460, rx: 140, ry: 145, wash: "#a8895a" },
  { name: "the Protected Grove", cx: 210, cy: 235, rx: 135, ry: 112, wash: "#4a7d5f" },
  { name: "the Doubled Coast", cx: 545, cy: 1465, rx: 165, ry: 80, wash: "#8f7a9c" },
  { name: "the Threshold District", cx: 795, cy: 1025, rx: 150, ry: 190, wash: "#6b7a8c" },
  // the two young regions, placed from their atlas semantics (no drawn wash upstream yet)
  { name: "the Reach", cx: 130, cy: 1300, rx: 110, ry: 190, wash: "#5f7a8c" },
  { name: "Aelyria", cx: 1080, cy: 1560, rx: 130, ry: 90, wash: "#7a6b9c" },
];

const sx = (x) => (x / 1200) * W;
const sy = (y) => (y / 1600) * H;

function smoothSegment(pts) {
  if (pts.length < 2) return `L${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)} `;
  let d = "";
  for (let i = 0; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    d += `Q${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)} `;
  }
  const last = pts[pts.length - 1];
  return d + `L${last.x.toFixed(1)},${last.y.toFixed(1)} `;
}
function ribbonPath(waypoints) {
  const left = [], right = [];
  for (let i = 0; i < waypoints.length; i++) {
    const p = waypoints[i];
    const prev = waypoints[Math.max(0, i - 1)];
    const next = waypoints[Math.min(waypoints.length - 1, i + 1)];
    let dx = next.x - prev.x, dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const nx = -dy, ny = dx, w = p.w / 2;
    left.push({ x: p.x + nx * w, y: p.y + ny * w });
    right.push({ x: p.x - nx * w, y: p.y - ny * w });
  }
  const r = right.slice().reverse();
  return `M${left[0].x.toFixed(1)},${left[0].y.toFixed(1)} ` +
    smoothSegment(left.slice(1)) + smoothSegment(r) + "Z";
}

const scaled = WATER.map((p) => ({ x: sx(p.x), y: sy(p.y), w: (p.w / 1200) * W }));
const river = ribbonPath(scaled);
const riverCore = ribbonPath(scaled.map((p) => ({ ...p, w: p.w * 0.4 })));

const grassB64 = readFileSync(join(ROOT, "public", "sprites", "ground", "grass.png")).toString("base64");

const washes = REGIONS.map((r) => `
  <ellipse cx="${sx(r.cx).toFixed(0)}" cy="${sy(r.cy).toFixed(0)}" rx="${((r.rx / 1200) * W).toFixed(0)}" ry="${((r.ry / 1600) * H).toFixed(0)}"
    fill="${r.wash}" opacity="0.13"/>
  <text x="${sx(r.cx).toFixed(0)}" y="${(sy(r.cy) - (r.ry / 1600) * H - 6).toFixed(0)}" text-anchor="middle"
    font-family="Georgia, serif" font-style="italic" font-size="15" fill="#cfc6ad" opacity="0.75">${r.name}</text>`).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <pattern id="grass" width="48" height="48" patternUnits="userSpaceOnUse">
      <image href="data:image/png;base64,${grassB64}" width="48" height="48"/>
    </pattern>
    <linearGradient id="waterGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1e3a52"/>
      <stop offset="100%" stop-color="#122943"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#grass)"/>
  ${washes}
  <path d="${river}" fill="url(#waterGrad)"/>
  <path d="${river}" fill="none" stroke="#3d5f7a" stroke-width="1.5" opacity="0.6"/>
  <path d="${riverCore}" fill="none" stroke="#4d7192" stroke-width="2" opacity="0.35"/>
  <rect x="0" y="${H - 28}" width="${W}" height="28" fill="#0b1622" opacity="0.9"/>
  <text x="${W / 2}" y="${H - 9}" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="13" fill="#4d7192">the open sea</text>
</svg>`;

const out = join(ROOT, "public", "sprites", "ground", "outside-floor.png");
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`wrote ${out} (${W}x${H}, river + ${REGIONS.length} region washes over grass)`);
