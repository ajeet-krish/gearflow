// Display store versioning: v1 fills new defaults, the current version
// round trips, corrupt payloads fall back per field. Key string stays unchanged.

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

describe("display store phase 9", () => {
    beforeEach(() => {
        installMemoryStorage();
    });

    it("keeps the storage key string unchanged", () => {
        expect(DISPLAY_STORAGE_KEY).toBe("gearflow:display:v1");
    });

    it("bumps the payload version to 4", () => {
        expect(DISPLAY_VERSION).toBe(4);
    });

    it("fills v1 payloads with new defaults", () => {
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({
                version: 1,
                prefs: { colormap: "turbo", variable: "cp", theme: "light", showLegend: false },
            }),
        );
        const prefs = loadDisplayPrefs();
        expect(prefs.colormap).toBe("turbo");
        expect(prefs.variable).toBe("cp");
        expect(prefs.theme).toBe("light");
        expect(prefs.showLegend).toBe(false);
        expect(prefs.fieldVisible).toBe(true);
        expect(prefs.contours).toBe(false);
        expect(prefs.particleCount).toBe(3000);
        expect(prefs.particleColor).toBe("auto");
        expect(prefs.showStreamlines).toBe(false);
        expect(prefs.meanFields).toBe(false);
    });

    it("round trips the current version payload", () => {
        const full = {
            ...DEFAULT_DISPLAY_PREFS,
            fieldVisible: false,
            contours: true,
            particleCount: 1200,
            particleColor: "cyan" as const,
            showStreamlines: true,
        };
        storeDisplayPrefs(full);
        expect(loadDisplayPrefs()).toEqual(full);
    });

    it("falls back per field on corrupt JSON", () => {
        localStorage.setItem(DISPLAY_STORAGE_KEY, "{not json");
        expect(loadDisplayPrefs()).toEqual(DEFAULT_DISPLAY_PREFS);
    });

    it("falls back on a wrong version", () => {
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({ version: 99, prefs: { ...DEFAULT_DISPLAY_PREFS, colormap: "turbo" } }),
        );
        expect(loadDisplayPrefs()).toEqual(DEFAULT_DISPLAY_PREFS);
    });

    it("rejects a bad particle count", () => {
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({ version: 2, prefs: { ...DEFAULT_DISPLAY_PREFS, particleCount: 999 } }),
        );
        expect(loadDisplayPrefs().particleCount).toBe(3000);
    });

    it("rejects a bad particle color", () => {
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({ version: 2, prefs: { ...DEFAULT_DISPLAY_PREFS, particleColor: "rainbow" } }),
        );
        expect(loadDisplayPrefs().particleColor).toBe("auto");
    });

    it("rejects non-boolean overlay flags", () => {
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({
                version: 2,
                prefs: { ...DEFAULT_DISPLAY_PREFS, fieldVisible: "yes", contours: 1, showStreamlines: null, meanFields: "yes" },
            }),
        );
        const prefs = loadDisplayPrefs();
        expect(prefs.fieldVisible).toBe(true);
        expect(prefs.contours).toBe(false);
        expect(prefs.showStreamlines).toBe(false);
        expect(prefs.meanFields).toBe(false);
    });
});

describe("display store v3/v4 particleSize and overlay pin", () => {
    beforeEach(() => {
        installMemoryStorage();
    });

    it("keeps valid particleSize and overlay pin fields from a v3 payload", () => {
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({
                version: 3,
                prefs: { ...DEFAULT_DISPLAY_PREFS, particleSize: 0.02, overlayPinned: true, overlayPinnedField: "cp" },
            }),
        );
        const prefs = loadDisplayPrefs();
        expect(prefs.particleSize).toBeCloseTo(0.02, 9);
        expect(prefs.overlayPinned).toBe(true);
        expect(prefs.overlayPinnedField).toBe("cp");
    });

    it("keeps valid particleSize and overlay pin fields from a v4 payload", () => {
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({
                version: 4,
                prefs: { ...DEFAULT_DISPLAY_PREFS, particleSize: 0.03, overlayPinned: true, overlayPinnedField: "omega" },
            }),
        );
        const prefs = loadDisplayPrefs();
        expect(prefs.particleSize).toBeCloseTo(0.03, 9);
        expect(prefs.overlayPinned).toBe(true);
        expect(prefs.overlayPinnedField).toBe("omega");
    });

    it("fills v2 payloads missing the new fields with defaults", () => {
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({
                version: 2,
                prefs: { colormap: "turbo", variable: "cp", theme: "light", showLegend: false },
            }),
        );
        const prefs = loadDisplayPrefs();
        expect(prefs.particleSize).toBe(DEFAULT_DISPLAY_PREFS.particleSize);
        expect(prefs.overlayPinned).toBe(false);
        expect(prefs.overlayPinnedField).toBeNull();
    });

    it("rejects invalid particleSize values with the default", () => {
        for (const bad of ["big", Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
            localStorage.setItem(
                DISPLAY_STORAGE_KEY,
                JSON.stringify({ version: 4, prefs: { ...DEFAULT_DISPLAY_PREFS, particleSize: bad } }),
            );
            expect(loadDisplayPrefs().particleSize).toBe(DEFAULT_DISPLAY_PREFS.particleSize);
        }
    });

    it("clamps out of band particleSize to the contract band", () => {
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({ version: 4, prefs: { ...DEFAULT_DISPLAY_PREFS, particleSize: 10 } }),
        );
        expect(loadDisplayPrefs().particleSize).toBe(0.036);
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({ version: 3, prefs: { ...DEFAULT_DISPLAY_PREFS, particleSize: -5 } }),
        );
        expect(loadDisplayPrefs().particleSize).toBe(0.008);
    });

    it("rejects invalid overlayPinned and overlayPinnedField values", () => {
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({
                version: 4,
                prefs: { ...DEFAULT_DISPLAY_PREFS, overlayPinned: "yes", overlayPinnedField: "rainbow" },
            }),
        );
        const prefs = loadDisplayPrefs();
        expect(prefs.overlayPinned).toBe(false);
        expect(prefs.overlayPinnedField).toBeNull();
        localStorage.setItem(
            DISPLAY_STORAGE_KEY,
            JSON.stringify({
                version: 3,
                prefs: { ...DEFAULT_DISPLAY_PREFS, overlayPinned: 1, overlayPinnedField: 7 },
            }),
        );
        const v3 = loadDisplayPrefs();
        expect(v3.overlayPinned).toBe(false);
        expect(v3.overlayPinnedField).toBeNull();
    });
});
