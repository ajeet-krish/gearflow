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
import { parseCustomGrid } from "@/flow/gridController";
import { preflightLbm } from "@/flow/lbmRunConfig";
import { alphaOutOfBandNote } from "@/contracts/schema";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import type { GeometrySpec } from "@/contracts/types";
import {
    SimulationSectionView,
    decideCustomGridCommit,
    decideReCommit,
    type SimulationSectionViewProps,
} from "./SimulationSection";
import {
    GeometrySectionView,
    clampBodyDim,
    commitAlphaValue,
    resolveLegacyDuct,
    type GeometrySectionViewProps,
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
        gridMode: "auto",
        customSize: 128,
        activeGrid: 256,
        gridNotice: null,
        onGridMode: noop,
        onClearGridNotice: noop,
        customText: "128",
        onCustomText: noop,
        customError: null,
        onCustomError: noop,
        solverPath: "analytic",
        neuralStatus: "unavailable",
        neuralNote: "weights unavailable",
        domainIn: true,
        domainReason: null,
        reynolds: 50000,
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
        blockageWarning: null,
        ...over,
    };
}

function geoProps(over: Partial<GeometrySectionViewProps> = {}): GeometrySectionViewProps {
    return {
        spec: NACA_SPEC,
        onSpec: noop,
        blockageWarning: null,
        orificeResolutionWarning: null,
        alphaText: "6",
        onAlphaText: noop,
        alphaPopup: null,
        onAlphaPopup: noop,
        ...over,
    };
}

describe("SIMULATION section", () => {
    it("renders every control: grid presets, solver status, Re, and the LBM run block", () => {
        const html = renderToStaticMarkup(SimulationSectionView(simProps({ gridMode: "custom" })) as never);
        for (const label of ["64", "128", "256", "Custom"]) {
            expect(html).toContain(`>${label}</button>`);
        }
        expect(html).toContain('id="simCustomGrid"');
        expect(html).toContain('id="simPathCurrent"');
        expect(html).toContain('id="simNeuralLine"');
        expect(html).toContain('id="simDomainLine"');
        expect(html).not.toContain('id="simBackend"');
        expect(html).toContain('id="simRey"');
        expect(html).toContain('id="simReNumber"');
        expect(html).toContain('aria-label="Run LBM solve"');
        expect(html).toContain('aria-label="Cancel LBM solve"');
        expect(html).toContain('id="simLbmU"');
        expect(html).toContain('id="simLbmSteps"');
        expect(html).toContain("LES auto above Re 500");
        expect(html).toContain("step 0 of 40000 (0 percent)");
        expect(html).toContain("Stable below about Re 480 at u 0.05 on the default grid, scales with body cells.");
        expect(html).toContain("LES modeled above Re 500.");
    });

    it("hides the custom grid input unless the Custom preset is active", () => {
        const auto = renderToStaticMarkup(SimulationSectionView(simProps({ gridMode: "auto" })) as never);
        expect(auto).not.toContain('id="simCustomGrid"');
    });

    it("grid Custom invalid keeps the last good size and shows the reason", () => {
        const onGridMode = vi.fn();
        const onCustomError = vi.fn();
        const tree = SimulationSectionView(
            simProps({ gridMode: "custom", customText: "abc", onGridMode, onCustomError })
        ) as unknown;
        const [input] = byId(tree, "simCustomGrid");
        expect(input).toBeDefined();
        (input.props.onBlur as () => void)();
        expect(onGridMode).not.toHaveBeenCalled();
        expect(onCustomError).toHaveBeenCalledTimes(1);
        expect(String(onCustomError.mock.calls[0][0])).toContain("32");
    });

    it("grid Custom valid commits through parseCustomGrid", () => {
        const onGridMode = vi.fn();
        const onCustomError = vi.fn();
        const tree = SimulationSectionView(
            simProps({ gridMode: "custom", customText: "96", onGridMode, onCustomError })
        ) as unknown;
        const [input] = byId(tree, "simCustomGrid");
        (input.props.onBlur as () => void)();
        expect(onGridMode).toHaveBeenCalledWith("custom", 96);
        expect(onCustomError).toHaveBeenCalledWith(null);
        expect(decideCustomGridCommit("7", 128)).toEqual({ fire: false, size: 128, message: expect.stringContaining("32") });
        expect(parseCustomGrid(513).ok).toBe(false);
    });

    it("Escape in the custom grid field reverts to the last good size", () => {
        const onCustomText = vi.fn();
        const onCustomError = vi.fn();
        const tree = SimulationSectionView(
            simProps({ gridMode: "custom", customSize: 96, customText: "abc", onCustomText, onCustomError })
        ) as unknown;
        const [input] = byId(tree, "simCustomGrid");
        (input.props.onKeyDown as (e: unknown) => void)({ key: "Escape" });
        expect(onCustomText).toHaveBeenCalledWith("96");
        expect(onCustomError).toHaveBeenCalledWith(null);
    });

    it("status block names the current path plus neural and domain lines", () => {
        const neural = renderToStaticMarkup(SimulationSectionView(simProps({
            solverPath: "neural-v2",
            neuralStatus: "ready",
            neuralNote: "weights v2, 3.0 ms",
            domainIn: true,
            domainReason: null,
        })) as never);
        expect(neural).toContain("Current path");
        expect(neural).toContain("neural-v2 predicted, not validated");
        expect(neural).toContain("Neural ready");
        expect(neural).toContain("inside the provisional envelope");
        const out = renderToStaticMarkup(SimulationSectionView(simProps({
            solverPath: "analytic",
            neuralStatus: "ready",
            neuralNote: "weights ready",
            domainIn: false,
            domainReason: "alpha 30 deg is outside the provisional envelope [-4, 12] deg",
        })) as never);
        expect(out).toContain("analytic potential flow, not validated");
        expect(out).toContain("outside the provisional envelope");
        expect(out).toContain("alpha 30 deg is outside");
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
        const onLbmRun = vi.fn();
        const tree = SimulationSectionView(simProps({ onLbmRun })) as unknown;
        const run = findAll(tree, (el) => el.props["aria-label"] === "Run LBM solve");
        expect(run).toHaveLength(1);
        (run[0].props.onClick as () => void)();
        expect(onLbmRun).toHaveBeenCalledTimes(1);
        expect(typeof Worker).toBe("undefined");
    });

    it("renders the fault lamp with Recover and the entry notice", () => {
        const html = renderToStaticMarkup(
            SimulationSectionView(
                simProps({ lbmFailed: "LBM tau fault", lbmNotice: "LBM needs low Re" })
            ) as never
        );
        expect(html).toContain("lbmFault");
        expect(html).toContain("Recover at Re 200");
        expect(html).toContain("LBM needs low Re");
        expect(html).toContain("Dismiss");
    });

    it("renders pre-flight warnings and the blockage warning", () => {
        const html = renderToStaticMarkup(
            SimulationSectionView(
                simProps({
                    preflightWarnings: ["LBM pre-flight: blockage 20 percent above 13 percent"],
                    blockageWarning: "blockage 20.0 percent exceeds 5 percent reference limit",
                })
            ) as never
        );
        expect(html).toContain("blockage 20 percent");
        expect(html).toContain("exceeds 5 percent reference limit");
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

    it("renders the full rotation AoA slider plus numeric entry", () => {
        const html = renderToStaticMarkup(GeometrySectionView(geoProps()) as never);
        expect(html).toContain('id="geoAlpha"');
        expect(html).toContain('min="-180"');
        expect(html).toContain('max="180"');
        expect(html).toContain('id="geoAlphaNumber"');
        expect(html).toContain("6.0 deg");
    });

    it("AoA 90 is accepted with the out of band note, 181 is rejected", () => {
        expect(commitAlphaValue(90, 6)).toEqual({ ok: true, value: 90 });
        expect(alphaOutOfBandNote(90)).toContain("outside the characterized band");
        expect(commitAlphaValue(181, 6)).toEqual({ ok: false, value: 6 });
        expect(commitAlphaValue(-181, 6).ok).toBe(false);
        expect(commitAlphaValue("abc", 6).ok).toBe(false);
        const onSpec = vi.fn();
        const onAlphaPopup = vi.fn();
        const bad = GeometrySectionView(geoProps({ alphaText: "181", onSpec, onAlphaPopup })) as unknown;
        const [badInput] = byId(bad, "geoAlphaNumber");
        (badInput.props.onBlur as () => void)();
        expect(onSpec).not.toHaveBeenCalled();
        expect(onAlphaPopup).toHaveBeenCalledTimes(1);
        const good = GeometrySectionView(geoProps({ alphaText: "90", onSpec, onAlphaPopup })) as unknown;
        const [goodInput] = byId(good, "geoAlphaNumber");
        (goodInput.props.onKeyDown as (e: unknown) => void)({ key: "Enter" });
        expect(onSpec).toHaveBeenCalledWith(expect.objectContaining({ alphaDeg: 90 }));
    });

    it("shows the out of band note for extended alpha", () => {
        const html = renderToStaticMarkup(
            GeometrySectionView(geoProps({ spec: { ...NACA_SPEC, alphaDeg: 90 }, alphaText: "90" })) as never
        );
        expect(html).toContain("outside the characterized band");
    });

    it("shows the symmetric body hint for cylinder and orifice only", () => {
        const hint = "Symmetric body, angle leaves the geometry unchanged and tilts the wake only.";
        const cyl = renderToStaticMarkup(
            GeometrySectionView(geoProps({ spec: { ...NACA_SPEC, kind: "cylinder", radius: 0.25 } })) as never
        );
        expect(cyl).toContain(hint);
        const ori = renderToStaticMarkup(GeometrySectionView(geoProps({ spec: ORIFICE_SPEC, alphaText: "0" })) as never);
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
        const ori = renderToStaticMarkup(GeometrySectionView(geoProps({ spec: ORIFICE_SPEC, alphaText: "0" })) as never);
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
                    alphaText: "0",
                    orificeResolutionWarning: "Orifice plate spans about 1.2 cells at 64",
                })
            ) as never
        );
        expect(html).toContain("Orifice plate spans about 1.2 cells at 64");
    });

    it("orifice gap control updates the built polygons", () => {
        const seen: GeometrySpec[] = [];
        const tree = GeometrySectionView(
            geoProps({ spec: ORIFICE_SPEC, alphaText: "0", onSpec: (next) => seen.push(next) })
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
            GeometrySectionView(geoProps({ spec: duct, alphaText: "0" })) as never
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
                onVariable={noop}
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
    it("App drops the unused LBM_MAX_RE import and collapses no grid label", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toMatch(/LBM_MAX_RE,/);
        expect(src).not.toContain("LBM_MAX_RE");
        expect(src).not.toContain("solveGrid.nx === 256 ? 256 : 128");
        expect(src).toContain("activeGrid={flow.nx}");
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
