// Settings manual toggle behavior: invoke the rendered Field checkbox
// handlers and capture the onPatch payloads, so the funnel fix is pinned
// by the actual component wiring instead of the pure helper alone.
// SettingsModal uses hooks and this repo has no DOM renderer, so the
// tests render by calling the component with a minimal hook dispatcher,
// the same direct element call style used for FieldBar and TopNav in
// displayCoupling13. Effects stay inert under the shim, which suits the
// node test environment where document listeners never run.

import { describe, expect, it } from "vitest";
import React from "react";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import SettingsModal, { type SettingsModalProps } from "./SettingsModal";
import { resolveOverlays } from "./fieldOverlay";
import { DEFAULT_DISPLAY_PREFS, type DisplayPrefs, type FieldMode } from "@/contracts/types";
import type { GridMode } from "@/flow/gridController";
import { readDebugPanels } from "../App";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");

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

function dispatcherShim(): {
    useRef: (initial: unknown) => { current: unknown };
    useState: (initial: unknown) => [unknown, () => void];
    useEffect: () => void;
} {
    return {
        useRef: (initial: unknown) => ({ current: initial }),
        useState: (initial: unknown) => {
            const value = typeof initial === "function" ? (initial as () => unknown)() : initial;
            return [value, () => {}] as [unknown, () => void];
        },
        useEffect: () => {},
    };
}

const dispatcherHost = React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
        ReactCurrentDispatcher: { current: unknown };
    };
};

/** Render SettingsModal to a plain element tree without a DOM renderer. */
function renderTree(props: SettingsModalProps): unknown {
    const host = dispatcherHost.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
    const prev = host.ReactCurrentDispatcher.current;
    host.ReactCurrentDispatcher.current = dispatcherShim();
    try {
        return SettingsModal(props) as unknown;
    } finally {
        host.ReactCurrentDispatcher.current = prev;
    }
}

function modalProps(over: {
    prefs?: DisplayPrefs;
    variable?: FieldMode;
    onPatch?: (next: Partial<DisplayPrefs>) => void;
    onGridMode?: (next: GridMode, customRaw?: unknown) => void;
    open?: boolean;
}): SettingsModalProps {
    return {
        open: over.open ?? true,
        onClose: () => {},
        prefs: over.prefs ?? DEFAULT_DISPLAY_PREFS,
        onPatch: over.onPatch ?? (() => {}),
        gridMode: "auto",
        activeGrid: 256,
        onGridMode: over.onGridMode ?? (() => {}),
        variable: over.variable ?? "speed",
    };
}

function findInput(tree: unknown, id: string): TestEl {
    const hits: TestEl[] = [];
    walk(tree, (el) => {
        if (el.type === "input" && el.props.id === id) hits.push(el);
    });
    if (hits.length === 0) throw new Error(`missing input ${id}`);
    return hits[0];
}

function findReset(tree: unknown): TestEl {
    const hits: TestEl[] = [];
    walk(tree, (el) => {
        if (el.type !== "button") return;
        const kids = el.props.children;
        const text =
            typeof kids === "string"
                ? kids
                : Array.isArray(kids)
                  ? kids.filter((k) => typeof k === "string").join("")
                  : "";
        if (text === "Reset defaults") hits.push(el);
    });
    if (hits.length === 0) throw new Error("missing Reset defaults button");
    return hits[0];
}

function fireCheck(el: TestEl, checked: boolean): void {
    (el.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked } });
}

function fireClick(el: TestEl): void {
    (el.props.onClick as () => void)();
}

describe("Settings rendered manual toggles", () => {
    it("toggling Contours on from fresh speed defaults pins contours true and keeps streamlines true", () => {
        const seen: Array<Partial<DisplayPrefs>> = [];
        const tree = renderTree(
            modalProps({
                prefs: DEFAULT_DISPLAY_PREFS,
                variable: "speed",
                onPatch: (next) => seen.push(next),
            }),
        );
        const contours = findInput(tree, "settingsContours");
        const stream = findInput(tree, "settingsStream");
        expect(contours.props.checked).toBe(false);
        expect(stream.props.checked).toBe(true);
        fireCheck(contours, true);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({
            contours: true,
            showStreamlines: true,
            overlayPinned: true,
            overlayPinnedField: "speed",
        });
    });

    it("toggling Streamlines off from fresh speed defaults pins both flags off", () => {
        const seen: Array<Partial<DisplayPrefs>> = [];
        const tree = renderTree(
            modalProps({
                prefs: DEFAULT_DISPLAY_PREFS,
                variable: "speed",
                onPatch: (next) => seen.push(next),
            }),
        );
        fireCheck(findInput(tree, "settingsStream"), false);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({
            contours: false,
            showStreamlines: false,
            overlayPinned: true,
            overlayPinnedField: "speed",
        });
    });

    it("toggling Streamlines on from cp defaults keeps contours on", () => {
        const seen: Array<Partial<DisplayPrefs>> = [];
        const tree = renderTree(
            modalProps({
                prefs: DEFAULT_DISPLAY_PREFS,
                variable: "cp",
                onPatch: (next) => seen.push(next),
            }),
        );
        expect(findInput(tree, "settingsContours").props.checked).toBe(true);
        expect(findInput(tree, "settingsStream").props.checked).toBe(false);
        fireCheck(findInput(tree, "settingsStream"), true);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({
            contours: true,
            showStreamlines: true,
            overlayPinned: true,
            overlayPinnedField: "cp",
        });
    });

    it("unchecking Contours from a pinned both on pair keeps streamlines on", () => {
        const effective = resolveOverlays("speed", DEFAULT_DISPLAY_PREFS);
        const pinned: DisplayPrefs = {
            ...DEFAULT_DISPLAY_PREFS,
            ...{
                contours: true,
                showStreamlines: true,
                overlayPinned: true as const,
                overlayPinnedField: "speed" as const,
            },
        };
        expect(effective).toEqual({ contours: false, showStreamlines: true, source: "field-default" });
        const seen: Array<Partial<DisplayPrefs>> = [];
        const tree = renderTree(
            modalProps({ prefs: pinned, variable: "speed", onPatch: (next) => seen.push(next) }),
        );
        expect(findInput(tree, "settingsContours").props.checked).toBe(true);
        fireCheck(findInput(tree, "settingsContours"), false);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual({
            contours: false,
            showStreamlines: true,
            overlayPinned: true,
            overlayPinnedField: "speed",
        });
    });

    it("applying the captured Contours patch resolves to a user pinned both on pair", () => {
        const seen: Array<Partial<DisplayPrefs>> = [];
        const tree = renderTree(
            modalProps({
                prefs: DEFAULT_DISPLAY_PREFS,
                variable: "speed",
                onPatch: (next) => seen.push(next),
            }),
        );
        fireCheck(findInput(tree, "settingsContours"), true);
        const prefs: DisplayPrefs = { ...DEFAULT_DISPLAY_PREFS, ...seen[0] };
        expect(resolveOverlays("speed", prefs)).toEqual({
            contours: true,
            showStreamlines: true,
            source: "user-pinned",
        });
    });

    it("returns null when closed", () => {
        const tree = renderTree(modalProps({ open: false }));
        expect(tree).toBeNull();
    });
});

describe("Settings Reset defaults", () => {
    it("restores the contract defaults and returns the grid to auto", () => {
        const pinned: DisplayPrefs = {
            ...DEFAULT_DISPLAY_PREFS,
            theme: "light",
            contours: true,
            showStreamlines: true,
            overlayPinned: true,
            overlayPinnedField: "speed",
            particleCount: 1200,
        };
        const patched: Array<Partial<DisplayPrefs>> = [];
        const gridModes: GridMode[] = [];
        const tree = renderTree(
            modalProps({
                prefs: pinned,
                variable: "speed",
                onPatch: (next) => patched.push(next),
                onGridMode: (next) => gridModes.push(next),
            }),
        );
        fireClick(findReset(tree));
        expect(patched).toHaveLength(1);
        expect(patched[0]).toEqual({
            colormap: DEFAULT_DISPLAY_PREFS.colormap,
            theme: DEFAULT_DISPLAY_PREFS.theme,
            showLegend: DEFAULT_DISPLAY_PREFS.showLegend,
            fieldVisible: DEFAULT_DISPLAY_PREFS.fieldVisible,
            contours: DEFAULT_DISPLAY_PREFS.contours,
            particleCount: DEFAULT_DISPLAY_PREFS.particleCount,
            particleColor: DEFAULT_DISPLAY_PREFS.particleColor,
            particleSize: DEFAULT_DISPLAY_PREFS.particleSize,
            showStreamlines: DEFAULT_DISPLAY_PREFS.showStreamlines,
            meanFields: DEFAULT_DISPLAY_PREFS.meanFields,
            overlayPinned: DEFAULT_DISPLAY_PREFS.overlayPinned,
            overlayPinnedField: DEFAULT_DISPLAY_PREFS.overlayPinnedField,
        });
        expect(gridModes).toEqual(["auto"]);
    });

    it("clears a pinned manual pair back to the auto source on the next resolve", () => {
        const patched: Array<Partial<DisplayPrefs>> = [];
        const pinned: DisplayPrefs = {
            ...DEFAULT_DISPLAY_PREFS,
            contours: true,
            showStreamlines: true,
            overlayPinned: true,
            overlayPinnedField: "speed",
        };
        const tree = renderTree(
            modalProps({ prefs: pinned, variable: "speed", onPatch: (next) => patched.push(next) }),
        );
        fireClick(findReset(tree));
        const prefs: DisplayPrefs = { ...pinned, ...patched[0] };
        expect(resolveOverlays("speed", prefs).source).toBe("field-default");
    });
});

describe("debug sections mount only behind the flag", () => {
    it("reads the flag behaviorally across a query truth table", () => {
        expect(readDebugPanels("?debug=1")).toBe(true);
        expect(readDebugPanels("")).toBe(false);
        expect(readDebugPanels("?debug=0")).toBe(false);
        expect(readDebugPanels("?debug=yes")).toBe(false);
        expect(readDebugPanels("?engine=lbm")).toBe(false);
        expect(readDebugPanels("?debug=1&engine=lbm")).toBe(true);
        expect(readDebugPanels("?engine=lbm&debug=1")).toBe(true);
        expect(readDebugPanels("debug=1")).toBe(true);
    });

    it("mounts VALIDATION and EXPORT inside the debug gate", async () => {
        const src = await readFile(appPath, "utf8");
        for (const id of ['id: "validation"', 'id: "export"'] as const) {
            const at = src.indexOf(id);
            expect(at).toBeGreaterThan(-1);
            const gate = src.lastIndexOf("...(debugPanels", at);
            expect(gate).toBeGreaterThan(-1);
            expect(at - gate).toBeLessThan(600);
        }
    });

    it("keeps the telemetry strip and the terminal outside the gate", async () => {
        const src = await readFile(appPath, "utf8");
        const lines = src.split("\n");
        for (const marker of ["<TelemetryBar", "<RunTerminal"] as const) {
            const line = lines.find((entry) => entry.includes(marker));
            expect(line).toBeDefined();
            expect(line as string).not.toContain("debugPanels");
        }
    });
});
