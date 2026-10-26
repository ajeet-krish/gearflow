// Frame source abstraction. Phase 2 analytic path: AnalyticFlowProvider wraps
// resolveBody plus fieldFromResolved so geometry changes re-resolve panels and
// Reynolds number changes rebuild only the wake overlay. FixtureFlowProvider
// remains for fallback comparisons. Pure wiring, physics lives in analyticFlow.

import type { FlowField, GeometrySpec, GridSpec } from "@/contracts/types";
import { validateGeometrySpec, validateGridSpec } from "@/contracts/schema";
import { resolveBody, fieldFromResolved } from "./analyticFlow";
import type { AnalyticFlowParams, ResolvedBody } from "./analyticFlow";

export interface FrameSource {
  readonly label: string;
  getFrame(): FlowField;
}

export class FixtureFlowProvider implements FrameSource {
  readonly label = "fixture";
  private field: FlowField;
  constructor(field: FlowField) {
    this.field = field;
  }
  getFrame(): FlowField {
    return this.field;
  }
}

/** Deep clone a GeometrySpec including nested naca and center objects. */
export function cloneGeometry(geom: GeometrySpec): GeometrySpec {
  return {
    ...geom,
    naca: geom.naca ? { ...geom.naca } : undefined,
    center: geom.center ? { ...geom.center } : undefined,
  };
}

/** Deep value compare for GeometrySpec so re-created but equal specs skip panel re-solves. */
function geometriesEqual(a: GeometrySpec, b: GeometrySpec): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.chord !== b.chord || a.alphaDeg !== b.alphaDeg || a.nPoints !== b.nPoints) return false;
  if ((a.radius ?? null) !== (b.radius ?? null)) return false;
  if ((a.width ?? null) !== (b.width ?? null)) return false;
  if ((a.height ?? null) !== (b.height ?? null)) return false;
  const ac = a.center;
  const bc = b.center;
  if ((ac?.x ?? null) !== (bc?.x ?? null) || (ac?.y ?? null) !== (bc?.y ?? null)) return false;
  const an = a.naca;
  const bn = b.naca;
  if ((an === undefined) !== (bn === undefined)) return false;
  if (an && bn && (an.code !== bn.code || an.m !== bn.m || an.p !== bn.p || an.t !== bn.t)) return false;
  return true;
}

/**
 * Analytic potential flow provider. Caches the panel solution: alpha or
 * geometry changes re-resolve panels, while a Reynolds number change only
 * rebuilds the field (wake overlay) and reuses the cached panels.
 */
export class AnalyticFlowProvider implements FrameSource {
  readonly label = "analytic-potential";
  private grid: GridSpec;
  private geom: GeometrySpec;
  private U: number;
  private Re: number;
  private resolved: ResolvedBody | null = null;
  private field: FlowField | null = null;
  private cl = 0;
  private cpMin = 0;
  private solveMs = 0;
  private panelsDirty = true;
  private fieldDirty = true;
  private _solveCount = 0;

  constructor(grid: GridSpec, geom: GeometrySpec, params: AnalyticFlowParams = {}) {
    const U = params.U ?? 1;
    const Re = params.Re ?? 1000;
    if (!Number.isFinite(U) || U <= 0) {
      throw new Error(`AnalyticFlowProvider: U must be a positive finite number, got ${String(U)}`);
    }
    if (!Number.isFinite(Re) || Re <= 0) {
      throw new Error(`AnalyticFlowProvider: Re must be a positive finite number, got ${String(Re)}`);
    }
    // Fail fast so a bad spec cannot be cached and bypass the validator later.
    validateGridSpec(grid);
    validateGeometrySpec(geom);
    this.grid = { nx: grid.nx, ny: grid.ny, domain: { ...grid.domain } };
    this.geom = cloneGeometry(geom);
    this.U = U;
    this.Re = Re;
  }

  /** Number of panel resolves performed. Re changes do not increment this. */
  get solveCount(): number {
    return this._solveCount;
  }

  setAlpha(alphaDeg: number): void {
    if (!Number.isFinite(alphaDeg)) {
      throw new Error(`AnalyticFlowProvider: alphaDeg must be finite, got ${String(alphaDeg)}`);
    }
    // Validate the full envelope (fail fast, no bypass via direct alpha sets).
    validateGeometrySpec({ ...this.geom, alphaDeg });
    if (this.geom.alphaDeg !== alphaDeg) {
      this.geom.alphaDeg = alphaDeg;
      this.panelsDirty = true;
      this.fieldDirty = true;
    }
  }

  setRe(Re: number): void {
    if (!Number.isFinite(Re) || Re <= 0) {
      throw new Error(`AnalyticFlowProvider: Re must be a positive finite number, got ${String(Re)}`);
    }
    if (this.Re !== Re) {
      this.Re = Re;
      this.fieldDirty = true;
    }
  }

  setGeometry(geom: GeometrySpec): void {
    // Fail fast: callers cannot stage an out-of-envelope spec and bypass validation.
    validateGeometrySpec(geom);
    if (geometriesEqual(this.geom, geom)) return;
    this.geom = cloneGeometry(geom);
    this.panelsDirty = true;
    this.fieldDirty = true;
  }

  getResult(): { cl: number; cpMin: number; solveMs: number; panelCount: number } {
    this.getFrame();
    if (!Number.isFinite(this.cl) || !Number.isFinite(this.cpMin)) {
      throw new Error("AnalyticFlowProvider: non-finite cl or cpMin (singular panel evaluation)");
    }
    return {
      cl: this.cl,
      cpMin: this.cpMin,
      solveMs: this.solveMs,
      panelCount: this.resolved?.panels.length ?? 0,
    };
  }

  /**
   * Returns the live cached field. Treat the result as read-only: do not
   * mutate the returned Float32Arrays or the next getFrame call reuses them.
   * Copy channels first if the caller needs to write.
   */
  getFrame(): FlowField {
    if (this.panelsDirty || this.resolved === null) {
      const out = resolveBody(this.geom, this.U);
      this.solveMs = out.solveMs;
      this.resolved = out.body;
      this._solveCount += 1;
      this.panelsDirty = false;
    }
    if (this.fieldDirty || this.field === null) {
      const body = this.resolved as ResolvedBody;
      this.field = fieldFromResolved(this.grid, this.geom, body, this.U, this.Re);
      let cpMin = Infinity;
      for (const c of body.sol.cp) {
        if (!Number.isFinite(c)) {
          throw new Error("AnalyticFlowProvider: non-finite cp (singular panel evaluation)");
        }
        if (c < cpMin) cpMin = c;
      }
      if (!Number.isFinite(body.sol.cl) || !Number.isFinite(cpMin)) {
        throw new Error("AnalyticFlowProvider: non-finite cl or cpMin (singular panel evaluation)");
      }
      this.cl = body.sol.cl;
      this.cpMin = cpMin;
      this.fieldDirty = false;
    }
    return this.field as FlowField;
  }
}
