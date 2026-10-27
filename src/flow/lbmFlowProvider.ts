// FrameSource served by the LBM worker. getFrame returns the most recent
// worker snapshot, or a deterministic uniform placeholder at the same grid
// until the first snapshot arrives so the canvas never blanks. The
// placeholder provenance says so and never claims LBM numbers.

import type { FlowField, GeometrySpec, GridSpec, LbmStats } from "@/contracts/types";
import { validateGeometrySpec, validateGridSpec } from "@/contracts/schema";
import { cloneGeometry, type FrameSource } from "./frameSource";

export function provenanceLbmShort(re: number): string {
    const tag = Number.isFinite(re) ? `at Re ${Math.round(re)}` : "at Re n/a";
    return `LBM viscous (D2Q9 BGK, halfway bounce back, momentum exchange forces): Cd and Cl computed ${tag}. Potential preview is inviscid and instant.`;
}

export const PROVENANCE_LBM_PLACEHOLDER =
    "LBM pending, placeholder preview, not physics. Press Run to start the viscous solve.";

export type LbmProviderStatus = "idle" | "running" | "done" | "cancelled" | "error";

export class LbmFlowProvider implements FrameSource {
    readonly label = "lbm";
    private grid: GridSpec;
    private geom: GeometrySpec;
    private U: number;
    private Re: number;
    private field: FlowField | null = null;
    private step = 0;
    private cd: number | null = null;
    private cl: number | null = null;
    private statusValue: LbmProviderStatus = "idle";
    private progressValue = { step: 0, targetSteps: 0 };
    private blockageNote: string | null = null;
    private placeholder: FlowField;

    constructor(grid: GridSpec, geom: GeometrySpec, params?: { U?: number; Re?: number }) {
        const U = params?.U ?? 1;
        const Re = params?.Re ?? 1000;
        if (!Number.isFinite(U) || U <= 0) {
            throw new Error(`LbmFlowProvider: U must be a positive finite number, got ${String(U)}`);
        }
        if (!Number.isFinite(Re) || Re <= 0) {
            throw new Error(`LbmFlowProvider: Re must be a positive finite number, got ${String(Re)}`);
        }
        validateGridSpec(grid);
        validateGeometrySpec(geom);
        this.grid = { nx: grid.nx, ny: grid.ny, domain: { ...grid.domain } };
        this.geom = cloneGeometry(geom);
        this.U = U;
        this.Re = Re;
        this.placeholder = makePlaceholder(this.grid, this.U);
    }

    setGeometry(geom: GeometrySpec): void {
        validateGeometrySpec(geom);
        this.geom = cloneGeometry(geom);
    }

    setRe(Re: number): void {
        if (!Number.isFinite(Re) || Re <= 0) {
            throw new Error(`LbmFlowProvider: Re must be a positive finite number, got ${String(Re)}`);
        }
        this.Re = Re;
    }

    setStatus(status: LbmProviderStatus, progress?: { step: number; targetSteps: number }): void {
        this.statusValue = status;
        if (progress) this.progressValue = { ...progress };
    }

    setProgress(step: number, targetSteps: number, cd: number, cl: number): void {
        this.progressValue = { step, targetSteps };
        if (Number.isFinite(cd)) this.cd = cd;
        if (Number.isFinite(cl)) this.cl = cl;
        this.statusValue = "running";
    }

    setBlockageNote(note: string | null): void {
        this.blockageNote = note;
    }

    setSnapshot(frame: FlowField, step: number, cd: number, cl: number): void {
        this.field = frame;
        this.step = step;
        if (Number.isFinite(cd)) this.cd = cd;
        if (Number.isFinite(cl)) this.cl = cl;
    }

    clearSnapshot(): void {
        this.field = null;
        this.step = 0;
        this.cd = null;
        this.cl = null;
        this.statusValue = "idle";
        this.progressValue = { step: 0, targetSteps: 0 };
    }

    hasSnapshot(): boolean {
        return this.field !== null;
    }

    status(): LbmProviderStatus {
        return this.statusValue;
    }

    progress(): { step: number; targetSteps: number } {
        return { ...this.progressValue };
    }

    forces(): { cd: number | null; cl: number | null; step: number } {
        if (this.field === null) return { cd: null, cl: null, step: this.step };
        return { cd: this.cd, cl: this.cl, step: this.step };
    }

    /** Latest turbulence statistics, or null before the first snapshot. */
    stats(): LbmStats | null {
        const s = this.field?.lbmStats;
        return s ?? null;
    }

    /** True only once the accumulator holds at least one sample. */
    statsReady(): boolean {
        const s = this.field?.lbmStats;
        return s !== undefined && s !== null && s.samples > 0;
    }

    geometry(): GeometrySpec {
        return cloneGeometry(this.geom);
    }

    reynolds(): number {
        return this.Re;
    }

    getProvenanceLabel(): string {
        if (this.field === null) return PROVENANCE_LBM_PLACEHOLDER;
        const base = provenanceLbmShort(this.Re);
        if (this.blockageNote !== null) return `${base} ${this.blockageNote}`;
        return base;
    }

    getFrame(): FlowField {
        if (this.field !== null) return this.field;
        return this.placeholder;
    }
}

function makePlaceholder(grid: GridSpec, U: number): FlowField {
    const n = grid.nx * grid.ny;
    const u = new Float32Array(n).fill(U);
    const v = new Float32Array(n);
    const p = new Float32Array(n);
    const omega = new Float32Array(n);
    const obstacle = new Float32Array(n);
    return { nx: grid.nx, ny: grid.ny, domain: { ...grid.domain }, u, v, p, omega, obstacle };
}
