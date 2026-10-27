import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FlowCanvas, { type FlowCanvasHandle } from "@/render/FlowCanvas";
import FlowControls, { type FlowMode } from "@/ui/FlowControls";
import ErrorBoundary from "@/ui/ErrorBoundary";
import ResizeHandle from "@/components/ui/ResizeHandle";
import AgentConsole from "@/ui/AgentConsole";
import EvalLogPanel from "@/ui/EvalLogPanel";
import SettingsModal from "@/ui/SettingsModal";
import TopNav, { type NavId } from "@/ui/TopNav";
import SolverBar from "@/ui/SolverBar";
import LbmSetupRow, { LbmEntryNotice, LbmFailoverNotice } from "@/ui/LbmSetupRow";
import FieldBar, { fallbackVariableFor } from "@/ui/FieldBar";
import TelemetryBar from "@/ui/TelemetryBar";
import AnalysisPanel from "@/ui/AnalysisPanel";
import { turbulenceSectionDef } from "@/ui/TurbulenceSection";
import VerticalColorbar from "@/ui/VerticalColorbar";
import { buildPolygons } from "@/geometry/parametric";
import { applyBodyPreset, bodySelectValue as bodySelectValueFor } from "@/geometry/bodyPresets";
import { AnalyticFlowProvider, type FrameSource } from "@/flow/frameSource";
import { createFlowProvider } from "@/flow/createFlowProvider";
import { readEngineMode, lbmGridFor, blockageForGeometry, type EngineMode } from "@/flow/engineMode";
import { LbmClient, type LbmProgress } from "@/flow/lbmClient";
import {
    LBM_DEFAULT_TARGET_STEPS,
    LBM_DEFAULT_U_LATTICE,
    LBM_MAX_RE,
    LBM_PARAM_CAP_NOTICE,
    clampLbmTargetSteps,
    clampLbmULattice,
    clampReForEngine,
    lbmEntryTransition,
    lbmLesEnabled,
    lbmRecoveryRe,
    withLbmTauGuidance,
} from "@/flow/lbmRunConfig";
import { LbmFlowProvider, type LbmProviderStatus } from "@/flow/lbmFlowProvider";
import { SurrogateFlowProvider } from "@/flow/surrogate";
import { useResolution } from "@/flow/gridController";
import { useDisplayPrefs } from "@/ui/displayStore";
import { useLayoutPrefs, shellVisibility } from "@/ui/layoutStore";
import { RailShell, SceneBars, resolveShellShortcut } from "@/ui/shellRegions";
import { applyTheme, storeTheme } from "@/ui/theme";
import { maybeLoadWasm } from "@/flow/wasmSpike";
import ValidationPanel, { type ValidationSummary } from "@/ui/ValidationPanel";
import ExportBar from "@/ui/ExportBar";
import { asFixtureExport, type ExportData } from "@/export/exportReport";
import { loadOfflinePack } from "@/meta/offlinePack";
import { buildAgentContext, type AppSnapshot } from "@/agent/agentContext";
import type { AgentAction } from "@/contracts/types";
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
export function isUsableField(flow: FlowField, cl: number, cpMin: number): boolean {
    if (!Number.isFinite(cl) || !Number.isFinite(cpMin)) return false;
    if (!Number.isFinite(flow.nx) || !Number.isFinite(flow.ny)) return false;
    const n = flow.nx * flow.ny;
    if (flow.u.length !== n || flow.v.length !== n || flow.p.length !== n || flow.omega.length !== n) return false;
    for (let k = 0; k < n; k++) {
        if (!Number.isFinite(flow.u[k]) || !Number.isFinite(flow.v[k]) || !Number.isFinite(flow.p[k]) || !Number.isFinite(flow.omega[k])) {
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
    // Phase 12a collapsible shell. Collapse never touches widths, so expand
    // restores the exact remembered rail size. Focus mode forces all three
    // regions shut through shellVisibility.
    const { prefs: layoutPrefs, patch: layoutPatch } = useLayoutPrefs();
    const shell = shellVisibility(layoutPrefs);
    const { state: gridState, recordSolveMs, setMode: setGridMode, clearNotice } = useResolution();
    const [settingsOpen, setSettingsOpen] = useState(false);

    useEffect(() => {
        applyTheme(prefs.theme);
    }, [prefs.theme]);

    // WASM backend: when ?wasm=1 (or ?engine=wasm) is present,
    // createFlowProvider loads the Rust solver once and serves frames with
    // analytic fallback. No flag means the analytic provider stays the only
    // frame source. ?engine=lbm selects the worker LBM path instead.
    const [wasmSource, setWasmSource] = useState<FrameSource | null>(null);
    const [wasmNote, setWasmNote] = useState<string | null>(null);
    const [engineMode, setEngineMode] = useState<EngineMode>(() => {
        try {
            return readEngineMode(window.location.search);
        } catch {
            return "analytic";
        }
    });
    const setEngineAndMirror = useCallback((next: EngineMode) => {
        setEngineMode(next);
        try {
            const url = new URL(window.location.href);
            if (next === "analytic") {
                url.searchParams.delete("engine");
                url.searchParams.delete("wasm");
            } else {
                url.searchParams.set("engine", next);
                url.searchParams.delete("wasm");
            }
            window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        } catch {
            // URL mirror must never break engine switching.
        }
    }, []);
    const lbmActive = engineMode === "lbm";
    const wasmEngine = engineMode === "wasm";
    // Latest solved inputs, read when constructing the provider so the
    // initial WASM solver is not stale. The provider itself stays alive
    // across slider moves and is updated via setters in the solved memo.
    const latestSpecRef = useRef(debouncedSpec);
    const latestReRef = useRef(debouncedRe);
    latestSpecRef.current = debouncedSpec;
    latestReRef.current = debouncedRe;
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
    const LEFT_MAX = 420;
    const RIGHT_MIN = 280;
    const RIGHT_MAX = 480;
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
    const [leftW, setLeftW] = useState<number>(() => loadRail("gearflow:leftW", 320, LEFT_MIN, LEFT_MAX));
    const [rightW, setRightW] = useState<number>(() => loadRail("gearflow:rightW", 320, RIGHT_MIN, RIGHT_MAX));

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

    // Collapsible shell toggles. Toggling any region while focus mode is on
    // releases focus mode first, so every visible handle always works.
    const toggleLeft = useCallback(() => {
        if (layoutPrefs.focusMode) layoutPatch({ focusMode: false });
        else layoutPatch({ leftCollapsed: !layoutPrefs.leftCollapsed });
    }, [layoutPrefs.focusMode, layoutPrefs.leftCollapsed, layoutPatch]);
    const toggleRight = useCallback(() => {
        if (layoutPrefs.focusMode) layoutPatch({ focusMode: false });
        else layoutPatch({ rightCollapsed: !layoutPrefs.rightCollapsed });
    }, [layoutPrefs.focusMode, layoutPrefs.rightCollapsed, layoutPatch]);
    const toggleBars = useCallback(() => {
        if (layoutPrefs.focusMode) layoutPatch({ focusMode: false });
        else layoutPatch({ barsCollapsed: !layoutPrefs.barsCollapsed });
    }, [layoutPrefs.focusMode, layoutPrefs.barsCollapsed, layoutPatch]);
    const toggleFocus = useCallback(() => {
        layoutPatch({ focusMode: !layoutPrefs.focusMode });
    }, [layoutPrefs.focusMode, layoutPatch]);

    // Shell shortcuts: backtick focus, brackets rails, Escape exits focus.
    // Ignored in fields, with modifiers, and while Settings owns the dialog.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const action = resolveShellShortcut(e.key, {
                settingsOpen,
                target: e.target,
                ctrl: e.ctrlKey,
                meta: e.metaKey,
                alt: e.altKey,
                repeat: e.repeat,
            });
            if (action === null) return;
            if (action === "focus") {
                e.preventDefault();
                toggleFocus();
            } else if (action === "left") {
                e.preventDefault();
                toggleLeft();
            } else if (action === "right") {
                e.preventDefault();
                toggleRight();
            } else if (action === "exitFocus" && layoutPrefs.focusMode) {
                e.preventDefault();
                layoutPatch({ focusMode: false });
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [settingsOpen, layoutPrefs.focusMode, toggleFocus, toggleLeft, toggleRight, layoutPatch]);

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

    // Zenith style stacked analysis rail. Multiple sections open at once,
    // default open GEOMETRY and DISPLAY. Navbar VALIDATE and EXPORT links
    // open the matching section. Content stays mounted when collapsed.
    const [openSections, setOpenSections] = useState<Set<string>>(
        () => new Set(["geometry", "display"])
    );
    const [navActive, setNavActive] = useState<NavId>("studio");
    const toggleSection = useCallback((id: string) => {
        setOpenSections((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);
    const openSection = useCallback((id: string) => {
        setOpenSections((prev) => new Set(prev).add(id));
    }, []);
    const handleNav = useCallback((id: NavId) => {
        setNavActive(id);
        if (id === "validate") openSection("validation");
        else if (id === "export") openSection("export");
        else openSection("geometry");
    }, [openSection]);

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

    // Parametric applies (MetaPanel, agent set_spec) share the LBM Re ceiling
    // with the bars. The capped value is returned so the caller can note it.
    const applyParametric = (next: ParametricSpec): { reynolds: number; capped: boolean } => {
        setSpec(next.geometry);
        const { reynolds: cappedRe, capped } = clampReForEngine(next.reynolds, lbmActive);
        setReynolds(cappedRe);
        if (capped) setLbmNotice(LBM_PARAM_CAP_NOTICE);
        if (next.geometry.kind === "custom") setMode("analytic");
        return { reynolds: cappedRe, capped };
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

    // WASM provider load: only when the wasm engine is selected (?wasm=1
    // or ?engine=wasm). Created once per grid and kept alive across
    // parameter changes; the solved memo drives it via setGeometry/setRe.
    // Any fault falls back to analytic.
    useEffect(() => {
        let cancelled = false;
        let live: FrameSource | null = null;
        if (!wasmEngine) return;
        try {
            if (typeof window === "undefined") return;
        } catch {
            return;
        }
        setWasmSource(null);
        void createFlowProvider(solveGrid, latestSpecRef.current, { Re: latestReRef.current })
            .then((p) => {
                const isWasm = (p as { label?: string }).label === "wasm-potential";
                if (cancelled) {
                    if (isWasm) {
                        try {
                            (p as { free?: () => void }).free?.();
                        } catch {
                            // Disposal must never break provider teardown.
                        }
                    }
                    return;
                }
                if (isWasm) {
                    live = p;
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
            if (live !== null) {
                try {
                    (live as { free?: () => void }).free?.();
                } catch {
                    // Disposal must never break provider teardown.
                }
                live = null;
            }
        };
    }, [solveGrid, wasmEngine]);

    // LBM engine (?engine=lbm): worker backed viscous solve. The worker
    // owns one WasmLbmSolver; this component owns the client plus a passive
    // LbmFlowProvider that serves the latest snapshot (or a labelled
    // placeholder until the first snapshot). Any worker fault latches to
    // the analytic provider and never shows LBM numbers.
    const [lbmStatus, setLbmStatus] = useState<LbmProviderStatus>("idle");
    const [lbmProgress, setLbmProgress] = useState<LbmProgress>({ step: 0, targetSteps: 0, cd: NaN, cl: NaN });
    const [lbmTick, setLbmTick] = useState(0);
    const [lbmFailed, setLbmFailed] = useState<string | null>(null);
    const [lbmHasSnapshot, setLbmHasSnapshot] = useState(false);
    const lbmClientRef = useRef<LbmClient | null>(null);
    const lbmProviderRef = useRef<LbmFlowProvider | null>(null);
    const lbmLastSnapAtRef = useRef(0);
    const lbmFailedRef = useRef<string | null>(null);
    lbmFailedRef.current = lbmFailed;

    // Configurable LBM run state. uLattice and targetSteps flow into
    // client.init; LES auto derives from the debounced Re, the manual
    // toggle only matters while Auto is off.
    const [lbmULattice, setLbmULattice] = useState(LBM_DEFAULT_U_LATTICE);
    const [lbmTargetSteps, setLbmTargetSteps] = useState(LBM_DEFAULT_TARGET_STEPS);
    const [lbmLesAuto, setLbmLesAuto] = useState(true);
    const [lbmLesManual, setLbmLesManual] = useState(false);
    const [lbmNotice, setLbmNotice] = useState<string | null>(null);
    const lbmLesEffective = lbmLesEnabled(lbmLesAuto, lbmLesManual, debouncedRe);
    // Keyed on the mode transition so entering LBM resets a high Re once,
    // without looping and without clobbering a deliberate low Re.
    const lbmEnterSeenRef = useRef<EngineMode | null>(null);
    useEffect(() => {
        if (engineMode !== "lbm") {
            lbmEnterSeenRef.current = engineMode;
            setLbmNotice(null);
            return;
        }
        const transition = lbmEntryTransition(engineMode, reynolds, lbmEnterSeenRef.current);
        lbmEnterSeenRef.current = "lbm";
        if (transition !== null) {
            setReynolds(transition.reynolds);
            setLbmNotice(transition.notice);
        }
    }, [engineMode, reynolds]);

    const lbmGrid = useMemo(() => lbmGridFor(DEFAULT_DOMAIN, activeGrid), [activeGrid]);

    const lbmBlockage = useMemo(
        () => blockageForGeometry(debouncedSpec, DEFAULT_DOMAIN),
        [debouncedSpec]
    );

    const lbmFailover = useCallback((message: string) => {
        if (lbmFailedRef.current !== null) return;
        // Tau and floor faults carry the measured stability guidance so the
        // notice is actionable. The latch and the honest fallback stay put.
        setLbmFailed(withLbmTauGuidance(message));
        setLbmHasSnapshot(false);
        setLbmProgress({ step: 0, targetSteps: 0, cd: NaN, cl: NaN });
        setLbmStatus("idle");
        try {
            lbmProviderRef.current?.clearSnapshot();
        } catch {
            // Clearing must never break failover.
        }
        try {
            lbmClientRef.current?.dispose();
        } catch {
            // Disposal must never break failover.
        }
        lbmClientRef.current = null;
    }, []);

    useEffect(() => {
        if (!lbmActive) return;
        // Fresh run: drop stale snapshot, progress, and status so a
        // placeholder is shown until the first snapshot of the new run.
        setLbmHasSnapshot(false);
        setLbmProgress({ step: 0, targetSteps: 0, cd: NaN, cl: NaN });
        setLbmStatus("idle");
        if (lbmGrid.reason !== null) {
            setLbmFailed(`LBM grid unavailable (${lbmGrid.reason}), analytic fallback serving frames.`);
            return;
        }
        let disposed = false;
        let worker: Worker | null = null;
        try {
            if (typeof Worker === "undefined") {
                setLbmFailed("LBM worker unavailable in this browser, analytic fallback serving frames.");
                return;
            }
            worker = new Worker(new URL("./flow/lbmWorker.ts", import.meta.url), { type: "module" });
        } catch {
            setLbmFailed("LBM worker unavailable in this browser, analytic fallback serving frames.");
            return;
        }
        const provider = new LbmFlowProvider(
            { nx: lbmGrid.nx, ny: lbmGrid.ny, domain: { ...DEFAULT_DOMAIN } },
            debouncedSpec,
            { Re: debouncedRe }
        );
        lbmProviderRef.current = provider;
        try {
            provider.setBlockageNote(blockageForGeometry(debouncedSpec, DEFAULT_DOMAIN).warning);
        } catch {
            // Blockage note must never break provider setup.
        }
        const client = new LbmClient(worker as unknown as ConstructorParameters<typeof LbmClient>[0]);
        lbmClientRef.current = client;
        // A worker that errors at the port level uses the same failover as
        // a client error state. Chain the client handler so both fire.
        try {
            const prevOnError = (worker as unknown as { onerror?: ((ev: unknown) => void) | null }).onerror;
            (worker as unknown as { onerror?: ((ev: unknown) => void) | null }).onerror = (ev: unknown) => {
                try {
                    (prevOnError as ((ev: unknown) => void) | null)?.(ev);
                } catch {
                    // Client handler faults must never break failover.
                }
                lbmFailover("LBM worker error event, analytic fallback serving frames.");
            };
        } catch {
            // Error slot wiring must never break setup.
        }
        client.onStatus = (s) => {
            if (disposed) return;
            if (s === "disposed") return;
            setLbmStatus(s);
            provider.setStatus(s);
        };
        client.onProgress = (p) => {
            if (disposed) return;
            setLbmProgress({ ...p });
            provider.setProgress(p.step, p.targetSteps, p.cd, p.cl);
            const now = Date.now();
            if (now - lbmLastSnapAtRef.current >= 250) {
                lbmLastSnapAtRef.current = now;
                client.requestSnapshot();
            }
        };
        client.onSnapshot = (s) => {
            if (disposed) return;
            provider.setSnapshot(
                {
                    nx: s.nx, ny: s.ny, domain: { ...s.domain }, u: s.u, v: s.v, p: s.p, omega: s.omega, obstacle: s.obstacle,
                    ...(s.uMean !== undefined ? { uMean: s.uMean } : null),
                    ...(s.vMean !== undefined ? { vMean: s.vMean } : null),
                    ...(s.k !== undefined ? { k: s.k } : null),
                    ...(s.recirc !== undefined ? { recirc: s.recirc } : null),
                    ...(s.stats !== undefined ? { lbmStats: s.stats } : null),
                },
                s.step,
                s.cd,
                s.cl
            );
            setLbmHasSnapshot(true);
            setLbmTick((t) => t + 1);
        };
        client.onError = (message) => {
            if (disposed) return;
            lbmFailover(message);
        };
        client.init({
            nx: lbmGrid.nx,
            ny: lbmGrid.ny,
            domain: { ...DEFAULT_DOMAIN },
            geomJson: JSON.stringify(debouncedSpec),
            re: debouncedRe,
            uLattice: lbmULattice,
            lesEnabled: lbmLesEffective,
            targetSteps: lbmTargetSteps,
            batchSteps: 512,
            statsStartStep: 8000,
        });
        // The effect deps array above is the canonical re-init trigger. A fresh
        // run is fully described by grid, spec, Re, and run settings.
        return () => {
            disposed = true;
            try {
                client.dispose();
            } catch {
                // Disposal must never break teardown.
            }
            if (lbmClientRef.current === client) lbmClientRef.current = null;
            if (lbmProviderRef.current === provider) lbmProviderRef.current = null;
            try {
                worker?.terminate();
            } catch {
                // Disposal must never break teardown.
            }
        };
    }, [lbmActive, lbmGrid.nx, lbmGrid.ny, lbmGrid.reason, debouncedSpec, debouncedRe, lbmULattice, lbmTargetSteps, lbmLesEffective, lbmFailover]);

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
                    const wasmFaulted = (ws as { wasmFailed?: boolean }).wasmFailed === true;
                    if (!isUsableField(flow, res.cl, res.cpMin)) {
                        throw new Error("wasm solve produced a non-finite field, holding last good frame");
                    }
                    const polygons = buildPolygons(debouncedSpec);
                    const provenance: Provenance = wasmFaulted
                        ? {
                            source: "analytic-potential",
                            label: `analytic fallback after wasm fault, computed locally at ${solveGrid.nx}`,
                            generatedAt: new Date().toISOString(),
                            gridLabel: `${solveGrid.nx}x${solveGrid.ny}`,
                            geometryLabel: `${debouncedSpec.kind} a${debouncedSpec.alphaDeg}`,
                            note: "WASM solver faulted mid-session, analytic fallback is serving frames.",
                        }
                        : {
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
    const lbmFailedActive = lbmActive && lbmFailed !== null;
    const lbmEffective = lbmActive && mode === "analytic" && !lbmFailedActive;
    // Read the passive LBM provider on every render when effective. lbmTick
    // bumps on each worker snapshot so the canvas picks up new fields.
    void lbmTick;
    const lbmProviderLive = lbmEffective ? lbmProviderRef.current : null;
    const lbmPolygons = lbmEffective ? buildPolygons(debouncedSpec) : null;
    const lbmForces = lbmProviderLive?.forces() ?? null;
    const lbmFlow = lbmProviderLive?.getFrame() ?? null;
    const lbmSolved: SolvedFrame | null = lbmEffective && lbmProviderLive !== null && lbmFlow !== null && lbmPolygons !== null
        ? {
            flow: lbmFlow,
            polygons: lbmPolygons,
            cl: lbmHasSnapshot && lbmForces !== null && lbmForces.cl !== null ? lbmForces.cl : Number.NaN,
            cpMin: Number.NaN,
            solveMs: 0,
            provenance: {
                source: lbmHasSnapshot ? "lbm-binary" : "analytic-potential",
                label: lbmProviderLive.getProvenanceLabel(),
                generatedAt: new Date().toISOString(),
                gridLabel: `${lbmGrid.nx}x${lbmGrid.ny}`,
                geometryLabel: `${debouncedSpec.kind} a${debouncedSpec.alphaDeg}`,
                note: lbmHasSnapshot
                    ? "Viscous LBM worker (D2Q9 BGK, momentum exchange forces). Cd and Cl computed."
                    : "LBM pending, placeholder preview, not physics. Press Run to start the viscous solve.",
            },
        }
        : null;
    const frame = lbmSolved ?? solved.frame;
    const solveError = isFixture ? null : lbmEffective ? null : solved.error;
    const wasmFaulted = mode === "analytic" && wasmSource !== null && (wasmSource as { wasmFailed?: boolean }).wasmFailed === true;
    const isWasmActive = mode === "analytic" && wasmSource !== null && !wasmFaulted && solveError === null && frame.provenance.label.startsWith("wasm-rust");
    const isSurrogatePending = mode === "surrogate" && !surrogateReady;
    const sourceIsSurrogate = frame.provenance.source === "surrogate";
    const isSurrogateFallback = mode === "surrogate" && surrogateReady && !sourceIsSurrogate;
    const isSurrogateActive = mode === "surrogate" && surrogateReady && sourceIsSurrogate;
    // Gated fallback keeps loaded weights that exceed the sync inference budget.
    // Missing or failed fallback has no weights. The badge color differs.
    const isSurrogateGated = isSurrogateFallback && (surrogateRef.current?.loaded === true);
    const flow = isFixture && pack ? pack.flow : lbmEffective && lbmFlow !== null ? lbmFlow : frame.flow;
    const airfoil = isFixture && pack ? [pack.airfoilPoints] : frame.polygons;
    const provenanceLabel = isFixture && pack
        ? pack.provenance.label
        : lbmEffective && lbmSolved !== null
            ? lbmSolved.provenance.label
            : solveError !== null
                ? `solve error, showing last good (${frame.provenance.geometryLabel}, ${frame.provenance.gridLabel})`
                : frame.provenance.label;
    const dotClass =
        solveError !== null ? "failed"
        : lbmFailedActive ? "fallback"
        : lbmEffective && !lbmHasSnapshot ? "pending"
        : lbmEffective ? "analytic"
        : isSurrogatePending ? "pending"
        : isSurrogateActive ? "surrogate"
        : isSurrogateGated ? "gated"
        : isSurrogateFallback ? "fallback"
        : isFixture ? "fixture"
        : "analytic";
    const backendName =
        isFixture ? "fixture preview"
        : lbmFailedActive ? "analytic fallback (lbm failover)"
        : lbmEffective && !lbmHasSnapshot ? "lbm pending"
        : lbmEffective ? "lbm live"
        : solveError !== null ? `${sourceIsSurrogate ? "surrogate" : isWasmActive ? "wasm-rust" : "analytic"} held`
        : isSurrogatePending ? "surrogate loading"
        : isSurrogateGated ? "analytic fallback (gated)"
        : isSurrogateFallback ? "analytic fallback"
        : isSurrogateActive ? "surrogate live"
        : isWasmActive ? `wasm-rust live ${solveGrid.nx}`
        : `analytic live ${solveGrid.nx}`;
    const regime = regimeLabel(debouncedRe);
    const boundaryKey = `${debouncedSpec.kind}|a${debouncedSpec.alphaDeg}|Re${debouncedRe}|${mode}|${lbmEffective ? `${lbmGrid.nx}x${lbmGrid.ny}` : solveGrid.nx}|${lbmTick}`;

    // Honest gating: TKE and recirculation chips enable only when the live
    // frame actually carries the channel and the first statistics sample
    // exists. The worker always ships the channels (all zero before the
    // first sampled step), so the channel alone never enables them.
    // Placeholder and failover states never enable them.
    const lbmStatsReady = lbmEffective && (lbmProviderLive?.statsReady() ?? false);
    const hasTke = lbmEffective && lbmHasSnapshot && lbmStatsReady && flow.k !== undefined;
    const hasRecirc = lbmEffective && lbmHasSnapshot && lbmStatsReady && flow.recirc !== undefined;
    const lbmStats = lbmStatsReady ? (lbmProviderLive?.stats() ?? null) : null;
    const turbulenceDef = turbulenceSectionDef(lbmEffective, lbmStatsReady, lbmStats);

    // Effective field variable, derived during render: a selected channel
    // the current frame does not carry paints speed on this very pass.
    // The stored preference stays untouched, so returning to LBM mode
    // restores the user's choice.
    const effectiveVariable = fallbackVariableFor(prefs.variable, flow);

    // LBM run controls. Run starts the worker loop, Cancel latches the
    // current state and keeps the last snapshot on screen.
    const onLbmRun = useCallback(() => {
        try {
            lbmClientRef.current?.run();
        } catch {
            // Run must never throw out of the button handler.
        }
    }, []);
    const onLbmCancel = useCallback(() => {
        try {
            lbmClientRef.current?.cancel();
        } catch {
            // Cancel must never throw out of the button handler.
        }
    }, []);
    // Recover clears the failover latch in step with the Re change so the
    // fresh init at Re 200 can go live instead of staying failed.
    const onLbmRecoverRe = useCallback(() => {
        setLbmFailed(null);
        setReynolds(lbmRecoveryRe);
        setLbmNotice(null);
    }, []);
    const onLbmDismissNotice = useCallback(() => {
        setLbmNotice(null);
    }, []);
    const lbmTarget = lbmProgress.targetSteps > 0 ? lbmProgress.targetSteps : lbmTargetSteps;
    const lbmPct = Math.min(100, Math.max(0, Math.round((lbmProgress.step / lbmTarget) * 100)));
    const lbmProgressText = `step ${lbmProgress.step} of ${lbmTarget} (${lbmPct} percent)`;

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

    const onVariable = (next: typeof prefs.variable) => patch({ variable: next });
    const handlePatch = useCallback((next: Partial<typeof prefs>) => {        if (next.theme !== undefined) storeTheme(next.theme);
        patch(next);
    }, [patch]);
    const handleCloseSettings = useCallback(() => {
        setSettingsOpen(false);
    }, []);

    // Solver bar BODY select. NACA presets set exact m, p, t triples, other
    // kinds follow the same object rules FlowControls.setKind uses. A NACA
    // section tuned by sliders falls back to the 2412 slot in the select.
    const bodySelectValue = bodySelectValueFor(spec);
    const onBodySelect = (value: string) => {
        const next = applyBodyPreset(spec, value);
        if (next !== spec) setSpec(next);
    };
    const onAlphaBar = (next: number) => {
        if (!Number.isFinite(next)) return;
        setSpec((s) => ({ ...s, alphaDeg: Math.min(12, Math.max(-4, next)) }));
    };
    const onReynoldsBar = (next: number) => {
        if (!Number.isFinite(next)) return;
        // LBM needs low Re for a stable solve, other backends keep full range.
        const cap = lbmActive ? LBM_MAX_RE : 1_000_000;
        setReynolds(Math.min(cap, Math.max(100, Math.round(next))));
    };

    // Phase B2 agent executor. Setup actions apply directly through the
    // existing setters. Run and cancel reuse the LBM buttons, whose confirm
    // and disabled states already live in the scene bar UI.
    const applyAgentAction = useCallback((action: AgentAction) => {
        if (action.kind === "set_body") {
            const next = applyBodyPreset(spec, action.body);
            if (next !== spec) setSpec(next);
            return;
        }
        if (action.kind === "set_alpha") {
            onAlphaBar(action.alphaDeg);
            return;
        }
        if (action.kind === "set_reynolds") {
            onReynoldsBar(action.reynolds);
            return;
        }
        if (action.kind === "set_engine") {
            if (action.engine === "surrogate") {
                setMode("surrogate");
                setEngineAndMirror("analytic");
            } else {
                setMode("analytic");
                setEngineAndMirror(action.engine);
            }
            return;
        }
        if (action.kind === "set_field") {
            if (action.field === "k" && !hasTke) return;
            if (action.field === "recirc" && !hasRecirc) return;
            onVariable(action.field);
            return;
        }
        if (action.kind === "run_lbm") {
            onLbmRun();
            return;
        }
        if (action.kind === "cancel_lbm") {
            onLbmCancel();
            return;
        }
        if (action.kind === "set_spec") {
            applyParametric(action.spec);
        }
    }, [spec, hasTke, hasRecirc, onAlphaBar, onReynoldsBar, onVariable, onLbmRun, onLbmCancel, setEngineAndMirror, applyParametric]);

    // Telemetry engine word. Short uppercase token for the status strip.
    const engineLabel = lbmFailedActive
        ? "ANALYTIC-FB"
        : lbmEffective
            ? "LBM"
            : isWasmActive
                ? "WASM-RUST"
                : isSurrogateActive
                    ? "SURROGATE"
                    : isSurrogatePending
                        ? "LOADING"
                        : isFixture
                            ? "FIXTURE"
                            : solveError !== null
                                ? "HELD"
                                : isSurrogateFallback
                                    ? "ANALYTIC-FB"
                                    : "ANALYTIC";
    const bodyRowLabel = bodySelectValue === "naca0012"
        ? "NACA 0012"
        : bodySelectValue === "naca2412"
            ? "NACA 2412"
            : bodySelectValue === "naca4412"
                ? "NACA 4412"
                : bodySelectValue.toUpperCase();

    // Phase B2 agent snapshot. Built from solved state only, no new data
    // plumbing. Passed as props toward AgentConsole, no styling here.
    const agentSnapshot: AppSnapshot = useMemo(() => ({
        spec: debouncedSpec,
        reynolds: debouncedRe,
        regime,
        bodyLabel: bodyRowLabel,
        backend: backendName,
        engine: engineMode,
        gridLabel: lbmEffective ? `${lbmGrid.nx}x${lbmGrid.ny}` : `${solveGrid.nx}x${solveGrid.ny}`,
        cl: frame.cl,
        cpMin: frame.cpMin,
        lbmStatus,
        lbmHasSnapshot,
        lbmEffective,
        lbmStatsReady,
        lbmStats,
        variable: prefs.variable,
        effectiveVariable,
        hasTke,
        hasRecirc,
        validation: { pass: valSummary.pass, warn: valSummary.warn, fail: valSummary.fail, info: valSummary.info },
        provenanceLabel,
        offline,
    }), [debouncedSpec, debouncedRe, regime, bodyRowLabel, backendName, engineMode, lbmEffective, lbmGrid, solveGrid, frame, lbmStatus, lbmHasSnapshot, lbmStatsReady, lbmStats, prefs.variable, effectiveVariable, hasTke, hasRecirc, valSummary, provenanceLabel, offline]);
    const agentContextValue = useMemo(() => buildAgentContext(agentSnapshot), [agentSnapshot]);

    return (
        <div className="page">
            <a className="skip" href="#tunnel">Skip to flow canvas</a>
            <TopNav
                offline={offline}
                active={navActive}
                onNav={handleNav}
                settingsOpen={settingsOpen}
                onOpenSettings={() => setSettingsOpen(true)}
                wasmActive={isWasmActive}
                focusMode={layoutPrefs.focusMode}
                onToggleFocus={toggleFocus}
            />

            <main id="flow" className="layout workbench">
                <RailShell
                    side="left"
                    label="Agent console: conversational assistant"
                    region="agent console"
                    bladeLabel="AGENT"
                    bodyId="railLeftBody"
                    collapsed={shell.left}
                    onToggle={toggleLeft}
                    width={leftW}
                >
                    <div className="railHead">
                        <span className="railTitle">AGENT CONSOLE</span>
                        <span className={offline ? "dot off" : "dot on"} aria-hidden="true" />
                        <span className="mono railState">{offline ? "OFFLINE" : "LIVE"}</span>
                    </div>
                    <div className="agentBody">
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
                                agentContext={agentContextValue}
                                onAgentAction={applyAgentAction}
                            />
                        </ErrorBoundary>
                    </div>
                </RailShell>

                {!shell.left && (
                    <ResizeHandle
                        id="gripLeft"
                        label="Resize agent console, left and right arrows adjust width"
                        onNudge={(d) => setLeftW((w) => clamp(d > 9000 ? LEFT_MAX : d < -9000 ? LEFT_MIN : w + d, LEFT_MIN, LEFT_MAX))}
                        onDrag={(d) => setLeftW((w) => clamp(w + d, LEFT_MIN, LEFT_MAX))}
                    />
                )}

                <section className="tunnelCol" aria-label="Tunnel window">
                    <SceneBars
                        bodyId="sceneBarsBody"
                        collapsed={shell.bars}
                        summary={`FIELD ${effectiveVariable.toUpperCase()} . ${engineLabel} . Re ${Math.round(debouncedRe)}`}
                        onToggle={toggleBars}
                    >
                        <div>
                            <SolverBar
                                mode={mode}
                                onMode={setMode}
                                body={bodySelectValue}
                                onBody={onBodySelect}
                                alpha={spec.alphaDeg}
                                onAlpha={onAlphaBar}
                                reynolds={reynolds}
                                onReynolds={onReynoldsBar}
                                live={solveError === null}
                                maxRe={lbmActive ? LBM_MAX_RE : 1000000}
                            />
                            <FieldBar
                                variable={effectiveVariable}
                                onVariable={onVariable}
                                hasTke={hasTke}
                                hasRecirc={hasRecirc}
                            />
                            {lbmActive && (
                                <LbmSetupRow
                                    uLattice={lbmULattice}
                                    onULattice={(v) => setLbmULattice(clampLbmULattice(v))}
                                    targetSteps={lbmTargetSteps}
                                    onTargetSteps={(v) => setLbmTargetSteps(clampLbmTargetSteps(v))}
                                    lesAuto={lbmLesAuto}
                                    onLesAuto={(v) => setLbmLesAuto(v)}
                                    lesManual={lbmLesManual}
                                    onLesManual={(v) => setLbmLesManual(v)}
                                    status={lbmStatus}
                                    onRun={onLbmRun}
                                    onCancel={onLbmCancel}
                                    progressText={lbmProgressText}
                                />
                            )}
                        </div>
                    </SceneBars>
                    <TelemetryBar
                        engine={engineLabel}
                        dotClass={dotClass}
                        gridLabel={lbmEffective ? `${lbmGrid.nx} x ${lbmGrid.ny}` : `${solveGrid.nx} x ${solveGrid.ny}`}
                        cells={flow.nx * flow.ny}
                        solveMs={frame.solveMs}
                        cl={frame.cl}
                        cpMin={frame.cpMin}
                        regime={regime}
                        provenanceLabel={packLoading && mode === "fixture" ? "Loading fixture" : provenanceLabel}
                        pass={valSummary.pass}
                        warn={valSummary.warn}
                        fail={valSummary.fail}
                        isFixture={isFixture}
                    />
                    <div className="tunnel" id="tunnel">
                        {layoutPrefs.focusMode && (
                            <button
                                type="button"
                                className="focusExit"
                                onClick={toggleFocus}
                                aria-label="Exit focus mode and restore panels"
                            >
                                EXIT FOCUS
                            </button>
                        )}
                        <ErrorBoundary resetKey={boundaryKey} label="flow canvas">
                            <FlowCanvas
                                ref={canvasRef}
                                flow={flow}
                                airfoil={airfoil}
                                colormap={prefs.colormap}
                                fieldMode={effectiveVariable}
                                meanFields={prefs.meanFields}
                                fieldVisible={prefs.fieldVisible}
                                particleCount={prefs.particleCount}
                                particleColor={prefs.particleColor}
                                showContours={prefs.contours}
                                showStreamlines={prefs.showStreamlines}
                                streamlineColormap={prefs.colormap}
                            />
                        </ErrorBoundary>
                        <div className="noticeStack" aria-label="Solver notices">
                            {lbmFailedActive && lbmFailed !== null && (
                                <LbmFailoverNotice
                                    message={lbmFailed}
                                    onRecover={onLbmRecoverRe}
                                    suffix="analytic fallback serving frames. No LBM numbers shown."
                                    recoverLabel="Recover at Re 200"
                                />
                            )}
                            {lbmActive && lbmNotice !== null && (
                                <LbmEntryNotice message={lbmNotice} onDismiss={onLbmDismissNotice} />
                            )}
                            {lbmEffective && !lbmHasSnapshot && lbmFailed === null && (
                                <p className="loading notice" role="status">LBM ready at {lbmGrid.nx} x {lbmGrid.ny}, placeholder preview, not physics. Press Run to start the viscous solve.</p>
                            )}
                            {lbmEffective && lbmBlockage.warning !== null && (
                                <p className="fallbackNote notice" role="status">{lbmBlockage.warning}</p>
                            )}
                            {packError && mode === "fixture" && <p className="error notice" role="alert">{packError}</p>}
                            {packLoading && mode === "fixture" && !pack && <p className="loading notice" role="status">Loading fixture pack</p>}
                            {isSurrogatePending && (
                                <p className="loading notice" role="status">Loading surrogate weights, showing analytic meanwhile. No action needed.</p>
                            )}
                            {isSurrogateFallback && (
                                <p className="fallbackNote notice" role="status">{frame.provenance.note ?? "Surrogate unavailable, analytic fallback active."}</p>
                            )}
                            {gridState.notice !== null && mode === "analytic" && (
                                <p className="fallbackNote notice" role="status">
                                    {gridState.notice}
                                    <button type="button" className="noticeDismiss" onClick={clearNotice} aria-label="Dismiss resolution notice">Dismiss</button>
                                </p>
                            )}
                            {mode === "surrogate" && surrogateNote !== null && surrogateReady && isSurrogateFallback && (
                                <p className="reNote notice">{surrogateNote}</p>
                            )}
                            {mode === "analytic" && wasmNote !== null && wasmSource === null && (
                                <p className="reNote notice" role="status">{wasmNote}</p>
                            )}
                            {wasmFaulted && (
                                <p className="fallbackNote notice" role="status">WASM faulted, analytic fallback serving frames.</p>
                            )}
                            {solveError !== null && !isFixture && (
                                <p className="error solveError notice" role="alert">
                                    {sourceIsSurrogate ? "Surrogate" : "Analytic"} solve failed ({solveError}), showing last good field. Adjust the shape controls to recover.
                                </p>
                            )}
                        </div>
                        <div className="runCard" aria-label="Run summary">
                            <p className="runTitle">RUN</p>
                            <dl className="runRows">
                                <div className="runRow"><dt>BODY</dt><dd className="mono">{bodyRowLabel}</dd></div>
                                <div className="runRow"><dt>ALPHA</dt><dd className="mono">{spec.alphaDeg.toFixed(1)} deg</dd></div>
                                <div className="runRow"><dt>RE</dt><dd className="mono">{Math.round(debouncedRe).toLocaleString("en-US")}</dd></div>
                                <div className="runRow"><dt>GRID</dt><dd className="mono">{lbmEffective ? `${lbmGrid.nx} x ${lbmGrid.ny}` : `${solveGrid.nx} x ${solveGrid.ny}`}</dd></div>
                                <div className="runRow"><dt>REGIME</dt><dd className="mono">{regime}</dd></div>
                            </dl>
                        </div>
                        <VerticalColorbar
                            flow={flow}
                            variable={effectiveVariable}
                            colormap={prefs.colormap}
                            visible={prefs.showLegend}
                            meanFields={prefs.meanFields}
                        />
                        <p className="printValidation mono" role="note" aria-label="Validation summary for print">
                            Validation ledger (print): {valSummary.pass} pass, {valSummary.warn} warn, {valSummary.fail} fail,{" "}
                            {valSummary.info} info. {valSummary.blocking === 0 ? "No blocking failures." : `${valSummary.blocking} blocking failures, demo hold.`}{" "}
                            Full 9 row ledger lives in the app side panel. PDF export carries the same counts plus report rows.
                        </p>
                    </div>
                </section>

                {!shell.right && (
                    <ResizeHandle
                        id="gripRight"
                        label="Resize instrument rack, left and right arrows adjust width"
                        onNudge={(d) => setRightW((w) => clamp(d > 9000 ? RIGHT_MAX : d < -9000 ? RIGHT_MIN : w - d, RIGHT_MIN, RIGHT_MAX))}
                        onDrag={(d) => setRightW((w) => clamp(w - d, RIGHT_MIN, RIGHT_MAX))}
                    />
                )}

                <RailShell
                    side="right"
                    label="Analysis rail: geometry, display, validation, eval ledger, export"
                    region="analysis rail"
                    bladeLabel="ANALYSIS"
                    bodyId="railRightBody"
                    collapsed={shell.right}
                    onToggle={toggleRight}
                    width={rightW}
                >
                    <ErrorBoundary resetKey="rack" label="analysis rail">
                        <AnalysisPanel
                            open={openSections}
                            onToggle={toggleSection}
                            sections={[
                                {
                                    id: "geometry",
                                    label: "GEOMETRY",
                                    content: (
                                        <FlowControls
                                            spec={spec}
                                            reynolds={reynolds}
                                            mode={mode}
                                            onSpecChange={setSpec}
                                            onReynoldsChange={onReynoldsBar}
                                            onModeChange={setMode}
                                        />
                                    ),
                                },
                                {
                                    id: "display",
                                    label: "DISPLAY",
                                    content: (
                                        <div>
                                            <div className="displaySummary">
                                                <p className="mono displaySummaryLine">
                                                    {prefs.colormap} field {prefs.fieldVisible ? "on" : "off"}, contours {prefs.contours ? "on" : "off"}, streamlines {prefs.showStreamlines ? "on" : "off"}
                                                </p>
                                                <p className="mono displaySummaryLine">
                                                    {prefs.particleCount === 0 ? "particles off" : `${prefs.particleCount} particles`} in {prefs.particleColor}
                                                </p>
                                                <p className="mono displaySummaryLine">
                                                    {prefs.meanFields ? "time mean u/v on" : "instantaneous u/v"}
                                                </p>
                                                <button
                                                    type="button"
                                                    className="mBtn displaySettingsBtn"
                                                    onClick={() => setSettingsOpen(true)}
                                                    aria-label="Open settings"
                                                >
                                                    Open settings
                                                </button>
                                            </div>
                                            <p className="hint mono">
                                                Honest Re note: Re shades the wake deficit only, the potential core stays inviscid.
                                            </p>
                                        </div>
                                    ),
                                },
                                ...(turbulenceDef === null ? [] : [turbulenceDef]),
                                {
                                    id: "validation",
                                    label: "VALIDATION",
                                    content: (
                                        <div>
                                            <ErrorBoundary resetKey="validation" label="validation panel">
                                                <ValidationPanel onSummary={setValSummary} />
                                            </ErrorBoundary>
                                            <p className="visuallyHidden" role="status">
                                                {valSummary.blocking === 0 ? "No blocking validation failures." : `${valSummary.blocking} blocking validation failures.`}
                                            </p>
                                        </div>
                                    ),
                                },
                                {
                                    id: "eval",
                                    label: "EVAL LEDGER",
                                    content: <EvalLogPanel entries={evalEntries} />,
                                },
                                {
                                    id: "export",
                                    label: "EXPORT",
                                    content: <ExportBar getSnapshot={getSnapshot} data={exportData} />,
                                },
                            ]}
                        />
                    </ErrorBoundary>
                </RailShell>
            </main>
            <SettingsModal
                open={settingsOpen}
                onClose={handleCloseSettings}
                prefs={prefs}
                onPatch={handlePatch}
                gridMode={gridState.mode}
                activeGrid={solveGrid.nx === 256 ? 256 : 128}
                onGridMode={setGridMode}
            />
        </div>
    );
}
