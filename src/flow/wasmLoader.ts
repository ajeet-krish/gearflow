// Singleton loader for the Rust WASM solver package (wasm-pack --target
// web output under src/wasm/pkg). Follows the zenith pattern: a non-literal
// specifier with @vite-ignore so the bundler leaves the probe alone, a
// singleton promise, and a readiness flag that never throws. Missing pkg or
// failed init resolves false and clears the inflight promise so the next
// call retries; callers fall back to the TS analytic path.

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
            // Non-literal specifier so the bundler leaves this probe alone.
            const parts = ["..", "wasm", "pkg", "gearflow_wasm.js"];
            const target = parts.join("/");
            const pkg = (await import(/* @vite-ignore */ target)) as WasmPackage;
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
