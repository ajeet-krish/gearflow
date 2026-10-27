// Singleton loader for the Rust WASM solver package (wasm-pack --target
// web output under src/wasm/pkg). Uses a statically analyzable dynamic
// import so Vite bundles the glue chunk and emits the .wasm asset in
// production. Singleton promise plus a readiness flag that never throws.
// Missing pkg or failed init resolves false and clears the inflight promise
// so the next call retries; callers fall back to the TS analytic path.

/** Minimal surface used from the generated wasm-pack glue. */
export interface WasmPackage {
    default?: () => Promise<unknown>;
    WasmSolver?: new (
        nx: number,
        ny: number,
        xMin: number,
        xMax: number,
        yMin: number,
        yMax: number
    ) => unknown;
}

let ready = false;
let wasmModule: WasmPackage | null = null;
let inflight: Promise<boolean> | null = null;

export function isWasmReady(): boolean {
    return ready && wasmModule !== null;
}

export function getWasmModule(): WasmPackage | null {
    return wasmModule;
}

/**
 * Initialize the WASM solver package. Resolves true once per session when
 * the built pkg exists and instantiates; resolves false otherwise and clears
 * the inflight slot so a later call retries. Never throws: any import or
 * init fault resolves false for TS fallback.
 */
export async function initWasm(): Promise<boolean> {
    if (isWasmReady()) {
        return true;
    }
    if (inflight) {
        return inflight;
    }
    inflight = (async () => {
        try {
            // Static specifier so Vite bundles the glue and emits the .wasm
            // asset. Kept inside this async function so test modules that
            // never call initWasm do not load WASM at import time.
            const pkg = (await import("@/wasm/pkg/gearflow_wasm")) as unknown as WasmPackage;
            const init = pkg.default as (() => Promise<unknown>) | undefined;
            if (typeof init === "function") {
                await init();
            }
            if (typeof pkg.WasmSolver !== "function") {
                return false;
            }
            wasmModule = pkg;
            ready = true;
            return true;
        } catch {
            return false;
        }
    })();
    const ok = await inflight;
    if (!ok) {
        inflight = null;
    }
    return ok;
}
