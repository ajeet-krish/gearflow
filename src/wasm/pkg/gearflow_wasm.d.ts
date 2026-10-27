/* tslint:disable */
/* eslint-disable */

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
    readonly __wbg_wasmsolver_free: (a: number, b: number) => void;
    readonly wasmsolver_field: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmsolver_new: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly wasmsolver_panel_count: (a: number) => number;
    readonly wasmsolver_resolve: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
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
