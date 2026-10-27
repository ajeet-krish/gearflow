// WASM spike probe. When ?wasm=1 is present, initializes the Rust solver
// package through the shared singleton loader, times it, and records the
// outcome in the eval ledger. It never serves frames itself: when init
// succeeds, frames are served by WasmFlowProvider (Rust WASM) created through
// createFlowProvider; this probe only times module init and records it.

import { g_evalLog } from "@/meta/evalLog";
import { initWasm, isWasmReady } from "./wasmLoader";

export interface WasmSpikeResult {
    loaded: boolean;
    ms: number;
    note: string;
}

function hasWasmFlag(): boolean {
    try {
        if (typeof window === "undefined") return false;
        return new URLSearchParams(window.location.search).get("wasm") === "1";
    } catch {
        return false;
    }
}

/**
 * Lazy WASM probe. Resolves { loaded: false } unless ?wasm=1 is set, in
 * which case it times the shared initWasm() loader and records the outcome
 * in the eval log. When init succeeds, live frames are served by
 * WasmFlowProvider (Rust WASM); this probe only times module init.
 */
export async function maybeLoadWasm(): Promise<WasmSpikeResult> {
    if (!hasWasmFlag()) {
        return { loaded: false, ms: 0, note: "WASM spike idle, pass ?wasm=1 to probe." };
    }
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const ok = await initWasm();
    const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    if (ok && isWasmReady()) {
        void g_evalLog.add({
            feature: "wasm-spike",
            model: "wasm-field",
            latencyMs: ms,
            costUsd: 0,
            costEstimated: true,
            cached: true,
            ok: true,
            fallback: "wasm-frames",
            hash: "wasm-spike",
        });
        return { loaded: true, ms, note: "WASM solver ready, frames served by WasmFlowProvider (Rust WASM)." };
    }
    void g_evalLog.add({
        feature: "wasm-spike",
        model: "wasm-field",
        latencyMs: ms,
        costUsd: 0,
        costEstimated: true,
        cached: false,
        ok: false,
        fallback: "analytic-fallback",
        hash: "wasm-spike",
    });
    return { loaded: false, ms, note: "WASM package missing or init failed, analytic frames only." };
}
