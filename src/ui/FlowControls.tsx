// GearFlow Phase 2 UI wiring. Presentational controls only, no solver math here.
// Controlled component: parent owns GeometrySpec plus Reynolds plus mode state.

import type { GeometryKind, GeometrySpec } from "@/contracts/types";

export type FlowMode = "analytic" | "fixture";

export interface FlowControlsProps {
  spec: GeometrySpec;
  reynolds: number;
  mode: FlowMode;
  onSpecChange: (next: GeometrySpec) => void;
  onReynoldsChange: (next: number) => void;
  onModeChange: (next: FlowMode) => void;
}

const LOG_RE_MIN = 2;
const LOG_RE_MAX = 6;

function formatRe(re: number): string {
  if (re >= 1_000_000) return `${(re / 1_000_000).toFixed(2)}M`;
  if (re >= 10_000) return `${(re / 1000).toFixed(1)}k`;
  if (re >= 1000) return `${(re / 1000).toFixed(2)}k`;
  return String(Math.round(re));
}

function nacaCodeFromParams(m: number, p: number, t: number): string {
  const d1 = Math.max(0, Math.min(9, Math.round(m * 100)));
  const d2 = Math.max(0, Math.min(9, Math.round(p * 10)));
  const d34 = Math.max(1, Math.min(99, Math.round(t * 100)));
  return `${d1}${d2}${String(d34).padStart(2, "0")}`;
}

function withNaca(spec: GeometrySpec, patch: Partial<{ m: number; p: number; t: number }>): GeometrySpec {
  const prev = spec.naca ?? { code: "2412", m: 0.02, p: 0.4, t: 0.12 };
  const next = { ...prev, ...patch };
  return { ...spec, naca: { ...next, code: nacaCodeFromParams(next.m, next.p, next.t) } };
}

export default function FlowControls({
  spec,
  reynolds,
  mode,
  onSpecChange,
  onReynoldsChange,
  onModeChange,
}: FlowControlsProps) {
  const isNaca = spec.kind === "naca4";
  const isAlphaWakeOnly = spec.kind === "cylinder" || spec.kind === "duct";
  const logRe = Math.min(LOG_RE_MAX, Math.max(LOG_RE_MIN, Math.log10(Math.max(1, reynolds))));

  const setKind = (kind: GeometryKind) => {
    if (kind === "naca4") {
      onSpecChange({
        ...spec,
        kind,
        naca: spec.naca ?? { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
      });
      return;
    }
    if (kind === "cylinder") {
      onSpecChange({ ...spec, kind, radius: spec.radius ?? 0.25, center: spec.center ?? { x: 0.5, y: 0 } });
      return;
    }
    onSpecChange({
      ...spec,
      kind,
      center: spec.center ?? { x: 0.5, y: 0 },
      width: spec.width ?? (kind === "duct" ? 1.0 : 0.5),
      height: spec.height ?? (kind === "duct" ? 0.4 : 0.5),
    });
  };

  return (
    <div className="controls">
      <div className="field">
        <label htmlFor="kind">Body kind</label>
        <select
          id="kind"
          value={spec.kind}
          onChange={(e) => setKind(e.target.value as GeometryKind)}
          aria-label="Body kind"
        >
          <option value="naca4">NACA 4-digit airfoil</option>
          <option value="cylinder">Cylinder</option>
          <option value="block">Block</option>
          <option value="duct">Duct constriction</option>
        </select>
        {isNaca && <p className="hint mono">NACA {spec.naca?.code ?? "2412"}, derived from the sliders below.</p>}
      </div>

      <div className="field">
        <label htmlFor="aoa">
          Angle of attack <output htmlFor="aoa" className="mono">{spec.alphaDeg.toFixed(1)} deg</output>
        </label>
        <input
          id="aoa"
          type="range"
          min={-4}
          max={12}
          step={0.5}
          value={spec.alphaDeg}
          onChange={(e) => onSpecChange({ ...spec, alphaDeg: Number(e.target.value) })}
          aria-label="Angle of attack in degrees, minus 4 to 12"
        />
        {isAlphaWakeOnly && (
          <p className="hint">Symmetric body, angle leaves the geometry unchanged and tilts the wake only.</p>
        )}
      </div>

      <div className="field">
        <label htmlFor="thick">
          Thickness <output htmlFor="thick" className="mono">{(spec.naca?.t ?? 0.12).toFixed(3)}</output>
        </label>
        <input
          id="thick"
          type="range"
          min={0.06}
          max={0.18}
          step={0.005}
          value={spec.naca?.t ?? 0.12}
          disabled={!isNaca}
          onChange={(e) => onSpecChange(withNaca(spec, { t: Number(e.target.value) }))}
          aria-label="Thickness fraction, 0.06 to 0.18, NACA only"
        />
        {!isNaca && <p className="hint">Thickness applies to NACA bodies only.</p>}
      </div>

      <div className="field">
        <label htmlFor="camber">
          Camber <output htmlFor="camber" className="mono">{(spec.naca?.m ?? 0).toFixed(3)}</output>
        </label>
        <input
          id="camber"
          type="range"
          min={0}
          max={0.09}
          step={0.005}
          value={spec.naca?.m ?? 0}
          disabled={!isNaca}
          onChange={(e) => onSpecChange(withNaca(spec, { m: Number(e.target.value) }))}
          aria-label="Camber fraction, 0 to 0.09, NACA only"
        />
      </div>

      <div className="field">
        <label htmlFor="camberpos">
          Camber position <output htmlFor="camberpos" className="mono">{(spec.naca?.p ?? 0.4).toFixed(2)}</output>
        </label>
        <input
          id="camberpos"
          type="range"
          min={0.2}
          max={0.8}
          step={0.05}
          value={spec.naca?.p ?? 0.4}
          disabled={!isNaca || (spec.naca?.m ?? 0) <= 1e-10}
          onChange={(e) => onSpecChange(withNaca(spec, { p: Number(e.target.value) }))}
          aria-label="Camber position fraction, 0.2 to 0.8, NACA only"
        />
      </div>

      <div className="field">
        <label htmlFor="rey">
          Reynolds <output htmlFor="rey" className="mono">Re {formatRe(reynolds)}</output>
        </label>
        <input
          id="rey"
          type="range"
          min={LOG_RE_MIN}
          max={LOG_RE_MAX}
          step={0.05}
          value={logRe}
          onChange={(e) => onReynoldsChange(Math.round(10 ** Number(e.target.value)))}
          aria-label="Reynolds number, log scale, 100 to 1 million"
        />
        <p className="hint">Log scale. Re shades the wake deficit only, the potential core stays inviscid.</p>
      </div>

      <div className="field toggleRow">
        <input
          id="fixtureToggle"
          type="checkbox"
          checked={mode === "fixture"}
          onChange={(e) => onModeChange(e.target.checked ? "fixture" : "analytic")}
        />
        <label htmlFor="fixtureToggle">Fixture fallback (fake fixture, not physics)</label>
      </div>
    </div>
  );
}
