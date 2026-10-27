// WASM backed flow provider. Same FrameSource surface as
// AnalyticFlowProvider: geometry or alpha changes re-resolve panels while a
// Reynolds number change only rebuilds the field (wake overlay) and reuses
// the cached panels. Any WASM fault latches to the TS analytic fallback.

import type { FlowField, GeometrySpec, GridSpec } from "@/contracts/types";
import { validateGeometrySpec, validateGridSpec } from "@/contracts/schema";
import { AnalyticFlowProvider, cloneGeometry, type FrameSource } from "./frameSource";
import type { AnalyticFlowParams } from "./analyticFlow";

export interface WasmSolverHandle {
    resolve(geomJson: string, uInf: number): unknown;
    field(uInf: number, re: number): unknown;
    panel_count(): number;
}

export type WasmSolverFactory = (
    nx: number,
    ny: number,
    xMin: number,
    xMax: number,
    yMin: number,
    yMax: number
) => WasmSolverHandle;

interface WasmSummary {
    cl: number;
    cpMin: number;
    panelCount: number;
}

interface WasmFieldPayload {
    nx: number;
    ny: number;
    domain: { xMin: number; xMax: number; yMin: number; yMax: number };
    u: ArrayLike<number>;
    v: ArrayLike<number>;
    p: ArrayLike<number>;
    omega: ArrayLike<number>;
    obstacle: ArrayLike<number>;
}

function toFlowField(payload: WasmFieldPayload): FlowField {
    const n = payload.nx * payload.ny;
    const wrap = (name: string, src: ArrayLike<number>): Float32Array => {
        if (!src || src.length !== n) {
            throw new Error(`WasmFlowProvider: channel ${name} length ${src?.length} does not match ${n}`);
        }
        return src instanceof Float32Array ? src : new Float32Array(src as ArrayLike<number> & { length: number } as unknown as number[]);
    };
    return {
        nx: payload.nx,
        ny: payload.ny,
        domain: { ...payload.domain },
        u: wrap("u", payload.u),
        v: wrap("v", payload.v),
        p: wrap("p", payload.p),
        omega: wrap("omega", payload.omega),
        obstacle: wrap("obstacle", payload.obstacle),
    };
}

/**
 * FrameSource served by the Rust WASM solver. Construct through
 * createFlowProvider (async factory) so the module init completes first.
 * Falls back to AnalyticFlowProvider on any WASM fault.
 */
export class WasmFlowProvider implements FrameSource {
    readonly label = "wasm-potential";
    private grid: GridSpec;
    private geom: GeometrySpec;
    private U: number;
    private Re: number;
    private solver: WasmSolverHandle;
    private analytic: AnalyticFlowProvider;
    private summary: WasmSummary | null = null;
    private field: FlowField | null = null;
    private panelsDirty = true;
    private fieldDirty = true;
    private _solveCount = 0;
    private _wasmFailed = false;

    constructor(grid: GridSpec, geom: GeometrySpec, params: AnalyticFlowParams = {}, solver: WasmSolverHandle) {
        const U = params.U ?? 1;
        const Re = params.Re ?? 1000;
        if (!Number.isFinite(U) || U <= 0) {
            throw new Error(`WasmFlowProvider: U must be a positive finite number, got ${String(U)}`);
        }
        if (!Number.isFinite(Re) || Re <= 0) {
            throw new Error(`WasmFlowProvider: Re must be a positive finite number, got ${String(Re)}`);
        }
        validateGridSpec(grid);
        validateGeometrySpec(geom);
        if (!solver || typeof solver.resolve !== "function" || typeof solver.field !== "function") {
            throw new Error("WasmFlowProvider: solver handle must expose resolve() and field()");
        }
        this.grid = { nx: grid.nx, ny: grid.ny, domain: { ...grid.domain } };
        this.geom = cloneGeometry(geom);
        this.U = U;
        this.Re = Re;
        this.solver = solver;
        this.analytic = new AnalyticFlowProvider(grid, geom, params);
    }

    /** Number of panel resolves performed. Re changes do not increment this. */
    get solveCount(): number {
        return this._solveCount;
    }

    /** True once a WASM fault latched this provider to the TS fallback. */
    get wasmFailed(): boolean {
        return this._wasmFailed;
    }

    private failover(): void {
        this._wasmFailed = true;
    }

    setAlpha(alphaDeg: number): void {
        if (!Number.isFinite(alphaDeg)) {
            throw new Error(`WasmFlowProvider: alphaDeg must be finite, got ${String(alphaDeg)}`);
        }
        validateGeometrySpec({ ...this.geom, alphaDeg });
        this.analytic.setAlpha(alphaDeg);
        if (this._wasmFailed) {
            return;
        }
        if (this.geom.alphaDeg !== alphaDeg) {
            this.geom.alphaDeg = alphaDeg;
            this.panelsDirty = true;
            this.fieldDirty = true;
        }
    }

    setRe(Re: number): void {
        if (!Number.isFinite(Re) || Re <= 0) {
            throw new Error(`WasmFlowProvider: Re must be a positive finite number, got ${String(Re)}`);
        }
        this.analytic.setRe(Re);
        if (this._wasmFailed) {
            return;
        }
        if (this.Re !== Re) {
            this.Re = Re;
            this.fieldDirty = true;
        }
    }

    setGeometry(geom: GeometrySpec): void {
        validateGeometrySpec(geom);
        this.analytic.setGeometry(geom);
        if (this._wasmFailed) {
            return;
        }
        this.geom = cloneGeometry(geom);
        this.panelsDirty = true;
        this.fieldDirty = true;
    }

    getResult(): { cl: number; cpMin: number; solveMs: number; panelCount: number } {
        if (this._wasmFailed) {
            return this.analytic.getResult();
        }
        try {
            this.getFrame();
            if (!this.summary || !Number.isFinite(this.summary.cl) || !Number.isFinite(this.summary.cpMin)) {
                throw new Error("WasmFlowProvider: non-finite cl or cpMin");
            }
            return {
                cl: this.summary.cl,
                cpMin: this.summary.cpMin,
                solveMs: 0,
                panelCount: this.summary.panelCount,
            };
        } catch {
            this.failover();
            return this.analytic.getResult();
        }
    }

    /**
     * Returns the live cached field. Treat the result as read-only: do not
     * mutate the returned Float32Arrays.
     */
    getFrame(): FlowField {
        if (this._wasmFailed) {
            return this.analytic.getFrame();
        }
        try {
            if (this.panelsDirty || this.summary === null) {
                const raw = this.solver.resolve(JSON.stringify(this.geom), this.U) as WasmSummary;
                if (!raw || !Number.isFinite(raw.cl) || !Number.isFinite(raw.cpMin)) {
                    throw new Error("WasmFlowProvider: bad resolve payload from WASM solver");
                }
                this.summary = { cl: raw.cl, cpMin: raw.cpMin, panelCount: raw.panelCount };
                this._solveCount += 1;
                this.panelsDirty = false;
            }
            if (this.fieldDirty || this.field === null) {
                const payload = this.solver.field(this.U, this.Re) as WasmFieldPayload;
                this.field = toFlowField(payload);
                this.fieldDirty = false;
            }
            return this.field as FlowField;
        } catch {
            this.failover();
            return this.analytic.getFrame();
        }
    }
}
