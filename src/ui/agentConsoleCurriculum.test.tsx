// AgentConsole curriculum chips: rendering, busy gating, and normal-turn
// dispatch. Drives the real component through the hook dispatcher shim with
// a counting fake port, zero live calls. Pins that a curriculum chip click
// lands a normal user turn and rides onSubmit end to end (offline local
// reply, streaming, spend, and busy gates intact).

import { describe, expect, it, vi, afterEach } from "vitest";
import * as React from "react";
import AgentConsole from "./AgentConsole";
import { CURRICULUM_CHIPS } from "@/agent/curriculum";
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

function buttonsByLabel(tree: unknown, label: string): TestEl[] {
    return findAll(tree, (el) => el.type === "button" && el.props["aria-label"] === label);
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
        if (renderCount > 4000) throw new Error("render loop suspected in curriculum harness");
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

async function flush(ticks = 80): Promise<void> {
    for (let i = 0; i < ticks; i += 1) {
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

function countingPort(counter: { streams: number; chats: number }) {
    return {
        async *streamChat(_messages: unknown, _opts?: unknown) {
            counter.streams += 1;
            throw new Error("network must stay idle in the curriculum test");
            yield { delta: "", text: "", done: true };
        },
        async chat(_messages: unknown, _opts?: unknown) {
            counter.chats += 1;
            throw new Error("network must stay idle in the curriculum test");
        },
    };
}

describe("agent console curriculum chips", () => {
    it("renders one chip per curriculum lesson", () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        const m = mountConsole({
            offline: true,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction: () => {},
            chatClient: countingPort({ streams: 0, chats: 0 }),
            initialTurns: [],
        });
        try {
            expect(CURRICULUM_CHIPS).toHaveLength(4);
            for (const chip of CURRICULUM_CHIPS) {
                const found = buttonsByLabel(m.tree(), `${chip.label} lesson`);
                expect(found).toHaveLength(1);
                expect(textOf(found[0])).toContain(chip.label);
                expect(found[0].props.disabled).toBe(false);
            }
        } finally {
            m.unmount();
        }
    });
    it("dispatches a chip prompt as a normal offline turn with zero port calls", async () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        const onAgentAction = vi.fn();
        const counter = { streams: 0, chats: 0 };
        const m = mountConsole({
            offline: true,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction,
            chatClient: countingPort(counter),
            initialTurns: [],
        });
        const chip = CURRICULUM_CHIPS[0];
        const found = buttonsByLabel(m.tree(), `${chip.label} lesson`);
        expect(found).toHaveLength(1);
        (found[0].props.onClick as () => void)();
        await flush();
        try {
            expect(counter.streams).toBe(0);
            expect(counter.chats).toBe(0);
            expect(m.text()).toContain(chip.prompt);
            expect(m.text().toLowerCase()).toContain("local");
        } finally {
            m.unmount();
        }
    });
    it("disables every curriculum chip while busy", () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        const m = mountConsole({
            offline: true,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction: () => {},
            chatClient: countingPort({ streams: 0, chats: 0 }),
            initialTurns: [],
            initialBusy: true,
        });
        try {
            for (const chip of CURRICULUM_CHIPS) {
                const found = buttonsByLabel(m.tree(), `${chip.label} lesson`);
                expect(found).toHaveLength(1);
                expect(found[0].props.disabled).toBe(true);
            }
        } finally {
            m.unmount();
        }
    });
});
