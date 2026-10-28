// Display store Phase 12b: meanFields default, persistence, and sanitize
// fallback. Version 3 payloads round trip; v1 and v2 payloads without the
// flag fill the false default.

import { describe, expect, it, beforeEach } from "vitest";
import {
    DISPLAY_STORAGE_KEY,
    DISPLAY_VERSION,
    loadDisplayPrefs,
    storeDisplayPrefs,
} from "@/ui/displayStore";
import { DEFAULT_DISPLAY_PREFS } from "@/contracts/types";

function installMemoryStorage(): void {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
        getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
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
}

describe("display store phase 12b meanFields", () => {
    beforeEach(() => {
        installMemoryStorage();
    });

    it("defaults meanFields to false", () => {
        expect(DEFAULT_DISPLAY_PREFS.meanFields).toBe(false);
        expect(loadDisplayPrefs().meanFields).toBe(false);
    });

    it("persists a true meanFields flag", () => {
        storeDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, meanFields: true });
        expect(loadDisplayPrefs().meanFields).toBe(true);
    });

    it("fills v1 and v2 payloads without the flag as false", () => {
        for (const version of [1, 2]) {
            localStorage.setItem(
                DISPLAY_STORAGE_KEY,
                JSON.stringify({ version, prefs: { ...DEFAULT_DISPLAY_PREFS, meanFields: undefined } }),
            );
            expect(loadDisplayPrefs().meanFields).toBe(false);
        }
        expect(DISPLAY_VERSION).toBe(4);
    });

    it("rejects a non-boolean meanFields value", () => {
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({ version: 3, prefs: { ...DEFAULT_DISPLAY_PREFS, meanFields: "yes" } }),
        );
        expect(loadDisplayPrefs().meanFields).toBe(false);
    });

    it("keeps k and recirc as valid persisted variables", () => {
        storeDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, variable: "k" });
        expect(loadDisplayPrefs().variable).toBe("k");
        storeDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, variable: "recirc" });
        expect(loadDisplayPrefs().variable).toBe("recirc");
    });
});
