import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FlowCanvas, { type FlowCanvasHandle } from "@/render/FlowCanvas";
import ErrorBoundary from "@/ui/ErrorBoundary";
import ResizeHandle from "@/components/ui/ResizeHandle";
import AgentConsole from "@/ui/AgentConsole";
import SettingsModal from "@/ui/SettingsModal";
import TopNav, { type NavId } from "@/ui/TopNav";
import TheoryPage from "@/ui/TheoryPage";
import EditorTabs from "@/ui/EditorTabs";
import { useCaseTabs, CaseFrameCache, caseKeyFor, bodyTabIdForSpec } from "@/ui/caseTabs";
import { LbmEntryNotice, LbmFailoverNotice } from "@/ui/LbmSetupRow";
import { fallbackVariableFor } from "@/ui/FieldBar";
import FieldBar from "@/ui/FieldBar";
import SimulationSection from "@/ui/SimulationSection";
import GeometrySection from "@/ui/GeometrySection";
import { overlayPatchForFieldChange, resolveOverlays } from "@/ui/fieldOverlay";
import VerticalColorbar from "@/ui/VerticalColorbar";
import { buildPolygons, migrateDuctToOrifice } from "@/geometry/parametric";
import { applyBodyPreset, bodySelectValue as bodySelectValueFor } from "@/geometry/bodyPresets";
import { AnalyticFlowProvider } from "@/flow/frameSource";
import { lbmGridFor, blockageForGeometry } from "@/flow/engineMode";
import { LbmClient, type LbmProgress } from "@/flow/lbmClient";
import {
    LBM_DEFAULT_TARGET_STEPS,
    LBM_DEFAULT_U_LATTICE,
    LBM_PARAM_CAP_NOTICE,
    clampReForEngine,
    lbmEntryTransition,
    lbmLesEnabled,
    lbmRecoveryRe,
    preflightLbm,
    withLbmTauGuidance,
} from "@/flow/lbmRunConfig";
import { LbmFlowProvider, type LbmProviderStatus } from "@/flow/lbmFlowProvider";
import { SurrogateV2Provider, SURROGATE_V2_DOMAIN } from "@/flow/surrogateV2";
import { SurrogateV3Provider, SURROGATE_V3_DOMAIN } from "@/flow/surrogateV3";
import { NeuralV2Adapter, neuralRequestKey, isUsableNeuralField, createNeuralRequestTracker } from "@/flow/neuralV2Adapter";
import { NeuralV3Adapter, neuralV3RequestKey } from "@/flow/neuralV3Adapter";
import { StreetLoop, shouldAnimateStreet } from "@/flow/streetLoop";
import { reconstructAtPhase } from "@/flow/phaseReconstruction";
import { decideFastPath, analyticProvenanceLabel, neuralProvenanceLabel, neuralPhaseAveragedLabel, neuralSteadyLabel, type NeuralStatus, type SolverPath } from "@/flow/solverRouter";
import { classifyNeuralDomain, PROVISIONAL_NEURAL_ENVELOPE } from "@/flow/neuralDomain";
import { useResolution } from "@/flow/gridController";
import { useDisplayPrefs } from "@/ui/displayStore";
import { useLayoutPrefs, shellVisibility } from "@/ui/layoutStore";
import { RailShell, SceneBars, resolveShellShortcut } from "@/ui/shellRegions";
import { applyTheme } from "@/ui/theme";
import type { ValidationSummary } from "@/ui/ValidationPanel";
import { asFixtureExport, capTutorCaption, type ExportData } from "@/export/exportReport";
import { localTutorReply } from "@/agent/tutorPolicy";
import { loadOfflinePack } from "@/meta/offlinePack";
import { buildAgentContext, type AppSnapshot } from "@/agent/agentContext";
import { expandCasePreset } from "@/agent/casePresets";
import { agentFirstRejectionFor } from "@/agent/agentActions";
import { agentFirstFlags, lbmWorkerArmed, neuralLoadAllowed, resolveAgentFirstStartup } from "@/config/agentFirst";
import type { AgentAction } from "@/contracts/types";
import { loadDemoPack, type LoadedPack } from "@/meta/fixtures";
import { HashCache } from "@/meta/cache";
import { MetaClient } from "@/meta/client";
import { g_evalLog } from "@/meta/evalLog";
import { DEFAULT_DOMAIN, DEFAULT_GRID, type FlowField, type GeometrySpec, type OfflineCase, type ParametricSpec, type Provenance, type TheoryTopicId } from "@/contracts/types";
import { ORIFICE_THICKNESS_DEFAULT } from "@/contracts/types";
import { ALPHA_HARD_MAX, ALPHA_HARD_MIN, alphaOutOfBandNote } from "@/contracts/schema";
import { commitReynoldsValue } from "@/flow/reynoldsField";
import { advectionScaleForRe, combineVelocity, VELOCITY_MULT_DEFAULT, VELOCITY_MULT_MAX, VELOCITY_MULT_MIN } from "@/render/advectionScale";
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
    if (reynolds < 200_000) return "Transitional Wake";
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

/** Phase T2 apply receipt. Additive return on the agent executor: the
 *  canvas behavior is unchanged, callers that ignore the return see the
 *  same writes. applied lists the actions that wrote canvas state, gated
 *  lists the human readable gate notes for actions that did not. */
export interface ApplyReceipt {
    applied: AgentAction[];
    gated: string[];
    summary: string;
}

/** One line summary for an apply receipt. Names applied kinds first, then
 *  gated notes, so console and test logs stay readable. Never throws. */
export function describeApplyReceipt(applied: AgentAction[], gated: string[]): string {
    try {
        const names = applied.map((a) => a.kind);
        if (names.length === 0 && gated.length === 0) return "no-op, canvas unchanged";
        if (names.length > 0 && gated.length === 0) return `applied ${names.join(", ")}`;
        if (names.length === 0) return `gated ${gated.join("; ")}`;
        return `applied ${names.join(", ")}, gated ${gated.join("; ")}`;
    } catch {
        return "apply settled";
    }
}

/** LBM run outcome for the T2 apply receipt. Started means the worker run
 *  was posted, blocked means the preflight gate held it. Never throws. */
export type LbmRunOutcome = "started" | "blocked";

/** Build the run_lbm apply receipt from the preflight outcome. A blocked
 *  run lands in gated with a block note, never in applied, so the receipt
 *  cannot claim a run that never started. Never throws. */
export function receiptForLbmRun(action: AgentAction, outcome: LbmRunOutcome, blockReason?: string): ApplyReceipt {
    try {
        if (outcome === "blocked") {
            const note = blockReason !== undefined && blockReason.length > 0
                ? `run_lbm blocked by preflight: ${blockReason}`
                : "run_lbm blocked by preflight gate, resolve the block notice before running";
            return { applied: [], gated: [note], summary: describeApplyReceipt([], [note]) };
        }
        return { applied: [action], gated: [], summary: describeApplyReceipt([action], []) };
    } catch {
        return { applied: [], gated: ["run_lbm receipt unavailable"], summary: "apply settled" };
    }
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

/** Inputs for the shared backend name selector. Pure, no hooks. */
export interface AppBackendNameInput {
    isFixture: boolean;
    lbmFailedActive: boolean;
    lbmEffective: boolean;
    lbmHasSnapshot: boolean;
    solveError: string | null;
    isNeuralPending: boolean;
    isNeuralActive: boolean;
    isNeuralV3Pending?: boolean;
    isNeuralV3Active?: boolean;
    solveGridNx: number;
}

/** Backend name follows the displayed frame, never the router alone.
 *  Neural live requires a keyed neural frame (isNeuralActive). A pending
 *  or failed predict with no keyed frame stays on analytic wording. The
 *  v3 street is named first: the v3 bundle is tried before v2. */
export function selectBackendName(input: AppBackendNameInput): string {
    if (input.isFixture) return "fixture preview";
    if (input.lbmFailedActive) return "analytic fallback (lbm failover)";
    if (input.lbmEffective && !input.lbmHasSnapshot) return "lbm pending";
    if (input.lbmEffective) return "lbm live";
    if (input.solveError !== null) return "analytic held";
    if (input.isNeuralV3Pending === true) return "neural-v3 loading";
    if (input.isNeuralV3Active === true) return "neural-v3 live";
    if (input.isNeuralPending) return "neural-v2 loading";
    if (input.isNeuralActive) return "neural-v2 live";
    return `analytic live ${input.solveGridNx}`;
}

/** Inputs for the shared provenance label selector. Pure, no hooks. */
export interface AppProvenanceInput {
    isFixture: boolean;
    fixtureLabel: string | null;
    lbmEffective: boolean;
    lbmLabel: string | null;
    solveError: string | null;
    isHeldAnalyticFrame: boolean;
    frameGeometryLabel: string;
    frameGridLabel: string;
    frameLabel: string;
}

/** Provenance follows the frame selector first. Solve error wording
 *  applies only when the displayed frame is the held analytic frame. */
export function selectProvenanceLabel(input: AppProvenanceInput): string {
    if (input.isFixture && input.fixtureLabel !== null) return input.fixtureLabel;
    if (input.lbmEffective && input.lbmLabel !== null) return input.lbmLabel;
    if (input.isHeldAnalyticFrame && input.solveError !== null) {
        return `solve error, showing last good (${input.frameGeometryLabel}, ${input.frameGridLabel})`;
    }
    return input.frameLabel;
}

/** One clean retry per failed key. Returns true only for the first
 *  failure of a key, so the effect reruns once and never loops. */
export function shouldRetryNeuralPredict(retriedKey: string | null, failedKey: string): boolean {
    return retriedKey !== failedKey;
}

/**
 * GearFlow Phase 6 shell. Agent console on the left, tunnel canvas center,
 * instrument rack on the right. Analytic path computes locally with zero
 * fetch on the critical path. Neural v2 overlays the analytic frame when
 * the router selects it, analytic always runs the fixed 512 grid.
 */
export interface RunLogEntry {
    step: number;
    message: string;
    level: "info" | "warn" | "block";
}

/** LBM hatch: ?engine=lbm arms the worker path, every other value is auto. */
export function readLbmArmed(search: string): boolean {
    try {
        const q = search.startsWith("?") ? search : `?${search}`;
        return new URLSearchParams(q).get("engine") === "lbm";
    } catch {
        return false;
    }
}

/** Debug panels hatch: ?debug=1 mounts VALIDATION and EXPORT plus the rail
 *  presence dot, every other value is the clean default view. Read once at
 *  startup, never a route. */
export function readDebugPanels(search: string): boolean {
    try {
        const q = search.startsWith("?") ? search : `?${search}`;
        return new URLSearchParams(q).get("debug") === "1";
    } catch {
        return false;
    }
}

/** Fixture debug override: ?fixture=1 shows the baked pack, never in controls. */
export function readFixtureDebug(search: string): boolean {
    try {
        const q = search.startsWith("?") ? search : `?${search}`;
        return new URLSearchParams(q).get("fixture") === "1";
    } catch {
        return false;
    }
}

/** Legacy engine flags map to auto: ?engine=wasm and ?wasm=1 are analytic. */
export function isLegacyEngineAuto(search: string): boolean {
    try {
        const q = search.startsWith("?") ? search : `?${search}`;
        const params = new URLSearchParams(q);
        return params.get("engine") === "wasm" || params.get("wasm") === "1";
    } catch {
        return false;
    }
}

export default function App() {
    const [spec, setSpec] = useState<GeometrySpec>(DEFAULT_SPEC);
    const [reynolds, setReynolds] = useState(50_000);

    // Explicit velocity multiplier, visual only (0.5x to 2x, default 1.0).
    // No display prefs field exists, so this persists to its own localStorage
    // key with session fallback. Never feeds physics or provenance.
    const [velocity, setVelocity] = useState<number>(() => {
        try {
            const raw = window.localStorage.getItem("gearflow:velocity");
            if (raw === null) return VELOCITY_MULT_DEFAULT;
            const n = Number(raw);
            if (!Number.isFinite(n)) return VELOCITY_MULT_DEFAULT;
            return Math.min(VELOCITY_MULT_MAX, Math.max(VELOCITY_MULT_MIN, n));
        } catch {
            return VELOCITY_MULT_DEFAULT;
        }
    });
    useEffect(() => {
        try {
            window.localStorage.setItem("gearflow:velocity", String(velocity));
        } catch {
            // Private mode: velocity still applies to this session.
        }
    }, [velocity]);
    const onVelocity = useCallback((next: number) => {
        if (!Number.isFinite(next)) return;
        setVelocity(Math.min(VELOCITY_MULT_MAX, Math.max(VELOCITY_MULT_MIN, next)));
    }, []);

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
    // P2 top navbar route: studio is the tunnel workbench, theory is the
    // airfoil companion page. Theory replaces the tunnel column content
    // while the rails stay mounted; the canvas unmounts while theory is
    // active so no solve frames render behind the page.
    const [activeNav, setActiveNav] = useState<NavId>("studio");
    // Phase 25C theory deep link: the agent open_theory action names a
    // Theory page anchor, the nonce retriggers scroll plus focus when the
    // same topic applies twice. Studio renders with no topic.
    const [theoryTopic, setTheoryTopic] = useState<TheoryTopicId | null>(null);
    const [theoryNonce, setTheoryNonce] = useState(0);
    const openTheory = useCallback((topic: string): void => {
        try {
            if (typeof topic === "string" && topic.trim().length > 0) {
                setTheoryTopic(topic.trim() as TheoryTopicId);
                setTheoryNonce((n) => n + 1);
            }
            setActiveNav("theory");
            if (layoutPrefs.focusMode) layoutPatch({ focusMode: false });
        } catch {
            // Theory nav must never break the executor.
            try {
                setActiveNav("theory");
            } catch {
                // Never throws.
            }
        }
    }, [layoutPrefs.focusMode, layoutPatch]);
    // Phase 25C theoryMode layout: left chat 1/3, theory 2/3, no right rail.
    // The tunnel canvas unmounts while theory is active.
    const theoryMode = activeNav === "theory";
    // Shell excision: no title, activity, or status bars. TopNav is the
    // sole topmost bar. The right sidebar owns its disclosure state.
    // P1 IDE shell: case tab memories own the case list. The single solver
    // reads only the active tab. Memories are data only, frame cache is
    // capped at 4 and cleared on grid change below.
    const caseTabs = useCaseTabs();
    const frameCacheRef = useRef<CaseFrameCache<SolvedFrame> | null>(null);
    if (frameCacheRef.current === null) frameCacheRef.current = new CaseFrameCache<SolvedFrame>();

    useEffect(() => {
        applyTheme("dark");
    }, []);

    // Unified engine: LBM is armed by ?engine=lbm, every other flag is auto.
    // Legacy ?engine=wasm and ?wasm=1 map to auto (analytic). Fixture debug
    // override lives in ?fixture=1 and never appears in controls.
    // P1 agent-first: the build-time flag forces analytic only. lbmArmed
    // starts false even with ?engine=lbm, and the ignored request lands in
    // the terminal log below, never in a worker.
    const agentFirst = useMemo(() => agentFirstFlags(), []);
    const [lbmArmed, setLbmArmed] = useState<boolean>(() => {
        try {
            return resolveAgentFirstStartup(window.location.search).lbmArmed;
        } catch {
            return false;
        }
    });
    const [fixtureDebug] = useState<boolean>(() => {
        try {
            return readFixtureDebug(window.location.search);
        } catch {
            return false;
        }
    });
    // Debug panels: VALIDATION, EXPORT, and the rail presence dot mount only
    // behind ?debug=1. Read once at startup, the default view stays clean.
    const [debugPanels] = useState<boolean>(() => {
        try {
            return readDebugPanels(window.location.search);
        } catch {
            return false;
        }
    });
    const setLbmArmedAndMirror = useCallback((next: boolean) => {
        // Agent-first holds analytic: engine switching requests are dropped
        // so no UI path can arm the worker.
        if (agentFirst.agentFirst && next) return;
        setLbmArmed(next);
        try {
            const url = new URL(window.location.href);
            if (next) {
                url.searchParams.set("engine", "lbm");
            } else {
                url.searchParams.delete("engine");
            }
            url.searchParams.delete("wasm");
            window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        } catch {
            // URL mirror must never break engine switching.
        }
    }, [agentFirst]);
    const lbmActive = lbmArmed;

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
    const toggleBars = useCallback(() => {
        if (layoutPrefs.focusMode) layoutPatch({ focusMode: false });
        else layoutPatch({ barsCollapsed: !layoutPrefs.barsCollapsed });
    }, [layoutPrefs.focusMode, layoutPrefs.barsCollapsed, layoutPatch]);
    const toggleRight = useCallback(() => {
        if (layoutPrefs.focusMode) layoutPatch({ focusMode: false });
        else layoutPatch({ rightCollapsed: !layoutPrefs.rightCollapsed });
    }, [layoutPrefs.focusMode, layoutPrefs.rightCollapsed, layoutPatch]);
    const toggleFocus = useCallback(() => {
        layoutPatch({ focusMode: !layoutPrefs.focusMode });
    }, [layoutPrefs.focusMode, layoutPatch]);

    // Shell shortcuts: backtick full screen, brackets rails, Escape exits
    // full screen. Ignored in fields, with modifiers, and while Settings
    // owns the dialog.
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
            } else if (action === "exitFocus") {
                e.preventDefault();
                if (layoutPrefs.focusMode) layoutPatch({ focusMode: false });
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

    // P2 top navbar route. STUDIO returns to the tunnel, THEORY shows the
    // companion page in the center column while the left rail stays mounted.
    // Any nav exits full screen mode so the destination renders cleanly.
    const handleNav = useCallback((id: NavId) => {
        setActiveNav(id);
        if (layoutPrefs.focusMode) layoutPatch({ focusMode: false });
    }, [layoutPrefs.focusMode, layoutPatch]);

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
    // A legacy duct geometry migrates to the orifice plate here so App state
    // commits the migration once even when the apply bypasses the rail.
    const applyParametric = (next: ParametricSpec): { reynolds: number; capped: boolean } => {
        const geometry = (next.geometry as unknown as { kind: string }).kind === "duct"
            ? migrateDuctToOrifice(next.geometry)
            : next.geometry;
        setSpec(geometry);
        const { reynolds: cappedRe, capped } = clampReForEngine(next.reynolds, lbmActive);
        setReynolds(cappedRe);
        if (capped) setLbmNotice(LBM_PARAM_CAP_NOTICE);
        return { reynolds: cappedRe, capped };
    };

    // Long lived analytic frame source. Geometry changes re-resolve panels,
    // Reynolds number changes reuse cached panels and rebuild the wake only.
    // Grid changes (256 to 128 fallback) recreate the provider.
    const providerRef = useRef<AnalyticFlowProvider | null>(null);
    const providerGridKeyRef = useRef("");

    useEffect(() => {
        const id = window.setTimeout(() => {
            setDebouncedSpec(spec);
            setDebouncedRe(reynolds);
        }, DEBOUNCE_MS);
        return () => window.clearTimeout(id);
    }, [spec, reynolds]);

    // Fixture debug override: ?fixture=1 loads the baked pack once for the
    // debug preview. No control ever opts into this path.
    useEffect(() => {
        if (!fixtureDebug || pack || packLoading) return;
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
    }, [fixtureDebug, pack, packLoading]);

    // Effective solve grid. Analytic follows the fixed 512 resolution
    // controller. Neural v2 stays at its canonical
    // 128 inside the adapter, fixture debug renders its baked field as is.
    const activeGrid = gridState.active;
    const solveGrid = useMemo(
        () => ({ nx: activeGrid, ny: activeGrid, domain: { ...DEFAULT_DOMAIN } }),
        [activeGrid]
    );
    // Last good analytic frame. On a failed solve the UI keeps rendering
    // this frame and reports the error inline instead of throwing.
    const lastGoodRef = useRef<SolvedFrame | null>(null);
    // P1 IDE shell: frame cache capped at 4, cleared on grid change.
    // Single solver, single canvas. Tabs hold data memories only.
    useEffect(() => {
        try {
            frameCacheRef.current?.clear();
        } catch {
            // Clearing never breaks the solve path.
        }
    }, [activeGrid]);

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
    // P1 IDE shell: run events surface through the LBM notice stack only.
    // No bottom terminal state is owned here.
    const appendRunLog = useCallback((_entry: RunLogEntry) => {
        // Intentionally no terminal state. Notices carry the message.
    }, []);
    // Agent-first startup honesty: a ?engine=lbm URL that the flag held off
    // lands a notice, once. The worker stays uncreated and analytic serves.
    const agentFirstNoteRef = useRef(false);
    useEffect(() => {
        if (!agentFirst.agentFirst || agentFirstNoteRef.current) return;
        let ignored = false;
        try {
            ignored = resolveAgentFirstStartup(window.location.search).ignoredLbmRequest;
        } catch {
            ignored = false;
        }
        if (!ignored) return;
        agentFirstNoteRef.current = true;
        setLbmNotice("Agent-first mode: analytic only, ?engine=lbm ignored.");
        appendRunLog({ step: 0, message: "Agent-first mode: analytic only, ?engine=lbm ignored, serving the analytic frame.", level: "info" });
    }, [agentFirst, appendRunLog]);
    const lbmLesEffective = lbmLesEnabled(lbmLesAuto, lbmLesManual, debouncedRe);
    // P1 IDE shell: tab activation drives the single solver. Switching tabs
    // writes that tab memory into spec and Re. Editing controls mirrors
    // back into the active tab memory by key comparison, so memories stay
    // isolated and no loop forms. Agent commits are atomic: ensureBodyTab
    // stamps the target tab id here before activating, so the one-shot
    // load below skips the stale stored memory and mirrors the agent spec
    // forward into the new active memory instead.
    const tabSyncRef = useRef<string>("");
    const agentTabCommitRef = useRef<string | null>(null);
    useEffect(() => {
        const a = caseTabs.active;
        if (a === null) return;
        if (tabSyncRef.current === a.id) return;
        if (agentTabCommitRef.current === a.id) {
            agentTabCommitRef.current = null;
            tabSyncRef.current = a.id;
            try {
                caseTabs.updateActive({ spec, reynolds });
            } catch {
                // Mirror faults never break the solver state.
            }
            return;
        }
        tabSyncRef.current = a.id;
        try {
            setSpec(a.spec);
            setReynolds(a.reynolds);
        } catch {
            // Tab switch never breaks the solver state.
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [caseTabs.activeId]);
    useEffect(() => {
        const a = caseTabs.active;
        if (a === null) return;
        try {
            const liveKey = caseKeyFor(spec, reynolds, 0).split("|g")[0];
            const tabKey = caseKeyFor(a.spec, a.reynolds, 0).split("|g")[0];
            if (liveKey === tabKey) return;
            caseTabs.updateActive({ spec, reynolds });
        } catch {
            // Mirror faults never break the controls.
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [spec, reynolds]);
    // Last completed progress plus the configured target, mirrored in refs
    // so the failover notice can name the death step without stale closures.
    const lbmProgressRef = useRef<LbmProgress>({ step: 0, targetSteps: 0, cd: NaN, cl: NaN });
    const lbmTargetStepsRef = useRef(LBM_DEFAULT_TARGET_STEPS);
    lbmTargetStepsRef.current = lbmTargetSteps;
    // Keyed on the LBM arming transition so entering LBM resets a high Re
    // once, without looping and without clobbering a deliberate low Re.
    const lbmEnterSeenRef = useRef<string | null>(null);
    useEffect(() => {
        const engineToken = lbmArmed ? "lbm" : "auto";
        if (!lbmArmed) {
            lbmEnterSeenRef.current = engineToken;
            setLbmNotice(null);
            return;
        }
        const transition = lbmEntryTransition(engineToken, reynolds, lbmEnterSeenRef.current);
        lbmEnterSeenRef.current = "lbm";
        if (transition !== null) {
            setReynolds(transition.reynolds);
            setLbmNotice(transition.notice);
        }
    }, [lbmArmed, reynolds]);

    const lbmGrid = useMemo(() => lbmGridFor(DEFAULT_DOMAIN, activeGrid), [activeGrid]);

    const lbmBlockage = useMemo(
        () => blockageForGeometry(debouncedSpec, DEFAULT_DOMAIN),
        [debouncedSpec]
    );

    // SIMULATION section pre-flight warnings. Same gate inputs as the Run
    // handler below, warnings only, the hard block still lands in the notice
    // stack plus the run log when Run is pressed.
    const simPreflightWarnings = useMemo(() => {
        try {
            return preflightLbm(
                debouncedSpec,
                { nx: lbmGrid.nx, ny: lbmGrid.ny, domain: { ...DEFAULT_DOMAIN } },
                lbmULattice,
                debouncedRe
            ).warnings;
        } catch {
            return [];
        }
    }, [debouncedSpec, lbmGrid.nx, lbmGrid.ny, lbmULattice, debouncedRe]);

    // GEOMETRY section orifice plate resolution warning. Counts plate
    // thickness cells on the active analytic grid, warns below 3 cells.
    const orificeResolutionWarning = useMemo(() => {
        if (debouncedSpec.kind !== "orifice") return null;
        try {
            const thickness = debouncedSpec.width ?? ORIFICE_THICKNESS_DEFAULT;
            const dx = (DEFAULT_DOMAIN.xMax - DEFAULT_DOMAIN.xMin) / (activeGrid - 1);
            const cells = thickness / dx;
            if (!Number.isFinite(cells)) return null;
            if (cells < 3) {
                return `Orifice plate spans about ${cells.toFixed(1)} cells at ${activeGrid}, below 3 cells the gap reads wide. Thicken the plate or widen the gap.`;
            }
        } catch {
            return null;
        }
        return null;
    }, [debouncedSpec, activeGrid]);

    const lbmFailover = useCallback((message: string) => {
        if (lbmFailedRef.current !== null) return;
        // Keep the death step: the last completed progress step rides into
        // the notice and the progress readout instead of resetting to 0,
        // while the analytic fallback still serves every frame.
        const last = lbmProgressRef.current;
        const target = last.targetSteps > 0 ? last.targetSteps : lbmTargetStepsRef.current;
        const stepped = /at step \d+/.test(message)
            ? message
            : last.step > 0
                ? `${message} Diverged at step ${last.step} of ${target}.`
                : message;
        // Tau and floor faults carry the measured stability guidance so the
        // notice is actionable. The latch and the honest fallback stay put.
        setLbmFailed(withLbmTauGuidance(stepped));
        setLbmHasSnapshot(false);
        setLbmProgress({ step: last.step, targetSteps: target, cd: last.cd, cl: last.cl });
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
        // Agent-first holds analytic: the worker constructor below is
        // unreachable while the flag is on.
        if (!lbmWorkerArmed(agentFirst, lbmActive)) return;
        // Fresh run: drop stale snapshot, progress, and status so a
        // placeholder is shown until the first snapshot of the new run.
        // Mirror the reset into the ref so a pre progress failover in a
        // fresh run never names a stale death step from the prior run.
        setLbmHasSnapshot(false);
        setLbmProgress({ step: 0, targetSteps: 0, cd: NaN, cl: NaN });
        lbmProgressRef.current = { step: 0, targetSteps: 0, cd: NaN, cl: NaN };
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
            lbmProgressRef.current = { ...p };
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
    }, [agentFirst, lbmActive, lbmGrid.nx, lbmGrid.ny, lbmGrid.reason, debouncedSpec, debouncedRe, lbmULattice, lbmTargetSteps, lbmLesEffective, lbmFailover]);

    // Neural v2 retired, v3 is the only neural path. No v2 bundle ships:
    // public/surrogate/ root holds the superseded v1 weights.bin format
    // (manifest version 1, no norm sidecar), and no surrogate/v2/ directory
    // exists, so the v2 manifest URL serves the app shell and JSON parse
    // fails by construction. The adapter plus request tracker stay so the
    // types and the router legacy path keep compiling, but availability is
    // pinned to unavailable so the router never selects neural-v2 and no v2
    // popup can appear. Without v3 the app serves analytic with the reason.
    const [neuralStatus] = useState<NeuralStatus>("unavailable");
    const [neuralFrame, setNeuralFrame] = useState<{
        key: string;
        flow: FlowField;
        cl: number;
        cpMin: number;
        solveMs: number;
        latencyMs: number;
        cached: boolean;
        weightsVersion: string;
    } | null>(null);
    const neuralAdapterRef = useRef<NeuralV2Adapter | null>(null);
    const neuralTrackerRef = useRef(createNeuralRequestTracker());
    const [neuralRetryTick, setNeuralRetryTick] = useState(0);
    const neuralRetriedKeyRef = useRef<string | null>(null);
    if (neuralAdapterRef.current === null && neuralLoadAllowed(agentFirst)) {
        try {
            const provider = new SurrogateV2Provider({
                grid: { nx: 128, ny: 128, domain: { ...SURROGATE_V2_DOMAIN } },
                geom: DEFAULT_SPEC,
                Re: 50000,
            });
            neuralAdapterRef.current = new NeuralV2Adapter(provider);
        } catch {
            neuralAdapterRef.current = null;
        }
    }

    // Neural v3 availability plus request tracking. Mirrors the v2 wiring:
    // the adapter owns the provider and the last frame cache, the tracker
    // hands out monotonic request ids so only the latest async predict can
    // commit. The v3 bundle is tried first, v2 stays the exact fallback.
    const [neuralV3Status, setNeuralV3Status] = useState<NeuralStatus>("loading");
    const [neuralV3Frame, setNeuralV3Frame] = useState<{
        key: string;
        flow: FlowField;
        cl: number;
        cpMin: number;
        solveMs: number;
        latencyMs: number;
        cached: boolean;
        weightsVersion: string;
        harmonicValid: boolean;
        harmonicInvalidReason: string | null;
        strouhal: number | null;
        explained: number | null;
    } | null>(null);
    const neuralV3AdapterRef = useRef<NeuralV3Adapter | null>(null);
    const neuralV3TrackerRef = useRef(createNeuralRequestTracker());
    const [neuralV3RetryTick, setNeuralV3RetryTick] = useState(0);
    const neuralV3RetriedKeyRef = useRef<string | null>(null);
    if (neuralV3AdapterRef.current === null && neuralLoadAllowed(agentFirst)) {
        try {
            const provider = new SurrogateV3Provider({
                grid: { nx: 128, ny: 128, domain: { ...SURROGATE_V3_DOMAIN } },
                geom: DEFAULT_SPEC,
                Re: 50000,
            });
            neuralV3AdapterRef.current = new NeuralV3Adapter(provider);
        } catch {
            neuralV3AdapterRef.current = null;
        }
    }

    // Phase averaged street animation. One StreetLoop per served v3 street
    // writes reconstructed u, v, and omega into caller owned buffers via
    // reconstructAtPhase; the same buffers feed the canvas field and the
    // particle advection, so particles and phase cannot drift. Pause, tab
    // hide, and unmount never jump the phase, and the loop never starts for
    // LBM or analytic frames (see shouldAnimateStreet).
    const streetLoopRef = useRef<StreetLoop | null>(null);
    const streetBaseRef = useRef<FlowField | null>(null);
    const streetAnimRef = useRef<FlowField | null>(null);
    const streetKeyRef = useRef<string | null>(null);
    const [streetTick, setStreetTick] = useState(0);

    // Router inputs come from the debounced case plus both availabilities.
    // The v3 bundle is tried first: when it is usable and the case sits
    // inside the envelope the path is neural-v3, otherwise the router falls
    // back to v2 exactly as before. The body token mirrors the BODY select
    // so the envelope allowlist stays single sourced.
    const routerBody = bodySelectValueFor(debouncedSpec);
    const domainVerdict = useMemo(
        () => classifyNeuralDomain(routerBody, debouncedSpec.alphaDeg, debouncedRe),
        [routerBody, debouncedSpec.alphaDeg, debouncedRe]
    );
    const fastDecision = useMemo(
        () => decideFastPath({ body: routerBody, alphaDeg: debouncedSpec.alphaDeg, reynolds: debouncedRe, neuralStatus, neuralV3Status }),
        [routerBody, debouncedSpec.alphaDeg, debouncedRe, neuralStatus, neuralV3Status]
    );

    // v2 retired (see the Neural v2 comment above): availability stays
    // pinned to unavailable, no v2 bundle is ever fetched.

    // v3 availability load runs once and never throws at startup. Any
    // failure latches so the router falls back to v2, then analytic, with
    // an honest reason.
    useEffect(() => {
        // Agent-first holds analytic: no neural bundle is fetched, the
        // status pins to unavailable so the router names analytic honestly.
        if (!neuralLoadAllowed(agentFirst)) {
            setNeuralV3Status("unavailable");
            return;
        }
        let cancelled = false;
        const adapter = neuralV3AdapterRef.current;
        if (adapter === null) {
            setNeuralV3Status("unavailable");
            return;
        }
        setNeuralV3Status(adapter.availability === "ready" ? "ready" : "loading");
        void adapter.ensureLoaded().then((status) => {
            if (!cancelled) setNeuralV3Status(status);
        }).catch((e) => {
            if (!cancelled) {
                try {
                    console.error("[neural-v3] availability load failed:", e instanceof Error ? e.message : String(e));
                } catch { /* never throws */ }
                setNeuralV3Status("failed");
            }
        });
        return () => {
            cancelled = true;
        };
    }, [agentFirst]);

    // Neural effect keyed on spec, Re, and availability. Monotonic request
    // id guards the async predict, latest only commits, stale keys never
    // display. A failed latest request retries once for its key via the
    // retry tick, then stays on the analytic frame underneath.
    useEffect(() => {
        void neuralRetryTick;
        // Agent-first holds analytic: no neural predict runs.
        if (!neuralLoadAllowed(agentFirst)) return;
        if (fastDecision.path !== "neural-v2") return;
        const adapter = neuralAdapterRef.current;
        if (adapter === null) return;
        const requestId = neuralTrackerRef.current.next();
        let cancelled = false;
        void adapter.predictFor(debouncedSpec, debouncedRe).then((res) => {
            if (cancelled) return;
            if (!neuralTrackerRef.current.isLatest(requestId)) return;
            const currentKey = neuralRequestKey(debouncedSpec, debouncedRe);
            if (res.key !== currentKey) return;
            if (!isUsableNeuralField(res.flow, res.cl, res.cpMin)) return;
            if (!isUsableField(res.flow, res.cl, res.cpMin)) return;
            setNeuralFrame({
                key: res.key,
                flow: res.flow,
                cl: res.cl,
                cpMin: res.cpMin,
                solveMs: res.solveMs,
                latencyMs: res.latencyMs,
                cached: res.cached,
                weightsVersion: adapter.version,
            });
        }).catch(() => {
            if (cancelled) return;
            if (!neuralTrackerRef.current.isLatest(requestId)) return;
            const failedKey = neuralRequestKey(debouncedSpec, debouncedRe);
            if (!shouldRetryNeuralPredict(neuralRetriedKeyRef.current, failedKey)) return;
            neuralRetriedKeyRef.current = failedKey;
            setNeuralRetryTick((t) => t + 1);
        });
        return () => {
            cancelled = true;
        };
    }, [debouncedSpec, debouncedRe, neuralStatus, fastDecision.path, neuralRetryTick]);

    // v3 neural effect, additive and minimal. Runs one inference per case
    // key only while the router holds neural-v3. Same latest only commit
    // and one clean retry per failed key as v2, then the analytic frame
    // underneath stays.
    useEffect(() => {
        void neuralV3RetryTick;
        // Agent-first holds analytic: no neural predict runs.
        if (!neuralLoadAllowed(agentFirst)) return;
        if (fastDecision.path !== "neural-v3") return;
        const adapter = neuralV3AdapterRef.current;
        if (adapter === null) return;
        const requestId = neuralV3TrackerRef.current.next();
        let cancelled = false;
        void adapter.predictFor(debouncedSpec, debouncedRe).then((res) => {
            if (cancelled) return;
            if (!neuralV3TrackerRef.current.isLatest(requestId)) return;
            const currentKey = neuralV3RequestKey(debouncedSpec, debouncedRe);
            if (res.key !== currentKey) return;
            if (!isUsableNeuralField(res.flow, res.cl, res.cpMin)) return;
            if (!isUsableField(res.flow, res.cl, res.cpMin)) return;
            setNeuralV3Frame({
                key: res.key,
                flow: res.flow,
                cl: res.cl,
                cpMin: res.cpMin,
                solveMs: res.solveMs,
                latencyMs: res.latencyMs,
                cached: res.cached,
                weightsVersion: adapter.version,
                harmonicValid: res.harmonicValid,
                harmonicInvalidReason: res.harmonicInvalidReason,
                strouhal: res.strouhal,
                explained: res.explained,
            });
        }).catch(() => {
            if (cancelled) return;
            if (!neuralV3TrackerRef.current.isLatest(requestId)) return;
            const failedKey = neuralV3RequestKey(debouncedSpec, debouncedRe);
            if (!shouldRetryNeuralPredict(neuralV3RetriedKeyRef.current, failedKey)) return;
            neuralV3RetriedKeyRef.current = failedKey;
            setNeuralV3RetryTick((t) => t + 1);
        });
        return () => {
            cancelled = true;
        };
    }, [debouncedSpec, debouncedRe, neuralV3Status, fastDecision.path, neuralV3RetryTick]);

    const solved = useMemo<{ frame: SolvedFrame; error: string | null }>(() => {
        try {
            const cache = frameCacheRef.current;
            const cacheKey = caseKeyFor(debouncedSpec, debouncedRe, solveGrid.nx);
            const hit = cache?.get(cacheKey) ?? null;
            if (hit !== null) {
                lastGoodRef.current = hit;
                return { frame: hit, error: null };
            }
            const gridKey = `${solveGrid.nx}x${solveGrid.ny}`;
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
                label: analyticProvenanceLabel(fastDecision.reason),
                generatedAt: new Date().toISOString(),
                gridLabel: `${solveGrid.nx}x${solveGrid.ny}`,
                geometryLabel: `${debouncedSpec.kind} a${debouncedSpec.alphaDeg}`,
                note: "Potential panel solution plus wake overlay. Re shades the wake deficit only.",
            };
            const frame: SolvedFrame = { flow, polygons, cl, cpMin, solveMs, provenance };
            lastGoodRef.current = frame;
            try {
                cache?.set(cacheKey, frame);
            } catch {
                // Cache faults never break the solve path.
            }
            return { frame, error: null };
        } catch (e: unknown) {
            const message = describeSolveError(e);
            console.error("Analytic solve failure, holding last good frame:", message);
            const fallback = lastGoodRef.current ?? emptyFrame();
            return { frame: fallback, error: message };
        }
    }, [debouncedSpec, debouncedRe, solveGrid, fastDecision.reason]);

    // Resolution bookkeeping: record each fresh solve once. The grid is
    // fixed at 512, so this never falls back and only keeps timing honest.
    const recordedSolveRef = useRef("");
    useEffect(() => {
        if (solved.error !== null) return;
        const key = `${solveGrid.nx}x${solveGrid.ny}|${solved.frame.provenance.geometryLabel}|${solved.frame.solveMs.toFixed(2)}`;
        if (recordedSolveRef.current === key) return;
        recordedSolveRef.current = key;
        recordSolveMs(solved.frame.solveMs);
    }, [solved, solveGrid, recordSolveMs]);

    const isFixture = fixtureDebug && pack !== null;
    const lbmFailedActive = lbmActive && lbmFailed !== null;
    const lbmEffective = lbmActive && !lbmFailedActive;
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
    // Neural keyed frame: only the current request key may display. Stale
    // keys stay on the analytic frame underneath.
    const neuralKey = neuralRequestKey(debouncedSpec, debouncedRe);
    const neuralKeyed = neuralFrame !== null && neuralFrame.key === neuralKey && fastDecision.path === "neural-v2"
        ? neuralFrame
        : null;
    const neuralSolved: SolvedFrame | null = neuralKeyed !== null
        ? {
            flow: neuralKeyed.flow,
            polygons: buildPolygons(debouncedSpec),
            cl: neuralKeyed.cl,
            cpMin: neuralKeyed.cpMin,
            solveMs: neuralKeyed.solveMs,
            provenance: {
                source: "surrogate",
                label: neuralProvenanceLabel({
                    weightsVersion: neuralKeyed.weightsVersion,
                    latencyMs: neuralKeyed.latencyMs,
                    cached: neuralKeyed.cached,
                }),
                generatedAt: new Date().toISOString(),
                gridLabel: "128x128",
                geometryLabel: `${debouncedSpec.kind} a${debouncedSpec.alphaDeg}`,
                note: "Neural v2 prediction, not validated physics.",
            },
        }
        : null;
    // v3 keyed frame: same key gate as v2, served only while the router
    // holds neural-v3. A harmonic invalid frame still serves, steady, with
    // the failing gate reason in the label; it never falls back to v2.
    const neuralV3Key = neuralV3RequestKey(debouncedSpec, debouncedRe);
    const neuralV3Keyed = neuralV3Frame !== null && neuralV3Frame.key === neuralV3Key && fastDecision.path === "neural-v3"
        ? neuralV3Frame
        : null;

    // Street gate, evaluated during render so the effect and the display
    // agree on one decision. True only for a served v3 street with valid
    // harmonics: LBM, fixture, held analytic, and steady v3 frames never
    // start the loop and keep the mean field. A steady-only bundle
    // (harmonicCapable false) never starts the loop either.
    const v3HarmonicCapable = neuralV3AdapterRef.current?.harmonicCapable ?? true;
    const streetActive = neuralV3Keyed !== null && v3HarmonicCapable && shouldAnimateStreet({
        path: fastDecision.path,
        harmonicValid: neuralV3Keyed.harmonicValid,
        harmonicCapable: v3HarmonicCapable,
        lbmEffective,
        isFixture,
        solveError: isFixture || lbmEffective ? null : solved.error,
        strouhal: neuralV3Keyed.strouhal,
    });

    // Street loop effect. Starts one StreetLoop while streetActive holds,
    // reuses the clock and buffers for the same key so pause and resume
    // never jump the phase, and stops on key change, on gate off, and on
    // unmount. Each visible frame rewrites the display u, v, and omega in
    // place via reconstructAtPhase and bumps the street tick.
    useEffect(() => {
        const keyed = neuralV3Keyed;
        if (!streetActive || keyed === null) {
            streetLoopRef.current?.stop();
            return;
        }
        if (streetKeyRef.current !== keyed.key || streetBaseRef.current !== keyed.flow) {
            streetLoopRef.current?.stop();
            streetLoopRef.current = null;
            streetKeyRef.current = keyed.key;
            streetBaseRef.current = keyed.flow;
            streetAnimRef.current = {
                ...keyed.flow,
                u: keyed.flow.u.slice(),
                v: keyed.flow.v.slice(),
                omega: keyed.flow.omega.slice(),
            };
            setStreetTick((t) => t + 1);
        }
        if (streetLoopRef.current === null) {
            const strouhal = keyed.strouhal;
            if (strouhal === null || !Number.isFinite(strouhal) || !(strouhal > 0)) return;
            const refLen = Number.isFinite(debouncedSpec.chord) && debouncedSpec.chord > 0
                ? debouncedSpec.chord
                : 1;
            const loop = new StreetLoop({
                strouhal,
                referenceLength: refLen,
                speed: 1,
                onFrame: (phase) => {
                    const base = streetBaseRef.current;
                    const anim = streetAnimRef.current;
                    if (base === null || anim === null) return;
                    try {
                        reconstructAtPhase(base, phase, anim);
                    } catch {
                        // A bad phase never blanks the last good frame.
                    }
                    setStreetTick((t) => t + 1);
                },
            });
            streetLoopRef.current = loop;
            loop.start(0);
        }
    }, [streetActive, neuralV3Keyed, debouncedSpec.chord]);

    // Unmount stops the street loop without touching the clock phase.
    useEffect(() => () => {
        streetLoopRef.current?.stop();
        streetLoopRef.current = null;
    }, []);

    // Animated display field. A fresh wrapper identity per street tick
    // drives the canvas repaint, while the u and v arrays stay the same
    // reconstructed buffers the particles advect on. The mean toggle
    // bypasses the animation and shows the served mean arrays.
    const streetDisplay = useMemo(() => {
        if (!streetActive || neuralV3Keyed === null) return null;
        if (prefs.meanFields) return null;
        const anim = streetAnimRef.current;
        if (anim === null) return null;
        return { ...anim };
    }, [streetTick, streetActive, neuralV3Keyed, prefs.meanFields]);

    const neuralV3Solved: SolvedFrame | null = neuralV3Keyed !== null
        ? {
            flow: streetDisplay ?? neuralV3Keyed.flow,
            polygons: buildPolygons(debouncedSpec),
            cl: neuralV3Keyed.cl,
            cpMin: neuralV3Keyed.cpMin,
            solveMs: neuralV3Keyed.solveMs,
            provenance: {
                source: "surrogate",
                label: neuralV3Keyed.harmonicValid
                    ? neuralPhaseAveragedLabel({
                        strouhal: neuralV3Keyed.strouhal ?? undefined,
                        explained: neuralV3Keyed.explained ?? undefined,
                        weightsVersion: neuralV3Keyed.weightsVersion,
                        latencyMs: neuralV3Keyed.latencyMs,
                    })
                    : neuralSteadyLabel(
                        neuralV3Keyed.harmonicInvalidReason ?? "no valid shedding",
                        neuralV3Keyed.weightsVersion,
                    ),
                generatedAt: new Date().toISOString(),
                gridLabel: "128x128",
                geometryLabel: `${debouncedSpec.kind} a${debouncedSpec.alphaDeg}`,
                note: "Neural v3 prediction, not validated physics.",
            },
        }
        : null;
    // Frame selector: agent-first collapses to the solved analytic frame
    // always, so no worker snapshot, fixture preview, or neural overlay can
    // serve. Legacy mode keeps fixture debug preview, then LBM, then v3
    // neural keyed, then v2 neural keyed, then analytic. Analytic always
    // solves first, neural overlays when its key matches. v3 wins over v2.
    const fixtureSolved: SolvedFrame | null = isFixture && pack !== null
        ? {
            flow: pack.flow,
            polygons: [pack.airfoilPoints],
            cl: Number.NaN,
            cpMin: Number.NaN,
            solveMs: 0,
            provenance: pack.provenance,
        }
        : null;
    const frame = agentFirst.agentFirst ? solved.frame : (fixtureSolved ?? lbmSolved ?? neuralV3Solved ?? neuralSolved ?? solved.frame);
    const solveError = agentFirst.agentFirst ? solved.error : isFixture ? null : lbmEffective ? null : solved.error;
    const isNeuralActive = !agentFirst.agentFirst && neuralSolved !== null && solveError === null;
    const isNeuralPending = !agentFirst.agentFirst && neuralStatus === "loading" && fastDecision.path === "neural-v2" && neuralSolved === null;
    const isNeuralV3Active = !agentFirst.agentFirst && neuralV3Solved !== null && solveError === null;
    const isNeuralV3Pending = !agentFirst.agentFirst && neuralV3Status === "loading" && fastDecision.path === "neural-v3" && neuralV3Solved === null;
    const flow = frame.flow;
    const airfoil = frame.polygons;
    const solverPath: SolverPath = agentFirst.agentFirst ? "analytic" : neuralV3Keyed !== null ? "neural-v3" : neuralKeyed !== null ? "neural-v2" : "analytic";    const neuralNote = neuralStatus === "ready" && neuralKeyed !== null
        ? `weights ${neuralKeyed.weightsVersion}, ${neuralKeyed.latencyMs.toFixed(1)} ms${neuralKeyed.cached ? ", cached" : ""}`
        : neuralStatus === "loading"
            ? "weights still loading"
            : neuralStatus === "failed"
                ? "weights failed to load"
                : "weights unavailable";
    // Panel neural line follows the active fast path: v3 note while the
    // router holds neural-v3, v2 note otherwise.
    const neuralV3Note = neuralV3Status === "ready" && neuralV3Keyed !== null
        ? `weights ${neuralV3Keyed.weightsVersion}, ${neuralV3Keyed.latencyMs.toFixed(1)} ms${neuralV3Keyed.cached ? ", cached" : ""}`
        : neuralV3Status === "loading"
            ? "weights still loading"
            : neuralV3Status === "failed"
                ? "weights failed to load"
                : "weights unavailable";
    // P1 agent-first: the SIMULATION panel no longer shows a solver path or
    // neural line, so the panel specific status alias is gone. The snapshot
    // and provenance label below still read neural state directly.
    const provenanceLabel = selectProvenanceLabel({
        isFixture,
        fixtureLabel: isFixture && fixtureSolved !== null ? fixtureSolved.provenance.label : null,
        lbmEffective,
        lbmLabel: lbmEffective && lbmSolved !== null ? lbmSolved.provenance.label : null,
        solveError,
        isHeldAnalyticFrame: solveError !== null && !isFixture && !lbmEffective && frame === solved.frame,
        frameGeometryLabel: frame.provenance.geometryLabel,
        frameGridLabel: frame.provenance.gridLabel,
        frameLabel: frame.provenance.label,
    });
    const dotClass =
        solveError !== null ? "failed"
        : lbmFailedActive ? "fallback"
        : lbmEffective && !lbmHasSnapshot ? "pending"
        : lbmEffective ? "analytic"
        : isNeuralV3Pending ? "pending"
        : isNeuralV3Active ? "surrogate"
        : isNeuralPending ? "pending"
        : isNeuralActive ? "surrogate"
        : isFixture ? "fixture"
        : "analytic";
    const backendName = agentFirst.agentFirst
        ? selectBackendName({
            isFixture: false,
            lbmFailedActive: false,
            lbmEffective: false,
            lbmHasSnapshot: false,
            solveError,
            isNeuralPending: false,
            isNeuralActive: false,
            isNeuralV3Pending: false,
            isNeuralV3Active: false,
            solveGridNx: solveGrid.nx,
        })
        : selectBackendName({
        isFixture,
        lbmFailedActive,
        lbmEffective,
        lbmHasSnapshot,
        solveError,
        isNeuralPending,
        isNeuralActive,
        isNeuralV3Pending,
        isNeuralV3Active,
        solveGridNx: solveGrid.nx,
    });
    // Status problems previously fed the removed status bar. The
    // validation ledger still owns its counts through valSummary.
    void lbmStatus;
    void dotClass;
    const regime = regimeLabel(debouncedRe);
    const alphaNote = alphaOutOfBandNote(debouncedSpec.alphaDeg);
    const boundaryKey = `${debouncedSpec.kind}|a${debouncedSpec.alphaDeg}|Re${debouncedRe}|${solverPath}|${flow.nx}x${flow.ny}|${lbmTick}|${neuralKey}|${neuralV3Key}`;

    // Honest gating: TKE and recirculation chips enable only when the live
    // frame actually carries the channel and the first statistics sample
    // exists. The worker always ships the channels (all zero before the
    // first sampled step), so the channel alone never enables them.
    // Placeholder and failover states never enable them.
    const lbmStatsReady = lbmEffective && (lbmProviderLive?.statsReady() ?? false);
    const hasTke = lbmEffective && lbmHasSnapshot && lbmStatsReady && flow.k !== undefined;
    const hasRecirc = lbmEffective && lbmHasSnapshot && lbmStatsReady && flow.recirc !== undefined;
    const lbmStats = lbmStatsReady ? (lbmProviderLive?.stats() ?? null) : null;

    // Effective field variable plus effective overlays, derived during
    // render: a selected channel the current frame does not carry paints
    // speed on this very pass, and each field ships its overlay default.
    // The stored preference stays untouched, so returning to LBM mode
    // restores the user's choice. Manual overlay toggles pin until the
    // field changes again.
    const effectiveVariable = fallbackVariableFor(prefs.variable, flow);
    const effectiveOverlays = resolveOverlays(effectiveVariable, prefs);

    // P2 visual coupling: Re scale (log, clamped) times the explicit
    // velocity multiplier. Display only, never physics.
    const advectionScale = useMemo(
        () => combineVelocity(advectionScaleForRe(debouncedRe), velocity),
        [debouncedRe, velocity]
    );

    // LBM run controls. Run starts the worker loop, Cancel latches the
    // current state and keeps the last snapshot on screen. Run first passes
    // the pre-flight gate: a hard block never starts the worker and lands
    // in the notice stack plus the run log, warnings allow Run with a note.
    const onLbmRun = useCallback((): LbmRunOutcome => {
        try {
            const gate = preflightLbm(
                debouncedSpec,
                { nx: lbmGrid.nx, ny: lbmGrid.ny, domain: { ...DEFAULT_DOMAIN } },
                lbmULattice,
                debouncedRe
            );
            if (!gate.ok) {
                const reason = gate.blockReasons.join(" ");
                setLbmNotice(reason);
                appendRunLog({ step: lbmProgressRef.current.step, message: `Run blocked: ${reason}`, level: "block" });
                return "blocked";
            }
            if (gate.warnings.length > 0) {
                const note = gate.warnings.join(" ");
                setLbmNotice(note);
                appendRunLog({ step: lbmProgressRef.current.step, message: note, level: "warn" });
            }
            lbmClientRef.current?.run();
            return "started";
        } catch {
            // Run must never throw out of the button handler.
            return "blocked";
        }
    }, [debouncedSpec, lbmGrid.nx, lbmGrid.ny, lbmULattice, debouncedRe, appendRunLog]);
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
    // P4 teaching caption: deterministic tutor line from the latest snapshot
    // via the offline localTutorReply template, no chat history needed. The
    // cap helper keeps it to 240 chars ending with the provenance family
    // caveat, and fixture mode carries no caption so the sheet cannot quote
    // stale words.
    const exportData = useMemo<ExportData>(() => {
        let tutorCaption = "";
        try {
            if (!isFixture) {
                const finiteOrNull = (v: unknown): number | null =>
                    typeof v === "number" && Number.isFinite(v) ? v : null;
                const fieldToken = typeof prefs.variable === "string" && prefs.variable.trim().length > 0
                    ? prefs.variable.trim()
                    : "speed";
                const snap = {
                    caseKey: `${debouncedSpec.kind}|a${debouncedSpec.alphaDeg}|Re${debouncedRe}|${provenanceLabel}|f${fieldToken}`,
                    bodyLabel: specLabelFor(debouncedSpec),
                    alpha: finiteOrNull(debouncedSpec.alphaDeg),
                    reynolds: finiteOrNull(debouncedRe),
                    cl: finiteOrNull(frame.cl),
                    cpMin: finiteOrNull(frame.cpMin),
                    regime,
                    pathLabel: provenanceLabel,
                    strouhal: null as number | null,
                };
                tutorCaption = capTutorCaption(localTutorReply(snap, snap), provenanceLabel);
            }
        } catch {
            tutorCaption = "";
        }
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
            tutorCaption,
        };
        return buildAppExportData(base, isFixture, isFixture && pack ? pack.provenance : null);
    }, [debouncedSpec, debouncedRe, regime, frame, backendName, provenanceLabel, flow, valSummary, isFixture, pack, prefs.variable]);

    // Single field funnel: a chip click recouple the overlays to the next
    // field default and clears any pin, so stale manual flags never leak
    // across fields.
    const onVariable = (next: typeof prefs.variable) => patch(overlayPatchForFieldChange(next));
    const handlePatch = useCallback((next: Partial<typeof prefs>) => {        patch({ ...next, theme: "dark" });
    }, [patch]);
    const handleCloseSettings = useCallback(() => {
        setSettingsOpen(false);
    }, []);

    // Solver bar BODY select. NACA presets set exact m, p, t triples, other
    // kinds follow the same object rules FlowControls.setKind uses. A NACA
    // section tuned by sliders falls back to the 2412 slot in the select.
    const bodySelectValue = bodySelectValueFor(spec);
    const onAlphaBar = (next: number) => {
        if (!Number.isFinite(next)) return;
        setSpec((s) => ({ ...s, alphaDeg: Math.min(ALPHA_HARD_MAX, Math.max(ALPHA_HARD_MIN, next)) }));
    };
    /** P3 sweep immediate apply: bypasses the 120 ms canvas debounce by
     *  writing both spec and debouncedSpec in the same tick, so each
     *  intermediate alpha paints in order. Orifice gate: the plate has no
     *  angle of attack (alpha invariant 0), so sweep applies refuse any
     *  alpha write and leave the canvas unchanged. Never throws. */
    const applySweepAlpha = useCallback((next: number): void => {
        try {
            if (!Number.isFinite(next)) return;
            const clamped = Math.min(ALPHA_HARD_MAX, Math.max(ALPHA_HARD_MIN, next));
            let refused = false;
            setSpec((s) => {
                try {
                    if ((s as { kind?: unknown }).kind === "orifice") {
                        refused = true;
                        return s;
                    }
                } catch {
                    refused = true;
                    return s;
                }
                if (s.alphaDeg === clamped) return s;
                return { ...s, alphaDeg: clamped };
            });
            if (refused) return;
            setDebouncedSpec((s) => {
                try {
                    if ((s as { kind?: unknown }).kind === "orifice") return s;
                } catch {
                    return s;
                }
                if (s.alphaDeg === clamped) return s;
                return { ...s, alphaDeg: clamped };
            });
        } catch {
            // Sweep applies never break the canvas.
        }
    }, []);
    const commitReynolds = useCallback((raw: unknown) => {
        // Single Re funnel: every committable value (clamp, LBM cap, LES band)
        // surfaces its note in the notice stack, the capped flag stays for
        // callers that still branch on the ceiling.
        const commit = commitReynoldsValue(raw, lbmActive, reynolds);
        if (commit.notice !== null) setLbmNotice(commit.notice);
        setReynolds(commit.reynolds);
    }, [lbmActive, reynolds]);
    const onReynoldsBar = (next: number | string) => {
        commitReynolds(next);
    };

    // Phase B2 agent executor. Setup actions apply directly through the
    // existing setters. Run and cancel reuse the LBM buttons, whose confirm
    // and disabled states already live in the scene bar UI.
    // Narrowed: set_engine accepts analytic or lbm only. Surrogate and wasm
    // tokens are rejected with this pointer copy (see ENGINE_TOKENS in
    // agent/agentActions.ts for the full envelope list).
    // P1 agent-first defense in depth: the executor rechecks every action
    // through agentFirstRejectionFor, so a non-analytic engine, an LBM run
    // or cancel, or a gated k/recirc field lands in gated with the honest
    // analytic-only reason even if it bypassed the envelope validator.
    // Trusted setup presets expand atomically through expandCasePreset and
    // apply the returned primitives directly (never re-validated through
    // the per-action envelope Re floor). Geometry, Re, and field flow
    // through the same funnels as the bars (onVariable recouple the
    // overlays), and presets never arm LBM. Canvas plus sim settings update
    // on the next render from state. A failed preset surfaces its reason to
    // the console instead of silently doing nothing.
    // Phase T2: returns an ApplyReceipt (additive, behavior unchanged).
    // Gated set_field and rejected engine tokens land in gated, everything
    // that writes canvas state lands in applied.
    const applyAgentAction = useCallback((action: AgentAction): ApplyReceipt => {
        const finish = (applied: AgentAction[], gated: string[]): ApplyReceipt => ({
            applied,
            gated,
            summary: describeApplyReceipt(applied, gated),
        });
        // Body selector tabs: every agent write routes through tab activation
        // so the active body tab owns the new case. Setup presets activate
        // their body tab first, primitives write onto the active tab memory.
        // The activation plus the spec commit below are atomic: the target
        // id is stamped into agentTabCommitRef so the one-shot tab load
        // effect mirrors the agent spec forward instead of loading the
        // stale stored memory over it.
        const ensureBodyTab = (body: string): void => {
            try {
                const provisional = applyBodyPreset(spec, body);
                const id = bodyTabIdForSpec(provisional);
                if (id !== caseTabs.activeId) {
                    agentTabCommitRef.current = id;
                    caseTabs.activate(id);
                }
            } catch {
                // Activation faults never break the executor.
            }
        };
        if (agentFirst.agentFirst) {
            const blocked = agentFirstRejectionFor(action);
            if (blocked !== null) return finish([], [blocked]);
        }
        // Phase 25C theory nav: open_theory names a Theory anchor and shows
        // the companion page. No canvas writes, no tab work, no solver touch.
        if (action.kind === "open_theory") {
            try {
                const topic = (action as { topic?: unknown }).topic;
                if (typeof topic === "string" && topic.length > 0) openTheory(topic);
                else setActiveNav("theory");
            } catch {
                // Nav faults never break the executor.
            }
            return finish([action], []);
        }
        if (action.kind === "setup_shedding" || action.kind === "setup_high_pressure" || action.kind === "setup_high_re_wake" || action.kind === "setup_airfoil") {
            if (action.kind === "setup_shedding") ensureBodyTab("cylinder");
            else if (action.kind === "setup_high_re_wake") ensureBodyTab("cylinder");
            else if (action.kind === "setup_airfoil") {
                const b = typeof action.body === "string" ? action.body : "naca2412";
                ensureBodyTab(b);
            }
            const request = action.kind === "setup_shedding"
                ? { preset: "shedding" as const }
                : action.kind === "setup_high_pressure"
                    ? { preset: "high_pressure" as const, body: action.body }
                    : action.kind === "setup_high_re_wake"
                        ? { preset: "high_re_wake" as const }
                        : { preset: "airfoil" as const, body: action.body, alphaDeg: action.alphaDeg };
            const expanded = expandCasePreset(request, { agentFirst: agentFirst.agentFirst });
            if (!expanded.ok) {
                const reason = expanded.reason ?? "unknown reason";
                console.warn(`setup preset rejected: ${reason}`);
                return finish([], [`setup preset rejected: ${reason}`]);
            }
            const applied: AgentAction[] = [];
            const gated: string[] = [];
            for (const prim of expanded.actions) {
                if (agentFirst.agentFirst) {
                    const blocked = agentFirstRejectionFor(prim);
                    if (blocked !== null) {
                        gated.push(blocked);
                        continue;
                    }
                }
                if (prim.kind === "set_body") {
                    const next = applyBodyPreset(spec, prim.body);
                    if (next !== spec) setSpec(next);
                    applied.push(prim);
                } else if (prim.kind === "set_alpha") {
                    onAlphaBar(prim.alphaDeg);
                    applied.push(prim);
                } else if (prim.kind === "set_reynolds") {
                    onReynoldsBar(prim.reynolds);
                    applied.push(prim);
                } else if (prim.kind === "set_field") {
                    if (prim.field === "k" && !hasTke) {
                        gated.push("set_field k gated until the first LBM statistics sample");
                        continue;
                    }
                    if (prim.field === "recirc" && !hasRecirc) {
                        gated.push("set_field recirc gated until the first LBM statistics sample");
                        continue;
                    }
                    onVariable(prim.field);
                    applied.push(prim);
                }
            }
            return finish(applied, gated);
        }
        if (action.kind === "set_body") {
            ensureBodyTab(action.body);
            const next = applyBodyPreset(spec, action.body);
            if (next !== spec) setSpec(next);
            return finish([action], []);
        }
        if (action.kind === "set_alpha") {
            onAlphaBar(action.alphaDeg);
            return finish([action], []);
        }
        if (action.kind === "set_reynolds") {
            onReynoldsBar(action.reynolds);
            return finish([action], []);
        }
        if (action.kind === "set_engine") {
            if (action.engine === "analytic") {
                setLbmArmedAndMirror(false);
                return finish([action], []);
            } else if (action.engine === "lbm") {
                setLbmArmedAndMirror(true);
                return finish([action], []);
            } else {
                return finish([], [`set_engine ${action.engine} needs engine in [analytic, lbm]`]);
            }
        }
        if (action.kind === "set_field") {
            if (action.field === "k" && !hasTke) return finish([], ["set_field k gated until the first LBM statistics sample"]);
            if (action.field === "recirc" && !hasRecirc) return finish([], ["set_field recirc gated until the first LBM statistics sample"]);
            onVariable(action.field);
            return finish([action], []);
        }
        if (action.kind === "run_lbm") {
            const outcome = onLbmRun();
            if (outcome === "blocked") {
                return receiptForLbmRun(action, "blocked");
            }
            return receiptForLbmRun(action, "started");
        }
        if (action.kind === "cancel_lbm") {
            onLbmCancel();
            return finish([action], []);
        }
        if (action.kind === "set_spec") {
            applyParametric(action.spec);
            return finish([action], []);
        }
        return finish([], ["unknown action kind, canvas unchanged"]);
    }, [agentFirst, spec, hasTke, hasRecirc, onAlphaBar, onReynoldsBar, onVariable, onLbmRun, onLbmCancel, setLbmArmedAndMirror, applyParametric, caseTabs, openTheory]);

    // Telemetry engine word. Short uppercase token for the status strip.
    // v3 names first: the v3 street is tried before v2. Agent-first pins
    // ANALYTIC so telemetry and export stay on the analytic label.
    const engineLabel = agentFirst.agentFirst
        ? "ANALYTIC"
        : lbmFailedActive
        ? "ANALYTIC-FB"
        : lbmEffective
            ? "LBM"
            : isFixture
                ? "FIXTURE"
                : solveError !== null
                    ? "HELD"
                    : isNeuralV3Pending || isNeuralPending
                        ? "LOADING"
                        : isNeuralV3Active
                            ? "NEURAL-V3"
                            : isNeuralActive
                                ? "NEURAL-V2"
                                : "ANALYTIC";
    const nacaCode = spec.kind === "naca4" && typeof spec.naca?.code === "string" && /^\d{4}$/.test(spec.naca.code)
        ? spec.naca.code
        : null;
    const bodyRowLabel = nacaCode !== null
        ? `NACA ${nacaCode}`
        : bodySelectValue === "naca0012"
            ? "NACA 0012"
            : bodySelectValue === "naca2412"
                ? "NACA 2412"
                : bodySelectValue === "naca4412"
                    ? "NACA 4412"
                    : bodySelectValue === "block"
                        ? "Rectangle"
                        : bodySelectValue.toUpperCase();

    // P3 live what-if sweep stepper. Analytic only, zero network: solves
    // one alpha on a throwaway AnalyticFlowProvider with the live geometry
    // plus Re, mirroring the displayed analytic frame. Faults land as n/a
    // cells, never throw. The console morphs the canvas separately through
    // the set_alpha executor, this stepper only supplies the numbers.
    const whatIfSweepStep = useCallback(async (alphaDeg: number): Promise<{ cl: number | null; cpMin: number | null; solveMs: number | null }> => {
        try {
            const stepped = { ...debouncedSpec, alphaDeg };
            const provider = new AnalyticFlowProvider(solveGrid, stepped, { Re: debouncedRe });
            const res = provider.getResult();
            const cl = typeof res.cl === "number" && Number.isFinite(res.cl) ? res.cl : null;
            const cpMin = typeof res.cpMin === "number" && Number.isFinite(res.cpMin) ? res.cpMin : null;
            const solveMs = typeof res.solveMs === "number" && Number.isFinite(res.solveMs) ? res.solveMs : null;
            return { cl, cpMin, solveMs };
        } catch {
            return { cl: null, cpMin: null, solveMs: null };
        }
    }, [debouncedSpec, debouncedRe, solveGrid]);

    // Phase B2 agent snapshot. Built from solved state only, no new data
    // plumbing. Passed as props toward AgentConsole, no styling here.
    // Neural availability mirrors the served neural frame, the envelope
    // summary quotes the provisional envelope, and the displayed path names
    // the solver path actually rendered this frame.
    // Phase T2: the snapshot also carries the stable caseKey (kind, body,
    // alpha, rounded Re, solver path, displayed field), the settled
    // flag, the neural scalars (strouhal, explained, validityProbability,
    // harmonic reason), and the analytic baseline Cl/CpMin plus deltas for
    // the tutor before vs after table. All additive, all finite guarded
    // downstream by buildAgentContext.
    const agentSnapshot: AppSnapshot = useMemo(() => {
        const caseKey = `${debouncedSpec.kind}|${nacaCode ?? bodySelectValue}|a${debouncedSpec.alphaDeg}|Re${Math.round(debouncedRe)}|${solverPath}|f${effectiveVariable}`;
        const settled = isFixture
            ? true
            : solveError !== null
                ? false
                : lbmEffective
                    ? lbmHasSnapshot
                    : isNeuralV3Pending || isNeuralPending
                        ? false
                        : true;
        const analyticCl = solved.frame.cl;
        const analyticCpMin = solved.frame.cpMin;
        const liveCl = frame.cl;
        const liveCp = frame.cpMin;
        const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
        const aCl = finite(analyticCl);
        const aCp = finite(analyticCpMin);
        const lCl = finite(liveCl);
        const lCp = finite(liveCp);
        const strouhal = neuralV3Keyed?.strouhal ?? lbmStats?.strouhal ?? null;
        const explained = neuralV3Keyed?.explained ?? null;
        const harmonicValid = neuralV3Keyed?.harmonicValid ?? null;
        const harmonicInvalidReason = neuralV3Keyed?.harmonicInvalidReason ?? null;
        const validityProbability = typeof flow.validityProbability === "number" && Number.isFinite(flow.validityProbability) && flow.validityProbability >= 0 && flow.validityProbability <= 1
            ? flow.validityProbability
            : null;
        return {
        spec: debouncedSpec,
        reynolds: debouncedRe,
        regime,
        bodyLabel: bodyRowLabel,
        backend: backendName,
        engine: agentFirst.agentFirst ? "analytic" : lbmArmed ? "lbm" : "analytic",
        gridLabel: `${flow.nx}x${flow.ny}`,
        cl: frame.cl,
        cpMin: frame.cpMin,
        lbmStatus,
        lbmHasSnapshot,
        lbmEffective,
        lbmStatsReady,
        lbmStats,
        agentFirst: agentFirst.agentFirst,
        variable: prefs.variable,
        effectiveVariable,
        hasTke,
        hasRecirc,
        validation: { pass: valSummary.pass, warn: valSummary.warn, fail: valSummary.fail, info: valSummary.info },
        provenanceLabel,
        offline,
        neuralAvailable: isNeuralActive || isNeuralV3Active,
        neuralEnvelopeSummary: `provisional neural envelope [${PROVISIONAL_NEURAL_ENVELOPE.kinds.join(", ")}], alpha [${PROVISIONAL_NEURAL_ENVELOPE.alphaMin}, ${PROVISIONAL_NEURAL_ENVELOPE.alphaMax}], Re [${PROVISIONAL_NEURAL_ENVELOPE.reMin}, ${PROVISIONAL_NEURAL_ENVELOPE.reMax}], ${PROVISIONAL_NEURAL_ENVELOPE.note}`,
        displayedPath: solverPath,
        caseKey,
        frameSettled: settled,
        surrogate: {
            path: solverPath,
            honestyState: neuralV3Keyed !== null
                ? neuralV3Keyed.harmonicValid ? "phase-averaged" : "steady"
                : solverPath,
            weightsVersion: neuralV3Keyed?.weightsVersion ?? "weights pending",
            runId: null,
            latencyMs: neuralV3Keyed?.latencyMs ?? null,
            inDomain: domainVerdict.inDomain,
            domainReason: domainVerdict.reason,
            strouhal,
            explained,
            harmonicValid: typeof harmonicValid === "boolean" ? harmonicValid : null,
            harmonicInvalidReason: typeof harmonicInvalidReason === "string" ? harmonicInvalidReason : null,
            validityProbability,
            recircFraction: lbmStats?.recircFraction ?? null,
            tkePeak: null,
            vorticityPeak: null,
            analyticCl: aCl,
            analyticCpMin: aCp,
            deltaClVsAnalytic: aCl !== null && lCl !== null ? lCl - aCl : null,
            deltaCpMinVsAnalytic: aCp !== null && lCp !== null ? lCp - aCp : null,
        },
        };
    }, [agentFirst, debouncedSpec, debouncedRe, regime, bodyRowLabel, backendName, lbmArmed, flow, frame, lbmStatus, lbmHasSnapshot, lbmEffective, lbmStatsReady, lbmStats, prefs.variable, effectiveVariable, hasTke, hasRecirc, valSummary, provenanceLabel, offline, isNeuralActive, isNeuralV3Active, solverPath, nacaCode, bodySelectValue, solveError, isFixture, isNeuralPending, isNeuralV3Pending, neuralV3Keyed, domainVerdict, solved]);
    const agentContextValue = useMemo(() => buildAgentContext(agentSnapshot), [agentSnapshot]);

    return (
        <div className="page idePage">
            <a className="skip" href={activeNav === "theory" ? "#theory" : "#tunnel"}>{activeNav === "theory" ? "Skip to theory content" : "Skip to flow canvas"}</a>
            <TopNav
                active={activeNav}
                onNav={handleNav}
                settingsOpen={settingsOpen}
                onOpenSettings={() => setSettingsOpen(true)}
                focusMode={layoutPrefs.focusMode}
                onToggleFocus={toggleFocus}
            />

            <main id="flow" className={theoryMode ? "layout workbench ideWorkbench theoryMode" : "layout workbench ideWorkbench"}>
                <RailShell
                    side="left"
                    label="Agent console: conversational assistant"
                    region="agent console"
                    bladeLabel="AGENT"
                    bodyId="railLeftBody"
                    collapsed={shell.left}
                    onToggle={toggleLeft}
                    width={theoryMode ? Math.min(480, Math.max(280, Math.round(((typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 1200) / 3)))) : leftW}
                >
                    <div className="railHead">
                        <span className="railTitle">AGENT CONSOLE</span>
                        {debugPanels && (
                            <>
                                <span className={offline ? "dot off" : "dot on"} aria-hidden="true" />
                                <span className="mono railState">{offline ? "OFFLINE" : "LIVE"}</span>
                            </>
                        )}
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
                                onWhatIfSweep={whatIfSweepStep}
                                onSweepAlpha={applySweepAlpha}
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

                <section className="tunnelCol ideEditor" aria-label="Editor and tunnel window" style={theoryMode ? { flex: "2 1 0%", minWidth: 0 } : undefined}>
                    {theoryMode ? (
                        <TheoryPage topic={theoryTopic} topicNonce={theoryNonce} />
                    ) : (
                    <>
                    <SceneBars
                        bodyId="sceneBars"
                        collapsed={shell.bars}
                        summary={`${effectiveVariable.toUpperCase()} . ${engineLabel} . Re ${Math.round(debouncedRe).toLocaleString("en-US")}`}
                        onToggle={toggleBars}
                    >
                        <EditorTabs tabs={caseTabs.tabs} activeId={caseTabs.activeId} onActivate={caseTabs.activate} />
                        <FieldBar
                            variable={effectiveVariable}
                            onVariable={onVariable}
                            hasTke={hasTke}
                            hasRecirc={hasRecirc}
                            overlays={effectiveOverlays}
                            agentFirst={agentFirst.agentFirst}
                        />
                    </SceneBars>
                    <div className="tunnel" id="tunnel">
                        {layoutPrefs.focusMode && (
                            <button
                                type="button"
                                className="focusExit"
                                onClick={toggleFocus}
                                aria-label="Exit full screen mode and restore panels"
                            >
                                EXIT FULL SCREEN
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
                                showParticles={prefs.showParticles}
                                particleColor={prefs.particleColor}
                                particleSize={prefs.particleSize}
                                showContours={effectiveOverlays.contours}
                                showStreamlines={effectiveOverlays.showStreamlines}
                                streamlineColormap={prefs.colormap}
                                advectionScale={advectionScale}
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
                            {packError && fixtureDebug && <p className="error notice" role="alert">{packError}</p>}
                            {packLoading && fixtureDebug && !pack && <p className="loading notice" role="status">Loading fixture pack</p>}
                            {!agentFirst.agentFirst && isNeuralV3Pending && (
                                <p className="loading notice" role="status">Neural v3 weights loading, showing analytic meanwhile. No action needed.</p>
                            )}
                            {!agentFirst.agentFirst && neuralV3Status === "failed" && (
                                <p className="fallbackNote notice" role="status">Neural v3 weights failed to load, analytic fallback active.</p>
                            )}
                            {!agentFirst.agentFirst && neuralV3Status === "unavailable" && fastDecision.path === "analytic" && (
                                <p className="fallbackNote notice" role="status">{fastDecision.reason}, analytic fallback active.</p>
                            )}
                            {gridState.notice !== null && (
                                <p className="fallbackNote notice" role="status">
                                    {gridState.notice}
                                    <button type="button" className="noticeDismiss" onClick={clearNotice} aria-label="Dismiss resolution notice">Dismiss</button>
                                </p>
                            )}
                            {solveError !== null && !isFixture && (
                                <p className="error solveError notice" role="alert">
                                    Analytic solve failed ({solveError}), showing last good field. Adjust the shape controls to recover.
                                </p>
                            )}
                            {alphaNote !== null && !isFixture && solveError === null && (
                                <p className="reNote notice" role="status">{alphaNote}</p>
                            )}
                        </div>
                        <div className="runCard" aria-label="Run summary">
                            <p className="runTitle">RUN</p>
                            <dl className="runRows">
                                <div className="runRow"><dt>BODY</dt><dd className="mono">{bodyRowLabel}</dd></div>
                                <div className="runRow"><dt>ALPHA</dt><dd className="mono">{spec.alphaDeg.toFixed(1)} deg</dd></div>
                                <div className="runRow"><dt>RE</dt><dd className="mono">{Math.round(debouncedRe).toLocaleString("en-US")}</dd></div>
                                <div className="runRow"><dt>CL</dt><dd className="mono">{Number.isFinite(frame.cl) ? frame.cl.toFixed(3) : "n/a"}</dd></div>
                                <div className="runRow"><dt>CPMIN</dt><dd className="mono">{Number.isFinite(frame.cpMin) ? frame.cpMin.toFixed(3) : "n/a"}</dd></div>
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
                    </>
                    )}
                </section>

                {/* Right analysis rail: SIMULATION (live Re slider plus
                    number) plus GEOMETRY (live spec: AoA slider, NACA
                    thickness and camber, cylinder radius, rectangle dims,
                    orifice gap and plate). Sections read the live spec and
                    Re so an agent case setup paints immediately, the 120 ms
                    debounced copies serve the solver only. GeometrySection
                    filters its own fields per body kind, so only the
                    matching controls render. Hidden in theory mode, where
                    the companion page owns the center column. */}
                {!theoryMode && !shell.right && (
                    <ResizeHandle
                        id="gripAnalysis"
                        label="Resize analysis rail, left and right arrows adjust width"
                        onNudge={(d) => setRightW((w) => clamp(d > 9000 ? RIGHT_MAX : d < -9000 ? RIGHT_MIN : w + d, RIGHT_MIN, RIGHT_MAX))}
                        onDrag={(d) => setRightW((w) => clamp(w + d, RIGHT_MIN, RIGHT_MAX))}
                    />
                )}
                {!theoryMode && (
                    <RailShell
                        side="right"
                        label="Analysis: simulation plus geometry controls"
                        region="analysis"
                        bladeLabel="ANALYSIS"
                        bodyId="analysisBody"
                        collapsed={shell.right}
                        onToggle={toggleRight}
                        width={rightW}
                    >
                        <div className="railHead">
                            <span className="railTitle">ANALYSIS</span>
                        </div>
                        <div className="analysisPanel">
                            <div className="analysisScroll">
                                <section className="asec" aria-label="Simulation controls">
                                    <div className="railHead">
                                        <span className="railTitle">SIMULATION</span>
                                    </div>
                                    <div className="asecBody">
                                        <SimulationSection
                                            agentFirst={agentFirst.agentFirst}
                                            bodyLabel={bodyRowLabel}
                                            alphaDeg={spec.alphaDeg}
                                            reynolds={reynolds}
                                            cl={frame.cl}
                                            regime={regimeLabel(reynolds)}
                                            lbmActive={lbmActive}
                                            onCommitReynolds={onReynoldsBar}
                                            lbmULattice={lbmULattice}
                                            onLbmULattice={setLbmULattice}
                                            lbmTargetSteps={lbmTargetSteps}
                                            onLbmTargetSteps={setLbmTargetSteps}
                                            lbmLesAuto={lbmLesAuto}
                                            onLbmLesAuto={setLbmLesAuto}
                                            lbmLesManual={lbmLesManual}
                                            onLbmLesManual={setLbmLesManual}
                                            lbmStatus={lbmStatus}
                                            lbmProgressText={lbmProgressText}
                                            onLbmRun={onLbmRun}
                                            onLbmCancel={onLbmCancel}
                                            preflightWarnings={simPreflightWarnings}
                                            lbmNotice={lbmNotice}
                                            onDismissLbmNotice={onLbmDismissNotice}
                                            lbmFailed={lbmFailed}
                                            onLbmRecover={onLbmRecoverRe}
                                        />
                                    </div>
                                </section>
                                <section className="asec" aria-label="Geometry controls" data-body={caseTabs.activeId}>
                                    <div className="railHead">
                                        <span className="railTitle">GEOMETRY</span>
                                    </div>
                                    <div className="asecBody">
                                        <GeometrySection
                                            spec={spec}
                                            onSpec={setSpec}
                                            orificeResolutionWarning={orificeResolutionWarning}
                                        />
                                    </div>
                                </section>
                            </div>
                        </div>
                    </RailShell>
                )}
            </main>
            <SettingsModal
                open={settingsOpen}
                onClose={handleCloseSettings}
                prefs={prefs}
                onPatch={handlePatch}
                gridMode={gridState.mode}
                activeGrid={solveGrid.nx}
                customSize={gridState.customSize}
                gridNotice={gridState.notice}
                onGridMode={setGridMode}
                variable={effectiveVariable}
            />
        </div>
    );
}
