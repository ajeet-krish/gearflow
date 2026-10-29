// Phase T2 agent console tutor hook. Drives the real AgentConsole through
// a hook dispatcher shim with effect support (zero live calls), so the
// pending tutor state machine, the dedupe, the offline table, the run-only
// silence, and the timeout path fail here instead of passing silently.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import AgentConsole, {
    TUTOR_FEATURE,
    TUTOR_LOADING_LINE,
    TUTOR_TIMEOUT_MS,
    snapshotLiteFor,
} from "./AgentConsole";
import { buildAgentContext } from "@/agent/agentContext";
import { buildTutorTable } from "@/agent/tutorTable";
import { g_evalLog } from "@/meta/evalLog";

const INTERNALS = (
    React as unknown as {
        __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } };
    }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

const mounted: Array<() => void> = [];

function installMemoryStorage(): void {
    const store = new Map<string, string>();
    const stub = {
        getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
        setItem: (k: string, v: string): void => {
            store.set(String(k), String(v));
        },
        removeItem: (k: string): void => {
            store.delete(k);
        },
        clear: (): void => {
            store.clear();
        },
        key: (i: number): string | null => [...store.keys()][i] ?? null,
        get length(): number {
            return store.size;
        },
    };
    (globalThis as Record<string, unknown>).localStorage = stub;
}

beforeEach(() => {
    installMemoryStorage();
    try {
        g_evalLog.clear();
    } catch {
        // Clearing the shared ledger is best effort in the harness.
    }
});

afterEach(() => {
    try {
        vi.restoreAllMocks();
    } catch {
        // Mock restore is best effort.
    }
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

function tutorBlocks(tree: unknown): TestEl[] {
    return findAll(
        tree,
        (el) =>
            el.type === "div" &&
            typeof el.props.className === "string" &&
            (el.props.className as string).includes("tutorBlock")
    );
}

function tutorTables(tree: unknown): TestEl[] {
    return findAll(
        tree,
        (el) =>
            el.type === "table" &&
            typeof el.props.className === "string" &&
            (el.props.className as string).includes("tutorTable")
    );
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

interface MountedTutor {
    tree: () => unknown;
    text: () => string;
    setProps: (next: Record<string, unknown>) => void;
    unmount: () => void;
}

function mountTutor(baseProps: Record<string, unknown>): MountedTutor {
    const cells: Array<{ v: unknown }> = [];
    const effects: Array<{ deps: unknown[] | undefined; cleanup: unknown }> = [];
    let hookIndex = 0;
    let effectIndex = 0;
    let pendingFx: number[] = [];
    let currentTree: unknown = null;
    let currentProps: Record<string, unknown> = baseProps;
    let renderCount = 0;
    const prev = INTERNALS.ReactCurrentDispatcher.current;
    const runPending = (): void => {
        const due = pendingFx;
        pendingFx = [];
        for (const i of due) {
            const slot = effects[i];
            try {
                const prevCleanup = slot.cleanup as (() => void) | undefined;
                if (typeof prevCleanup === "function") prevCleanup();
            } catch {
                // Cleanup faults never break the harness.
            }
            slot.cleanup = undefined;
            // The effect fn was captured at registration time below.
            const fn = (slot as unknown as { fn: () => void | (() => void) }).fn;
            try {
                const out = fn();
                if (typeof out === "function") slot.cleanup = out;
            } catch {
                // Effect faults never break the harness.
            }
        }
    };
    const renderOnce = (): void => {
        renderCount += 1;
        if (renderCount > 2000) throw new Error("render loop suspected in tutor harness");
        hookIndex = 0;
        effectIndex = 0;
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
            useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
                const i = effectIndex++;
                const slot = effects[i] as unknown as { deps: unknown[] | undefined; cleanup: unknown; fn: () => void | (() => void) } | undefined;
                const changed =
                    slot === undefined ||
                    deps === undefined ||
                    slot.deps === undefined ||
                    deps.length !== slot.deps.length ||
                    deps.some((d, k) => !Object.is(d, (slot.deps as unknown[])[k]));
                if (changed) {
                    effects[i] = { deps, cleanup: slot?.cleanup, fn } as unknown as (typeof effects)[number];
                    pendingFx.push(i);
                }
            },
        };
        currentTree = (AgentConsole as unknown as (p: Record<string, unknown>) => unknown)(currentProps);
        runPending();
    };
    renderOnce();
    const unmount = (): void => {
        INTERNALS.ReactCurrentDispatcher.current = prev;
    };
    mounted.push(unmount);
    return {
        tree: () => currentTree,
        text: () => textOf(currentTree),
        setProps: (next: Record<string, unknown>) => {
            currentProps = next;
            renderOnce();
        },
        unmount: () => {
            const at = mounted.indexOf(unmount);
            if (at >= 0) mounted.splice(at, 1);
            unmount();
        },
    };
}

function typeText(m: MountedTutor, value: string): void {
    (findInput(m.tree()).props.onChange as (e: unknown) => void)({ target: { value } });
}

function submitForm(m: MountedTutor): void {
    (findForm(m.tree()).props.onSubmit as (e: unknown) => void)({ preventDefault: () => {} });
}

async function flush(ticks = 80): Promise<void> {
    for (let i = 0; i < ticks; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

function tutorPort(log: { chats: number; streams: number }, tutorText = "Spark tutor prose, plain words."): {
    streamChat: (m: unknown, o?: unknown) => AsyncGenerator<{ delta: string; text: string; done: boolean }, { text: string; action: null; model: string; usage: { inputTokens: number; outputTokens: number; cachedTokens: number }; costUsd: number; latencyMs: number }, void>;
    chat: (m: unknown, o?: unknown) => Promise<{ text: string; action: null; model: string; usage: { inputTokens: number; outputTokens: number; cachedTokens: number }; costUsd: number; latencyMs: number }>;
} {
    const result = () => ({
        text: tutorText,
        action: null,
        model: "test-spark",
        usage: { inputTokens: 4, outputTokens: 8, cachedTokens: 0 },
        costUsd: 0,
        latencyMs: 2,
    });
    return {
        async *streamChat(_m: unknown, _o?: unknown) {
            log.streams += 1;
            yield { delta: "x", text: "x", done: false };
            return result();
        },
        async chat(_m: unknown, _o?: unknown) {
            log.chats += 1;
            return result();
        },
    };
}

function settledSnapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 5, nPoints: 120 },
        reynolds: 50000,
        regime: "laminar, attached",
        bodyLabel: "NACA 2412",
        backend: "analytic live 128",
        engine: "analytic",
        gridLabel: "128x128",
        cl: 0.6,
        cpMin: -1.1,
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
        provenanceLabel: "analytic potential flow, not validated",
        offline: false,
        caseKey: "case-before",
        frameSettled: true,
        ...over,
    };
}

describe("agent console tutor hook (T2)", () => {
    it("renders exactly one tutor turn after one applied case settles, once on rerender", async () => {
        expect(TUTOR_TIMEOUT_MS).toBe(2500);
        const before = buildAgentContext(settledSnapshot() as never);
        const log = { chats: 0, streams: 0 };
        const onAgentAction = vi.fn();
        const evalSink = vi.fn();
        const base = {
            offline: false,
            onOfflineChange: () => {},
            agentContext: before,
            onAgentAction,
            chatClient: tutorPort(log),
            evalSink,
            initialTurns: [],
        };
        const m = mountTutor(base);
        try {
            typeText(m, "Set up NACA 2412 alpha 6 Re 50000");
            submitForm(m);
            await flush();
            // Parser fast path: three canvas writes, zero port calls.
            expect(log.streams).toBe(0);
            expect(log.chats).toBe(0);
            expect(onAgentAction).toHaveBeenCalledTimes(3);
            expect(tutorBlocks(m.tree())).toHaveLength(0);
            const after = buildAgentContext(
                settledSnapshot({
                    spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
                    cl: 0.7,
                    cpMin: -1.3,
                    caseKey: "case-after",
                    frameSettled: true,
                }) as never
            );
            m.setProps({ ...base, agentContext: after });
            await flush();
            expect(log.chats).toBe(1);
            expect(tutorBlocks(m.tree())).toHaveLength(1);
            expect(m.text()).toContain("attached-lift");
            expect(m.text()).toContain("Spark tutor prose");
            expect(m.text()).toContain("Before vs after");
            expect(m.text()).toContain("Applied: body naca2412.");
            const rows = buildTutorTable(snapshotLiteFor(before), snapshotLiteFor(after));
            // T2 frontend renders rows as a real numbers table, never raw pipes.
            expect(tutorTables(m.tree())).toHaveLength(1);
            expect(textOf(tutorTables(m.tree())[0])).toContain(rows[0].metric);
            expect(textOf(tutorTables(m.tree())[0])).toContain(rows[0].before);
            expect(evalSink).toHaveBeenCalledWith({ feature: TUTOR_FEATURE, model: "test-spark" });
            expect(TUTOR_FEATURE).toBe("tutor");
            // Rerender with the same settled key fires nothing more.
            m.setProps({ ...base, agentContext: after });
            await flush();
            expect(log.chats).toBe(1);
            expect(tutorBlocks(m.tree())).toHaveLength(1);
        } finally {
            m.unmount();
        }
    });

    it("answers offline with zero network and the identical table", async () => {
        const before = buildAgentContext(settledSnapshot() as never);
        const log = { chats: 0, streams: 0 };
        const onAgentAction = vi.fn();
        const base = {
            offline: true,
            onOfflineChange: () => {},
            agentContext: before,
            onAgentAction,
            chatClient: tutorPort(log),
            initialTurns: [],
        };
        const m = mountTutor(base);
        try {
            typeText(m, "Set up NACA 2412 alpha 6 Re 50000");
            submitForm(m);
            await flush();
            expect(onAgentAction).toHaveBeenCalledTimes(3);
            const after = buildAgentContext(
                settledSnapshot({
                    spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
                    cl: 0.7,
                    cpMin: -1.3,
                    caseKey: "case-after-offline",
                    frameSettled: true,
                    offline: true,
                }) as never
            );
            m.setProps({ ...base, agentContext: after });
            await flush();
            expect(log.chats).toBe(0);
            expect(log.streams).toBe(0);
            expect(tutorBlocks(m.tree())).toHaveLength(1);
            const rows = buildTutorTable(snapshotLiteFor(before), snapshotLiteFor(after));
            // T2 frontend renders rows as real tables, never raw pipes.
            expect(tutorTables(m.tree()).length).toBeGreaterThan(0);
            for (const row of rows) {
                expect(m.text()).toContain(row.metric);
                expect(m.text()).toContain(row.before);
            }
            expect(m.text()).toContain("Quantity");
            expect(m.text()).toContain("Change");
            expect(m.text()).toContain("Caveat:");
        } finally {
            m.unmount();
        }
    });

    it("keeps run envelopes on the confirm chip with zero tutor", async () => {
        const RUN_ENVELOPE = "Ready to solve. The viscous run is staged.\n```action-json\n{\"kind\":\"run_lbm\"}\n```";
        const pending = buildAgentContext(
            settledSnapshot({ engine: "lbm", lbmEffective: true, caseKey: "case-run-before", frameSettled: true }) as never
        );
        const log = { chats: 0, streams: 0 };
        const onAgentAction = vi.fn();
        const fake = {
            async *streamChat(_m: unknown, _o?: unknown) {
                log.streams += 1;
                yield { delta: RUN_ENVELOPE, text: RUN_ENVELOPE, done: false };
                return {
                    text: RUN_ENVELOPE,
                    action: null,
                    model: "test-spark",
                    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
                    costUsd: 0,
                    latencyMs: 1,
                };
            },
            async chat(_m: unknown, _o?: unknown) {
                log.chats += 1;
                return {
                    text: RUN_ENVELOPE,
                    action: null,
                    model: "test-spark",
                    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
                    costUsd: 0,
                    latencyMs: 1,
                };
            },
        };
        const base = {
            offline: false,
            onOfflineChange: () => {},
            agentContext: pending,
            onAgentAction,
            chatClient: fake,
            initialTurns: [],
        };
        const m = mountTutor(base);
        try {
            typeText(m, "please run the viscous solve");
            submitForm(m);
            await flush();
            expect(onAgentAction).not.toHaveBeenCalled();
            expect(buttonsByLabel(m.tree(), "Confirm Run LBM solve")).toHaveLength(1);
            const after = buildAgentContext(
                settledSnapshot({ engine: "lbm", lbmEffective: true, caseKey: "case-run-after", frameSettled: true }) as never
            );
            m.setProps({ ...base, agentContext: after });
            await flush();
            expect(tutorBlocks(m.tree())).toHaveLength(0);
            expect(m.text()).not.toContain("Tutor:");
        } finally {
            m.unmount();
        }
    });

    it("dedupes a repeated settle on the same after key", async () => {
        const before = buildAgentContext(settledSnapshot() as never);
        const log = { chats: 0, streams: 0 };
        const onAgentAction = vi.fn();
        const base = {
            offline: false,
            onOfflineChange: () => {},
            agentContext: before,
            onAgentAction,
            chatClient: tutorPort(log),
            initialTurns: [],
        };
        const m = mountTutor(base);
        try {
            typeText(m, "Set up NACA 2412 alpha 6 Re 50000");
            submitForm(m);
            await flush();
            const after = buildAgentContext(
                settledSnapshot({
                    spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
                    cl: 0.7,
                    cpMin: -1.3,
                    caseKey: "case-dedupe",
                    frameSettled: true,
                }) as never
            );
            m.setProps({ ...base, agentContext: after });
            await flush();
            expect(tutorBlocks(m.tree())).toHaveLength(1);
            expect(log.chats).toBe(1);
            // A second applied turn settling on the same key renders no new tutor.
            typeText(m, "Set up NACA 2412 alpha 6 Re 50000");
            submitForm(m);
            await flush();
            m.setProps({ ...base, agentContext: after });
            await flush();
            expect(tutorBlocks(m.tree())).toHaveLength(1);
            expect(log.chats).toBe(1);
        } finally {
            m.unmount();
        }
    });

    it("fires the timeout path with the loading line and zero network", async () => {
        let now = 1_000_000;
        const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
            const before = buildAgentContext(settledSnapshot() as never);
            const log = { chats: 0, streams: 0 };
            const onAgentAction = vi.fn();
            const base = {
                offline: false,
                onOfflineChange: () => {},
                agentContext: before,
                onAgentAction,
                chatClient: tutorPort(log),
                initialTurns: [],
            };
            const m = mountTutor(base);
            try {
                typeText(m, "Set up NACA 2412 alpha 6 Re 50000");
                submitForm(m);
                await flush();
                expect(tutorBlocks(m.tree())).toHaveLength(0);
                now += TUTOR_TIMEOUT_MS + 100;
                const unsettled = buildAgentContext(
                    settledSnapshot({
                        spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
                        cl: 0.7,
                        cpMin: -1.3,
                        caseKey: "case-timeout",
                        frameSettled: false,
                    }) as never
                );
                m.setProps({ ...base, agentContext: unsettled });
                await flush();
                expect(log.chats).toBe(0);
                expect(tutorBlocks(m.tree())).toHaveLength(1);
                expect(m.text()).toContain(TUTOR_LOADING_LINE);
                expect(m.text()).toContain("Before vs after");
            } finally {
                m.unmount();
            }
        } finally {
            spy.mockRestore();
        }
    });

    it("suppresses the auto field write after a manual field change", async () => {
        const before = buildAgentContext(
            settledSnapshot({ regime: "stall, separated", caseKey: "case-stall-before", frameSettled: true }) as never
        );
        const log = { chats: 0, streams: 0 };
        const onAgentAction = vi.fn();
        const base = {
            offline: false,
            onOfflineChange: () => {},
            agentContext: before,
            onAgentAction,
            chatClient: tutorPort(log),
            initialTurns: [],
        };
        const m = mountTutor(base);
        try {
            typeText(m, "Set up NACA 2412 alpha 6 Re 50000");
            submitForm(m);
            await flush();
            expect(onAgentAction).toHaveBeenCalledTimes(3);
            // The stall concept suggests omega, but the operator already
            // moved to omega by hand, so the tutor must not rewrite it.
            const after = buildAgentContext(
                settledSnapshot({
                    spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
                    regime: "stall, separated",
                    variable: "omega",
                    effectiveVariable: "omega",
                    cl: 0.7,
                    cpMin: -1.3,
                    caseKey: "case-stall-after",
                    frameSettled: true,
                }) as never
            );
            m.setProps({ ...base, agentContext: after });
            await flush();
            expect(tutorBlocks(m.tree())).toHaveLength(1);
            expect(m.text()).toContain("stall-separation");
            const fieldWrites = onAgentAction.mock.calls.filter(
                (c) => (c[0] as { kind?: string }).kind === "set_field"
            );
            expect(fieldWrites).toHaveLength(0);
        } finally {
            m.unmount();
        }
    });

    it("fires a field-only apply on timeout with the loading line and the field reflected", async () => {
        let now = 2_000_000;
        const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
            const FIELD_ENVELOPE = "Switching field to cp.\n```action-json\n{\"kind\": \"set_field\", \"field\": \"cp\"}\n```";
            const before = buildAgentContext(
                settledSnapshot({ caseKey: "case-field-same", variable: "speed", effectiveVariable: "speed", frameSettled: true }) as never
            );
            const log = { chats: 0, streams: 0 };
            const onAgentAction = vi.fn();
            const fake = {
                async *streamChat(_m: unknown, _o?: unknown) {
                    log.streams += 1;
                    yield { delta: FIELD_ENVELOPE, text: FIELD_ENVELOPE, done: false };
                    return {
                        text: FIELD_ENVELOPE,
                        action: null,
                        model: "test-spark",
                        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
                        costUsd: 0,
                        latencyMs: 1,
                    };
                },
                async chat(_m: unknown, _o?: unknown) {
                    log.chats += 1;
                    return {
                        text: FIELD_ENVELOPE,
                        action: null,
                        model: "test-spark",
                        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
                        costUsd: 0,
                        latencyMs: 1,
                    };
                },
            };
            const base = {
                offline: false,
                onOfflineChange: () => {},
                agentContext: before,
                onAgentAction,
                chatClient: fake,
                initialTurns: [],
            };
            const m = mountTutor(base);
            try {
                typeText(m, "show me the cp field");
                submitForm(m);
                await flush();
                expect(onAgentAction).toHaveBeenCalledWith({ kind: "set_field", field: "cp" });
                expect(tutorBlocks(m.tree())).toHaveLength(0);
                now += TUTOR_TIMEOUT_MS + 100;
                const after = buildAgentContext(
                    settledSnapshot({
                        caseKey: "case-field-same",
                        variable: "cp",
                        effectiveVariable: "cp",
                        frameSettled: false,
                    }) as never
                );
                m.setProps({ ...base, agentContext: after });
                await flush();
                expect(log.chats).toBe(0);
                expect(tutorBlocks(m.tree())).toHaveLength(1);
                expect(m.text()).toContain(TUTOR_LOADING_LINE);
                expect(m.text()).toContain("Before vs after");
                expect(snapshotLiteFor(after).caseKey).toContain("fcp");
                expect(snapshotLiteFor(after).caseKey).not.toBe(snapshotLiteFor(before).caseKey);
            } finally {
                m.unmount();
            }
        } finally {
            spy.mockRestore();
        }
    });
});
