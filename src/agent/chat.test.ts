// Agent console transcript store and intent router tests.

import { describe, expect, it, beforeEach } from "vitest";
import { loadTurns, saveTurns, clearTurns, appendTurns, CHAT_CAP } from "./chatStore";
import { routeIntent, OFFLINE_TEMPLATES } from "./intents";
import type { ChatTurn } from "@/contracts/types";

function turn(id: string, text: string): ChatTurn {
    return { id, role: "user", text, at: new Date().toISOString() };
}

/** Node test env has no DOM storage, install a memory backed stub. */
function installMemoryStorage(): void {
    const store = new Map<string, string>();
    const stub = {
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
    (globalThis as Record<string, unknown>).localStorage = stub;
}

describe("chatStore", () => {
    beforeEach(() => {
        installMemoryStorage();
        clearTurns();
    });

    it("round trips turns through save and load", () => {
        saveTurns([turn("a", "hello"), turn("b", "world")]);
        const loaded = loadTurns();
        expect(loaded.map((t) => t.id)).toEqual(["a", "b"]);
    });

    it("caps the transcript at 50 turns", () => {
        const many = Array.from({ length: CHAT_CAP + 10 }, (_, i) => turn(`t${i}`, `msg ${i}`));
        saveTurns(many);
        const loaded = loadTurns();
        expect(loaded.length).toBe(CHAT_CAP);
        expect(loaded[0].id).toBe("t10");
    });

    it("appends and persists without duplicating", () => {
        const first = appendTurns([], turn("a", "one"));
        expect(first.length).toBe(1);
        const second = appendTurns(first, turn("b", "two"));
        expect(second.length).toBe(2);
        expect(loadTurns().length).toBe(2);
    });

    it("returns [] on corrupt or foreign versions", () => {
        localStorage.setItem("gearflow:chat:v1", "not json");
        expect(loadTurns()).toEqual([]);
        localStorage.setItem("gearflow:chat:v1", JSON.stringify({ version: 999, turns: [turn("x", "y")] }));
        expect(loadTurns()).toEqual([]);
    });

    it("clearTurns empties the transcript", () => {
        saveTurns([turn("a", "hello")]);
        clearTurns();
        expect(loadTurns()).toEqual([]);
    });
});

describe("routeIntent", () => {
    it("routes explanation keywords to explain", () => {
        expect(routeIntent("Explain this run, why did Cl change").kind).toBe("explain");
    });

    it("routes design keywords to spec", () => {
        expect(routeIntent("Thicken the section a touch").kind).toBe("spec");
        expect(routeIntent("Raise alpha to 8 degrees").kind).toBe("spec");
        expect(routeIntent("More camber please").kind).toBe("spec");
    });

    it("routes sketch keywords to sam", () => {
        expect(routeIntent("Segment this sketch of a wing").kind).toBe("sam");
    });

    it("routes poster keywords to poster", () => {
        expect(routeIntent("Render a poster of this study").kind).toBe("poster");
    });

    it("falls back to chat for anything else", () => {
        const intent = routeIntent("Hello, what can you do here");
        expect(intent.kind).toBe("chat");
        expect(intent.confidence).toBeLessThanOrEqual(0.5);
    });

    it("has an offline template for every intent", () => {
        for (const kind of ["explain", "spec", "sam", "poster", "chat"] as const) {
            expect(typeof OFFLINE_TEMPLATES[kind]).toBe("string");
            expect(OFFLINE_TEMPLATES[kind].length).toBeGreaterThan(0);
        }
    });
});
