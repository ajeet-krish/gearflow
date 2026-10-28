// Field overlay defaults plus pin and recouple logic. Pure and testable,
// no DOM access. The FIELD bar owns the effective contours and streamlines
// flags: each field quantity ships a default overlay pair, changing the
// field recouple the overlays to that default, and a manual toggle pins the
// overlays to the current field until the field changes again.

import type { DisplayPrefs, FieldMode } from "@/contracts/types";

/** Manual overlay flags: contours plus streamlines. */
export interface OverlaySet {
    contours: boolean;
    showStreamlines: boolean;
}

/** Where the effective overlays came from. */
export type OverlaySource = "field-default" | "user-pinned";

/** Resolved overlays plus their source. */
export interface EffectiveOverlays extends OverlaySet {
    source: OverlaySource;
}

/**
 * Per field overlay defaults. Speed reads with streamlines on and contours
 * off; cp reads with contours on and streamlines off; omega, u, v, k, and
 * recirc read with contours on and streamlines off.
 */
export const FIELD_OVERLAY_DEFAULTS: Record<FieldMode, OverlaySet> = {
    speed: { contours: false, showStreamlines: true },
    cp: { contours: true, showStreamlines: false },
    omega: { contours: true, showStreamlines: false },
    u: { contours: true, showStreamlines: false },
    v: { contours: true, showStreamlines: false },
    k: { contours: true, showStreamlines: false },
    recirc: { contours: true, showStreamlines: false },
};

/** Prefs subset resolveOverlays reads. */
export type OverlayPrefs = Pick<DisplayPrefs, "contours" | "showStreamlines" | "overlayPinned" | "overlayPinnedField">;

/**
 * Resolve the effective overlays for a field. A pin only holds for the
 * field it was set on: when overlayPinned is true and overlayPinnedField
 * matches the requested variable, the manual flags win with a user-pinned
 * source; otherwise the field default wins and the pin is ignored.
 */
export function resolveOverlays(variable: FieldMode, prefs: OverlayPrefs): EffectiveOverlays {
    if (prefs.overlayPinned === true && prefs.overlayPinnedField === variable) {
        return { contours: prefs.contours, showStreamlines: prefs.showStreamlines, source: "user-pinned" };
    }
    const fallback: OverlaySet = { contours: true, showStreamlines: false };
    const defaults = FIELD_OVERLAY_DEFAULTS[variable] ?? fallback;
    return { contours: defaults.contours, showStreamlines: defaults.showStreamlines, source: "field-default" };
}

/**
 * Patch for a field change. Recouples the overlays to the next field
 * default and clears any pin, so stale manual flags never leak across
 * fields.
 */
export function overlayPatchForFieldChange(next: FieldMode): Partial<DisplayPrefs> {
    const defaults = FIELD_OVERLAY_DEFAULTS[next] ?? { contours: true, showStreamlines: false };
    return {
        variable: next,
        contours: defaults.contours,
        showStreamlines: defaults.showStreamlines,
        overlayPinned: false,
        overlayPinnedField: null,
    };
}

/**
 * Patch for a manual overlay toggle. Applies the toggled flags and pins
 * them to the current field, so the next resolveOverlays call for the same
 * field keeps the manual choice.
 */
export function overlayPatchForManualToggle(field: FieldMode, next: Partial<OverlaySet>): Partial<DisplayPrefs> {
    const patch: Partial<DisplayPrefs> = { overlayPinned: true, overlayPinnedField: field };
    if (typeof next.contours === "boolean") patch.contours = next.contours;
    if (typeof next.showStreamlines === "boolean") patch.showStreamlines = next.showStreamlines;
    return patch;
}

/**
 * Manual patch built from the full effective pair with only the toggled
 * flag replaced. Stored prefs need not equal the displayed effective pair
 * (fresh defaults store showStreamlines false while speed effectively
 * shows streamlines on), so patching only the toggled flag would let the
 * other flag fall back to a stale stored value. Pass the resolved
 * effective overlays and the toggled flag, and both flags are pinned.
 */
export function manualPatchForToggle(
    field: FieldMode,
    effective: OverlaySet,
    next: Partial<OverlaySet>,
): Partial<DisplayPrefs> {
    return {
        contours: typeof next.contours === "boolean" ? next.contours : effective.contours,
        showStreamlines:
            typeof next.showStreamlines === "boolean" ? next.showStreamlines : effective.showStreamlines,
        overlayPinned: true,
        overlayPinnedField: field,
    };
}
