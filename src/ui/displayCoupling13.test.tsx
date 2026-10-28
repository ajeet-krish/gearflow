// Phase 13 display coupling: FIELD bar chip mapping plus the coupling
// note, override then recouple, Settings effective rows and the particle
// size slider, the canvas size effect, the trimmed TopNav, and the debug
// flag gating the rail sections. Static markup plus direct element calls,
// App and FlowCanvas source reads for wiring. No live solves.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import FieldBar, { couplingNoteFor } from "./FieldBar";
import SettingsModal from "./SettingsModal";
import TopNav from "./TopNav";
import { readDebugPanels } from "../App";
import {
    manualPatchForToggle,
    overlayPatchForFieldChange,
    overlayPatchForManualToggle,
    resolveOverlays,
} from "./fieldOverlay";
import { DEFAULT_DISPLAY_PREFS, type FieldMode } from "@/contracts/types";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");
const canvasPath = resolve(here, "../render/FlowCanvas.tsx");

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

describe("FIELD bar chip mapping", () => {
    function treeWith(variable: FieldMode, onVariable: (next: FieldMode) => void) {
        return FieldBar({
            variable,
            onVariable,
            hasTke: true,
            hasRecirc: true,
            overlays: resolveOverlays(variable, DEFAULT_DISPLAY_PREFS),
        }) as unknown;
    }

    it("maps VELOCITY, PRESSURE, VORTICITY to speed, cp, omega", () => {
        const seen: FieldMode[] = [];
        const tree = treeWith("cp", (next) => seen.push(next));
        clickLabel(tree, "VELOCITY");
        clickLabel(tree, "PRESSURE");
        clickLabel(tree, "VORTICITY");
        expect(seen).toEqual(["speed", "cp", "omega"]);
    });

    it("fires TKE and RECIRC when the channels are enabled", () => {
        const seen: FieldMode[] = [];
        const tree = treeWith("speed", (next) => seen.push(next));
        clickLabel(tree, "TKE");
        clickLabel(tree, "RECIRC");
        expect(seen).toEqual(["k", "recirc"]);
    });

    it("disables TKE and RECIRC with the existing reason when gated", () => {
        const html = renderToStaticMarkup(
            <FieldBar
                variable="speed"
                onVariable={noop}
                hasTke={false}
                hasRecirc={false}
                overlays={resolveOverlays("speed", DEFAULT_DISPLAY_PREFS)}
            />,
        );
        expect(html).toContain("Available after the first LBM statistics sample");
    });
});

describe("FIELD bar coupling note", () => {
    it("names the auto overlay per field", () => {
        expect(couplingNoteFor(resolveOverlays("speed", DEFAULT_DISPLAY_PREFS)).text).toContain("streamlines on");
        expect(couplingNoteFor(resolveOverlays("cp", DEFAULT_DISPLAY_PREFS)).text).toContain("contours on");
        expect(couplingNoteFor(resolveOverlays("omega", DEFAULT_DISPLAY_PREFS)).text).toContain("contours on");
    });

    it("renders the auto note beside the chips", () => {
        const html = renderToStaticMarkup(
            <FieldBar
                variable="speed"
                onVariable={noop}
                hasTke={false}
                hasRecirc={false}
                overlays={resolveOverlays("speed", DEFAULT_DISPLAY_PREFS)}
            />,
        );
        expect(html).toContain("streamlines on");
    });

    it("renders the manual hold once pinned", () => {
        const pinned = {
            ...DEFAULT_DISPLAY_PREFS,
            ...overlayPatchForManualToggle("speed", { contours: true }),
        };
        const overlays = resolveOverlays("speed", pinned);
        expect(overlays.source).toBe("user-pinned");
        expect(couplingNoteFor(overlays).text).toContain("MANUAL");
        const html = renderToStaticMarkup(
            <FieldBar variable="speed" onVariable={noop} overlays={overlays} />,
        );
        expect(html).toContain("MANUAL until field change");
    });
});

describe("override then recouple", () => {
    it("holds the manual flags while pinned, then recouple on field change", () => {
        const auto = resolveOverlays("speed", DEFAULT_DISPLAY_PREFS);
        expect(auto).toEqual({ contours: false, showStreamlines: true, source: "field-default" });
        const pinnedPrefs = {
            ...DEFAULT_DISPLAY_PREFS,
            ...overlayPatchForManualToggle("speed", { contours: true, showStreamlines: false }),
        };
        expect(resolveOverlays("speed", pinnedPrefs).source).toBe("user-pinned");
        expect(resolveOverlays("speed", pinnedPrefs)).toEqual({
            contours: true,
            showStreamlines: false,
            source: "user-pinned",
        });
        const recoupledPrefs = {
            ...pinnedPrefs,
            ...overlayPatchForFieldChange("cp"),
        };
        expect(resolveOverlays("cp", recoupledPrefs)).toEqual({
            contours: true,
            showStreamlines: false,
            source: "field-default",
        });
    });
});

describe("Settings effective rows and slider", () => {
    function settingsHtml(prefs = DEFAULT_DISPLAY_PREFS, variable: FieldMode = "speed") {
        return renderToStaticMarkup(
            <SettingsModal
                open={true}
                onClose={noop}
                prefs={prefs}
                onPatch={noop}
                gridMode="auto"
                activeGrid={256}
                onGridMode={noop}
                variable={variable}
            />,
        );
    }

    it("binds the checkboxes to the effective overlays with an auto source", () => {
        const html = settingsHtml(DEFAULT_DISPLAY_PREFS, "speed");
        expect(html).toContain('id="settingsContours"');
        expect(html).toContain('id="settingsStream"');
        expect(html).toContain("Auto from field");
        const stream = html.indexOf('id="settingsStream"');
        expect(html.slice(stream, stream + 160)).toContain("checked");
    });

    it("reflects the pinned manual flags with a manual source", () => {
        const pinned = {
            ...DEFAULT_DISPLAY_PREFS,
            ...overlayPatchForManualToggle("cp", { contours: false, showStreamlines: true }),
        };
        const html = settingsHtml(pinned, "cp");
        expect(html).toContain("Manual until field change");
        const contours = html.indexOf('id="settingsContours"');
        expect(html.slice(contours, contours + 160)).not.toContain("checked");
    });

    it("renders the particle size slider in the contract band with a readout", () => {
        const html = settingsHtml({ ...DEFAULT_DISPLAY_PREFS, particleSize: 0.024 }, "speed");
        expect(html).toContain('id="settingsParticleSize"');
        expect(html).toContain('type="range"');
        expect(html).toContain('min="0.008"');
        expect(html).toContain('max="0.036"');
        expect(html).toContain('step="0.002"');
        expect(html).toContain("0.024");
    });

    it("pins a manual toggle from the effective pair through the funnel patch", async () => {
        const src = await readFile(resolve(here, "./SettingsModal.tsx"), "utf8");
        expect(src).toContain("manualPatchForToggle(variable, effective, { contours:");
        expect(src).toContain("manualPatchForToggle(variable, effective, { showStreamlines:");
        expect(src).not.toContain("overlayPatchForManualToggle(variable,");
    });

    it("keeps streamlines on when Contours is toggled on from fresh speed defaults", () => {
        const effective = resolveOverlays("speed", DEFAULT_DISPLAY_PREFS);
        expect(effective).toEqual({ contours: false, showStreamlines: true, source: "field-default" });
        const patch = manualPatchForToggle("speed", effective, { contours: true });
        expect(patch).toEqual({
            contours: true,
            showStreamlines: true,
            overlayPinned: true,
            overlayPinnedField: "speed",
        });
        const prefs = { ...DEFAULT_DISPLAY_PREFS, ...patch };
        expect(resolveOverlays("speed", prefs)).toEqual({
            contours: true,
            showStreamlines: true,
            source: "user-pinned",
        });
    });
});

describe("canvas particle size effect", () => {
    it("accepts a particle size prop and applies it to the material without a rebuild", async () => {
        const src = await readFile(canvasPath, "utf8");
        expect(src).toContain("particleSize?: number");
        expect(src).toContain("particleSize = 0.018");
        expect(src).toContain("mat.size = particleSize");
        expect(src).toContain("pointsRef.current?.material");
        expect(src).toContain("[particleSize]");
    });
});

describe("trimmed TopNav", () => {
    it("keeps STUDIO, FOCUS, settings, and the WASM badge with no legacy items", () => {
        const html = renderToStaticMarkup(
            <TopNav
                active="studio"
                onNav={noop}
                settingsOpen={false}
                onOpenSettings={noop}
                wasmActive={true}
                focusMode={false}
                onToggleFocus={noop}
            />,
        );
        expect(html).toContain("STUDIO");
        expect(html).toContain("FOCUS");
        expect(html).toContain("Open settings");
        expect(html).toContain("WASM");
        expect(html).not.toContain("VALIDATE");
        expect(html).not.toContain("EXPORT");
        expect(html).not.toContain("ONLINE");
        expect(html).not.toContain("OFFLINE");
    });

    it("fires the studio nav and toggles focus through props", () => {
        const onNav = vi.fn();
        const onToggleFocus = vi.fn();
        const tree = TopNav({
            active: "studio",
            onNav,
            settingsOpen: false,
            onOpenSettings: noop,
            wasmActive: false,
            focusMode: false,
            onToggleFocus,
        }) as unknown;
        const btns = findButtons(tree);
        const studio = btns.find((el) => buttonText(el) === "STUDIO");
        expect(studio).toBeDefined();
        (studio!.props.onClick as () => void)();
        expect(onNav).toHaveBeenCalledWith("studio");
        const focus = btns.find((el) => buttonText(el) === "FOCUS");
        expect(focus).toBeDefined();
        (focus!.props.onClick as () => void)();
        expect(onToggleFocus).toHaveBeenCalledTimes(1);
    });

    it("marks the settings expanded state while open", () => {
        const html = renderToStaticMarkup(
            <TopNav
                active="studio"
                onNav={noop}
                settingsOpen={true}
                onOpenSettings={noop}
                wasmActive={false}
            />,
        );
        expect(html).toContain('aria-expanded="true"');
    });
});

describe("debug flag gates rail sections", () => {
    it("reads ?debug=1 once and rejects every other value", () => {
        expect(readDebugPanels("?debug=1")).toBe(true);
        expect(readDebugPanels("")).toBe(false);
        expect(readDebugPanels("?debug=0")).toBe(false);
        expect(readDebugPanels("?engine=lbm")).toBe(false);
        expect(readDebugPanels("?debug=1&engine=lbm")).toBe(true);
    });

    it("mounts VALIDATION and EXPORT only behind the flag", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("readDebugPanels(window.location.search)");
        expect(src).toContain("debugPanels");
        expect(src).toContain('id: "validation"');
        expect(src).toContain('id: "export"');
    });

    it("keeps telemetry counts and the terminal outside the gate", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("<TelemetryBar");
        expect(src).toContain("valSummary");
        expect(src).toContain("<RunTerminal");
    });
});
