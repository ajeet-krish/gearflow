// Agent console wiring behavior. Drives the real AgentConsole component
// through a hook dispatcher shim (zero new deps, zero live calls) plus the
// real BasetenClient with fake fetch, so auto run, busy lock, offline, and
// spend regressions fail instead of passing silently.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import AgentConsole, { BASETEN_FEATURE, PRESET_CHIPS, SPEND_SOFT_STOP_USD, spendExceeded } from "./AgentConsole";
import { parseAgentEnvelope } from "@/agent/agentActions";
import { buildAgentContext } from "@/agent/agentContext";
import { BasetenClient } from "@/agent/basetenClient";

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
            // Restore is best effort, later tests remount cleanly.
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

function buttonsByText(tree: unknown, text: string): TestEl[] {
    return findAll(tree, (el) => el.type === "button" && textOf(el) === text);
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

function badgeTexts(tree: unknown, badge: string): TestEl[] {
    return findAll(
        tree,
        (el) =>
            (el.type === "span" || el.type === "p") &&
            typeof el.props.className === "string" &&
            (el.props.className as string).includes("badge") &&
            textOf(el) === badge
    );
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
        if (renderCount > 2000) throw new Error("render loop suspected in console harness");
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
        backend: "lbm pending",
        engine: "lbm",
        gridLabel: "128x128",
        cl: Number.NaN,
        cpMin: Number.NaN,
        lbmStatus: "idle",
        lbmHasSnapshot: false,
        lbmEffective: true,
        lbmStatsReady: false,
        lbmStats: null,
        variable: "speed",
        effectiveVariable: "speed",
        hasTke: false,
        hasRecirc: false,
        validation: { pass: 0, warn: 0, fail: 0, info: 0 },
        provenanceLabel: "lbm pending placeholder",
        offline: false,
    };
}

function streamingPort(text: string, counter: { streams: number; chats: number }) {
    const result = () => ({
        text,
        action: null,
        model: "meta-models/muse-spark-open-1026",
        usage: { inputTokens: 12, outputTokens: 24, cachedTokens: 0 },
        costUsd: 0.0001,
        latencyMs: 5,
    });
    return {
        async *streamChat(_messages: unknown, _opts?: unknown) {
            counter.streams += 1;
            yield { delta: text, text, done: false };
            return result();
        },
        async chat(_messages: unknown, _opts?: unknown) {
            counter.chats += 1;
            return result();
        },
    };
}

function hangingPort(counter: { streams: number; chats: number }) {
    const abortableGate = (signal?: AbortSignal): Promise<void> =>
        new Promise<void>((_resolve, reject) => {
            const fail = (): void => {
                const err = new Error("stopped by the Stop control");
                err.name = "AbortError";
                reject(err);
            };
            if (signal?.aborted) {
                fail();
                return;
            }
            signal?.addEventListener("abort", fail, { once: true });
        });
    return {
        async *streamChat(_messages: unknown, opts?: { signal?: AbortSignal }) {
            counter.streams += 1;
            await abortableGate(opts?.signal);
            yield { delta: "", text: "", done: true };
            return {
                text: "",
                action: null,
                model: "meta-models/muse-spark-open-1026",
                usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
                costUsd: 0,
                latencyMs: 0,
            };
        },
        async chat(_messages: unknown, _opts?: unknown) {
            counter.chats += 1;
            return {
                text: "plain fallback",
                action: null,
                model: "meta-models/muse-spark-open-1026",
                usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
                costUsd: 0,
                latencyMs: 0,
            };
        },
    };
}

function statusResponse(status: number, retryAfter: string | null): Record<string, unknown> {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? retryAfter : null) },
        json: async () => ({ error: { message: "Baseten service unavailable" } }),
        text: async () => JSON.stringify({ error: { message: "Baseten service unavailable" } }),
        body: null,
    };
}

const RUN_ENVELOPE = "Ready to solve. The viscous run is staged.\n```action-json\n{\"kind\":\"run_lbm\"}\n```";
const SETUP_ENVELOPE = "Tuning alpha now.\n```action-json\n{\"kind\":\"set_alpha\",\"alphaDeg\":6}\n```";
const NEURAL_REJECTED_SETUP_ENVELOPE =
    "Shedding case request.\n```action-json\n{\"kind\":\"setup_shedding\"}\n```";

describe("agent console run gating", () => {
    it("parks a run_lbm envelope on the confirm chip with zero executor calls", async () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        const onAgentAction = vi.fn();
        const counter = { streams: 0, chats: 0 };
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction,
            chatClient: streamingPort(RUN_ENVELOPE, counter),
            initialTurns: [],
        });
        typeText(m, "please run the viscous solve");
        submitForm(m);
        await flush();
        try {
            expect(counter.streams).toBe(1);
            expect(onAgentAction).not.toHaveBeenCalled();
            const confirms = buttonsByLabel(m.tree(), "Confirm Run LBM solve");
            expect(confirms).toHaveLength(1);
            expect(m.text()).toContain("Ready to solve");
            expect(m.text()).not.toContain("action-json");
            expect(m.text()).not.toContain("Applied after confirm");
        } finally {
            m.unmount();
        }
    });

    it("fires the executor exactly once on confirm and clears the chip", async () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        const onAgentAction = vi.fn();
        const counter = { streams: 0, chats: 0 };
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction,
            chatClient: streamingPort(RUN_ENVELOPE, counter),
            initialTurns: [],
        });
        typeText(m, "please run the viscous solve");
        submitForm(m);
        await flush();
        try {
            const confirms = buttonsByLabel(m.tree(), "Confirm Run LBM solve");
            expect(confirms).toHaveLength(1);
            (confirms[0].props.onClick as () => void)();
            expect(onAgentAction).toHaveBeenCalledTimes(1);
            expect(onAgentAction).toHaveBeenCalledWith({ kind: "run_lbm" });
            await flush(5);
            expect(buttonsByLabel(m.tree(), "Confirm Run LBM solve")).toHaveLength(0);
            expect(m.text()).toContain("Applied after confirm: Run LBM.");
        } finally {
            m.unmount();
        }
    });

    it("auto applies setup actions while run actions wait for confirm", async () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        const onAgentAction = vi.fn();
        const counter = { streams: 0, chats: 0 };
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction,
            chatClient: streamingPort(SETUP_ENVELOPE, counter),
            initialTurns: [],
        });
        typeText(m, "tune alpha to six");
        submitForm(m);
        await flush();
        try {
            expect(onAgentAction).toHaveBeenCalledTimes(1);
            expect(onAgentAction).toHaveBeenCalledWith({ kind: "set_alpha", alphaDeg: 6 });
            expect(m.text()).toContain("Applied: alpha 6.");
            expect(buttonsByLabel(m.tree(), "Confirm Run LBM solve")).toHaveLength(0);
            const reply = parseAgentEnvelope(SETUP_ENVELOPE, {
                lbmEffective: true,
                statsReady: false,
                hasTke: false,
                hasRecirc: false,
            });
            expect(reply.actions).toEqual([{ kind: "set_alpha", alphaDeg: 6 }]);
            expect(reply.reply).not.toContain("action-json");
        } finally {
            m.unmount();
        }
    });

    it("leaves the executor idle for a neural rejected setup with zero actions", async () => {
        const ctx = buildAgentContext({ ...pendingSnapshot(), neuralAvailable: true } as never);
        expect(ctx.neural.available).toBe(true);
        const onAgentAction = vi.fn();
        const counter = { streams: 0, chats: 0 };
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction,
            chatClient: streamingPort(NEURAL_REJECTED_SETUP_ENVELOPE, counter),
            initialTurns: [],
        });
        typeText(m, "show vortex shedding while the neural path serves");
        submitForm(m);
        await flush();
        try {
            expect(counter.streams).toBe(1);
            expect(onAgentAction).not.toHaveBeenCalled();
            expect(m.text()).toContain("Shedding case request.");
            expect(m.text()).not.toContain("action-json");
            expect(m.text()).toContain("Rejected:");
            expect(m.text()).toContain("Analytic path serves this case instead.");
            expect(buttonsByLabel(m.tree(), "Confirm Run LBM solve")).toHaveLength(0);
            expect(m.text()).not.toContain("Applied:");
        } finally {
            m.unmount();
        }
    });
});

describe("agent console busy lock", () => {
    it("ignores a second submit while busy and stops on demand", async () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        const onAgentAction = vi.fn();
        const counter = { streams: 0, chats: 0 };
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: ctx,
            onAgentAction,
            chatClient: hangingPort(counter),
            initialTurns: [],
        });
        typeText(m, "please run the viscous solve");
        submitForm(m);
        await flush(10);
        try {
            expect(counter.streams).toBe(1);
            expect(buttonsByLabel(m.tree(), "Stop the streaming reply")).toHaveLength(1);
            expect(buttonsByLabel(m.tree(), "Send chat message")).toHaveLength(0);
            for (const chip of PRESET_CHIPS) {
                const found = buttonsByText(m.tree(), chip);
                expect(found.length).toBeGreaterThan(0);
                for (const el of found) expect(el.props.disabled).toBe(true);
            }
            typeText(m, "a second submit while busy");
            submitForm(m);
            await flush(10);
            expect(counter.streams).toBe(1);
            expect(counter.chats).toBe(0);
            const stop = buttonsByLabel(m.tree(), "Stop the streaming reply");
            expect(stop).toHaveLength(1);
            (stop[0].props.onClick as () => void)();
            await flush();
            expect(counter.streams).toBe(1);
            expect(badgeTexts(m.tree(), "stopped")).toHaveLength(1);
            expect(m.text()).toContain("Stopped, partial reply discarded.");
            expect(buttonsByLabel(m.tree(), "Send chat message")).toHaveLength(1);
        } finally {
            m.unmount();
        }
    });
});

describe("agent console offline paths", () => {
    it("answers locally on the offline toggle with zero fetch calls", async () => {
        const fetchFn = vi.fn(async () => {
            throw new Error("network must stay idle while offline");
        });
        const client = new BasetenClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
        const onAgentAction = vi.fn();
        const m = mountConsole({
            offline: true,
            onOfflineChange: () => {},
            agentContext: buildAgentContext(pendingSnapshot() as never),
            onAgentAction,
            chatClient: client,
            initialTurns: [],
        });
        typeText(m, "please explain this run");
        submitForm(m);
        await flush();
        try {
            expect(fetchFn).not.toHaveBeenCalled();
            expect(onAgentAction).not.toHaveBeenCalled();
            expect(m.text()).toContain("engineer note, local only");
            expect(m.text()).toContain("Canvas unchanged");
            expect(badgeTexts(m.tree(), "offline").length).toBeGreaterThan(0);
        } finally {
            m.unmount();
        }
    });

    it("renders the offline badge when the proxy answers 503", async () => {
        const fetchFn = vi.fn(async () => statusResponse(503, "0"));
        const client = new BasetenClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
        const onAgentAction = vi.fn();
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: buildAgentContext(pendingSnapshot() as never),
            onAgentAction,
            chatClient: client,
            initialTurns: [],
        });
        typeText(m, "please explain this run");
        submitForm(m);
        await flush(120);
        try {
            expect(fetchFn).toHaveBeenCalled();
            expect(onAgentAction).not.toHaveBeenCalled();
            expect(m.text()).toContain("Baseten unreachable, local mode. Canvas unchanged.");
            expect(badgeTexts(m.tree(), "offline").length).toBeGreaterThan(0);
        } finally {
            m.unmount();
        }
    });

    it("renders the offline badge when fetch fails outright", async () => {
        const fetchFn = vi.fn(async () => {
            throw new TypeError("fetch failed");
        });
        const client = new BasetenClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
        const onAgentAction = vi.fn();
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: buildAgentContext(pendingSnapshot() as never),
            onAgentAction,
            chatClient: client,
            initialTurns: [],
        });
        typeText(m, "please explain this run");
        submitForm(m);
        await flush(120);
        try {
            expect(fetchFn).toHaveBeenCalled();
            expect(onAgentAction).not.toHaveBeenCalled();
            expect(m.text()).toContain("Baseten unreachable, local mode. Canvas unchanged.");
            expect(badgeTexts(m.tree(), "offline").length).toBeGreaterThan(0);
        } finally {
            m.unmount();
        }
    });
});

describe("agent console spend gate", () => {
    it("forces local mode with a cap note once the session crosses five dollars", async () => {
        expect(SPEND_SOFT_STOP_USD).toBe(5);
        expect(spendExceeded(5)).toBe(true);
        expect(spendExceeded(4.9999)).toBe(false);
        expect(spendExceeded(Number.NaN)).toBe(false);
        expect(spendExceeded(10, 20)).toBe(false);
        expect(spendExceeded(25, 20)).toBe(true);
        const counter = { streams: 0, chats: 0 };
        const onAgentAction = vi.fn();
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: buildAgentContext(pendingSnapshot() as never),
            onAgentAction,
            chatClient: streamingPort("Live reply that must never send.", counter),
            spendCapUsd: 0,
            initialTurns: [],
        });
        typeText(m, "please explain this run");
        submitForm(m);
        await flush();
        try {
            expect(counter.streams).toBe(0);
            expect(counter.chats).toBe(0);
            expect(onAgentAction).not.toHaveBeenCalled();
            expect(m.text()).toContain("local mode until reset");
            expect(m.text()).toContain("engineer note, local only");
            expect(m.text()).toContain("Canvas unchanged");
        } finally {
            m.unmount();
        }
    });

    it("keeps the live path free of local mode notes under the cap", () => {
        const counter = { streams: 0, chats: 0 };
        const m = mountConsole({
            offline: false,
            onOfflineChange: () => {},
            agentContext: buildAgentContext(pendingSnapshot() as never),
            onAgentAction: () => {},
            chatClient: streamingPort("Live reply.", counter),
            initialTurns: [],
        });
        try {
            expect(m.text()).not.toContain("local mode until reset");
            expect(buttonsByLabel(m.tree(), "Send chat message")).toHaveLength(1);
            expect(BASETEN_FEATURE).toBe("baseten-chat");
        } finally {
            m.unmount();
        }
    });
});
