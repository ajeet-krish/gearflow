import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FlowCanvas, { type FlowCanvasHandle } from "@/render/FlowCanvas";
import FlowControls, { type FlowMode } from "@/ui/FlowControls";
import ErrorBoundary from "@/ui/ErrorBoundary";
import ResizeHandle from "@/components/ui/ResizeHandle";
import AgentConsole from "@/ui/AgentConsole";
import EvalLogPanel from "@/ui/EvalLogPanel";
import DisplayControls from "@/ui/DisplayControls";
import Legend from "@/ui/Legend";
import ThemeToggle from "@/ui/ThemeToggle";
import RackTabs from "@/ui/RackTabs";
import { buildPolygons } from "@/geometry/parametric";
import { AnalyticFlowProvider, type FrameSource } from "@/flow/frameSource";
import { createFlowProvider } from "@/flow/createFlowProvider";
import { SurrogateFlowProvider } from "@/flow/surrogate";
import { useResolution } from "@/flow/gridController";
import { useDisplayPrefs } from "@/ui/displayStore";
import { applyTheme, storeTheme } from "@/ui/theme";
import { maybeLoadWasm } from "@/flow/wasmSpike";
import ValidationPanel, { type ValidationSummary } from "@/ui/ValidationPanel";
import ExportBar from "@/ui/ExportBar";
import { asFixtureExport, type ExportData } from "@/export/exportReport";
import { loadOfflinePack } from "@/meta/offlinePack";
import { loadDemoPack, type LoadedPack } from "@/meta/fixtures";
import { HashCache } from "@/meta/cache";
import { MetaClient } from "@/meta/client";
import { g_evalLog } from "@/meta/evalLog";
import { DEFAULT_DOMAIN, DEFAULT_GRID, type EvalLogEntry, type FlowField, type GeometrySpec, type OfflineCase, type ParametricSpec, type Provenance } from "@/contracts/types";
import type { ColormapName } from "@/flow/colormap";
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

/** Short label for file names and report titles, derived from the solved spec. */
function specLabelFor(spec: GeometrySpec): string {
    if (spec.kind === "naca4" && spec.naca) return `naca${spec.naca.code}`;
    return spec.kind;
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

/** Phase 5 export sheet: fixture preview carries no solved numbers, so its
 *  cl, cpMin, and solveMs stay NaN and the sheet renders n/a. Exported for
 *  tests so the fixture branch cannot silently regress to analytic numbers. */
export function buildAppExportData(
    base: ExportData,
    isFixture: boolean,
    packProvenance: Provenance | null,
): ExportData {
    if (isFixture && packProvenance !== null) {
        return asFixtureExport(base, packProvenance.label, packProvenance.generatedAt);
    }
    return base;
}

/**
 * GearFlow Phase 6 shell. Agent console on the left, tunnel canvas center,
 * instrument rack on the right. Analytic path computes locally with zero
 * fetch on the critical path. Surrogate stays at 128, analytic may run 256
 * with automatic fallback to 128 after repeated slow solves.
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

    // Phase 6 display and resolution state. Dark theme default, persisted.
    const { prefs, patch } = useDisplayPrefs();
    const { state: gridState, recordSolveMs, setMode: setGridMode, clearNotice } = useResolution();
    const [fieldVisible, setFieldVisible] = useState(true);
    const [contours, setContours] = useState(false);
    const [particleCount, setParticleCount] = useState(3000);

    useEffect(() => {
        applyTheme(prefs.theme);
    }, [prefs.theme]);

    // WASM backend: when ?wasm=1 is present, createFlowProvider loads the
    // Rust solver once and serves frames with analytic fallback. No flag
    // means the analytic provider stays the only frame source.
    const [wasmSource, setWasmSource] = useState<FrameSource | null>(null);
    const [wasmNote, setWasmNote] = useState<string | null>(null);
    useEffect(() => {
        void maybeLoadWasm();
    }, []);

    // Phase 4 Meta orchestration state. Offline persists across sessions so a
    // judged demo booth stays local. The poster url lives here so the render
    // survives panel rerenders. Eval entries mirror the shared eval log.
    const [offline, setOffline] = useState<boolean>(() => {
        try {
            const raw = window.localStorage.getItem("gearflow:offline");
            if (raw !== null) return raw === "true";
        } catch {
            // Private mode: fall through to the env default.
        }
        return (import.meta.env.VITE_DEMO_OFFLINE as string | undefined) === "true";
    });
    const [evalEntries, setEvalEntries] = useState<EvalLogEntry[]>(() => g_evalLog.list());
    const [posterUrl, setPosterUrl] = useState<string | null>(null);
    const [offlineCases, setOfflineCases] = useState<OfflineCase[] | null>(null);
    const [offlinePackError, setOfflinePackError] = useState<string | null>(null);
    // Phase 5 export: validation summary mirrors the ledger counts for the
    // export sheet, the canvas handle feeds PNG snapshots. Styling stays in
    // the panels, this is wiring only.
    const [valSummary, setValSummary] = useState<ValidationSummary>({ pass: 0, warn: 0, fail: 0, info: 0, blocking: 0 });
    const canvasRef = useRef<FlowCanvasHandle | null>(null);
    // Resizable control room rails. Widths persist per booth so a judged demo
    // keeps its tunnel framing. Clamped to usable instrument widths.
    const LEFT_MIN = 280;
    const LEFT_MAX = 480;
    const RIGHT_MIN = 260;
    const RIGHT_MAX = 420;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    function loadRail(key: string, fallback: number, lo: number, hi: number): number {
        try {
            const raw = window.localStorage.getItem(key);
            if (raw !== null) {
                const n = Number(raw);
                if (Number.isFinite(n)) return clamp(Math.round(n), lo, hi);
            }
        } catch {
            // Private mode: fall through to the default width.
        }
        return fallback;
    }
    const [leftW, setLeftW] = useState<number>(() => loadRail("gearflow:leftW", 330, LEFT_MIN, LEFT_MAX));
    const [rightW, setRightW] = useState<number>(() => loadRail("gearflow:rightW", 330, RIGHT_MIN, RIGHT_MAX));

    useEffect(() => {
        try {
            window.localStorage.setItem("gearflow:leftW", String(leftW));
        } catch {
            // Private mode: width still applies to this session.
        }
    }, [leftW]);
    useEffect(() => {
        try {
            window.localStorage.setItem("gearflow:rightW", String(rightW));
        } catch {
            // Private mode: width still applies to this session.
        }
    }, [rightW]);

    useEffect(() => {
        if (!offline) {
            setOfflineCases(null);
            setOfflinePackError(null);
            return;
        }
        let cancelled = false;
        loadOfflinePack()
            .then((cases) => {
                if (!cancelled) {
                    setOfflineCases(cases);
                    setOfflinePackError(null);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setOfflineCases(null);
                    setOfflinePackError("Offline pack missing, live calls are blocked.");
                }
            });
        return () => {
            cancelled = true;
        };
    }, [offline]);

    useEffect(() => {
        try {
            window.localStorage.setItem("gearflow:offline", String(offline));
        } catch {
            // Private mode: offline still applies to this session.
        }
    }, [offline]);

    useEffect(() => g_evalLog.subscribe(setEvalEntries), []);

    const cacheRef = useRef<HashCache | null>(null);
    if (cacheRef.current === null) cacheRef.current = new HashCache(true);
    const metaClient = useMemo(
        () =>
            new MetaClient({
                offline,
                onEval: (payload) => {
                    void g_evalLog.add(payload);
                },
            }),
        [offline]
    );

    const applyParametric = (next: ParametricSpec) => {
        setSpec(next.geometry);
        setReynolds(next.reynolds);
        if (next.geometry.kind === "custom") setMode("analytic");
    };

    // Long lived analytic frame source. Geometry changes re-resolve panels,
    // Reynolds number changes reuse cached panels and rebuild the wake only.
    // Grid changes (256 to 128 fallback) recreate the provider.
    const providerRef = useRef<AnalyticFlowProvider | null>(null);
    const providerGridKeyRef = useRef("");

    // Surrogate provider, created lazily on first opt-in. Weights load once
    // from public/surrogate; any failure keeps the analytic fallback path.
    // Surrogate always solves at 128, never through the resolution controller.
    const surrogateRef = useRef<SurrogateFlowProvider | null>(null);
    const [surrogateReady, setSurrogateReady] = useState(false);
    const [surrogateNote, setSurrogateNote] = useState<string | null>(null);

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

    // Lazy surrogate load, only when the user opts into that backend.
    useEffect(() => {
        if (mode !== "surrogate" || surrogateRef.current !== null) return;
        let cancelled = false;
        const provider = new SurrogateFlowProvider({ grid: DEFAULT_GRID, geom: debouncedSpec, Re: debouncedRe });
        setSurrogateNote("loading surrogate weights");
        provider
            .ensureLoaded()
            .then((ok) => {
                if (cancelled) return;
                surrogateRef.current = provider;
                setSurrogateReady(true);
                setSurrogateNote(ok ? null : "surrogate weights missing, analytic fallback active");
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                console.error("Surrogate load failure:", e instanceof Error ? e.message : String(e));
                surrogateRef.current = provider;
                setSurrogateReady(true);
                setSurrogateNote("surrogate load failed, analytic fallback active");
            });
        return () => {
            cancelled = true;
        };
    }, [mode, debouncedSpec, debouncedRe]);

    // Effective solve grid. Surrogate and fixture stay at 128; analytic
    // follows the resolution controller (256 default, auto fallback to 128).
    const activeGrid = gridState.active;
    const solveGrid = useMemo(
        () => (mode === "analytic" ? { nx: activeGrid, ny: activeGrid, domain: { ...DEFAULT_DOMAIN } } : DEFAULT_GRID),
        [mode, activeGrid]
    );
    // Last good analytic frame. On a failed solve the UI keeps rendering
    // this frame and reports the error inline instead of throwing.
    const lastGoodRef = useRef<SolvedFrame | null>(null);

    // WASM provider load: only when ?wasm=1 is present. createFlowProvider
    // falls back to analytic on any fault, so check the label before keeping
    // the handle as the live wasm path.
    useEffect(() => {
        let cancelled = false;
        try {
            if (typeof window === "undefined") return;
            if (new URLSearchParams(window.location.search).get("wasm") !== "1") return;
        } catch {
            return;
        }
        void createFlowProvider(solveGrid, debouncedSpec, { Re: debouncedRe })
            .then((p) => {
                if (cancelled) return;
                if ((p as { label?: string }).label === "wasm-potential") {
                    setWasmSource(p);
                    setWasmNote(null);
                } else {
                    setWasmNote("wasm requested but unavailable, analytic fallback");
                }
            })
            .catch(() => {
                if (!cancelled) setWasmNote("wasm requested but unavailable, analytic fallback");
            });
        return () => {
            cancelled = true;
        };
    }, [solveGrid, debouncedSpec, debouncedRe]);

    const solved = useMemo<{ frame: SolvedFrame; error: string | null }>(() => {
        try {
            if (mode === "surrogate" && surrogateRef.current !== null) {
                const sp = surrogateRef.current;
                sp.setGeometry(debouncedSpec);
                sp.setRe(debouncedRe);
                const flow = sp.getFrame();
                const { cl, cpMin, solveMs } = sp.getResult();
                if (!isUsableField(flow, cl, cpMin)) {
                    throw new Error("surrogate solve produced a non-finite field, holding last good frame");
                }
                const polygons = buildPolygons(debouncedSpec);
                const isFallback = sp.meta.backend !== "surrogate";
                // Gated means weights are loaded but the sync inference budget rejects
                // the shape, so no reload is needed. Missing or failed means no weights.
                const gated = isFallback && sp.loaded;
                const provenance: Provenance = {
                    source: isFallback ? "analytic-potential" : "surrogate",
                    label: isFallback
                        ? gated
                            ? "surrogate gated by sync budget, analytic fallback"
                            : "surrogate unavailable, analytic fallback"
                        : `surrogate ${sp.meta.weightsVersion}, ${sp.meta.latencyMs.toFixed(1)} ms${sp.meta.cached ? ", cached" : ""}`,
                    generatedAt: new Date().toISOString(),
                    gridLabel: `${DEFAULT_GRID.nx}x${DEFAULT_GRID.ny}`,
                    geometryLabel: `${debouncedSpec.kind} a${debouncedSpec.alphaDeg}`,
                    note: isFallback
                        ? gated
                            ? "Surrogate weights loaded but over the sync inference budget, analytic fallback active (gated)."
                            : "Surrogate weights missing or failed, analytic fallback active."
                        : "Learned U-Net backend, offline weights.",
                };
                const frame: SolvedFrame = { flow, polygons, cl, cpMin, solveMs, provenance };
                lastGoodRef.current = frame;
                return { frame, error: null };
            }
            const gridKey = `${solveGrid.nx}x${solveGrid.ny}`;
            if (mode === "analytic" && wasmSource !== null) {
                try {
                    const ws = wasmSource as FrameSource & {
                        setGeometry?: (g: GeometrySpec) => void;
                        setRe?: (re: number) => void;
                        getResult?: () => { cl: number; cpMin: number; solveMs: number };
                    };
                    ws.setGeometry?.(debouncedSpec);
                    ws.setRe?.(debouncedRe);
                    const flow = ws.getFrame();
                    const res = ws.getResult?.() ?? { cl: Number.NaN, cpMin: Number.NaN, solveMs: 0 };
                    if (!isUsableField(flow, res.cl, res.cpMin)) {
                        throw new Error("wasm solve produced a non-finite field, holding last good frame");
                    }
                    const polygons = buildPolygons(debouncedSpec);
                    const provenance: Provenance = {
                        source: "analytic-potential",
                        label: `wasm-rust backend, computed locally at ${solveGrid.nx}`,
                        generatedAt: new Date().toISOString(),
                        gridLabel: `${solveGrid.nx}x${solveGrid.ny}`,
                        geometryLabel: `${debouncedSpec.kind} a${debouncedSpec.alphaDeg}`,
                        note: "Rust WASM solver (wasm-rust), analytic fallback on fault. Potential panel solution plus wake overlay.",
                    };
                    const frame: SolvedFrame = { flow, polygons, cl: res.cl, cpMin: res.cpMin, solveMs: res.solveMs, provenance };
                    lastGoodRef.current = frame;
                    return { frame, error: null };
                } catch (e: unknown) {
                    const message = describeSolveError(e);
                    console.error("WASM solve failure, holding last good frame:", message);
                    const fallback = lastGoodRef.current ?? emptyFrame();
                    return { frame: fallback, error: message };
                }
            }
            let provider = providerRef.current;
            if (provider === null || providerGridKeyRef.current !== gridKey) {
                provider = new AnalyticFlowProvider(solveGrid, debouncedSpec, { Re: debouncedRe });
                providerRef.current = provider;
                providerGridKeyRef.current = gridKey;
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
                label: solveGrid.nx === 256
                    ? "analytic-potential, computed locally at 256"
                    : "analytic-potential, computed locally at 128",
                generatedAt: new Date().toISOString(),
                gridLabel: `${solveGrid.nx}x${solveGrid.ny}`,
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
    }, [debouncedSpec, debouncedRe, mode, surrogateReady, solveGrid, wasmSource]);

    // Resolution bookkeeping: record each fresh solve once. Two consecutive
    // analytic solves over budget at 256 drop to 128 automatically.
    const recordedSolveRef = useRef("");
    useEffect(() => {
        if (mode !== "analytic" || solved.error !== null) return;
        const key = `${solveGrid.nx}x${solveGrid.ny}|${solved.frame.provenance.geometryLabel}|${solved.frame.solveMs.toFixed(2)}`;
        if (recordedSolveRef.current === key) return;
        recordedSolveRef.current = key;
        recordSolveMs(solved.frame.solveMs);
    }, [mode, solved, solveGrid, recordSolveMs]);

    const isFixture = mode === "fixture" && pack !== null;
    const frame = solved.frame;
    const solveError = isFixture ? null : solved.error;
    const isWasmActive = mode === "analytic" && wasmSource !== null && solveError === null && frame.provenance.label.startsWith("wasm-rust");
    const isSurrogatePending = mode === "surrogate" && !surrogateReady;
    const sourceIsSurrogate = frame.provenance.source === "surrogate";
    const isSurrogateFallback = mode === "surrogate" && surrogateReady && !sourceIsSurrogate;
    const isSurrogateActive = mode === "surrogate" && surrogateReady && sourceIsSurrogate;
    // Gated fallback keeps loaded weights that exceed the sync inference budget.
    // Missing or failed fallback has no weights. The badge color differs.
    const isSurrogateGated = isSurrogateFallback && (surrogateRef.current?.loaded === true);
    const flow = isFixture && pack ? pack.flow : frame.flow;
    const airfoil = isFixture && pack ? [pack.airfoilPoints] : frame.polygons;
    const provenanceLabel = isFixture && pack
        ? pack.provenance.label
        : solveError !== null
            ? `solve error, showing last good (${frame.provenance.geometryLabel}, ${frame.provenance.gridLabel})`
            : frame.provenance.label;
    const dotClass =
        solveError !== null ? "failed"
        : isSurrogatePending ? "pending"
        : isSurrogateActive ? "surrogate"
        : isSurrogateGated ? "gated"
        : isSurrogateFallback ? "fallback"
        : isFixture ? "fixture"
        : "analytic";
    const backendName =
        isFixture ? "fixture preview"
        : solveError !== null ? `${sourceIsSurrogate ? "surrogate" : isWasmActive ? "wasm-rust" : "analytic"} held`
        : isSurrogatePending ? "surrogate loading"
        : isSurrogateGated ? "analytic fallback (gated)"
        : isSurrogateFallback ? "analytic fallback"
        : isSurrogateActive ? "surrogate live"
        : isWasmActive ? `wasm-rust live ${solveGrid.nx}`
        : `analytic live ${solveGrid.nx}`;
    const regime = regimeLabel(debouncedRe);
    const boundaryKey = `${debouncedSpec.kind}|a${debouncedSpec.alphaDeg}|Re${debouncedRe}|${mode}|${solveGrid.nx}`;

    const getSnapshot = useCallback(async (): Promise<Blob | null> => {
        const handle = canvasRef.current;
        if (!handle) return null;
        try {
            return await handle.capturePng();
        } catch (e) {
            console.error("Snapshot capture failed:", e instanceof Error ? e.message : String(e));
            return null;
        }
    }, []);

    // Phase 5 export sheet: assembled from the solved frame plus the ledger
    // counts, so PNG and PDF carry the same numbers as the live UI. Fixture
    // mode carries no solved numbers, so it exports pack provenance with
    // cl, cpMin, and solveMs as NaN and the sheet renders n/a.
    const exportData = useMemo<ExportData>(() => {
        const base: ExportData = {
            specLabel: specLabelFor(debouncedSpec),
            alphaDeg: debouncedSpec.alphaDeg,
            reynolds: debouncedRe,
            regime,
            cl: frame.cl,
            cpMin: frame.cpMin,
            solveMs: frame.solveMs,
            backend: backendName,
            provenance: provenanceLabel,
            gridLabel: `${flow.nx}x${flow.ny}`,
            validation: { pass: valSummary.pass, warn: valSummary.warn, fail: valSummary.fail, info: valSummary.info },
            generatedAt: frame.provenance.generatedAt,
        };
        return buildAppExportData(base, isFixture, isFixture && pack ? pack.provenance : null);
    }, [debouncedSpec, debouncedRe, regime, frame, backendName, provenanceLabel, flow, valSummary, isFixture, pack]);

    const onColormap = (next: ColormapName) => patch({ colormap: next });
    const onVariable = (next: typeof prefs.variable) => patch({ variable: next });
    const onTheme = (next: typeof prefs.theme) => {
        storeTheme(next);
        patch({ theme: next });
    };

    return (
        <div className="page">
            <a className="skip" href="#flow">Skip to flow canvas</a>
            <header className="masthead">
                <div>
                    <p className="eyebrow">GearFlow control room, Phase 6</p>
                    <h1 className="display">Wind over a wing, live in the browser</h1>
                    <p className="lede">
                        Shape the body and the Reynolds number, the field recomputes locally
                        in milliseconds. Ask the agent, tune the display, and export the run
                        as PNG or a clean printed sheet.
                    </p>
                </div>
                <div className="provenance" role="status" aria-label={`Data provenance, ${backendName}`}>
                    <span className={`dot ${dotClass}`} aria-hidden="true" />
                    <span className="provText">{packLoading && mode === "fixture" ? "Loading fixture" : provenanceLabel}</span>
                    <span className="provMode mono" aria-hidden="true">{backendName}</span>
                </div>
            </header>

            <main id="flow" className="layout workbench">
                <aside className="rail railLeft" style={{ width: leftW }} aria-label="Agent console: conversational assistant and eval">
                    <div className="railScroll">
                        <section className="card meta" aria-label="Agent console">
                            <h2><span className="railTag mono" aria-hidden="true">CON 01</span>Agent console</h2>
                            {offline && offlinePackError !== null && (
                                <p className="error" role="alert">{offlinePackError}</p>
                            )}
                            {offline && offlineCases !== null && (
                                <p className="mSub mono" role="status">
                                    Offline pack loaded, {offlineCases.length} baked cases, zero network.
                                </p>
                            )}
                            <ErrorBoundary resetKey={`agent-${offline}`} label="agent console">
                                <AgentConsole
                                    spec={spec}
                                    reynolds={reynolds}
                                    cl={frame.cl}
                                    cpMin={frame.cpMin}
                                    offline={offline}
                                    onOfflineChange={setOffline}
                                    onApplySpec={applyParametric}
                                    client={metaClient}
                                    cache={cacheRef.current!}
                                    posterUrl={posterUrl}
                                    onPosterUrl={setPosterUrl}
                                    offlineCases={offlineCases}
                                />
                            </ErrorBoundary>
                        </section>
                        <section className="card evalCard" aria-label="Eval log">
                            <h2><span className="railTag mono" aria-hidden="true">LOG 02</span>Eval ledger</h2>
                            <EvalLogPanel entries={evalEntries} />
                        </section>
                    </div>
                </aside>

                <ResizeHandle
                    id="gripLeft"
                    label="Resize agent console, left and right arrows adjust width"
                    onNudge={(d) => setLeftW((w) => clamp(d > 9000 ? LEFT_MAX : d < -9000 ? LEFT_MIN : w + d, LEFT_MIN, LEFT_MAX))}
                    onDrag={(d) => setLeftW((w) => clamp(w + d, LEFT_MIN, LEFT_MAX))}
                />

                <section className="center" aria-label="Tunnel window">
                    <div className="canvasCard" aria-label={isFixture ? "Fixture flow" : "Live analytic flow"}>
                        {packError && mode === "fixture" && <p className="error">{packError}</p>}
                        {packLoading && mode === "fixture" && !pack && <p className="loading">Loading fixture pack</p>}
                        {isSurrogatePending && (
                            <p className="loading" role="status">Loading surrogate weights, showing analytic meanwhile. No action needed.</p>
                        )}
                        {isSurrogateFallback && (
                            <p className="fallbackNote" role="status">{frame.provenance.note ?? "Surrogate unavailable, analytic fallback active."}</p>
                        )}
                        {gridState.notice !== null && mode === "analytic" && (
                            <p className="fallbackNote" role="status">
                                {gridState.notice}
                                <button type="button" className="noticeDismiss" onClick={clearNotice} aria-label="Dismiss resolution notice">Dismiss</button>
                            </p>
                        )}
                        {mode === "surrogate" && surrogateNote !== null && surrogateReady && isSurrogateFallback && (
                            <p className="reNote">{surrogateNote}</p>
                        )}
                        {mode === "analytic" && wasmNote !== null && wasmSource === null && (
                            <p className="reNote" role="status">{wasmNote}</p>
                        )}
                        {solveError !== null && !isFixture && (
                            <p className="error solveError" role="alert">
                                {sourceIsSurrogate ? "Surrogate" : "Analytic"} solve failed ({solveError}), showing last good field. Adjust the shape controls to recover.
                            </p>
                        )}
                        <ErrorBoundary resetKey={boundaryKey} label="flow canvas">
                            <FlowCanvas
                                ref={canvasRef}
                                flow={flow}
                                airfoil={airfoil}
                                colormap={prefs.colormap}
                                fieldMode={prefs.variable}
                                fieldVisible={fieldVisible}
                                particleCount={particleCount}
                                showContours={contours}
                            />
                        </ErrorBoundary>
                        <div className="canvasFoot">
                            <span className="mono">{`${flow.nx} x ${flow.ny} grid, x [-0.5, 2.0] y [-1.0, 1.0]`}</span>
                            <span className="mono">{`${debouncedSpec.kind} a${debouncedSpec.alphaDeg} Re${debouncedRe}`}</span>
                        </div>
                        {prefs.showLegend && (
                            <div className="legendWrap">
                                <Legend flow={flow} variable={prefs.variable} colormap={prefs.colormap} visible />
                            </div>
                        )}
                        <div className="metricsBar" aria-label="Solver metrics">
                            {isFixture ? (
                                <span className="mono">Cl n/a (fixture), CpMin n/a (fixture), regime {regime}</span>
                            ) : solveError !== null ? (
                                <span className="mono">
                                    Solve failed, last good Cl {Number.isFinite(frame.cl) ? frame.cl.toFixed(3) : "n/a"}, CpMin{" "}
                                    {Number.isFinite(frame.cpMin) ? frame.cpMin.toFixed(3) : "n/a"}, {frame.solveMs.toFixed(1)} ms, {regime}
                                </span>
                            ) : (
                                <span className="mono">
                                    Cl {frame.cl.toFixed(3)}, CpMin {frame.cpMin.toFixed(3)}, {frame.solveMs.toFixed(1)} ms, {regime}
                                </span>
                            )}
                        </div>
                        {!isFixture && (
                            <p className="reNote">Honest Re note: Re shades the wake deficit only, the potential core stays inviscid.</p>
                        )}
                        <p className="printValidation mono" role="note" aria-label="Validation summary for print">
                            Validation ledger (print): {valSummary.pass} pass, {valSummary.warn} warn, {valSummary.fail} fail,{" "}
                            {valSummary.info} info. {valSummary.blocking === 0 ? "No blocking failures." : `${valSummary.blocking} blocking failures, demo hold.`}{" "}
                            Full 9 row ledger lives in the app side panel. PDF export carries the same counts plus report rows.
                        </p>
                    </div>
                </section>

                <ResizeHandle
                    id="gripRight"
                    label="Resize instrument rack, left and right arrows adjust width"
                    onNudge={(d) => setRightW((w) => clamp(d > 9000 ? RIGHT_MAX : d < -9000 ? RIGHT_MIN : w - d, RIGHT_MIN, RIGHT_MAX))}
                    onDrag={(d) => setRightW((w) => clamp(w - d, RIGHT_MIN, RIGHT_MAX))}
                />

                <aside className="side rail railRight" style={{ width: rightW }} aria-label="Instrument rack: shape, display, validation, export">
                    <div className="railScroll">
                        <ErrorBoundary resetKey="rack" label="instrument rack">
                            <RackTabs
                                shape={
                                    <section className="card" aria-label="Shape controls">
                                        <h2><span className="railTag mono" aria-hidden="true">RCK 01</span>Shape controls</h2>
                                        <FlowControls
                                            spec={spec}
                                            reynolds={reynolds}
                                            mode={mode}
                                            onSpecChange={setSpec}
                                            onReynoldsChange={setReynolds}
                                            onModeChange={setMode}
                                        />
                                    </section>
                                }
                                display={
                                    <section className="card" aria-label="Display controls">
                                        <h2><span className="railTag mono" aria-hidden="true">RCK 02</span>Display</h2>
                                        <DisplayControls
                                            colormap={prefs.colormap}
                                            onColormap={onColormap}
                                            variable={prefs.variable}
                                            onVariable={onVariable}
                                            gridMode={gridState.mode}
                                            activeGrid={solveGrid.nx === 256 ? 256 : 128}
                                            onGridMode={setGridMode}
                                            particles={particleCount}
                                            onParticles={setParticleCount}
                                            fieldVisible={fieldVisible}
                                            onFieldVisible={setFieldVisible}
                                            contours={contours}
                                            onContours={setContours}
                                            showLegend={prefs.showLegend}
                                            onShowLegend={(next) => patch({ showLegend: next })}
                                        />
                                        <div className="themeRow">
                                            <ThemeToggle theme={prefs.theme} onTheme={onTheme} />
                                        </div>
                                    </section>
                                }
                                validation={
                                    <section className="card validationCard" aria-label="Validation panel">
                                        <h2><span className="railTag mono" aria-hidden="true">RCK 03</span>Validation ledger</h2>
                                        <ErrorBoundary resetKey="validation" label="validation panel">
                                            <ValidationPanel onSummary={setValSummary} />
                                        </ErrorBoundary>
                                        <p className="visuallyHidden" role="status">
                                            {valSummary.blocking === 0 ? "No blocking validation failures." : `${valSummary.blocking} blocking validation failures.`}
                                        </p>
                                    </section>
                                }
                                exportPanel={
                                    <section className="card" aria-label="Export panel">
                                        <h2><span className="railTag mono" aria-hidden="true">RCK 04</span>Export</h2>
                                        <ExportBar getSnapshot={getSnapshot} data={exportData} />
                                    </section>
                                }
                            />
                        </ErrorBoundary>
                    </div>
                </aside>
            </main>

            <footer className="foot">
                <span className="mono">GearFlow 1.0.0, Phase 6 agent console and display overhaul. Commas, colons, parentheses.</span>
            </footer>
        </div>
    );
}
