// Generates Phase 1 demo pack fixtures. Deterministic, no network.
// Run: node scripts/generate-fixtures.mjs (or npm run gen:fixtures)
//
// SINGLE SOURCE OF TRUTH: the canonical flow/geometry logic lives in
// TypeScript (src/flow/fakeFlow.ts and src/geometry/parametric.ts). This
// script is a line-for-line mirror for offline fixture baking only: same
// cosine spacing, same closed TE coeff (-0.1036), same aerodynamic alpha sign
// (positive = nose up = negated math angle), same FNV-1a hashSeed, same
// mulberry32 jitter, same obstacle masks (naca4, cylinder, block, orifice),
// same alpha-deflected wake model with the characterized band clamp, same
// v-phase `seed % 7`.
// If you change the TS modules, mirror the change here, regenerate, and run
// the parity guard: npm test -- fixtures.parity

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outBase = join(root, "public", "demo-pack");

// Mirror of naca4Airfoil in src/geometry/parametric.ts.
function naca4(m, p, t, nPoints) {
    if (!Number.isInteger(nPoints) || nPoints < 2) throw new Error(`nPoints must be an integer >= 2, got ${nPoints}`);
    if (!(m >= 0 && m <= 0.095)) throw new Error(`m must be in [0, 0.095], got ${m}`);
    if (m > 1e-10 && !(p > 0 && p < 1)) throw new Error(`p must be in (0, 1) when m > 0, got ${p}`);
    if (!(t > 0 && t <= 0.4)) throw new Error(`t must be in (0, 0.4], got ${t}`);
    const x = [];
    for (let i = 0; i < nPoints; i++) x.push((1 - Math.cos((i / (nPoints - 1)) * Math.PI)) / 2);
    const yt = x.map((xi) => 5 * t * (0.2969 * Math.sqrt(xi) - 0.126 * xi - 0.3516 * xi ** 2 + 0.2843 * xi ** 3 - 0.1036 * xi ** 4));
    const yc = new Array(nPoints).fill(0);
    const dyc = new Array(nPoints).fill(0);
    if (m > 1e-10 && p > 1e-10) {
        for (let i = 0; i < nPoints; i++) {
            if (x[i] < p) {
                yc[i] = (m / (p * p)) * (2 * p * x[i] - x[i] * x[i]);
                dyc[i] = ((2 * m) / (p * p)) * (p - x[i]);
            } else {
                yc[i] = (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x[i] - x[i] * x[i]);
                dyc[i] = ((2 * m) / ((1 - p) * (1 - p))) * (p - x[i]);
            }
        }
    }
    const upper = [];
    const lower = [];
    for (let i = 0; i < nPoints; i++) {
        const th = Math.atan(dyc[i]);
        upper.push({ x: x[i] - yt[i] * Math.sin(th), y: yc[i] + yt[i] * Math.cos(th) });
        lower.push({ x: x[i] + yt[i] * Math.sin(th), y: yc[i] - yt[i] * Math.cos(th) });
    }
    const pts = [];
    for (let i = nPoints - 1; i >= 0; i--) pts.push(upper[i]);
    for (let i = 1; i < nPoints; i++) pts.push(lower[i]);
    return pts;
}

// Mirror of transformPoints: angleDeg is aerodynamic alpha (positive = nose
// up), so the math angle is negated. Keep in sync with parametric.ts.
function transform(points, cx, cy, scale, angleDeg) {
    if (!Array.isArray(points) || points.length === 0) throw new Error("polygon must be non-empty");
    if (!Number.isFinite(scale) || scale <= 0) throw new Error(`scale (chord) must be positive, got ${scale}`);
    const a = (-angleDeg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return points.map((pt) => {
        const xs = pt.x * scale;
        const ys = pt.y * scale;
        return { x: xs * c - ys * s + cx, y: xs * s + ys * c + cy };
    });
}

function pointInPolygon(px, py, poly) {
    if (!Array.isArray(poly) || poly.length === 0) throw new Error("polygon must be non-empty");
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Mirror of obstacleMask in src/flow/fakeFlow.ts (naca4, cylinder, block, orifice).
function obstacleMask(px, py, geom, poly) {
    if (geom.kind === "naca4") {
        if (!poly) return false;
        return pointInPolygon(px, py, poly);
    }
    if (geom.kind === "cylinder") {
        const c = geom.center ?? { x: 0.5, y: 0 };
        const r = geom.radius ?? 0.25;
        return (px - c.x) ** 2 + (py - c.y) ** 2 <= r * r;
    }
    if (geom.kind === "block") {
        const c = geom.center ?? { x: 0.5, y: 0 };
        const w = (geom.width ?? 0.5) / 2, h = (geom.height ?? 0.5) / 2;
        return Math.abs(px - c.x) <= w && Math.abs(py - c.y) <= h;
    }
    if (geom.kind === "orifice") {
        const c = geom.center ?? { x: 0.5, y: 0 };
        const t = (geom.width ?? 0.08) / 2, g = (geom.height ?? 0.4) / 2;
        if (Math.abs(px - c.x) > t) return false;
        return Math.abs(py - c.y) >= g;
    }
    return false;
}

// Mirror of wakeSlopeForAlpha in src/flow/wake.ts plus wakeProfile in
// src/flow/fakeFlow.ts: slope clamps alpha to the characterized band.
function wakeSlopeForAlpha(alphaDeg) {
    if (!Number.isFinite(alphaDeg)) return 0;
    const clamped = Math.min(12, Math.max(-4, alphaDeg));
    return -Math.tan((clamped * Math.PI) / 180) * 0.5;
}

// Mirror of wakeProfile in src/flow/fakeFlow.ts.
function wakeProfile(geom, poly) {
    let baseY = geom.center?.y ?? 0;
    if (geom.kind === "naca4" && poly && poly.length > 0) {
        let sum = 0;
        for (const pt of poly) sum += pt.y;
        baseY = sum / poly.length;
    }
    const slope = wakeSlopeForAlpha(geom.alphaDeg);
    return { baseY, slope };
}

// Mirror of generateFakeFlow in src/flow/fakeFlow.ts.
function generateFakeFlow(grid, geom, seedKey) {
    const { nx, ny, domain } = grid;
    const n = nx * ny;
    const u = new Array(n), v = new Array(n), p = new Array(n), omega = new Array(n), obstacle = new Array(n);
    const seed = hashSeed(`${seedKey}|${nx}x${ny}|${geom.kind}|${geom.alphaDeg}`);
    const rand = mulberry32(seed);
    const jitter = new Array(n);
    for (let k = 0; k < n; k++) jitter[k] = (rand() - 0.5) * 0.02;
    let poly = null;
    if (geom.kind === "naca4" && geom.naca) poly = transform(naca4(geom.naca.m, geom.naca.p, geom.naca.t, geom.nPoints), 0, 0, geom.chord, geom.alphaDeg);
    const { baseY, slope } = wakeProfile(geom, poly);
    const phase = seed % 7;
    for (let j = 0; j < ny; j++) {
        const y = domain.yMin + ((domain.yMax - domain.yMin) * j) / (ny - 1);
        for (let i = 0; i < nx; i++) {
            const x = domain.xMin + ((domain.xMax - domain.xMin) * i) / (nx - 1);
            const k = j * nx + i;
            const inside = obstacleMask(x, y, geom, poly);
            obstacle[k] = inside ? 1 : 0;
            if (inside) { u[k] = 0; v[k] = 0; p[k] = 0.4; omega[k] = 0; continue; }
            const behind = Math.max(0, x - 0.8);
            const wakeCenter = baseY + slope * behind;
            const yw = y - wakeCenter;
            const wakeWidth = 0.12 + behind * 0.18;
            const wake = Math.exp(-(yw * yw) / (wakeWidth * wakeWidth)) * Math.min(1, behind * 1.4);
            const yb = y - baseY;
            const blockage = Math.exp(-((x - 0.4) * (x - 0.4) + yb * yb) * 3.0);
            u[k] = Math.max(0.05, 1 - 0.55 * wake - 0.25 * blockage + jitter[k]);
            v[k] = 0.12 * Math.sin(x * 4.2 + phase) * Math.exp(-yw * yw * 2.2) * Math.min(1, behind + 0.3) + jitter[k] * 0.4;
            p[k] = 0.5 * Math.exp(-((x + 0.15) * (x + 0.15) + yb * yb) * 6.0) - 0.35 * Math.exp(-((x - 0.5) * (x - 0.5) + (yb - 0.25) * (yb - 0.25)) * 5.0) - 0.2 * wake;
            omega[k] = 2.2 * (-yw / (wakeWidth + 1e-3)) * Math.exp(-(yw * yw) / (wakeWidth * wakeWidth)) * Math.min(1, behind * 2 + 0.15);
        }
    }
    const r4 = (a) => a.map((val) => Math.round(val * 10000) / 10000);
    return { nx, ny, domain, u: r4(u), v: r4(v), p: r4(p), omega: r4(omega), obstacle };
}

const domain = { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 };
const grid = { nx: 128, ny: 128, domain };

// Five Phase 1 fixtures (see docs/RESEARCH.md): two airfoils, cylinder,
// orifice plate constriction, rectangular block. Shared 128x128 grid.
const cases = [
    { name: "naca2412-a6", geom: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 } },
    { name: "naca0012-a0", geom: { kind: "naca4", naca: { code: "0012", m: 0, p: 0, t: 0.12 }, chord: 1, alphaDeg: 0, nPoints: 120 } },
    { name: "cylinder-r025", geom: { kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 64, radius: 0.25, center: { x: 0.5, y: 0 } } },
    { name: "orifice-g040", geom: { kind: "orifice", chord: 1, alphaDeg: 0, nPoints: 64, width: 0.08, height: 0.4, center: { x: 0.5, y: 0 } } },
    { name: "block-w050-h020", geom: { kind: "block", chord: 1, alphaDeg: 0, nPoints: 64, width: 0.5, height: 0.2, center: { x: 0.5, y: 0 } } },
];

mkdirSync(join(outBase, "geometry"), { recursive: true });
mkdirSync(join(outBase, "flow"), { recursive: true });
mkdirSync(join(outBase, "meta"), { recursive: true });

for (const c of cases) {
    let points = [];
    if (c.geom.kind === "naca4") points = transform(naca4(c.geom.naca.m, c.geom.naca.p, c.geom.naca.t, c.geom.nPoints), 0, 0, c.geom.chord, c.geom.alphaDeg);
    writeFileSync(join(outBase, "geometry", `${c.name}.json`), JSON.stringify({ name: c.name, geometry: c.geom, points }, null, 2));
    const flow = generateFakeFlow(grid, c.geom, c.name);
    writeFileSync(join(outBase, "flow", `${c.name}-128x128.json`), JSON.stringify(flow, null, 0));
}

const pack = {
    name: "naca2412-a6",
    version: 1,
    geometry: cases[0].geom,
    grid,
    provenance: {
        source: "fake-fixture",
        label: "Fake fixture, not physics",
        generatedAt: new Date().toISOString(),
        gridLabel: "128 x 128, x [-0.5, 2.0] y [-1.0, 1.0]",
        geometryLabel: "NACA 2412, chord 1, alpha 6 deg",
        note: "Deterministic fixture generator. No solver ran. Replace with surrogate or LBM in Phase 2.",
    },
    meta: {
        spark: { prompt: "Rank fixture plausibility", summary: "Placeholder, cached fixture note", model: "spark-placeholder" },
        sam: { prompt: "Segment airfoil mask", summary: "Placeholder, obstacle channel is mask", model: "sam-placeholder" },
        image: { prompt: "Thumbnail of wake", summary: "Placeholder, canvas screenshot in Phase 5", model: "image-placeholder" },
    },
    files: { geometry: "geometry/naca2412-a6.json", flow: "flow/naca2412-a6-128x128.json" },
};
writeFileSync(join(outBase, "manifest.json"), JSON.stringify(pack, null, 2));
writeFileSync(join(outBase, "meta", "spark.json"), JSON.stringify(pack.meta.spark, null, 2));
writeFileSync(join(outBase, "meta", "sam.json"), JSON.stringify(pack.meta.sam, null, 2));
writeFileSync(join(outBase, "meta", "image.json"), JSON.stringify(pack.meta.image, null, 2));
console.log(`Wrote demo pack to ${outBase}: ${cases.map((c) => c.name).join(", ")}`);
