// Async factory for flow providers. When ?wasm=1 is set and the Rust WASM
// package initializes, returns a WasmFlowProvider; otherwise returns the TS
// AnalyticFlowProvider. Never throws: any fault falls back to analytic.

import type { GeometrySpec, GridSpec } from "@/contracts/types";
import { AnalyticFlowProvider, type FrameSource } from "./frameSource";
import type { AnalyticFlowParams } from "./analyticFlow";
import { initWasm, getWasmModule } from "./wasmLoader";
import { WasmFlowProvider, type WasmSolverHandle } from "./wasmFlowProvider";

function hasWasmFlag(): boolean {
    try {
        if (typeof window === "undefined") {
            return false;
        }
        return new URLSearchParams(window.location.search).get("wasm") === "1";
    } catch {
        return false;
    }
}

/**
 * Create the active frame source. WASM path constructs a WasmSolver over
 * the grid domain and wraps it in a WasmFlowProvider; every fault path
 * returns an AnalyticFlowProvider so frames always stay available.
 */
export async function createFlowProvider(
    grid: GridSpec,
    geom: GeometrySpec,
    params: AnalyticFlowParams = {}
): Promise<FrameSource> {
    if (!hasWasmFlag()) {
        return new AnalyticFlowProvider(grid, geom, params);
    }
    try {
        const ok = await initWasm();
        if (!ok) {
            return new AnalyticFlowProvider(grid, geom, params);
        }
        const mod = getWasmModule();
        if (!mod || typeof mod.WasmSolver !== "function") {
            return new AnalyticFlowProvider(grid, geom, params);
        }
        const solver = new mod.WasmSolver(
            grid.nx,
            grid.ny,
            grid.domain.xMin,
            grid.domain.xMax,
            grid.domain.yMin,
            grid.domain.yMax
        ) as unknown as WasmSolverHandle;
        return new WasmFlowProvider(grid, geom, params, solver);
    } catch {
        return new AnalyticFlowProvider(grid, geom, params);
    }
}
