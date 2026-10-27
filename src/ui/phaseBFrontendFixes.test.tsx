// Phase B frontend fixes: LBM Re band warning funnel, terminal aware
// Escape capture, and legacy duct commit. Behavioral element calls plus the
// shared parser funnel, no worker threads, no live solves.

import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { commitReynoldsValue } from "@/flow/reynoldsField";
import { shouldCloseTerminalOnEscape } from "./shellRegions";
import { SimulationSectionView, decideReCommit } from "./SimulationSection";
import type { SimulationSectionViewProps } from "./SimulationSection";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");

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
        solveMode: "analytic",
        onSolveMode: noop,
        reynolds: 50000,
        lbmActive: true,
        onCommitReynolds: noop,
        reText: "1500",
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

describe("Re 1500 LBM band warning funnel", () => {
    it("commits 1500 with the LES band notice, not capped", () => {
        const commit = commitReynoldsValue("1500", true, 50000);
        expect(commit.reynolds).toBe(1500);
        expect(commit.capped).toBe(false);
        expect(commit.notice).not.toBeNull();
        expect(String(commit.notice)).toContain("LES auto");
    });

    it("decideReCommit fires with the band message so the value commits while it warns", () => {
        const decision = decideReCommit("1500", true);
        expect(decision.fire).toBe(true);
        expect(decision.message).not.toBeNull();
        expect(String(decision.message)).toContain("LES auto");
    });

    it("SIM commit wires the warning plus the commit through the section", () => {
        const onCommitReynolds = vi.fn();
        const onRePopup = vi.fn();
        const tree = SimulationSectionView(
            simProps({ reText: "1500", lbmActive: true, onCommitReynolds, onRePopup })
        ) as unknown;
        const [input] = byId(tree, "simReNumber");
        expect(input).toBeDefined();
        (input.props.onBlur as () => void)();
        expect(onCommitReynolds).toHaveBeenCalledWith("1500");
        expect(onRePopup).toHaveBeenCalledTimes(1);
        expect(String(onRePopup.mock.calls[0][0])).toContain("LES auto");
    });

    it("App funnels every non null commit notice into the notice stack", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("if (commit.notice !== null) setLbmNotice(commit.notice)");
        expect(src).not.toContain("commit.capped && commit.notice");
    });
});

describe("terminal aware Escape capture", () => {
    it("closes the raised panel on Escape while Settings is closed", () => {
        expect(shouldCloseTerminalOnEscape("Escape", { terminalOpen: true, settingsOpen: false })).toBe(true);
    });

    it("ignores editable targets on purpose: the field reverts, then this capture closes the panel", () => {
        const onReText = vi.fn();
        const onRePopup = vi.fn();
        const tree = SimulationSectionView(
            simProps({ reynolds: 1500, reText: "abc", onReText, onRePopup })
        ) as unknown;
        const [input] = byId(tree, "simReNumber");
        (input.props.onKeyDown as (e: unknown) => void)({ key: "Escape" });
        expect(onReText).toHaveBeenCalledWith("1500");
        expect(shouldCloseTerminalOnEscape("Escape", { terminalOpen: true, settingsOpen: false })).toBe(true);
    });

    it("stays shut when collapsed, when Settings owns the dialog, on modifiers, repeats, and non Escape keys", () => {
        expect(shouldCloseTerminalOnEscape("Escape", { terminalOpen: false, settingsOpen: false })).toBe(false);
        expect(shouldCloseTerminalOnEscape("Escape", { terminalOpen: true, settingsOpen: true })).toBe(false);
        expect(shouldCloseTerminalOnEscape("Enter", { terminalOpen: true, settingsOpen: false })).toBe(false);
        expect(shouldCloseTerminalOnEscape("Escape", { terminalOpen: true, settingsOpen: false, ctrl: true })).toBe(false);
        expect(shouldCloseTerminalOnEscape("Escape", { terminalOpen: true, settingsOpen: false, repeat: true })).toBe(false);
    });

    it("App wires the capture before the shell shortcut funnel", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("shouldCloseTerminalOnEscape");
        const captureAt = src.indexOf("shouldCloseTerminalOnEscape(e.key");
        const funnelAt = src.indexOf("resolveShellShortcut(e.key");
        expect(captureAt).toBeGreaterThan(-1);
        expect(funnelAt).toBeGreaterThan(captureAt);
    });
});
