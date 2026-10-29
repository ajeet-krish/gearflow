// Browser-path ORT verification: loads the REAL installed onnxruntime-web
// browser bundle, points wasmPaths at a served /ort/ dir, and creates a
// session plus runs inference on the REAL model bytes. With --no-coi it
// simulates a browser page without COOP/COEP (no SharedArrayBuffer, shared
// WebAssembly.Memory throws), which is the vite dev and GitHub Pages case.
// Usage:
//   node scripts/sim-browser-ort.mjs --base http://127.0.0.1:5173 [--no-coi]
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const noCoi = args.includes("--no-coi");
const forceThreads = args.includes("--threads");
const baseIdx = args.indexOf("--base");
const base = baseIdx >= 0 && args[baseIdx + 1] ? args[baseIdx + 1] : "http://127.0.0.1:5173";

// Browser shims for the web bundle.
globalThis.self = globalThis;
globalThis.window = globalThis;
try {
    Object.defineProperty(globalThis, "navigator", {
        value: { hardwareConcurrency: 4, userAgent: "sim-browser" },
        configurable: true,
        writable: true,
    });
} catch { /* ignore */ }
globalThis.crossOriginIsolated = false;
globalThis.self.crossOriginIsolated = false;

if (noCoi) {
    // Browsers without COOP+COEP: no SharedArrayBuffer global, and
    // constructing a shared WebAssembly.Memory throws a RangeError.
    try {
        delete globalThis.SharedArrayBuffer;
    } catch { /* ignore */ }
    globalThis.SharedArrayBuffer = undefined;
    const RealMemory = WebAssembly.Memory;
    class NoSharedMemory extends RealMemory {
        constructor(desc) {
            if (desc && desc.shared === true) {
                throw new RangeError(
                    "Failed to construct 'WebAssembly.Memory': shared memory requires cross-origin isolation",
                );
            }
            super(desc);
        }
    }
    WebAssembly.Memory = NoSharedMemory;
    console.log("[sim] SharedArrayBuffer exposed:", typeof globalThis.SharedArrayBuffer);
}

// Pick the browser bundle of whichever onnxruntime-web is installed.
const here = new URL("./", import.meta.url);
const candidates = [
    "../node_modules/onnxruntime-web/dist/esm/ort.min.js",
    "../node_modules/onnxruntime-web/dist/ort.bundle.min.mjs",
];
let bundle = null;
for (const c of candidates) {
    const u = new URL(c, here);
    if (existsSync(u)) {
        bundle = u;
        break;
    }
}
if (!bundle) throw new Error("no onnxruntime-web browser bundle found");
console.log("[sim] bundle:", bundle.pathname.split("node_modules/")[1]);

const realProcess = process;
// The 1.18 browser bundle sniffs node via process.versions and then takes a
// CJS/node path using __dirname (absent in ESM). Hide process before the
// bundle import so it takes the browser path, exactly as in a real browser.
globalThis.process = undefined;

const ort = await import(bundle.href);
console.log("[sim] ort bundle loaded");
ort.env.wasm.wasmPaths = `${base}/ort/`;
if (!forceThreads && !(typeof globalThis.self !== "undefined" && globalThis.self.crossOriginIsolated === true)) {
    ort.env.wasm.numThreads = 1;
}
console.log("[sim] wasmPaths =", ort.env.wasm.wasmPaths, "numThreads =", ort.env.wasm.numThreads);

const res = await fetch(`${base}/surrogate/v3/model.onnx`);
if (!res.ok) throw new Error(`model fetch failed: ${res.status}`);
const modelBytes = await res.arrayBuffer();
console.log("[sim] model bytes:", modelBytes.byteLength);

try {
    const sess = await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
    console.log("[sim] SESSION CREATED OK, inputNames:", sess.inputNames, "outputNames:", sess.outputNames);
    const input = new ort.Tensor("float32", new Float32Array(1 * 4 * 128 * 128), [1, 4, 128, 128]);
    const out = await sess.run({ input });
    for (const [k, v] of Object.entries(out)) {
        console.log("[sim] output", k, "dims:", [...v.dims].join("x"),
            "head:", Array.from(v.data.slice(0, 8)).map((x) => Number(x).toFixed(6)).join(","));
    }
    console.log("[sim] INFERENCE OK");
    globalThis.process = realProcess;
    process.exitCode = 0;
} catch (e) {
    console.log("[sim] FAILED:", e && e.message ? e.message : String(e));
    if (e && e.stack) console.log("[sim] stack:", String(e.stack).split("\n").slice(0, 8).join("\n"));
    globalThis.process = realProcess;
    process.exitCode = 2;
}
