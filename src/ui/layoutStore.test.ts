// Layout store: defaults, round trip, corrupt payload, wrong version,
// per field fallback. Key string stays fixed. Mirrors displayStore tests.

import { describe, expect, it, beforeEach } from "vitest";
import {
    DEFAULT_LAYOUT_PREFS,
    LAYOUT_STORAGE_KEY,
    LAYOUT_VERSION,
    loadLayoutPrefs,
    shellVisibility,
    storeLayoutPrefs,
} from "@/ui/layoutStore";

function installMemoryStorage(): void {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
        getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
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
}

describe("layout store phase 12a", () => {
    beforeEach(() => {
        installMemoryStorage();
    });

    it("keeps the storage key string unchanged", () => {
        expect(LAYOUT_STORAGE_KEY).toBe("gearflow:layout:v1");
    });

    it("pins the payload version to 1", () => {
        expect(LAYOUT_VERSION).toBe(1);
    });

    it("defaults to everything expanded", () => {
        expect(DEFAULT_LAYOUT_PREFS).toEqual({
            leftCollapsed: false,
            rightCollapsed: false,
            barsCollapsed: false,
            focusMode: false,
        });
        expect(loadLayoutPrefs()).toEqual(DEFAULT_LAYOUT_PREFS);
    });

    it("round trips a fully collapsed payload", () => {
        const full = {
            leftCollapsed: true,
            rightCollapsed: true,
            barsCollapsed: true,
            focusMode: true,
        };
        storeLayoutPrefs(full);
        expect(loadLayoutPrefs()).toEqual(full);
    });

    it("falls back on corrupt JSON", () => {
        localStorage.setItem(LAYOUT_STORAGE_KEY, "{not json");
        expect(loadLayoutPrefs()).toEqual(DEFAULT_LAYOUT_PREFS);
    });

    it("falls back on a wrong version", () => {
        localStorage.setItem(
            LAYOUT_STORAGE_KEY,
            JSON.stringify({ version: 99, prefs: { leftCollapsed: true } }),
        );
        expect(loadLayoutPrefs()).toEqual(DEFAULT_LAYOUT_PREFS);
    });

    it("falls back per field on non-boolean values", () => {
        localStorage.setItem(
            LAYOUT_STORAGE_KEY,
            JSON.stringify({
                version: 1,
                prefs: { leftCollapsed: "yes", rightCollapsed: 1, barsCollapsed: null, focusMode: true },
            }),
        );
        const prefs = loadLayoutPrefs();
        expect(prefs.leftCollapsed).toBe(false);
        expect(prefs.rightCollapsed).toBe(false);
        expect(prefs.barsCollapsed).toBe(false);
        expect(prefs.focusMode).toBe(true);
    });

    it("never throws in private mode", () => {
        (globalThis as Record<string, unknown>).localStorage = {
            getItem: (): never => {
                throw new Error("denied");
            },
            setItem: (): never => {
                throw new Error("denied");
            },
            removeItem: (): never => {
                throw new Error("denied");
            },
            clear: (): never => {
                throw new Error("denied");
            },
            key: (): null => null,
            get length(): number {
                throw new Error("denied");
            },
        };
        expect(loadLayoutPrefs()).toEqual(DEFAULT_LAYOUT_PREFS);
        expect(() => storeLayoutPrefs({
            leftCollapsed: true,
            rightCollapsed: true,
            barsCollapsed: true,
            focusMode: true,
        })).not.toThrow();
    });

    it("derives shell visibility with focus mode forcing all shut", () => {
        expect(shellVisibility(DEFAULT_LAYOUT_PREFS)).toEqual({ left: false, right: false, bars: false });
        expect(shellVisibility({ ...DEFAULT_LAYOUT_PREFS, leftCollapsed: true })).toEqual({
            left: true,
            right: false,
            bars: false,
        });
        expect(shellVisibility({ ...DEFAULT_LAYOUT_PREFS, focusMode: true })).toEqual({
            left: true,
            right: true,
            bars: true,
        });
    });
});
