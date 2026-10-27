// Phase 6 review fixes: reload apply actions, intent false positives,
// poisoned snapshots, oversize text, NaN quantity packing.

import { describe, expect, it, beforeEach } from "vitest";
import {
    loadTurns,
    saveTurns,
    clearTurns,
    loadChatActions,
    saveChatActions,
    loadChatState,
    rebuildActionsFromTurns,
    CHAT_STORAGE_KEY,
    CHAT_ACTIONS_KEY,
} from "@/agent/chatStore";
import { routeIntent } from "@/agent/intents";
import { createFieldTextures, updateFieldTextures, disposeFieldTextures } from "@/render/fieldTexture";
import type { ChatTurn, FlowField, ParametricSpec } from "@/contracts/types";

function installMemoryStorage(): Map<string, string> {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
        getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
        setItem: (k: string, v: string): void => {
            store.set(k, String(v));
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
    return store;
}

const VALID_SPEC: ParametricSpec = {
    geometry: {
        kind: "naca4",
        naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
        chord: 1,
        alphaDeg: 6,
        nPoints: 120,
    },
    reynolds: 50000,
    rationale: "test spec",
};

function makeFlow(nx = 4, ny = 4): FlowField {
    const n = nx * ny;
    return {
        nx,
        ny,
        domain: { xMin: -0.5, xMax: 2, yMin: -1, yMax: 1 },
        u: new Float32Array(n).fill(0.5),
        v: new Float32Array(n).fill(0.1),
        p: new Float32Array(n).fill(-0.2),
        omega: new Float32Array(n).fill(0.05),
        obstacle: new Float32Array(n),
    };
}

describe("review fix: reload apply actions survive reload", () => {
    beforeEach(() => {
        installMemoryStorage();
        clearTurns();
    });

    it("persists spec actions and rebuilds them from snapshots on load", () => {
        const turns: ChatTurn[] = [
            {
                id: "a1",
                role: "assistant",
                text: "Proposed NACA 2412",
                at: "2026-10-27T00:00:01Z",
                tool: "spark-spec",
                status: "offline",
                specSnapshot: VALID_SPEC,
            },
        ];
        saveTurns(turns);
        saveChatActions({ a1: { kind: "spec", spec: VALID_SPEC } });
        const state = loadChatState();
        expect(state.turns.length).toBe(1);
        expect(state.actions["a1"]).toBeDefined();
        expect(state.actions["a1"].spec).toEqual(VALID_SPEC);
    });

    it("rebuilds spec actions from snapshots when the actions key is missing", () => {
        const turns: ChatTurn[] = [
            {
                id: "b1",
                role: "assistant",
                text: "chat proposal",
                at: "2026-10-27T00:00:02Z",
                tool: "chat",
                status: "live",
                specSnapshot: VALID_SPEC,
            },
        ];
        saveTurns(turns);
        const rebuilt = rebuildActionsFromTurns(loadTurns());
        expect(rebuilt["b1"]).toBeDefined();
        expect(rebuilt["b1"].kind).toBe("spec");
        const state = loadChatState();
        expect(state.actions["b1"]).toBeDefined();
    });

    it("drops actions whose stored spec is poisoned", () => {
        const bad = {
            geometry: { kind: "naca4", chord: 1, alphaDeg: 9999, nPoints: 120 },
            reynolds: 50,
            rationale: "",
        };
        localStorage.setItem(
            CHAT_ACTIONS_KEY,
            JSON.stringify({ version: 1, actions: { x1: { kind: "spec", spec: bad } } })
        );
        expect(loadChatActions([])["x1"]).toBeUndefined();
    });
});

describe("review fix: intent word boundaries", () => {
    it("does not route substrings inside larger words to spec", () => {
        expect(routeIntent("I was thinking about the run").kind).not.toBe("spec");
        expect(routeIntent("go within the tunnel").kind).not.toBe("spec");
        expect(routeIntent("thinking through lift").kind).toBe("chat");
    });

    it("still routes whole word hits", () => {
        expect(routeIntent("make it thin").kind).toBe("spec");
        expect(routeIntent("raise alpha to 8").kind).toBe("spec");
        expect(routeIntent("explain this run").kind).toBe("explain");
    });

    it("uses ctx without throwing", () => {
        expect(routeIntent("explain this run", { metricsReady: false }).kind).toBe("explain");
        expect(routeIntent("explain this run", { metricsReady: false }).confidence).toBeLessThan(0.8);
        expect(routeIntent("segment this sketch", { geometryKind: "custom" }).confidence).toBeGreaterThan(0.8);
    });
});

describe("review fix: chatStore injection hardening", () => {
    beforeEach(() => {
        installMemoryStorage();
        clearTurns();
    });

    it("drops the snapshot field when specSnapshot is poisoned but keeps the turn", () => {
        const raw = {
            version: 1,
            turns: [
                {
                    id: "p1",
                    role: "assistant",
                    text: "poisoned",
                    at: "2026-10-27T00:00:01Z",
                    tool: "chat",
                    status: "live",
                    specSnapshot: { geometry: { kind: "naca4", chord: 1, alphaDeg: "boom", nPoints: 120 }, reynolds: 1, rationale: "" },
                },
            ],
        };
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(raw));
        const loaded = loadTurns();
        expect(loaded.length).toBe(1);
        expect(loaded[0].specSnapshot).toBeUndefined();
    });

    it("rejects turns with disallowed tool or status enums", () => {
        const raw = {
            version: 1,
            turns: [
                { id: "ok", role: "user", text: "hi", at: "2026-10-27T00:00:01Z" },
                { id: "badtool", role: "assistant", text: "x", at: "2026-10-27T00:00:02Z", tool: "evil-tool" },
                { id: "badstatus", role: "assistant", text: "x", at: "2026-10-27T00:00:03Z", status: "pwned" },
            ],
        };
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(raw));
        expect(loadTurns().map((t) => t.id)).toEqual(["ok"]);
    });

    it("rejects oversize id and text over 2000 chars", () => {
        const big = "x".repeat(2001);
        const raw = {
            version: 1,
            turns: [
                { id: big, role: "user", text: "hi", at: "2026-10-27T00:00:01Z" },
                { id: "bigtext", role: "user", text: big, at: "2026-10-27T00:00:02Z" },
                { id: "ok", role: "user", text: "fine", at: "2026-10-27T00:00:03Z" },
            ],
        };
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(raw));
        expect(loadTurns().map((t) => t.id)).toEqual(["ok"]);
    });
});

describe("review fix: fieldTexture finite quantity", () => {
    it("rejects NaN cp on the cp variable path", () => {
        const flow = makeFlow();
        flow.p[3] = Number.NaN;
        expect(() => createFieldTextures(flow, "viridis", "cp")).toThrow(/finite/);
    });

    it("rejects NaN omega on the omega variable path and update path", () => {
        const flow = makeFlow();
        flow.omega[5] = Number.NaN;
        expect(() => createFieldTextures(flow, "viridis", "omega")).toThrow(/finite/);
        const good = makeFlow();
        const tex = createFieldTextures(good, "viridis", "speed");
        const bad = makeFlow();
        bad.p[2] = Number.POSITIVE_INFINITY;
        expect(() => updateFieldTextures(tex, bad, "viridis", "cp")).toThrow(/finite/);
        disposeFieldTextures(tex);
    });
});
