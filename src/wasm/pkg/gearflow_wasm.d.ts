/* tslint:disable */
/* eslint-disable */

/**
 * Viscous LBM solver binding. Mirrors the host LbmState API.
 * Construction validates grid caps plus square cells; configure()
 * builds the state; run_steps() advances in bounded batches.
 */
export class WasmLbmSolver {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Request cancellation. State stays intact and resumable.
     */
    cancel(): void;
    /**
     * Current drag coefficient.
     */
    cd(): number;
    /**
     * Current lift coefficient.
     */
    cl(): number;
    /**
     * Configure geometry plus flow parameters. Picks inlet and outlet
     * from the kind: duct keeps the legacy channel pairing (parabolic
     * plus zero gradient) for Poiseuille fixtures, every other body
     * including the orifice plate uses uniform plus convective.
     * stats_start_step is the optional
     * transient cut for time statistics (None means 0, no cut).
     * Values above MAX_STATS_START_STEP are rejected. The binding does
     * not know the run target, so a cut at or past the target is not
     * rejected here (it yields few or no samples). Reconfigure rebuilds
     * the state, so the new cut replaces the old one. reset() keeps the
     * configured cut.
     */
    configure(geom_json: string, re: number, u_lattice: number, les_enabled: boolean, stats_start_step?: number | null): void;
    /**
     * Field snapshot with the same object shape as WasmSolver::field.
     */
    field(): any;
    /**
     * Create an LBM solver grid. Rejects non-square cells with a
     * corrected ny in the message.
     */
    constructor(nx: number, ny: number, xmin: number, xmax: number, ymin: number, ymax: number);
    /**
     * Restore the initial condition, clear stats and history.
     */
    reset(): void;
    /**
     * Clear a pending cancel so stepping can continue. Leaves the field,
     * step count, forces, and statistics untouched. Errors when diverged.
     */
    resume(): void;
    /**
     * Advance up to n steps (bounded by max_steps_per_call).
     * Returns { stepsDone, step, cd, cl, cancelled, diverged }.
     */
    run_steps(n: bigint): any;
    /**
     * Single lattice step. Returns { step, cd, cl }.
     * Errors when cancelled (call resume() first) or diverged.
     */
    step(): any;
}

/**
 * Cached solver holding the grid plus the last resolved body.
 * resolve() caches panels; field() reuses them (Re changes skip re-solve).
 */
export class WasmSolver {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Evaluate the field at (u_inf, re) using the cached panels.
     * Call resolve() first. Returns { nx, ny, domain, u, v, p, omega,
     * obstacle } with Float32Array channels.
     */
    field(u_inf: number, re: number): any;
    /**
     * Create a solver for an nx by ny grid over the given domain.
     */
    constructor(nx: number, ny: number, xmin: number, xmax: number, ymin: number, ymax: number);
    /**
     * Panel count from the last resolve, or 0 when nothing is cached.
     */
    panel_count(): number;
    /**
     * Resolve panels for a geometry JSON plus freestream speed.
     * Returns { cl, cpMin, panelCount }.
     */
    resolve(geom_json: string, u_inf: number): any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmlbmsolver_free: (a: number, b: number) => void;
    readonly __wbg_wasmsolver_free: (a: number, b: number) => void;
    readonly wasmlbmsolver_cancel: (a: number) => void;
    readonly wasmlbmsolver_cd: (a: number) => number;
    readonly wasmlbmsolver_cl: (a: number) => number;
    readonly wasmlbmsolver_configure: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly wasmlbmsolver_field: (a: number) => [number, number, number];
    readonly wasmlbmsolver_new: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly wasmlbmsolver_reset: (a: number) => [number, number];
    readonly wasmlbmsolver_resume: (a: number) => [number, number];
    readonly wasmlbmsolver_run_steps: (a: number, b: bigint) => [number, number, number];
    readonly wasmlbmsolver_step: (a: number) => [number, number, number];
    readonly wasmsolver_field: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmsolver_new: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly wasmsolver_panel_count: (a: number) => number;
    readonly wasmsolver_resolve: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
