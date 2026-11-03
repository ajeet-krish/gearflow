// AgentConsole sweep behavior: summary-only, Stop end state, chip Apply.
// Drives the real component through the hook dispatcher shim with a fake
// stepper (onWhatIfSweep) and executor (onAgentAction/onSweepAlpha), zero
// live calls. Pins the P3 console fixes: offline sweep status, finally
// gate reset, and chip applies through the validated settle path.

import { describe, expect, it, vi, afterEach } from "vitest";
import * as React from "react";
import AgentConsole from "./AgentConsole";
import { SWEEP_ALPHAS } from "@/agent/alphaSweep";
import { buildAgentContext } from "@/agent/agentContext";

const INTERNALS = (
    React as unknown as {
        __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } };
    }
). __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

const mounted: Array<() => void> = [];

afterEach(() => {
    while (mounted.length > 0) {
        const restore = mounted.pop();
        try {
            restore?.();
        } catch {
            // Best effort.
        }
    }
});

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
        walk((node.props as Record<string, unknown>).children, visit);
    }
}

function findAll(tree: unknown, pred: (el: TestEl) => boolean): TestEl[] {
    const out: TestEl[] = [];
    walk(tree, (el) => {
        if (pred(el)) out.push(el);
    });
    return out;
}

function textOf(node: unknown): string {
    const parts: string[] = [];
    const gather = (n: unknown): void => {
        if (typeof n === "string" || typeof n === "number") {
            parts.push(String(n));
            return;
        }
        if (Array.isArray(n)) {
            for (const child of n) gather(child);
            return;
        }
        if (isEl(n)) gather(n.props.children);
    };
    gather(node);
    return parts.join(" ");
}

function buttonsByLabel(tree: unknown, label: string): TestEl[] {
    return findAll(tree, (el) => el.type === "button" && el.props["aria-label"] === label);
}

function findInput(tree: unknown): TestEl {
    const found = findAll(tree, (el) => el.type === "input" && el.props.id === "agentInput");
    if (found.length !== 1) throw new Error(`expected one composer input, saw ${found.length}`);
    return found[0];
}

function findForm(tree: unknown): TestEl {
    const found = findAll(tree, (el) => el.type === "form");
    if (found.length !== 1) throw new Error(`expected one composer form, saw ${found.length}`);
    return found[0];
}

function badgeCount(tree: unknown, badge: string): number {
    return findAll(
        tree,
        (el) =>
            (el.type === "span" || el.type === "p") &&
            typeof el.props.className === "string" &&
            (el.props.className as string).includes("badge") &&
            textOf(el) === badge
    ).length;
}

interface MountedConsole {
    tree: () => unknown;
    text: () => string;
    unmount: () => void;
}

function mountConsole(props: Record<string, unknown>): MountedConsole {
    const cells: Array<{ v: unknown }> = [];
    let hookIndex = 0;
    let currentTree: unknown = null;
    let renderCount = 0;
    const prev = INTERNALS.ReactCurrentDispatcher.current;
    const renderOnce = (): void => {
        renderCount += 1;
        if (renderCount > 4000) throw new Error("render loop suspected in sweep harness");
        hookIndex = 0;
        INTERNALS.ReactCurrentDispatcher.current = {
            useState: (init: unknown) => {
                const i = hookIndex++;
                if (cells[i] === undefined) cells[i] = { v: typeof init === "function" ? (init as () => unknown)() : init };
                const set = (next: unknown): void => {
                    cells[i].v = typeof next === "function" ? (next as (prior: unknown) => unknown)(cells[i].v) : next;
                    renderOnce();
                };
                return [cells[i].v, set];
            },
            useMemo: (fn: () => unknown) => fn(),
            useRef: (init: unknown) => {
                const i = hookIndex++;
                if (cells[i] === undefined) cells[i] = { v: { current: init } };
                return cells[i].v;
            },
        };
        currentTree = (AgentConsole as unknown as (p: Record<string, unknown>) => unknown)(props);
    };
    renderOnce();
    const unmount = (): void => {
        INTERNALS.ReactCurrentDispatcher.current = prev;
    };
    mounted.push(unmount);
    return {
        tree: () => currentTree,
        text: () => textOf(currentTree),
        unmount: () => {
            const at = mounted.indexOf(unmount);
            if (at >= 0) mounted.splice(at, 1);
            unmount();
        },
    };
}

function typeText(m: MountedConsole, value: string): void {
    (findInput(m.tree()).props.onChange as (e: unknown) => void)({ target: { value } });
}

function submitForm(m: MountedConsole): void {
    (findForm(m.tree()).props.onSubmit as (e: unknown) => void)({ preventDefault: () => {} });
}

async function waitSweep(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    for (let i = 0; i < 40; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

function pendingSnapshot(): Record<string, unknown> {
    return {
        spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
        reynolds: 50000,
        regime: "laminar, attached",
        bodyLabel: "NACA 2412",
        backend: "analytic",
        engine: "analytic",
        gridLabel: "128x128",
        cl: 0.6,
        cpMin: -1.2,
        lbmStatus: "idle",
        lbmHasSnapshot: false,
        lbmEffective: false,
        lbmStatsReady: false,
        lbmStats: null,
        variable: "speed",
        effectiveVariable: "speed",
        hasTke: false,
        hasRecirc: false,
        validation: { pass: 0, warn: 0, fail: 0, info: 0 },
        provenanceLabel: "analytic",
        offline: false,
        agentFirst: true,
    };
}

function fakeStepper() {
    return async (alphaDeg: number): Promise<{ cl: number | null; cpMin: number | null; solveMs: number | null }> => ({
        cl: 0.1 * alphaDeg,
        cpMin: -1 - 0.05 * alphaDeg,
        solveMs: 2,
    });
}

/** Fake Modal port for the sweep summary call. The staircase itself stays
 *  local through onWhatIfSweep; only the summary plus teaching rides chat. */
function fakeSummaryPort(text = "Sweep summary from the tutor, plain words.") {
    const result = () => ({
        text,
        action: null,
        model: "test-spark",
        usage: { inputTokens: 4, outputTokens: 8, cachedTokens: 0 },
        costUsd: 0,
        latencyMs: 2,
        reasoning: "",
    });
    return {
        async *streamChat(_m: unknown, _o?: unknown) {
            yield { delta: "x", text: "x", done: false };
            return result();
        },
        async chat(_m: unknown, _o?: unknown) {
            return result();
        },
    };
}

describe("agent console sweep summary-only", () => {
    it("paints every alpha in order with one Modal summary plus Apply chips", async () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        const applied: number[] = [];
        const executor = vi.fn();
        const sweepApplied: number[] = [];
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction: executor,
            onWhatIfSweep: fakeStepper(),
            onSweepAlpha: async (alpha: number) => {
                sweepApplied.push(alpha);
                applied.push(alpha);
            },
            chatClient: fakeSummaryPort(),
            initialTurns: [],
        });
        typeText(m, "sweep the alpha staircase");
        submitForm(m);
        await waitSweep();
        try {
            expect(sweepApplied).toEqual([...SWEEP_ALPHAS]);
            expect(applied).toEqual([...SWEEP_ALPHAS]);
            expect(executor).not.toHaveBeenCalled();
            expect(m.text()).toContain("Sweep complete");
            expect(m.text()).toContain("Sweep summary from the tutor");
            expect(m.text()).toContain("Summary follows");
            const chips = buttonsByLabel(m.tree(), "Apply angle of attack (alpha) 6 degrees");
            expect(chips.length).toBeGreaterThan(0);
            expect(m.text()).not.toContain("Running the live alpha staircase, canvas stepping");
            expect(badgeCount(m.tree(), "live")).toBe(0);
            expect(badgeCount(m.tree(), "offline")).toBeGreaterThan(0);
            // P0 TUI mimic: no tool or model pills, no separate tutor badge
            // pill. The summary turn still teaches in place with the Tutor
            // label plus the numbers table.
            expect(badgeCount(m.tree(), "tutor")).toBe(0);
            expect(m.text()).toContain("Tutor");
        } finally {
            m.unmount();
        }
    });

    it("resets the sweep gate so a second sweep still runs", async () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        const sweepApplied: number[] = [];
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction: () => {},
            onWhatIfSweep: fakeStepper(),
            onSweepAlpha: async (alpha: number) => {
                sweepApplied.push(alpha);
            },
            chatClient: fakeSummaryPort(),
            initialTurns: [],
        });
        typeText(m, "sweep alpha");
        submitForm(m);
        await waitSweep();
        const first = sweepApplied.length;
        expect(first).toBe(SWEEP_ALPHAS.length);
        typeText(m, "sweep alpha again");
        submitForm(m);
        await waitSweep();
        try {
            expect(sweepApplied.length).toBe(SWEEP_ALPHAS.length * 2);
            expect(m.text()).toContain("Sweep complete");
        } finally {
            m.unmount();
        }
    });

    it("lands an honest offline error with rows when truly down", async () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        const sweepApplied: number[] = [];
        const m = mountConsole({
            offline: true,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction: () => {},
            onWhatIfSweep: fakeStepper(),
            onSweepAlpha: async (alpha: number) => {
                sweepApplied.push(alpha);
            },
            chatClient: fakeSummaryPort(),
            initialTurns: [],
        });
        typeText(m, "sweep alpha");
        submitForm(m);
        await waitSweep();
        try {
            // The staircase still runs locally even when down.
            expect(sweepApplied).toEqual([...SWEEP_ALPHAS]);
            expect(m.text()).toContain("Sweep complete");
            expect(m.text()).toContain("offline demo mode");
            expect(m.text()).toContain("Canvas unchanged");
            expect(m.text()).not.toContain("Sweep summary from the tutor");
            const chips = buttonsByLabel(m.tree(), "Apply angle of attack (alpha) 6 degrees");
            expect(chips.length).toBeGreaterThan(0);
        } finally {
            m.unmount();
        }
    });
});

describe("agent console sweep stop", () => {
    it("leaves the last applied alpha with an honest stopped note", async () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        const sweepApplied: number[] = [];
        let calls = 0;
        const m = mountConsole({
            offline: true,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction: () => {},
            onWhatIfSweep: async (alpha: number) => {
                calls += 1;
                if (calls === 3) {
                    const stop = buttonsByLabel(m.tree(), "Stop the alpha sweep");
                    expect(stop.length).toBe(1);
                    (stop[0].props.onClick as () => void)();
                }
                return { cl: 0.1 * alpha, cpMin: -1, solveMs: 1 };
            },
            onSweepAlpha: async (alpha: number) => {
                sweepApplied.push(alpha);
            },
            chatClient: fakeSummaryPort(),
            initialTurns: [],
        });
        typeText(m, "sweep alpha");
        submitForm(m);
        await waitSweep();
        try {
            expect(sweepApplied.length).toBeGreaterThan(0);
            expect(sweepApplied.length).toBeLessThan(SWEEP_ALPHAS.length);
            expect(m.text()).toContain("Sweep stopped");
            expect(m.text()).toContain("leaving the last applied alpha");
        } finally {
            m.unmount();
        }
    });
});

describe("agent console sweep chips", () => {
    it("routes Apply chips through the validated settle path with no applied line", async () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        const executor = vi.fn();
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction: executor,
            onWhatIfSweep: fakeStepper(),
            onSweepAlpha: async () => {},
            chatClient: fakeSummaryPort(),
            initialTurns: [],
        });
        typeText(m, "sweep alpha");
        submitForm(m);
        await waitSweep();
        try {
            const chips = buttonsByLabel(m.tree(), "Apply angle of attack (alpha) 4 degrees");
            expect(chips.length).toBe(1);
            (chips[0].props.onClick as () => void)();
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(executor).toHaveBeenCalledWith({ kind: "set_alpha", alphaDeg: 4 });
            expect(m.text()).toContain("Applying angle of attack (alpha) 4 deg from the sweep");
            // The apply receipt stays in extras; the turn never renders it.
            expect(m.text()).not.toContain("Applied: angle of attack (alpha) 4 deg.");
        } finally {
            m.unmount();
        }
    });
});
