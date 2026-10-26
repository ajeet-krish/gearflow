// Generate 4000 analytic training samples for the Phase 3 surrogate.
// Reuses the canonical TS modules (analyticFlow, parametric) via tsx so the
// training inputs match the browser path exactly. Deterministic (seeded).
// Run: npm run gen:dataset (or npx tsx training/gen_dataset.mjs)
// Output: data/train/shard-*.npz (stored, uncompressed) plus
// data/manifest.jsonl with one JSON object per sample.
// Stratified by body kind and alpha. NOT run by agents: the user runs this.

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSdfGrid } from "../src/flow/sdf.ts";
import { resolveBody, fieldFromResolved } from "../src/flow/analyticFlow.ts";
import { DEFAULT_DOMAIN } from "../src/contracts/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "data", "train");

const NX = 128;
const NY = 128;
const GRID = { nx: NX, ny: NY, domain: { ...DEFAULT_DOMAIN } };
const N_SAMPLES = 4000;
const SHARD_SIZE = 400;
const SEED = 7;

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function npyBuffer(data, shape) {
    const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(", ")}, ), }`;
    const magic = Buffer.from([0x93, ...Buffer.from("NUMPY"), 0x01, 0x00]);
    let headerLen = header.length + 1;
    const pad = (64 - ((magic.length + 2 + headerLen) % 64)) % 64;
    headerLen += pad;
    const headerBuf = Buffer.alloc(headerLen, " ");
    headerBuf.write(header, 0, "ascii");
    headerBuf[headerLen - 1] = 0x0a;
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16LE(headerLen, 0);
    const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return Buffer.concat([magic, lenBuf, headerBuf, body]);
}

function crc32(buf) {
    if (!crc32.table) {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
        crc32.table = table;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = crc32.table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, "utf8");
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0x21, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        parts.push(local, nameBuf, data);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(0x031e, 4);
        cen.writeUInt16LE(20, 6);
        cen.writeUInt16LE(0, 8);
        cen.writeUInt16LE(0, 10);
        cen.writeUInt16LE(0x21, 12);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(data.length, 20);
        cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt16LE(0, 30);
        cen.writeUInt16LE(0, 32);
        cen.writeUInt16LE(0, 34);
        cen.writeUInt16LE(0, 36);
        cen.writeUInt32LE(0, 38);
        cen.writeUInt32LE(offset, 42);
        central.push(cen, nameBuf);
        offset += local.length + nameBuf.length + data.length;
    }
    const cdStart = offset;
    const cd = Buffer.concat(central);
    offset += cd.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(cdStart, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...parts, cd, end]);
}

function sampleSpec(rand, index) {
    const pick = rand();
    const alpha = Math.round((-4 + rand() * 16) * 2) / 2;
    if (pick < 0.6) {
        const t = 0.06 + rand() * 0.12;
        const m = rand() < 0.25 ? 0 : rand() * 0.09;
        const p = 0.2 + rand() * 0.6;
        return { spec: { kind: "naca4", naca: { code: "0000", m, p, t }, chord: 1, alphaDeg: alpha, nPoints: 120 }, kind: "naca4", alpha, thick: t, camber: m };
    }
    if (pick < 0.75) {
        const r = 0.15 + rand() * 0.2;
        return { spec: { kind: "cylinder", chord: 1, alphaDeg: alpha, nPoints: 96, radius: r, center: { x: 0.5, y: 0 } }, kind: "cylinder", alpha, radius: r };
    }
    if (pick < 0.9) {
        const w = 0.3 + rand() * 0.4;
        const h = 0.3 + rand() * 0.4;
        return { spec: { kind: "block", chord: 1, alphaDeg: alpha, nPoints: 64, width: w, height: h, center: { x: 0.5, y: 0 } }, kind: "block", alpha, width: w, height: h };
    }
    const w = 0.8 + rand() * 0.6;
    const h = 0.3 + rand() * 0.3;
    return { spec: { kind: "duct", chord: 1, alphaDeg: 0, nPoints: 64, width: w, height: h, center: { x: 0.5, y: 0 } }, kind: "duct", alpha: 0, width: w, height: h };
}

function isReservedAnchor(meta) {
    // Held-out validation anchor: naca4 near 0012/2412 thickness at the
    // panel PASS alphas. Mirrors training/dataset.py RESERVED_* constants.
    if (meta.kind !== "naca4") return false;
    if (![4, 6, 8].includes(meta.alpha)) return false;
    return Math.abs((meta.thick ?? 0.12) - 0.12) <= 0.005;
}

function main() {
    const rand = mulberry32(SEED);
    mkdirSync(outDir, { recursive: true });
    const manifestPath = join(root, "data", "manifest.jsonl");
    writeFileSync(manifestPath, "");
    let shardEntries = [];
    let shardIdx = 0;
    let inShard = 0;
    for (let s = 0; s < N_SAMPLES; s++) {
        const { spec, ...meta } = sampleSpec(rand, s);
        const Re = Math.round(10 ** (2 + rand() * 4));
        const U = 1;
        const id = `s${String(s).padStart(5, "0")}`;
        const { body } = resolveBody(spec, U);
        const field = fieldFromResolved(GRID, spec, body, U, Re);
        const sdfGrid = buildSdfGrid(body.polygons, GRID, body.circles);
        const stacked = new Float32Array(6 * NX * NY);
        const q = 0.5 * U * U;
        for (let k = 0; k < NX * NY; k++) {
            const ch = (c) => (c * NX * NY + k);
            stacked[ch(0)] = sdfGrid.sdf[k];
            stacked[ch(1)] = sdfGrid.obstacle[k];
            stacked[ch(2)] = spec.alphaDeg;
            stacked[ch(3)] = field.u[k];
            stacked[ch(4)] = field.v[k];
            stacked[ch(5)] = field.p[k] / q;
        }
        shardEntries.push({ name: `${id}.npy`, data: npyBuffer(stacked, [6, NX, NY]) });
        const reserved = isReservedAnchor(meta);
        const split = reserved ? "val" : s % 10 === 9 ? "val" : "train";
        const entry = {
            id, split, Re, ...meta, shard: shardIdx, index: inShard,
            chord: spec.chord, nPoints: spec.nPoints, alphaDeg: spec.alphaDeg, kind: spec.kind,
        };
        appendFileSync(manifestPath, JSON.stringify(entry) + "\n");
        inShard++;
        if (inShard >= SHARD_SIZE || s === N_SAMPLES - 1) {
            const shardName = `shard-${String(shardIdx).padStart(3, "0")}.npz`;
            writeFileSync(join(outDir, shardName), buildZip(shardEntries));
            console.log(`gen: ${shardName} samples=${shardEntries.length}`);
            shardEntries = [];
            shardIdx++;
            inShard = 0;
        }
        if ((s + 1) % 500 === 0) console.log(`gen: ${s + 1}/${N_SAMPLES}`);
    }
    console.log("gen: done");
}

main();
