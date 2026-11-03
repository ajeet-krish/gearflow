// P3 ruthless simplification removals: one file pins every P3 cut so no
// removed surface drifts back silently. Settings popover with no tint that
// is anchored and patches live, SolverBar plus TelemetryBar unmounted,
// vorticity gone with the velocity chip kept, velocity slider gone with Re
// kept, blockage plus band plus blurb plus eval ledger gone, run card rows
// plus the Transitional Wake label. Static markup plus direct element
// calls plus source reads. No worker threads, no live solves.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import FieldBar, { fallbackVariableFor } from "./FieldBar";
import SettingsModal from "./SettingsModal";
import {
    SimulationSectionView,
    decideReCommit,
    type SimulationSectionViewProps,
} from "./SimulationSection";
import {
    GeometrySectionView,
    type GeometrySectionProps,
} from "./GeometrySection";
import { resolveOverlays } from "./fieldOverlay";
import { DEFAULT_DISPLAY_PREFS, type FieldMode, type GeometrySpec } from "@/contracts/types";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");
const fieldBarPath = resolve(here, "./FieldBar.tsx");
const simPath = resolve(here, "./SimulationSection.tsx");
const geoPath = resolve(here, "./GeometrySection.tsx");
const settingsPath = resolve(here, "./SettingsModal.tsx");
const stylesPath = resolve(here, "../styles.css");

const noop = () => {};

interface TestEl {
    type: unknown;
    props: Record<string, unknown>;
}

function isEl(node: unknown): node is TestEl {
    return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

function walk(node: unknown, visit: (el: TestEl) => void): void {
    if (Array.isArray(node)) {
        for (const child of node) walk(child, visit);
        return;
    }
    if (isEl(node)) {
        visit(node);
        walk(node.props.children, visit);
    }
}

function findButtons(tree: unknown): TestEl[] {
    const out: TestEl[] = [];
    walk(tree, (el) => {
        if (el.type === "button") out.push(el);
    });
    return out;
}

function buttonText(el: TestEl): string {
    const kids = el.props.children;
    if (typeof kids === "string") return kids;
    if (Array.isArray(kids)) return kids.filter((k) => typeof k === "string").join("");
    return "";
}

function clickLabel(tree: unknown, label: string): void {
    const btn = findButtons(tree).find((el) => buttonText(el) === label);
    if (!btn) throw new Error(`missing button ${label}`);
    (btn.props.onClick as () => void)();
}

function renderSettings() {
    return renderToStaticMarkup(
        <SettingsModal
            open={true}
            onClose={noop}
            prefs={DEFAULT_DISPLAY_PREFS}
            onPatch={noop}
            gridMode="512"
            activeGrid={512}
            onGridMode={noop}
            variable="speed"
        />,
    );
}

const NACA_SPEC: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 120,
};

function simProps(over: Partial<SimulationSectionViewProps> = {}): SimulationSectionViewProps {
    return {
        agentFirst: true,
        bodyLabel: "NACA 2412",
        alphaDeg: 6,
        reynolds: 50000,
        cl: 0.412,
        regime: "Transitional Wake",
        lbmActive: false,
        onCommitReynolds: noop,
        reText: "50000",
        onReText: noop,
        rePopup: null,
        onRePopup: noop,
        lbmULattice: 0.05,
        onLbmULattice: noop,
        lbmTargetSteps: 40000,
        onLbmTargetSteps: noop,
        lbmLesAuto: true,
        onLbmLesAuto: noop,
        lbmLesManual: false,
        onLbmLesManual: noop,
        lbmStatus: "idle",
        lbmProgressText: "step 0 of 40000 (0 percent)",
        onLbmRun: noop,
        onLbmCancel: noop,
        preflightWarnings: [],
        lbmNotice: null,
        onDismissLbmNotice: noop,
        lbmFailed: null,
        onLbmRecover: noop,
        ...over,
    };
}

function geoProps(over: Partial<GeometrySectionProps> = {}): GeometrySectionProps {
    return {
        spec: NACA_SPEC,
        onSpec: noop,
        orificeResolutionWarning: null,
        ...over,
    };
}

describe("P3 settings popover: no tint, anchored, live patch", () => {
    it("renders a popover dialog with no dimmed backdrop", () => {
        const html = renderSettings();
        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-modal="false"');
        expect(html).toContain("settingsPopoverWrap");
        expect(html).toContain("settingsPopover");
        expect(html).not.toContain("modalBackdrop");
        expect(html).not.toContain("settingsModal");
    });

    it("anchors under the gear with a transparent click through wrap", async () => {
        const css = await readFile(stylesPath, "utf8");
        expect(css).toContain(".settingsPopoverWrap");
        expect(css).toContain("pointer-events: none");
        expect(css).toContain("background: transparent");
        expect(css).toContain(".settingsPopover");
        expect(css).toContain("top: 64px");
        expect(css).toContain("right: 12px");
        expect(css).not.toContain(".modalBackdrop");
    });

    it("closes on outside mousedown and Escape with focus restore", async () => {
        const src = await readFile(settingsPath, "utf8");
        expect(src).toContain('document.addEventListener("mousedown", onDown)');
        expect(src).toContain("!root.contains(e.target as Node | null)");
        expect(src).toContain('e.key === "Escape"');
        expect(src).toContain("prevFocusRef.current");
        expect(src).toContain('aria-modal="false"');
    });

    it("patches every control live with no Apply step", async () => {
        const src = await readFile(settingsPath, "utf8");
        expect(src).not.toContain("Apply");
        for (const token of [
            "onPatch({ theme:",
            "onPatch({ colormap:",
            "onPatch({ particleCount:",
            "onPatch({ particleSize:",
            "onPatch({ particleColor:",
            "manualPatchForToggle",
            "onPatch({ fieldVisible:",
            "onPatch({ showLegend:",
        ]) {
            expect(src).toContain(token);
        }
        const html = renderSettings();
        expect(html).not.toContain("Apply");
        expect(html).toContain("Theme");
        expect(html).toContain("Colormap");
    });

    it("renders nothing when closed so the canvas stays fully visible", () => {
        const html = renderToStaticMarkup(
            <SettingsModal
                open={false}
                onClose={noop}
                prefs={DEFAULT_DISPLAY_PREFS}
                onPatch={noop}
                gridMode="512"
                activeGrid={512}
                onGridMode={noop}
                variable="speed"
            />,
        );
        expect(html).toBe("");
    });
});

describe("P3 SolverBar plus TelemetryBar unmounted", () => {
    it("mounts no solver or LBM setup bar above the canvas", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toContain("<SolverBar");
        expect(src).not.toContain("<LbmSetupRow");
        expect(src).not.toContain("ui/SolverBar");
    });

    it("unmounts TelemetryBar plus RunTerminal with no terminal state", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toContain("<TelemetryBar");
        expect(src).not.toContain("ui/TelemetryBar");
        expect(src).not.toContain("<RunTerminal");
        expect(src).not.toContain("terminalOpen");
    });

    it("keeps FieldBar inside SceneBars as the single scene bar", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("<SceneBars");
        expect(src).toContain("<FieldBar");
        expect(src).toContain("variable={effectiveVariable}");
    });
});

describe("P3 vorticity gone with the velocity chip kept", () => {
    it("declares VELOCITY plus PRESSURE chips only in the BASE list", async () => {
        const src = await readFile(fieldBarPath, "utf8");
        expect(src).toContain('label: "VELOCITY"');
        expect(src).toContain('label: "PRESSURE"');
        expect(src).not.toContain("VORTICITY");
        expect(src).not.toContain('"omega"');
    });

    it("renders VELOCITY active plus PRESSURE with no VORTICITY in either mode", () => {
        for (const agentFirst of [true, false]) {
            const html = renderToStaticMarkup(
                <FieldBar variable="speed" onVariable={noop} hasTke={true} hasRecirc={true} agentFirst={agentFirst} />,
            );
            expect(html).toContain("VELOCITY");
            expect(html).toContain("PRESSURE");
            expect(html).toContain("chip active");
            expect(html).not.toContain("VORTICITY");
        }
    });

    it("maps VELOCITY to speed and PRESSURE to cp on click", () => {
        const seen: FieldMode[] = [];
        const tree = FieldBar({
            variable: "cp",
            onVariable: (next) => seen.push(next),
            hasTke: true,
            hasRecirc: true,
            overlays: resolveOverlays("cp", DEFAULT_DISPLAY_PREFS),
        }) as unknown;
        clickLabel(tree, "VELOCITY");
        clickLabel(tree, "PRESSURE");
        expect(seen).toEqual(["speed", "cp"]);
    });

    it("falls back to speed when a mean channel has no frame data", () => {
        expect(fallbackVariableFor("k", {})).toBe("speed");
        expect(fallbackVariableFor("recirc", {})).toBe("speed");
        expect(fallbackVariableFor("cp", {})).toBe("cp");
    });
});

describe("P3 velocity slider gone with Re kept", () => {
    it("carries no velocity slider, props, or copy in the SIMULATION section", async () => {
        const src = await readFile(simPath, "utf8");
        expect(src).not.toContain("simVel");
        expect(src).not.toContain("onVelocity");
        expect(src).not.toContain("Velocity multiplier, visual only");
        expect(src).not.toContain("Scales particle speed");
    });

    it("wires no velocity plumbing from App into the SIMULATION section", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toContain("velocity={velocity}");
        expect(src).not.toContain("onVelocity={onVelocity}");
        expect(src).not.toContain("blockageWarning={lbmBlockage.warning}");
    });

    it("keeps the Re slider plus number entry in markup", () => {
        const html = renderToStaticMarkup(SimulationSectionView(simProps()) as never);
        expect(html).toContain('id="simRey"');
        expect(html).toContain('id="simReNumber"');
        expect(html).toContain("Log scale. Re shades the wake deficit only");
        expect(html).not.toContain('id="simVel"');
    });

    it("rejects empty plus non-numeric Re typing and holds last good", () => {
        expect(decideReCommit("", false).fire).toBe(false);
        expect(decideReCommit("not a number", false).fire).toBe(false);
        expect(decideReCommit("50000", false).fire).toBe(true);
    });
});

describe("P3 blockage plus band plus blurb plus eval ledger gone", () => {
    it("drops the blockageWarning prop from both rail sections", async () => {
        const [sim, geo] = await Promise.all([
            readFile(simPath, "utf8"),
            readFile(geoPath, "utf8"),
        ]);
        expect(sim).not.toContain("blockageWarning");
        expect(geo).not.toContain("blockageWarning");
        expect(sim).not.toContain("exceeds 5 percent reference limit");
        expect(geo).not.toContain("exceeds 5 percent reference limit");
    });

    it("renders preflight lines without the generic Cd blockage row", () => {
        const html = renderToStaticMarkup(
            SimulationSectionView(
                simProps({
                    agentFirst: false,
                    preflightWarnings: ["LBM pre-flight: blockage 20 percent above 13 percent"],
                }),
            ) as never,
        );
        expect(html).toContain("blockage 20 percent");
        expect(html).not.toContain("exceeds 5 percent reference limit");
    });

    it("drops the characterized band strip from GEOMETRY", async () => {
        const src = await readFile(geoPath, "utf8");
        expect(src).not.toContain("Characterized band [");
        expect(src).not.toContain("ALPHA_MIN");
        expect(src).not.toContain("ALPHA_MAX");
        const html = renderToStaticMarkup(GeometrySectionView(geoProps()) as never);
        expect(html).not.toContain("Characterized band");
    });

    it("drops the analytic blurb from the SIMULATION readout", async () => {
        const src = await readFile(simPath, "utf8");
        expect(src).not.toContain("Analytic potential flow, not validated. Run controls live in the agent console.");
        const html = renderToStaticMarkup(SimulationSectionView(simProps()) as never);
        expect(html).not.toContain("Analytic potential flow, not validated");
        expect(html).toContain("Run readout");
    });

    it("unmounts the eval ledger panel from the analysis rail", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toContain("<EvalLogPanel");
        expect(src).not.toContain("EvalLogPanel");
        expect(src).not.toContain('id: "eval"');
        expect(src).not.toContain("EVAL LEDGER");
    });
});

describe("P3 runCard rows plus Transitional Wake", () => {
    it("shows BODY, ALPHA, RE, CL, CPMIN with no GRID or REGIME rows", async () => {
        const src = await readFile(appPath, "utf8");
        for (const row of ["<dt>BODY</dt>", "<dt>ALPHA</dt>", "<dt>RE</dt>", "<dt>CL</dt>", "<dt>CPMIN</dt>"]) {
            expect(src).toContain(row);
        }
        expect(src).not.toContain("<dt>GRID</dt>");
        expect(src).not.toContain("<dt>REGIME</dt>");
    });

    it("labels the 20k to 200k band Transitional Wake with capital initials", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain('return "Transitional Wake"');
        expect(src).not.toContain('return "transitional wake"');
    });

    it("renders the regime inside the SIMULATION readout REGIME row", () => {
        const html = renderToStaticMarkup(SimulationSectionView(simProps({ regime: "Transitional Wake" })) as never);
        expect(html).toContain("<dt>REGIME</dt>");
        expect(html).toContain("Transitional Wake");
    });

    it("guards non-finite CL and CPMIN to n/a in the run card", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("frame.cl.toFixed(3)");
        expect(src).toContain("frame.cpMin.toFixed(3)");
        expect(src).toContain('"n/a"');
    });
});
