// Phase B2 chat store migration: old transcripts load, baseten tag survives.

import { beforeEach, describe, expect, it } from "vitest";
import { CHAT_STORAGE_KEY, clearTurns, isTutorPayload, loadTurns } from "./chatStore";

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

describe("chatStore migration", () => {
    beforeEach(() => {
        installMemoryStorage();
        clearTurns();
    });

    it("loads a version 1 transcript written before the baseten tag", () => {
        const legacy = {
            version: 1,
            turns: [
                { id: "u1", role: "user", text: "Explain this run", at: "2026-01-01T00:00:00.000Z" },
                { id: "a1", role: "assistant", text: "Offline note", at: "2026-01-01T00:00:01.000Z", tool: "chat", status: "offline" },
            ],
        };
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(legacy));
        const loaded = loadTurns();
        expect(loaded.map((t) => t.id)).toEqual(["u1", "a1"]);
    });

    it("keeps the new baseten tool tag through save and load", () => {
        const shape = {
            version: 1,
            turns: [
                { id: "b1", role: "assistant", text: "Spark reply with actions", at: "2026-01-01T00:00:02.000Z", tool: "baseten", status: "live" },
            ],
        };
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(shape));
        const loaded = loadTurns();
        expect(loaded.length).toBe(1);
        expect(loaded[0].tool).toBe("baseten");
    });

    it("drops poisoned snapshots but keeps the turn text", () => {
        const shape = {
            version: 1,
            turns: [
                {
                    id: "p1",
                    role: "assistant",
                    text: "Proposed spec",
                    at: "2026-01-01T00:00:03.000Z",
                    tool: "chat",
                    specSnapshot: { geometry: { kind: "naca4" }, reynolds: 1, rationale: "" },
                },
            ],
        };
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(shape));
        const loaded = loadTurns();
        expect(loaded.length).toBe(1);
        expect(loaded[0].specSnapshot).toBeUndefined();
    });

    it("rejects a tutor payload with secondary omitted so no chip renders", () => {
        const omitted = {
            concept: "attached-lift",
            primary: "speed",
            rows: [{ metric: "Cl", before: "0.600", after: "0.700", delta: "+0.100" }],
            caseKey: "naca4|NACA 2412|a6|Re50000|analytic",
        };
        expect(isTutorPayload(omitted)).toBe(false);
        const shape = {
            version: 1,
            turns: [
                {
                    id: "t1",
                    role: "assistant",
                    text: "Tutor note",
                    at: "2026-01-01T00:00:04.000Z",
                    tool: "chat",
                    status: "live",
                    tutor: omitted,
                },
            ],
        };
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(shape));
        const loaded = loadTurns();
        expect(loaded.length).toBe(1);
        expect(loaded[0].tutor).toBeUndefined();
        const tutor = loaded[0].tutor;
        const showsChip = tutor !== undefined
            && tutor !== null
            && tutor.secondary !== null
            && tutor.secondary !== tutor.primary;
        expect(showsChip).toBe(false);
    });

    it("keeps a tutor payload with an explicit null secondary and no chip", () => {
        const nulled = {
            concept: "attached-lift",
            primary: "speed",
            secondary: null,
            rows: [{ metric: "Cl", before: "0.600", after: "0.700", delta: "+0.100" }],
            caseKey: "naca4|NACA 2412|a6|Re50000|analytic",
        };
        expect(isTutorPayload(nulled)).toBe(true);
    });
});
