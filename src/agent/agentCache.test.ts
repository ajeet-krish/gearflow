// Phase B3 agent cache tests. Memory plus injected fake store, zero live
// calls except through counting fake ports.

import { beforeEach, describe, expect, it } from "vitest";
import {
    AGENT_CACHE_TTL_MS,
    AGENT_CACHE_VERSION,
    buildCacheKey,
    buildCacheKeyAsync,
    cachedChat,
    cacheGet,
    cacheSet,
    clearAgentCache,
    isExpired,
    type AgentCacheEntry,
    type AgentCacheStore,
    type ChatPort,
} from "./agentCache";
import type { BasetenChatResult, BasetenMessage } from "./basetenClient";

function makeResult(text: string): BasetenChatResult {
    return {
        text,
        action: null,
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 20, cachedTokens: 0 },
        costUsd: 0.001,
        latencyMs: 5,
    };
}

function makeStore(): AgentCacheStore & { data: Record<string, string> } {
    const data: Record<string, string> = {};
    return {
        data,
        getItem: (k: string) => (k in data ? data[k] : null),
        setItem: (k: string, v: string) => {
            data[k] = v;
        },
        removeItem: (k: string) => {
            delete data[k];
        },
    };
}

function makePort(result: BasetenChatResult, fail?: Error): ChatPort & { calls: number } {
    const port = {
        calls: 0,
        chat: async (_messages: BasetenMessage[]) => {
            port.calls += 1;
            if (fail !== undefined) throw fail;
            return result;
        },
    };
    return port;
}

const MESSAGES: BasetenMessage[] = [
    { role: "system", content: "ctx" },
    { role: "user", content: "explain this run" },
];

beforeEach(() => {
    clearAgentCache();
});

describe("buildCacheKey", () => {
    it("is deterministic and separates prompts, contexts, and versions", () => {
        expect(buildCacheKey("a", "c")).toBe(buildCacheKey("a", "c"));
        expect(buildCacheKey("a", "c")).not.toBe(buildCacheKey("b", "c"));
        expect(buildCacheKey("a", "c")).not.toBe(buildCacheKey("a", "d"));
        expect(buildCacheKey("a", "c")).toContain(`v${AGENT_CACHE_VERSION}:`);
    });

    it("resolves an async versioned key that matches across calls", async () => {
        const first = await buildCacheKeyAsync("a", "c");
        const second = await buildCacheKeyAsync("a", "c");
        expect(first).toBe(second);
        expect(first).toContain(`v${AGENT_CACHE_VERSION}:`);
    });
});

describe("isExpired", () => {
    const entry = { at: 1000 } as AgentCacheEntry;

    it("treats fresh entries as live and old entries as expired", () => {
        expect(isExpired(entry, 1000 + AGENT_CACHE_TTL_MS - 1)).toBe(false);
        expect(isExpired(entry, 1000 + AGENT_CACHE_TTL_MS + 1)).toBe(true);
    });

    it("treats null and poisoned entries as expired without throwing", () => {
        expect(isExpired(null)).toBe(true);
        expect(isExpired(undefined)).toBe(true);
        expect(isExpired({} as AgentCacheEntry)).toBe(true);
    });
});

describe("cachedChat", () => {
    it("serves a hit with zero marginal cost and no second fetch", async () => {
        const store = makeStore();
        const port = makePort(makeResult("live answer"));
        const first = await cachedChat(port, MESSAGES, { store, now: 1000 });
        expect(first.text).toBe("live answer");
        expect(port.calls).toBe(1);
        const second = await cachedChat(port, MESSAGES, { store, now: 2000 });
        expect(port.calls).toBe(1);
        expect(second.text).toBe("live answer");
        expect(second.costUsd).toBe(0);
        expect(second.usage.inputTokens).toBe(0);
        expect(second.usage.outputTokens).toBe(0);
        expect(second.usage.cachedTokens).toBeGreaterThan(0);
    });

    it("refetches after the TTL expires", async () => {
        const store = makeStore();
        const port = makePort(makeResult("fresh"));
        await cachedChat(port, MESSAGES, { store, now: 1000, skipMemory: true });
        await cachedChat(port, MESSAGES, { store, now: 1000 + AGENT_CACHE_TTL_MS + 1, skipMemory: true });
        expect(port.calls).toBe(2);
    });

    it("serves the stale entry when the live call fails", async () => {
        const store = makeStore();
        const good = makePort(makeResult("stale answer"));
        await cachedChat(good, MESSAGES, { store, now: 1000, skipMemory: true });
        const bad = makePort(makeResult("never"), new Error("upstream down"));
        const out = await cachedChat(bad, MESSAGES, { store, now: 1000 + AGENT_CACHE_TTL_MS + 1, skipMemory: true });
        expect(out.text).toBe("stale answer");
        expect(out.costUsd).toBe(0);
        expect(bad.calls).toBe(1);
    });

    it("rejects when the store is empty and the live call fails", async () => {
        const store = makeStore();
        const bad = makePort(makeResult("never"), new Error("upstream down"));
        await expect(cachedChat(bad, MESSAGES, { store, now: 1000 })).rejects.toThrow("upstream down");
    });

    it("drops a corrupt blob entry and refetches", async () => {
        const store = makeStore();
        store.data["gearflow:agent-cache:v1"] = "not json{{{";
        const port = makePort(makeResult("recovered"));
        const out = await cachedChat(port, MESSAGES, { store, now: 1000, skipMemory: true });
        expect(out.text).toBe("recovered");
        expect(port.calls).toBe(1);
        const again = await cachedChat(port, MESSAGES, { store, now: 2000, skipMemory: true });
        expect(again.text).toBe("recovered");
        expect(port.calls).toBe(1);
    });
});

describe("cacheGet and cacheSet", () => {
    it("round trips through the injected store", () => {
        const store = makeStore();
        cacheSet("k1", makeResult("hi"), { store, now: 500, skipMemory: true });
        expect(cacheGet("k1", { store, now: 600, skipMemory: true })?.text).toBe("hi");
    });

    it("returns null past the TTL", () => {
        const store = makeStore();
        cacheSet("k1", makeResult("hi"), { store, now: 500, skipMemory: true });
        expect(cacheGet("k1", { store, now: 500 + AGENT_CACHE_TTL_MS + 1, skipMemory: true })).toBe(null);
    });

    it("never throws on a throwing store", () => {
        const evil: AgentCacheStore = {
            getItem: () => {
                throw new Error("denied");
            },
            setItem: () => {
                throw new Error("denied");
            },
            removeItem: () => {
                throw new Error("denied");
            },
        };
        cacheSet("k", makeResult("hi"), { store: evil, skipMemory: true });
        expect(cacheGet("k", { store: evil, skipMemory: true })).toBe(null);
    });

    it("ignores foreign version blobs", () => {
        const store = makeStore();
        store.data["gearflow:agent-cache:v1"] = JSON.stringify({ version: 999, entries: {} });
        expect(cacheGet("k", { store, now: 1, skipMemory: true })).toBe(null);
    });

    it("uses memory when no store is available", async () => {
        const port = makePort(makeResult("mem"));
        const opts = { now: 1000, store: null as AgentCacheStore | null };
        const first = await cachedChat(port, MESSAGES, opts);
        const second = await cachedChat(port, MESSAGES, { ...opts, now: 2000 });
        expect(first.text).toBe("mem");
        expect(second.text).toBe("mem");
        expect(port.calls).toBe(1);
    });

    it("does not cache failures", async () => {
        const store = makeStore();
        const bad = makePort(makeResult("never"), new Error("down"));
        await expect(cachedChat(bad, MESSAGES, { store, now: 1000 })).rejects.toThrow();
        expect(bad.calls).toBe(1);
        const good = makePort(makeResult("later"));
        const out = await cachedChat(good, MESSAGES, { store, now: 2000 });
        expect(out.text).toBe("later");
        expect(good.calls).toBe(1);
    });
});
