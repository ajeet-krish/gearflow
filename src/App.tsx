import { useEffect, useMemo, useRef, useState } from "react";
import FlowCanvas from "@/render/FlowCanvas";
import FlowControls, { type FlowMode } from "@/ui/FlowControls";
import ErrorBoundary from "@/ui/ErrorBoundary";
import { buildPolygons } from "@/geometry/parametric";
import { AnalyticFlowProvider } from "@/flow/frameSource";
import { loadDemoPack, type LoadedPack } from "@/meta/fixtures";
import { DEFAULT_GRID, type FlowField, type GeometrySpec, type Provenance } from "@/contracts/types";
import type { Point } from "@/geometry/parametric";

const DEFAULT_SPEC: GeometrySpec = {
  kind: "naca4",
  naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
  chord: 1,
  alphaDeg: 6,
  nPoints: 120,
};

const DEBOUNCE_MS = 120;

/** Local regime note. No core equivalent exists, thresholds match the prior UI text. */
function regimeLabel(reynolds: number): string {
  if (reynolds < 1_000) return "creeping, viscous dominated";
  if (reynolds < 20_000) return "laminar, attached";
  if (reynolds < 200_000) return "transitional wake";
  return "turbulent, potential model omits separation";
}

interface SolvedFrame {
  flow: FlowField;
  polygons: Point[][];
  cl: number;
  cpMin: number;
  solveMs: number;
  provenance: Provenance;
}

/** Poisoned field guard: a single NaN or Infinity anywhere rejects the frame. */
function isUsableField(flow: FlowField, cl: number, cpMin: number): boolean {
  if (!Number.isFinite(cl) || !Number.isFinite(cpMin)) return false;
  if (!Number.isFinite(flow.nx) || !Number.isFinite(flow.ny)) return false;
  const n = flow.nx * flow.ny;
  if (flow.u.length !== n || flow.v.length !== n || flow.p.length !== n) return false;
  for (let k = 0; k < n; k++) {
    if (!Number.isFinite(flow.u[k]) || !Number.isFinite(flow.v[k]) || !Number.isFinite(flow.p[k])) {
      return false;
    }
  }
  return true;
}

function describeSolveError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.length > 220 ? `${raw.slice(0, 217)}...` : raw;
}

/** Zero field used only when the very first solve fails (no last good yet). */
function emptyFrame(): SolvedFrame {
  const n = DEFAULT_GRID.nx * DEFAULT_GRID.ny;
  const flow: FlowField = {
    nx: DEFAULT_GRID.nx,
    ny: DEFAULT_GRID.ny,
    domain: { ...DEFAULT_GRID.domain },
    u: new Float32Array(n),
    v: new Float32Array(n),
    p: new Float32Array(n),
    omega: new Float32Array(n),
    obstacle: new Float32Array(n),
  };
  return {
    flow,
    polygons: [],
    cl: Number.NaN,
    cpMin: Number.NaN,
    solveMs: 0,
    provenance: {
      source: "analytic-potential",
      label: "analytic unavailable, no valid solve yet",
      generatedAt: new Date().toISOString(),
      gridLabel: `${DEFAULT_GRID.nx}x${DEFAULT_GRID.ny}`,
      geometryLabel: "none",
      note: "Placeholder empty field. Adjust the shape controls to a valid body.",
    },
  };
}

/**
 * GearFlow Phase 2 shell. Analytic path computes locally with zero fetch on the
 * critical path. The demo pack loads lazily only in fixture fallback mode.
 */
export default function App() {
  const [spec, setSpec] = useState<GeometrySpec>(DEFAULT_SPEC);
  const [reynolds, setReynolds] = useState(50_000);
  const [mode, setMode] = useState<FlowMode>("analytic");

  const [debouncedSpec, setDebouncedSpec] = useState<GeometrySpec>(DEFAULT_SPEC);
  const [debouncedRe, setDebouncedRe] = useState(50_000);

  const [pack, setPack] = useState<LoadedPack | null>(null);
  const [packError, setPackError] = useState<string | null>(null);
  const [packLoading, setPackLoading] = useState(false);

  // Long lived analytic frame source. Geometry changes re-resolve panels,
  // Reynolds number changes reuse cached panels and rebuild the wake only.
  const providerRef = useRef<AnalyticFlowProvider | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedSpec(spec);
      setDebouncedRe(reynolds);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [spec, reynolds]);

  // Lazy fixture load, only when the user opts into fallback.
  useEffect(() => {
    if (mode !== "fixture" || pack || packLoading) return;
    setPackLoading(true);
    loadDemoPack()
      .then((p) => {
        setPack(p);
        setPackError(null);
      })
      .catch((e: unknown) => {
        console.error("Fixture load failure:", e instanceof Error ? e.message : String(e));
        setPackError("Fixture failed to load. Check connection and retry.");
      })
      .finally(() => setPackLoading(false));
  }, [mode, pack, packLoading]);

  // Last good analytic frame. On a failed solve the UI keeps rendering
  // this frame and reports the error inline instead of throwing.
  const lastGoodRef = useRef<SolvedFrame | null>(null);

  const solved = useMemo<{ frame: SolvedFrame; error: string | null }>(() => {
    try {
      let provider = providerRef.current;
      if (provider === null) {
        provider = new AnalyticFlowProvider(DEFAULT_GRID, debouncedSpec, { Re: debouncedRe });
        providerRef.current = provider;
      } else {
        provider.setGeometry(debouncedSpec);
        provider.setRe(debouncedRe);
      }
      const flow = provider.getFrame();
      const { cl, cpMin, solveMs } = provider.getResult();
      if (!isUsableField(flow, cl, cpMin)) {
        throw new Error("analytic solve produced a non-finite field (singular system), holding last good frame");
      }
      const polygons = buildPolygons(debouncedSpec);
      const provenance: Provenance = {
        source: "analytic-potential",
        label: "analytic-potential, computed locally",
        generatedAt: new Date().toISOString(),
        gridLabel: `${DEFAULT_GRID.nx}x${DEFAULT_GRID.ny}`,
        geometryLabel: `${debouncedSpec.kind} a${debouncedSpec.alphaDeg}`,
        note: "Potential panel solution plus wake overlay. Re shades the wake deficit only.",
      };
      const frame: SolvedFrame = { flow, polygons, cl, cpMin, solveMs, provenance };
      lastGoodRef.current = frame;
      return { frame, error: null };
    } catch (e: unknown) {
      const message = describeSolveError(e);
      console.error("Analytic solve failure, holding last good frame:", message);
      const fallback = lastGoodRef.current ?? emptyFrame();
      return { frame: fallback, error: message };
    }
  }, [debouncedSpec, debouncedRe]);

  const isFixture = mode === "fixture" && pack !== null;
  const frame = solved.frame;
  const solveError = mode === "analytic" ? solved.error : null;
  const flow = isFixture && pack ? pack.flow : frame.flow;
  const airfoil = isFixture && pack ? [pack.airfoilPoints] : frame.polygons;
  const provenanceLabel = isFixture && pack
    ? pack.provenance.label
    : solveError !== null
      ? `analytic error, showing last good (${frame.provenance.geometryLabel}, ${frame.provenance.gridLabel})`
      : frame.provenance.label;
  const regime = regimeLabel(debouncedRe);
  const boundaryKey = `${debouncedSpec.kind}|a${debouncedSpec.alphaDeg}|Re${debouncedRe}|${mode}`;

  return (
    <div className="page">
      <a className="skip" href="#flow">Skip to flow canvas</a>
      <header className="masthead">
        <div>
          <p className="eyebrow">GearFlow: Phase 2, live analytic loop</p>
          <h1 className="display">Wind over a wing, live in the browser</h1>
          <p className="lede">
            Shape the body and the Reynolds number, the field recomputes locally
            in milliseconds. The badge below always says what the pixels are.
          </p>
        </div>
        <div className="provenance" role="status" aria-label="Data provenance">
          <span className={`dot${mode === "analytic" && solveError === null ? " analytic" : ""}`} aria-hidden="true" />
          <span>{packLoading && mode === "fixture" ? "Loading fixture" : provenanceLabel}</span>
        </div>
      </header>

      <main id="flow" className="layout">
        <section className="canvasCard" aria-label={isFixture ? "Fixture flow" : "Live analytic flow"}>
          {packError && mode === "fixture" && <p className="error">{packError}</p>}
          {packLoading && mode === "fixture" && !pack && <p className="loading">Loading fixture pack</p>}
          {solveError !== null && !isFixture && (
            <p className="error solveError" role="alert">
              Analytic solve failed ({solveError}), showing last good field. Adjust the shape controls to recover.
            </p>
          )}
          <ErrorBoundary resetKey={boundaryKey} label="flow canvas">
            <FlowCanvas flow={flow} airfoil={airfoil} colormap="viridis" />
          </ErrorBoundary>
          <div className="canvasFoot">
            <span className="mono">{`${flow.nx} x ${flow.ny} grid, x [-0.5, 2.0] y [-1.0, 1.0]`}</span>
            <span className="mono">{`${debouncedSpec.kind} a${debouncedSpec.alphaDeg} Re${debouncedRe}`}</span>
          </div>
          <div className="metricsBar" aria-label="Solver metrics">
            {isFixture ? (
              <span className="mono">Cl n/a (fixture) · CpMin n/a (fixture) · regime {regime}</span>
            ) : solveError !== null ? (
              <span className="mono">
                Solve failed, last good Cl {Number.isFinite(frame.cl) ? frame.cl.toFixed(3) : "n/a"} · CpMin{" "}
                {Number.isFinite(frame.cpMin) ? frame.cpMin.toFixed(3) : "n/a"} · {frame.solveMs.toFixed(1)} ms · {regime}
              </span>
            ) : (
              <span className="mono">
                Cl {frame.cl.toFixed(3)} · CpMin {frame.cpMin.toFixed(3)} · {frame.solveMs.toFixed(1)} ms · {regime}
              </span>
            )}
          </div>
          {!isFixture && (
            <p className="reNote">Honest Re note: Re shades the wake deficit only, the potential core stays inviscid.</p>
          )}
        </section>

        <aside className="side" aria-label="Controls and Meta placeholders">
          <section className="card" aria-label="Phase 2 controls">
            <h2>Shape controls</h2>
            <FlowControls
              spec={spec}
              reynolds={reynolds}
              mode={mode}
              onSpecChange={setSpec}
              onReynoldsChange={setReynolds}
              onModeChange={setMode}
            />
          </section>

          <section className="card meta" aria-label="Meta orchestration placeholders">
            <h2>Meta orchestration</h2>
            <ul>
              <li><strong>Spark</strong><span>Ranking and explanation placeholder</span></li>
              <li><strong>SAM</strong><span>Segmentation mask placeholder</span></li>
              <li><strong>Image</strong><span>Thumbnail render placeholder</span></li>
            </ul>
            <p className="mono">Analytic path runs offline. API keys stay in env.</p>
          </section>
        </aside>
      </main>

      <footer className="foot">
        <span className="mono">GearFlow 0.2.0, Phase 2 wiring. Commas and colons only.</span>
      </footer>
    </div>
  );
}
