// Phase B panel rework tests: the right rail SIMULATION and GEOMETRY
// windows plus the Settings grid extension and the duct era leftovers.
// Static markup for structure, direct element calls for commit wiring,
// App source reads for the rail contract. No worker threads, no live solves.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildPolygons } from "@/geometry/parametric";
import { preflightLbm } from "@/flow/lbmRunConfig";
import { alphaOutOfBandNote } from "@/contracts/schema";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import type { GeometrySpec } from "@/contracts/types";
import {
    SimulationSectionView,
    decideReCommit,
    type SimulationSectionViewProps,
} from "./SimulationSection";
import {
    GeometrySectionView,
    clampBodyDim,
    resolveLegacyDuct,
    type GeometrySectionProps,
} from "./GeometrySection";
import SettingsModal, { decideSettingsCustomCommit } from "./SettingsModal";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");
const assistantPath = resolve(here, "../agent/localAssistant.ts");
const flowControlsPath = resolve(here, "./FlowControls.tsx");

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

function findAll(tree: unknown, pred: (el: TestEl) => boolean): TestEl[] {
    const out: TestEl[] = [];
    walk(tree, (el) => {
        if (pred(el)) out.push(el);
    });
    return out;
}

function byId(tree: unknown, id: string): TestEl[] {
    return findAll(tree, (el) => el.props.id === id);
}

const NACA_SPEC: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 120,
};

const ORIFICE_SPEC: GeometrySpec = {
    kind: "orifice",
    chord: 1,
    alphaDeg: 0,
    nPoints: 64,
    width: 0.08,
    height: 0.4,
    center: { x: 0.5, y: 0 },
};

function simProps(over: Partial<SimulationSectionViewProps> = {}): SimulationSectionViewProps {
    return {
        agentFirst: true,
        bodyLabel: "NACA 2412",
        alphaDeg: 6,
        reynolds: 50000,
        cl: 0.412,
        regime: "laminar wake",
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

describe("SIMULATION section", () => {
    it("renders the honest readout plus Re, with no grid, solver path, or LBM block under the flag", () => {
        const html = renderToStaticMarkup(SimulationSectionView(simProps()) as never);
        for (const label of ["BODY", "ALPHA", "CL", "REGIME"]) {
            expect(html).toContain(`<dt>${label}</dt>`);
        }
        expect(html).toContain("NACA 2412");
        expect(html).toContain("6.0 deg");
        expect(html).toContain("0.412");
        expect(html).toContain("laminar wake");
        expect(html).not.toContain("Analytic potential flow, not validated. Run controls live in the agent console.");
        expect(html).toContain('id="simRey"');
        expect(html).toContain('id="simReNumber"');
        expect(html).not.toContain('id="simCustomGrid"');
        expect(html).not.toContain('id="simPathCurrent"');
        expect(html).not.toContain('id="simNeuralLine"');
        expect(html).not.toContain('id="simDomainLine"');
        expect(html).not.toContain('aria-label="Run LBM solve"');
        expect(html).not.toContain('aria-label="Cancel LBM solve"');
        expect(html).not.toContain('id="simLbmU"');
        expect(html).not.toContain('id="simLbmSteps"');
        expect(html).not.toContain("LES auto above Re 500");
    });

    it("renders the legacy LBM run block when the flag is off", () => {
        const html = renderToStaticMarkup(SimulationSectionView(simProps({ agentFirst: false })) as never);
        expect(html).toContain('aria-label="Run LBM solve"');
        expect(html).toContain('aria-label="Cancel LBM solve"');
        expect(html).toContain('id="simLbmU"');
        expect(html).toContain('id="simLbmSteps"');
        expect(html).toContain("LES auto above Re 500");
        expect(html).toContain("step 0 of 40000 (0 percent)");
        expect(html).toContain("Stable below about Re 480 at u 0.05 on the default grid, scales with body cells.");
        expect(html).toContain("LES modeled above Re 500.");
    });

    it("names Cl n/a when the frame carries no finite lift", () => {
        const html = renderToStaticMarkup(SimulationSectionView(simProps({ cl: null })) as never);
        expect(html).toContain("n/a");
    });

    it("Re invalid typing shows a popup and fires no setter", () => {
        const onCommitReynolds = vi.fn();
        const onRePopup = vi.fn();
        const tree = SimulationSectionView(
            simProps({ reText: "abc", onCommitReynolds, onRePopup })
        ) as unknown;
        const [input] = byId(tree, "simReNumber");
        (input.props.onBlur as () => void)();
        expect(onCommitReynolds).not.toHaveBeenCalled();
        expect(onRePopup).toHaveBeenCalledTimes(1);
        expect(String(onRePopup.mock.calls[0][0])).toContain("numeric");
        expect(decideReCommit("", false).fire).toBe(false);
        expect(decideReCommit("abc", false).fire).toBe(false);
    });

    it("Re valid typing commits through the shared funnel", () => {
        const onCommitReynolds = vi.fn();
        const onRePopup = vi.fn();
        const tree = SimulationSectionView(
            simProps({ reText: "50000", onCommitReynolds, onRePopup })
        ) as unknown;
        const [input] = byId(tree, "simReNumber");
        (input.props.onKeyDown as (e: unknown) => void)({ key: "Enter" });
        expect(onCommitReynolds).toHaveBeenCalledWith("50000");
        expect(onRePopup).toHaveBeenCalledWith(null);
        expect(decideReCommit("50000", false).fire).toBe(true);
    });

    it("Escape in the Re field reverts to the committed value", () => {
        const onReText = vi.fn();
        const onRePopup = vi.fn();
        const tree = SimulationSectionView(
            simProps({ reynolds: 50000, reText: "abc", onReText, onRePopup })
        ) as unknown;
        const [input] = byId(tree, "simReNumber");
        (input.props.onKeyDown as (e: unknown) => void)({ key: "Escape" });
        expect(onReText).toHaveBeenCalledWith("50000");
        expect(onRePopup).toHaveBeenCalledWith(null);
    });

    it("carries no velocity slider and no velocity props: Re owns the field", () => {
        const html = renderToStaticMarkup(SimulationSectionView(simProps()) as never);
        expect(html).not.toContain('id="simVel"');
        expect(html).not.toContain("Velocity multiplier, visual only");
        expect(html).not.toContain("Scales particle speed");
        expect(html).toContain('id="simReNumber"');
    });

    it("LBM Run is hard blocked by pre-flight without a worker start", () => {
        const gate = preflightLbm(
            NACA_SPEC,
            { nx: 128, ny: 128, domain: { ...DEFAULT_DOMAIN } },
            0.02,
            2000
        );
        expect(gate.ok).toBe(false);
        expect(gate.blockReasons.join(" ")).toContain("floor");
        // The section Run button only calls the App handler, which owns the
        // pre-flight gate. No Worker is constructed anywhere in this file.
        // The block renders in legacy mode only, under the flag it is hidden.
        const onLbmRun = vi.fn();
        const tree = SimulationSectionView(simProps({ agentFirst: false, onLbmRun })) as unknown;
        const run = findAll(tree, (el) => el.props["aria-label"] === "Run LBM solve");
        expect(run).toHaveLength(1);
        (run[0].props.onClick as () => void)();
        expect(onLbmRun).toHaveBeenCalledTimes(1);
        expect(typeof Worker).toBe("undefined");
    });

    it("renders the fault lamp with Recover and the entry notice in legacy mode", () => {
        const html = renderToStaticMarkup(
            SimulationSectionView(
                simProps({ agentFirst: false, lbmFailed: "LBM tau fault", lbmNotice: "LBM needs low Re" })
            ) as never
        );
        expect(html).toContain("lbmFault");
        expect(html).toContain("Recover at Re 200");
        expect(html).toContain("LBM needs low Re");
        expect(html).toContain("Dismiss");
    });

    it("renders pre-flight warnings in legacy mode with no blockage row", () => {
        const html = renderToStaticMarkup(
            SimulationSectionView(
                simProps({
                    agentFirst: false,
                    preflightWarnings: ["LBM pre-flight: blockage 20 percent above 13 percent"],
                })
            ) as never
        );
        expect(html).toContain("blockage 20 percent");
        expect(html).not.toContain("exceeds 5 percent reference limit");
    });

    it("carries no live status dot, the terminal owns status", () => {
        const html = renderToStaticMarkup(SimulationSectionView(simProps()) as never);
        expect(html).not.toContain("liveState");
        expect(html).not.toContain("LIVE");
        expect(html).not.toContain("HELD");
    });
});

describe("GEOMETRY section", () => {
    it("renders the body dropdown with six bodies and no duct", () => {
        const html = renderToStaticMarkup(GeometrySectionView(geoProps()) as never);
        for (const label of ["NACA 0012", "NACA 2412", "NACA 4412", "Cylinder", "Block", "Orifice plate"]) {
            expect(html).toContain(label);
        }
        expect(html).not.toContain(">Duct<");
        expect(html).not.toContain('value="duct"');
    });

    it("renders the full rotation AoA slider with its exact output readout and no numeric entry", () => {
        const html = renderToStaticMarkup(GeometrySectionView(geoProps()) as never);
        expect(html).toContain('id="geoAlpha"');
        expect(html).toContain('min="-180"');
        expect(html).toContain('max="180"');
        expect(html).toContain('step="0.5"');
        expect(html).not.toContain('id="geoAlphaNumber"');
        expect(html).toContain("6.0 deg");
    });

    it("AoA 90 renders with the out of band note at the hard envelope edge", () => {
        // The hard envelope contract lives in schema tests now
        // (validateGeometrySpec accepts 90, rejects 181 and -181). The rail
        // slider covers the same range, this pins the view side.
        const html = renderToStaticMarkup(
            GeometrySectionView(geoProps({ spec: { ...NACA_SPEC, alphaDeg: 90 } })) as never
        );
        expect(html).toContain("outside the characterized band");
        expect(alphaOutOfBandNote(90)).toContain("outside the characterized band");
    });

    it("the slider commits the exact 0.5 deg step through onSpec", () => {
        const onSpec = vi.fn();
        const tree = GeometrySectionView(geoProps({ onSpec })) as unknown;
        const [slider] = byId(tree, "geoAlpha");
        expect(slider).toBeDefined();
        (slider.props.onChange as (e: unknown) => void)({ target: { value: "90" } });
        expect(onSpec).toHaveBeenCalledWith(expect.objectContaining({ alphaDeg: 90 }));
    });

    it("shows the out of band note for extended alpha", () => {
        const html = renderToStaticMarkup(
            GeometrySectionView(geoProps({ spec: { ...NACA_SPEC, alphaDeg: 90 } })) as never
        );
        expect(html).toContain("outside the characterized band");
    });

    it("shows the symmetric body hint for cylinder and orifice only", () => {
        const hint = "Symmetric body, angle leaves the geometry unchanged and tilts the wake only.";
        const cyl = renderToStaticMarkup(
            GeometrySectionView(geoProps({ spec: { ...NACA_SPEC, kind: "cylinder", radius: 0.25 } })) as never
        );
        expect(cyl).toContain(hint);
        const ori = renderToStaticMarkup(GeometrySectionView(geoProps({ spec: ORIFICE_SPEC })) as never);
        expect(ori).toContain(hint);
        const naca = renderToStaticMarkup(GeometrySectionView(geoProps()) as never);
        expect(naca).not.toContain(hint);
    });

    it("renders per body fields: cylinder radius, block dims, orifice gap and thickness", () => {
        const cyl = renderToStaticMarkup(
            GeometrySectionView(geoProps({ spec: { ...NACA_SPEC, kind: "cylinder", radius: 0.25 } })) as never
        );
        expect(cyl).toContain('id="geoRadius"');
        const block = renderToStaticMarkup(
            GeometrySectionView(
                geoProps({ spec: { ...NACA_SPEC, kind: "block", width: 0.5, height: 0.5 } })
            ) as never
        );
        expect(block).toContain('id="geoLength"');
        expect(block).toContain('id="geoHeight"');
        const ori = renderToStaticMarkup(GeometrySectionView(geoProps({ spec: ORIFICE_SPEC })) as never);
        expect(ori).toContain('id="geoGap"');
        expect(ori).toContain('id="geoThickPlate"');
        expect(ori).toContain('min="0.05"');
        expect(ori).toContain('max="1.8"');
        expect(ori).toContain('min="0.02"');
        expect(ori).toContain('max="0.2"');
    });

    it("renders the plate resolution warning when known", () => {
        const html = renderToStaticMarkup(
            GeometrySectionView(
                geoProps({
                    spec: ORIFICE_SPEC,
                    orificeResolutionWarning: "Orifice plate spans about 1.2 cells at 64",
                })
            ) as never
        );
        expect(html).toContain("Orifice plate spans about 1.2 cells at 64");
    });

    it("orifice gap control updates the built polygons", () => {
        const seen: GeometrySpec[] = [];
        const tree = GeometrySectionView(
            geoProps({ spec: ORIFICE_SPEC, onSpec: (next) => seen.push(next) })
        ) as unknown;
        const [gap] = byId(tree, "geoGap");
        (gap.props.onChange as (e: unknown) => void)({ target: { value: "0.6" } });
        expect(seen).toHaveLength(1);
        expect(seen[0].height).toBeCloseTo(0.6, 12);
        const polys = buildPolygons(seen[0]);
        expect(polys).toHaveLength(2);
        const upperMinY = Math.min(...polys[0].map((p) => p.y));
        const lowerMaxY = Math.max(...polys[1].map((p) => p.y));
        expect(upperMinY).toBeCloseTo(0.3, 9);
        expect(lowerMaxY).toBeCloseTo(-0.3, 9);
    });

    it("clamps body dims to their envelopes and holds on garbage", () => {
        expect(clampBodyDim("0.6", 0.05, 1.8, 0.4)).toBeCloseTo(0.6, 12);
        expect(clampBodyDim(5, 0.05, 1.8, 0.4)).toBe(1.8);
        expect(clampBodyDim("abc", 0.05, 1.8, 0.4)).toBe(0.4);
    });

    it("a legacy duct spec resolves to the orifice plate", () => {
        const duct = {
            kind: "duct",
            chord: 1,
            alphaDeg: 0,
            nPoints: 64,
            width: 1.0,
            height: 0.9,
            center: { x: 0.5, y: 0 },
        } as unknown as GeometrySpec;
        const next = resolveLegacyDuct(duct);
        expect(next.kind).toBe("orifice");
        expect(next.height).toBeCloseTo(0.9, 12);
        const html = renderToStaticMarkup(
            GeometrySectionView(geoProps({ spec: duct })) as never
        );
        expect(html).toContain('value="orifice"');
        expect(html).toContain("Legacy duct spec resolved as an orifice plate.");
        expect(html).toContain('id="geoGap"');
    });
});

describe("Settings grid extension", () => {
    const prefs = {
        colormap: "viridis",
        variable: "speed",
        theme: "dark",
        showLegend: true,
        fieldVisible: true,
        contours: false,
        particleCount: 3000,
        particleColor: "auto",
        showStreamlines: false,
        meanFields: false,
        particleSize: 0.018,
        overlayPinned: false,
        overlayPinnedField: null,
    } as const;

    function renderSettings(over: Record<string, unknown> = {}) {
        return renderToStaticMarkup(
            <SettingsModal
                open={true}
                onClose={noop}
                prefs={{ ...prefs }}
                onPatch={noop}
                gridMode="auto"
                activeGrid={256}
                onGridMode={noop}
                variable="speed"
                {...over}
            />
        );
    }

    it("offers 64 and Custom beyond auto, 256, and 128", () => {
        const html = renderSettings();
        for (const label of ["Auto (256, fallback to 128)", "256 x 256 pinned", "128 x 128 pinned", "64 x 64 pinned", "Custom square"]) {
            expect(html).toContain(label);
        }
    });

    it("shows the Custom input while Custom is active", () => {
        const html = renderSettings({ gridMode: "custom", customSize: 96 });
        expect(html).toContain('id="settingsCustomGrid"');
        expect(html).toContain('value="96"');
    });

    it("Custom invalid keeps the last good size", () => {
        expect(decideSettingsCustomCommit("abc", 96)).toEqual({
            fire: false,
            size: 96,
            message: expect.stringContaining("32"),
        });
        expect(decideSettingsCustomCommit("", 96).fire).toBe(false);
        expect(decideSettingsCustomCommit("96", 128)).toEqual({ fire: true, size: 96, message: null });
        expect(decideSettingsCustomCommit(513, 128).fire).toBe(false);
    });
});

describe("panel rework leftovers", () => {
    it("App SIMULATION panel is a readout with no grid or solver path fields", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toMatch(/LBM_MAX_RE,/);
        expect(src).not.toContain("LBM_MAX_RE");
        expect(src).not.toContain("solveGrid.nx === 256 ? 256 : 128");
        expect(src).not.toContain("activeGrid={flow.nx}");
        expect(src).toContain("agentFirst={agentFirst.agentFirst}");
        expect(src).toContain("bodyLabel={bodyRowLabel}");
        expect(src).toContain("regime={regime}");
    });

    it("App mounts SIMULATION plus GEOMETRY sections with the new components", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain('id: "simulation"');
        expect(src).toContain('id: "geometry"');
        expect(src).toContain("<SimulationSection");
        expect(src).toContain("<GeometrySection");
        expect(src).toContain("onCommitReynolds={onReynoldsBar}");
        expect(src).toContain("onLbmRun={onLbmRun}");
        expect(src).toContain("onLbmRecover={onLbmRecoverRe}");
        expect(src).not.toContain("<FlowControls");
        expect(src).toContain("commitReynoldsValue(raw, lbmActive, reynolds)");
        expect(src).toContain("preflightLbm(");
        expect(src).toContain("Run blocked");
        expect(src).toContain("orificeResolutionWarning");
    });

    it("App passes the extended grid state into SettingsModal", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("customSize={gridState.customSize}");
        expect(src).toContain("onGridMode={setGridMode}");
    });

    it("duct era copy now names the orifice plate", async () => {
        const assistant = await readFile(assistantPath, "utf8");
        expect(assistant).toContain("cylinder, block, orifice");
        expect(assistant).not.toContain("cylinder, block, duct");
        const controls = await readFile(flowControlsPath, "utf8");
        expect(controls).not.toContain("duct");
    });
});
