// fieldOverlay tests: per field defaults, pin hold, cross field recouple,
// and the field change and manual toggle patches. No DOM, pure logic only.

import { describe, expect, it } from "vitest";
import {
    FIELD_OVERLAY_DEFAULTS,
    overlayPatchForFieldChange,
    overlayPatchForManualToggle,
    resolveOverlays,
} from "@/ui/fieldOverlay";
import { DEFAULT_DISPLAY_PREFS, type FieldMode } from "@/contracts/types";

const FIELDS: FieldMode[] = ["speed", "cp", "omega", "u", "v", "k", "recirc"];

describe("fieldOverlay defaults", () => {
    it("covers every field mode", () => {
        expect(Object.keys(FIELD_OVERLAY_DEFAULTS).sort()).toEqual([...FIELDS].sort());
    });

    it("defaults speed to streamlines on and contours off", () => {
        expect(FIELD_OVERLAY_DEFAULTS.speed).toEqual({ contours: false, showStreamlines: true });
    });

    it("defaults cp to contours on and streamlines off", () => {
        expect(FIELD_OVERLAY_DEFAULTS.cp).toEqual({ contours: true, showStreamlines: false });
    });

    it("defaults omega, u, v, k, and recirc to contours on and streamlines off", () => {
        for (const field of ["omega", "u", "v", "k", "recirc"] as const) {
            expect(FIELD_OVERLAY_DEFAULTS[field]).toEqual({ contours: true, showStreamlines: false });
        }
    });

    it("resolves unpinned prefs to the field default with a field-default source", () => {
        for (const field of FIELDS) {
            const got = resolveOverlays(field, {
                contours: !FIELD_OVERLAY_DEFAULTS[field].contours,
                showStreamlines: !FIELD_OVERLAY_DEFAULTS[field].showStreamlines,
                overlayPinned: false,
                overlayPinnedField: field,
            });
            expect(got).toEqual({ ...FIELD_OVERLAY_DEFAULTS[field], source: "field-default" });
        }
    });
});

describe("fieldOverlay pin and recouple", () => {
    it("holds the manual flags while pinned to the same field", () => {
        const got = resolveOverlays("speed", {
            contours: true,
            showStreamlines: false,
            overlayPinned: true,
            overlayPinnedField: "speed",
        });
        expect(got).toEqual({ contours: true, showStreamlines: false, source: "user-pinned" });
    });

    it("ignores the pin for a different field and recouple to that default", () => {
        const got = resolveOverlays("cp", {
            contours: false,
            showStreamlines: true,
            overlayPinned: true,
            overlayPinnedField: "speed",
        });
        expect(got).toEqual({ ...FIELD_OVERLAY_DEFAULTS.cp, source: "field-default" });
    });

    it("ignores the pin when the pinned field is null", () => {
        const got = resolveOverlays("speed", {
            contours: false,
            showStreamlines: false,
            overlayPinned: true,
            overlayPinnedField: null,
        });
        expect(got).toEqual({ ...FIELD_OVERLAY_DEFAULTS.speed, source: "field-default" });
    });

    it("field change patch recouple to the next default and clears the pin", () => {
        expect(overlayPatchForFieldChange("speed")).toEqual({
            variable: "speed",
            contours: false,
            showStreamlines: true,
            overlayPinned: false,
            overlayPinnedField: null,
        });
        expect(overlayPatchForFieldChange("cp")).toEqual({
            variable: "cp",
            contours: true,
            showStreamlines: false,
            overlayPinned: false,
            overlayPinnedField: null,
        });
    });

    it("manual toggle patch pins the flags to the current field", () => {
        expect(overlayPatchForManualToggle("speed", { contours: true })).toEqual({
            overlayPinned: true,
            overlayPinnedField: "speed",
            contours: true,
        });
        expect(overlayPatchForManualToggle("cp", { showStreamlines: true })).toEqual({
            overlayPinned: true,
            overlayPinnedField: "cp",
            showStreamlines: true,
        });
    });

    it("pinned manual flags survive a sanitize style round trip through defaults", () => {
        const patch = overlayPatchForManualToggle("speed", { contours: true, showStreamlines: false });
        const prefs = { ...DEFAULT_DISPLAY_PREFS, ...overlayPatchForFieldChange("speed"), ...patch };
        expect(resolveOverlays("speed", prefs).source).toBe("user-pinned");
        expect(resolveOverlays("cp", prefs).source).toBe("field-default");
    });
});
