// LBM setup row tests: presentational row plus fault lamp and entry
// notices. Static markup for structure, direct element calls for the
// select and button wiring. No worker threads, no live solves.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import LbmSetupRow, { LbmEntryNotice, LbmFailoverNotice } from "./LbmSetupRow";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");

const noop = () => {};

function baseProps(over: Record<string, unknown> = {}) {
    return {
        uLattice: 0.05,
        onULattice: noop,
        targetSteps: 40000,
        onTargetSteps: noop,
        lesAuto: true,
        onLesAuto: noop,
        lesManual: false,
        onLesManual: noop,
        status: "idle",
        onRun: noop,
        onCancel: noop,
        progressText: "step 0 of 40000 (0 percent)",
        ...over,
    };
}

function renderRow(over: Record<string, unknown> = {}) {
    return renderToStaticMarkup(LbmSetupRow(baseProps(over) as never) as never);
}

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

describe("LbmSetupRow", () => {
    it("renders the toolbar with run controls, selects, LES auto, and progress", () => {
        const html = renderRow();
        expect(html).toContain('aria-label="LBM setup"');
        expect(html).toContain('aria-label="Run LBM solve"');
        expect(html).toContain('aria-label="Cancel LBM solve"');
        expect(html).toContain('aria-label="Lattice velocity"');
        expect(html).toContain('aria-label="Target steps"');
        expect(html).toContain("LES AUTO");
        expect(html).toContain("PROGRESS");
        expect(html).toContain("step 0 of 40000 (0 percent)");
    });

    it("offers the four U options and the three STEPS options", () => {
        const html = renderRow();
        for (const u of ["0.02", "0.05", "0.08", "0.12"]) {
            expect(html).toContain(`value="${u}"`);
        }
        for (const s of ["8000", "40000", "120000"]) {
            expect(html).toContain(`value="${s}"`);
        }
    });

    it("carries the stability note with the measured band and the modeled note", () => {
        const html = renderRow();
        expect(html).toContain("Stable below about Re 480 at u 0.05 on the default grid, scales with body cells.");
        expect(html).toContain("LES modeled above Re 500.");
    });

    it("changing the U select calls through with the numeric value", () => {
        const onULattice = vi.fn();
        const tree = LbmSetupRow(baseProps({ onULattice }) as never) as unknown;
        const selects = findAll(tree, (el) => el.type === "select" && el.props.id === "lbmSetupU");
        expect(selects).toHaveLength(1);
        (selects[0].props.onChange as (e: unknown) => void)({ target: { value: "0.08" } });
        expect(onULattice).toHaveBeenCalledTimes(1);
        expect(onULattice).toHaveBeenCalledWith(0.08);
    });

    it("changing the STEPS select calls through with the numeric value", () => {
        const onTargetSteps = vi.fn();
        const tree = LbmSetupRow(baseProps({ onTargetSteps }) as never) as unknown;
        const selects = findAll(tree, (el) => el.type === "select" && el.props.id === "lbmSetupSteps");
        expect(selects).toHaveLength(1);
        (selects[0].props.onChange as (e: unknown) => void)({ target: { value: "8000" } });
        expect(onTargetSteps).toHaveBeenCalledTimes(1);
        expect(onTargetSteps).toHaveBeenCalledWith(8000);
    });

    it("hides the manual LES toggle while Auto is on and shows it while Auto is off", () => {
        expect(renderRow({ lesAuto: true })).not.toContain("lbmSetupLesManual");
        const off = renderRow({ lesAuto: false });
        expect(off).toContain("lbmSetupLesManual");
        expect(off).toContain("Manual LES toggle, applies while Auto is off");
    });

    it("toggling LES Auto calls through", () => {
        const onLesAuto = vi.fn();
        const tree = LbmSetupRow(baseProps({ onLesAuto }) as never) as unknown;
        const boxes = findAll(tree, (el) => el.type === "input" && el.props.id === "lbmSetupLesAuto");
        expect(boxes).toHaveLength(1);
        expect(boxes[0].props.checked).toBe(true);
        (boxes[0].props.onChange as (e: unknown) => void)({ target: { checked: false } });
        expect(onLesAuto).toHaveBeenCalledWith(false);
    });

    it("disables Run while running and disables Cancel while idle", () => {
        const running = renderRow({ status: "running" });
        expect(running).toContain("Run LBM solve");
        const idleTree = LbmSetupRow(baseProps({ status: "idle" }) as never) as unknown;
        const buttons = findAll(idleTree, (el) => el.type === "button");
        const cancel = buttons.filter((b) => b.props["aria-label"] === "Cancel LBM solve");
        expect(cancel).toHaveLength(1);
        expect(cancel[0].props.disabled).toBe(true);
    });

    it("carries no Re control so the SolverBar stays the single Re owner", () => {
        const html = renderRow();
        expect(html).not.toContain("solverRe");
        expect(html).not.toContain(">RE<");
    });

    it("stays out of the scene path while the failover and entry notices stay wired", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toContain("<LbmSetupRow");
        expect(src).toContain("LbmEntryNotice");
        expect(src).toContain("LbmFailoverNotice");
        expect(src).toContain("onRecover={onLbmRecoverRe}");
        expect(src).toContain("onDismiss={onLbmDismissNotice}");
    });
});

describe("LbmFailoverNotice", () => {
    const suffix = "analytic fallback serving frames. No LBM numbers shown.";
    const recoverLabel = "Recover at Re 200";

    it("renders a tau failover as a fault lamp with a recovery action", () => {
        const onRecover = vi.fn();
        const html = renderToStaticMarkup(
            LbmFailoverNotice({
                message: "LBM tau floor fault at Re 800 (stable below about Re 480 at u 0.05).",
                onRecover,
                suffix,
                recoverLabel,
            }) as never,
        );
        expect(html).toContain("lbmFault");
        expect(html).toContain("FAULT");
        expect(html).toContain("lbmFaultLamp");
        expect(html).toContain(recoverLabel);
        expect(html).toContain(suffix);
        expect(html).toContain('role="alert"');
    });

    it("recovery button invokes the App recover path that sets Re 200", async () => {
        const onRecover = vi.fn();
        const tree = LbmFailoverNotice({
            message: "LBM tau fault",
            onRecover,
            suffix,
            recoverLabel,
        }) as unknown;
        const buttons = findAll(tree, (el) => el.type === "button");
        expect(buttons).toHaveLength(1);
        (buttons[0].props.onClick as () => void)();
        expect(onRecover).toHaveBeenCalledTimes(1);
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("onRecover={onLbmRecoverRe}");
        expect(src).toContain("setReynolds(lbmRecoveryRe)");
        expect(src).toContain(recoverLabel);
    });

    it("keeps a non tau failover in the plain notice style with no recovery button", () => {
        const html = renderToStaticMarkup(
            LbmFailoverNotice({
                message: "LBM worker error event",
                onRecover: noop,
                suffix,
                recoverLabel,
            }) as never,
        );
        expect(html).toContain("fallbackNote");
        expect(html).not.toContain("FAULT");
        expect(html).not.toContain("lbmFaultLamp");
        expect(html).not.toContain(recoverLabel);
    });
});

describe("LbmEntryNotice", () => {
    it("renders the entry message with a dismiss control", () => {
        const html = renderToStaticMarkup(
            LbmEntryNotice({ message: "LBM needs low Re, Re set to 200 for the run default.", onDismiss: noop }) as never,
        );
        expect(html).toContain("LBM needs low Re, Re set to 200 for the run default.");
        expect(html).toContain("Dismiss");
    });

    it("dismiss invokes the App path that clears the notice", async () => {
        const onDismiss = vi.fn();
        const tree = LbmEntryNotice({ message: "entry", onDismiss }) as unknown;
        const buttons = findAll(tree, (el) => el.type === "button");
        expect(buttons).toHaveLength(1);
        (buttons[0].props.onClick as () => void)();
        expect(onDismiss).toHaveBeenCalledTimes(1);
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("onDismiss={onLbmDismissNotice}");
        expect(src).toContain("setLbmNotice(null)");
    });
});
