// GearFlow Phase 5 offline pack. Zips dist into gearflow-offline.zip with
// zero dependencies, stored entries only, so the judged demo booth can run
// from a plain file copy. Run after npm run build. To serve, unzip and serve
// from unzip directory root via npx serve or any static server; file:// will
// not load assets due to absolute URLs. Pass --base=./ to rewrite absolute
// root paths (src="/, href="/) to relative paths inside the zip when a
// relative base is needed (for example serving from a subpath). Rebuild with
// vite build --base=<value> is the equivalent permanent option.

import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIST = resolve(ROOT, "dist");
const OUT = resolve(ROOT, "gearflow-offline.zip");

// Optional --base=<value> rewrites absolute root asset paths in HTML files
// (src="/, href="/) to the given base at pack time, for relative-base zips.
// Example: node scripts/make-offline-pack.mjs --base=./
function parseBase(argv) {
    for (const arg of argv) {
        if (arg.startsWith("--base=")) return arg.slice("--base=".length);
        if (arg === "--base") return "./";
    }
    return null;
}

const BASE_OVERRIDE = parseBase(process.argv.slice(2));

function applyBase(html, base) {
    const norm = base.endsWith("/") ? base : `${base}/`;
    return html.replaceAll('src="/', `src="${norm}`).replaceAll('href="/', `href="${norm}`);
}

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC_TABLE[n] = c;
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function walk(dir, out) {
    for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) {
            console.error(`make-offline-pack: refusing symlink ${full}`);
            process.exit(1);
        }
        if (st.isDirectory()) walk(full, out);
        else if (st.isFile()) out.push(full);
    }
    return out;
}

function localHeader(name, crc, size) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0, 6);
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(0, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(size, 18);
    h.writeUInt32LE(size, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    return Buffer.concat([h, name]);
}

function centralHeader(name, crc, size, offset) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(0, 12);
    h.writeUInt16LE(0, 14);
    h.writeUInt32LE(crc, 16);
    h.writeUInt32LE(size, 20);
    h.writeUInt32LE(size, 24);
    h.writeUInt16LE(name.length, 28);
    h.writeUInt16LE(0, 30);
    h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34);
    h.writeUInt16LE(0, 36);
    h.writeUInt32LE(0, 38);
    h.writeUInt32LE(offset, 42);
    return Buffer.concat([h, name]);
}

function pack() {
    if (!existsSync(DIST)) {
        console.error("make-offline-pack: dist is missing, run npm run build first.");
        process.exit(1);
    }
    const files = walk(DIST, []);
    if (files.length === 0) {
        console.error("make-offline-pack: dist is empty, run npm run build first.");
        process.exit(1);
    }
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const full of files) {
        const real = realpathSync(full);
        if (real !== DIST && !real.startsWith(DIST + sep)) {
            console.error(`make-offline-pack: entry escapes dist ${full}`);
            process.exit(1);
        }
        const rel = full.startsWith(DIST + sep) ? full.slice(DIST.length + 1) : full;
        const zipName = rel.split(sep).join("/");
        const name = Buffer.from(zipName, "utf8");
        let data = readFileSync(full);
        if (BASE_OVERRIDE && full.endsWith(".html")) {
            const text = applyBase(data.toString("utf8"), BASE_OVERRIDE);
            data = Buffer.from(text, "utf8");
        }
        const crc = crc32(data);
        chunks.push(localHeader(name, crc, data.length));
        chunks.push(data);
        central.push(centralHeader(name, crc, data.length, offset));
        offset += 30 + name.length + data.length;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) {
        chunks.push(c);
        centralSize += c.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    chunks.push(end);
    writeFileSync(OUT, Buffer.concat(chunks));
    if (BASE_OVERRIDE) console.log(`make-offline-pack: rewrote absolute paths with base ${BASE_OVERRIDE}.`);
    console.log(`make-offline-pack: wrote ${OUT} with ${files.length} files.`);
    console.log("make-offline-pack: serve from unzip directory root via npx serve or any static server; file:// will not load assets due to absolute URLs.");
}

pack();
