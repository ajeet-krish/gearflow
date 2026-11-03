// Orifice sweep gate: the plate has no angle of attack (alpha invariant
// 0), so a stall demo request must not run the staircase and must not
// write alpha. Drives the real AgentConsole through the hook dispatcher
// shim with spies on the stepper and canvas writers, zero live calls.

import { describe, expect, it, vi, afterEach } from "vitest";
import * as React from "react";
import AgentConsole from "./AgentConsole";
import { isOrificeSweepBody } from "@/agent/alphaSweep";
import { buildAgentContext } from "@/agent/agentContext";

const INTERNALS = (
    React as unknown as {
        __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } };
    }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

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
        if (renderCount > 4000) throw new Error("render loop suspected in orifice sweep harness");
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
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));
    for (let i = 0; i < 40; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

function orificeSnapshot(): Record<string, unknown> {
    return {
        spec: { kind: "orifice", chord: 1, alphaDeg: 0, nPoints: 64, width: 0.08, height: 0.4, center: { x: 0.5, y: 0 } },
        reynolds: 1000,
        regime: "laminar, attached",
        bodyLabel: "ORIFICE",
        backend: "analytic",
        engine: "analytic",
        gridLabel: "128x128",
        cl: 0,
        cpMin: -1,
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

describe("orifice sweep gate", () => {
    it("classifies the plate by kind and by label fallback", () => {
        expect(isOrificeSweepBody("orifice", "ORIFICE")).toBe(true);
        expect(isOrificeSweepBody("ORIFICE", "current body")).toBe(true);
        expect(isOrificeSweepBody("naca4", "ORIFICE plate")).toBe(true);
        expect(isOrificeSweepBody("naca4", "NACA 2412")).toBe(false);
        expect(isOrificeSweepBody("cylinder", "current body")).toBe(false);
        expect(isOrificeSweepBody(null, null)).toBe(false);
    });

    it("set up orifice then stall demo: alpha stays 0 and no staircase runs", async () => {
        const ctx = buildAgentContext(orificeSnapshot() as never);
        expect(ctx.alphaDeg).toBe(0);
        const sweepApplied: number[] = [];
        const executor = vi.fn();
        const stepper = vi.fn(fakeStepper());
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction: executor,
            onWhatIfSweep: stepper,
            onSweepAlpha: async (alpha: number) => {
                sweepApplied.push(alpha);
            },
            chatClient: null,
            initialTurns: [],
        });
        typeText(m, "show stall demo");
        submitForm(m);
        await waitSweep();
        try {
            // No staircase: neither the stepper nor any canvas writer ran.
            expect(stepper).not.toHaveBeenCalled();
            expect(sweepApplied).toEqual([]);
            expect(executor).not.toHaveBeenCalled();
            // Alpha invariant holds: the console context still reads 0.
            expect(ctx.alphaDeg).toBe(0);
            // Gate teaches the gap (venturi Try next style), canvas unchanged.
            const body = m.text();
            expect(body).toContain("alpha stays 0");
            expect(body).toContain("no stall staircase");
            expect(body).toContain("gap");
            expect(body).toContain("venturi");
            expect(body).toContain("Canvas unchanged");
            expect(body).not.toContain("Sweep complete");
        } finally {
            m.unmount();
        }
    });
});
