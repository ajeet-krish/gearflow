// Full provider-level v3 verification against the REAL browser ORT bundle
// under a simulated non-COI page (no SharedArrayBuffer): SurrogateV3Provider
// load() plus predictFrame() with session and tensor factories injected from
// the installed onnxruntime-web browser bundle, model files fetched from the
// dev server. Mirrors defaultCreateSession (wasmPaths prefix, numThreads 1
// when not isolated).
// Run: node --import tsx/esm scripts/sim-v3-e2e.mjs --base http://127.0.0.1:5173 [--threads]
const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const base = baseIdx >= 0 && args[baseIdx + 1] ? args[baseIdx + 1] : "http://127.0.0.1:5173";
const forceThreads = args.includes("--threads");
const realProcess = process;

// Simulated non-COI browser page. Note: the real SharedArrayBuffer global
// is kept (tsx and esbuild need it for module loading), but any attempt to
// construct a shared WebAssembly.Memory throws, which is the exact gate a
// non-COI browser enforces. With numThreads pinned to 1 the 1.18 loader
// short-circuits to the single-threaded binary before touching threads, so
// selection matches a real browser bit for bit.
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

// The 1.18 browser bundle sniffs node via process.versions.node inside its
// lazily evaluated init thunks and then takes a CJS path using __dirname.
// versions.node is configurable, so mask it around inference (tsx itself
// only needs process.cwd and friends, which stay intact).
Object.defineProperty(process.versions, "node", { value: undefined, configurable: true });

// @ts-ignore TS module imported through the tsx ESM loader at runtime.

// @ts-ignore TS module imported through the tsx ESM loader at runtime.
const { SurrogateV3Provider } = await import("../src/flow/surrogateV3.ts");
const bundle = new URL("../node_modules/onnxruntime-web/dist/esm/ort.min.js", import.meta.url);
const ort = (await import(bundle.href));
ort.env.wasm.wasmPaths = `${base}/ort/`;
if (!forceThreads) ort.env.wasm.numThreads = 1;

const provider = new SurrogateV3Provider({
    grid: { nx: 128, ny: 128, domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 } },
    geom: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 24 },
    U: 1,
    Re: 1000,
    baseUrl: `${base}/surrogate/v3`,
    createSession: async (modelBytes) => {
        const sess = await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
        return { run: (feeds) => sess.run(feeds) };
    },
    createTensor: (data, dims) => new ort.Tensor("float32", data, [...dims]),
});

try {
    await provider.load();
    console.log("[e2e] load OK, harmonicCapable:", provider.harmonicCapable);
    const field = await provider.predictFrame();
    console.log("[e2e] predictFrame OK, grid:", field.nx + "x" + field.ny);
    console.log("[e2e] strouhal:", field.strouhalPredicted, "explained:", field.explainedPredicted,
        "validProb:", field.validityProbability, "harmonicValid:", field.harmonicValid,
        "reason:", field.harmonicInvalidReason, "capped:", field.cappedCells);
    const prov = provider.getProvenance();
    console.log("[e2e] provenance:", prov.label);
    console.log("[e2e] PROVIDER E2E OK");
    Object.defineProperty(process.versions, "node", { value: realProcess.versions.node, configurable: true });
    process.exitCode = 0;
} catch (e) {
    console.log("[e2e] FAILED:", e && e.message ? e.message : String(e));
    try {
        Object.defineProperty(process.versions, "node", { value: realProcess.versions.node, configurable: true });
    } catch { /* ignore */ }
    process.exitCode = 2;
}
