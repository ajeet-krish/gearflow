// Settings popover: appearance, field, particles, resolution in one small
// panel anchored under the gear button. Rendered only when open. No
// backdrop tint, the canvas stays visible while colormap and particles
// adjust live. Click outside plus Escape close, focus trap kept light,
// focus restored to the opener on close.

import { useEffect, useRef } from "react";
import { COLORMAPS, type ColormapName } from "@/flow/colormap";
import { DEFAULT_DISPLAY_PREFS, PARTICLE_COUNT_MAX, PARTICLE_COUNT_MIN, PARTICLE_COUNT_STEP, PARTICLE_SIZE_MAX, PARTICLE_SIZE_MIN, type DisplayPrefs, type FieldMode, type ParticleColorMode } from "@/contracts/types";
import { PARTICLE_COLOR_OPTIONS } from "@/render/particleColor";
import { parseCustomGrid, type GridMode } from "@/flow/gridController";
import type { GridSize } from "@/contracts/types";
import { manualPatchForToggle, resolveOverlays } from "./fieldOverlay";

export interface SettingsModalProps {
    open: boolean;
    onClose: () => void;
    prefs: DisplayPrefs;
    onPatch: (next: Partial<DisplayPrefs>) => void;
    gridMode: GridMode;
    activeGrid: GridSize;
    customSize?: number;
    gridNotice?: string | null;
    onGridMode: (next: GridMode, customRaw?: unknown) => void;
    variable: FieldMode;
}

const THEMES: Array<{ value: DisplayPrefs["theme"]; label: string }> = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
];

/** Particle count slider commit: finite input rounds into the envelope,
 *  garbage holds the previous count. Never throws. */
export function decideParticleCountCommit(raw: unknown, fallback: number): number {
    const n = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : Number.NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(PARTICLE_COUNT_MAX, Math.max(PARTICLE_COUNT_MIN, Math.round(n)));
}

/**
 * Commit decision for the Settings custom grid field. Valid input fires
 * onGridMode with the parsed side, invalid input keeps the last good size
 * and carries the parser reason. Never throws.
 */
export function decideSettingsCustomCommit(raw: unknown, fallbackSize: number): {
    fire: boolean;
    size: number;
    message: string | null;
} {
    const parsed = parseCustomGrid(raw);
    if (parsed.ok) return { fire: true, size: parsed.size, message: null };
    return {
        fire: false,
        size: fallbackSize,
        message: parsed.reason ?? "Custom grid needs a number in [128, 1024].",
    };
}

export default function SettingsModal({
    open,
    onClose,
    prefs,
    onPatch,
    gridMode,
    activeGrid,
    customSize = 256,
    gridNotice = null,
    onGridMode,
    variable,
}: SettingsModalProps) {
    void gridMode;
    void customSize;
    void gridNotice;
    void onGridMode;
    const dialogRef = useRef<HTMLDivElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    const prevFocusRef = useRef<Element | null>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        if (!open) return;
        prevFocusRef.current = document.activeElement;
        closeRef.current?.focus();
        return () => {
            const prev = prevFocusRef.current as HTMLElement | null;
            if (prev && typeof prev.focus === "function") prev.focus();
            prevFocusRef.current = null;
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            const root = dialogRef.current;
            if (root !== null && !root.contains(e.target as Node | null)) {
                onCloseRef.current();
            }
        };
        document.addEventListener("mousedown", onDown);
        return () => {
            document.removeEventListener("mousedown", onDown);
        };
    }, [open ]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onCloseRef.current();
                return;
            }
            if (e.key === "Tab") {
                const root = dialogRef.current;
                if (!root) return;
                const items = Array.from(
                    root.querySelectorAll<HTMLElement>("button, select, input, [tabindex]:not([tabindex='-1'])"),
                ).filter((el) => !el.hasAttribute("disabled"));
                if (items.length === 0) return;
                const first = items[0];
                const last = items[items.length - 1];
                const active = document.activeElement;
                if (!items.includes(active as HTMLElement)) {
                    e.preventDefault();
                    (e.shiftKey ? last : first).focus();
                    return;
                }
                if (e.shiftKey && active === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && active === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    if (!open) return null;

    const onReset = () => {
        onPatch({
            colormap: DEFAULT_DISPLAY_PREFS.colormap,
            theme: DEFAULT_DISPLAY_PREFS.theme,
            showLegend: DEFAULT_DISPLAY_PREFS.showLegend,
            fieldVisible: DEFAULT_DISPLAY_PREFS.fieldVisible,
            contours: DEFAULT_DISPLAY_PREFS.contours,
            particleCount: DEFAULT_DISPLAY_PREFS.particleCount,
            particleColor: DEFAULT_DISPLAY_PREFS.particleColor,
            particleSize: DEFAULT_DISPLAY_PREFS.particleSize,
            showStreamlines: DEFAULT_DISPLAY_PREFS.showStreamlines,
            meanFields: DEFAULT_DISPLAY_PREFS.meanFields,
            overlayPinned: DEFAULT_DISPLAY_PREFS.overlayPinned,
            overlayPinnedField: DEFAULT_DISPLAY_PREFS.overlayPinnedField,
        });
        onGridMode("512");
    };

    // Effective overlays for the active field: the checkboxes below reflect
    // the resolved value, and any manual change pins to this field until the
    // field changes again.
    const effective = resolveOverlays(variable, prefs);
    const overlaySource = effective.source === "user-pinned" ? "Manual until field change" : "Auto from field";
    const onToggleContours = (next: boolean) => {
        onPatch(manualPatchForToggle(variable, effective, { contours: next }));
    };
    const onToggleStreamlines = (next: boolean) => {
        onPatch(manualPatchForToggle(variable, effective, { showStreamlines: next }));
    };

    return (
        <div className="settingsPopoverWrap">
            <div
                ref={dialogRef}
                className="settingsPopover"
                role="dialog"
                aria-modal="false"
                aria-labelledby="settingsTitle"
            >
                <div className="settingsHeader">
                    <span id="settingsTitle" className="settingsTitle">SETTINGS</span>
                    <button
                        ref={closeRef}
                        type="button"
                        className="settingsClose"
                        onClick={onClose}
                        aria-label="Close settings"
                    >
                        Close
                    </button>
                </div>
                <div className="settingsBody">
                    <section className="settingsSection" aria-label="Appearance">
                        <h3>APPEARANCE</h3>
                        <div className="settingsRow">
                            <span className="settingsLabel" id="themeLabel">Theme</span>
                            <div className="segRow" role="group" aria-labelledby="themeLabel">
                                {THEMES.map((t) => (
                                    <button
                                        key={t.value}
                                        type="button"
                                        className={prefs.theme === t.value ? "segBtn active" : "segBtn"}
                                        aria-pressed={prefs.theme === t.value}
                                        onClick={() => onPatch({ theme: t.value })}
                                    >
                                        {t.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="settingsRow toggleRow">
                            <input
                                id="settingsLegend"
                                type="checkbox"
                                checked={prefs.showLegend}
                                onChange={(e) => onPatch({ showLegend: e.target.checked })}
                            />
                            <label htmlFor="settingsLegend">Legend visible</label>
                        </div>
                    </section>
                    <section className="settingsSection" aria-label="Field">
                        <h3>FIELD</h3>
                        <div className="settingsRow">
                            <label className="settingsLabel" htmlFor="settingsColormap">Colormap</label>
                            <select
                                id="settingsColormap"
                                className="barSelect"
                                value={prefs.colormap}
                                onChange={(e) => onPatch({ colormap: e.target.value as ColormapName })}
                                aria-label="Field colormap"
                            >
                                {COLORMAPS.map((c) => (
                                    <option key={c.name} value={c.name}>
                                        {c.label}{c.diverging ? " (diverging)" : ""}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="settingsRow toggleRow">
                            <input
                                id="settingsFieldVis"
                                type="checkbox"
                                checked={prefs.fieldVisible}
                                onChange={(e) => onPatch({ fieldVisible: e.target.checked })}
                            />
                            <label htmlFor="settingsFieldVis">Field layer visible</label>
                        </div>
                        <div className="settingsRow toggleRow">
                            <input
                                id="settingsContours"
                                type="checkbox"
                                checked={effective.contours}
                                onChange={(e) => onToggleContours(e.target.checked)}
                            />
                            <label htmlFor="settingsContours">Contour lines <span className="settingsSource mono">{overlaySource}</span></label>
                        </div>
                        <div className="settingsRow toggleRow">
                            <input
                                id="settingsStream"
                                type="checkbox"
                                checked={effective.showStreamlines}
                                onChange={(e) => onToggleStreamlines(e.target.checked)}
                            />
                            <label htmlFor="settingsStream">Streamlines <span className="settingsSource mono">{overlaySource}</span></label>
                        </div>
                        <p className="hint mono" role="status">Overlays: {overlaySource}.</p>
                    </section>
                    <section className="settingsSection" aria-label="Particles">
                        <h3>PARTICLES</h3>
                        <div className="settingsRow">
                            <label className="settingsLabel" htmlFor="settingsParticles">
                                Count <output htmlFor="settingsParticles" className="mono">{prefs.particleCount === 0 ? "Off" : prefs.particleCount.toLocaleString("en-US")}</output>
                            </label>
                            <input
                                id="settingsParticles"
                                type="range"
                                min={PARTICLE_COUNT_MIN}
                                max={PARTICLE_COUNT_MAX}
                                step={PARTICLE_COUNT_STEP}
                                value={prefs.particleCount}
                                onChange={(e) => onPatch({ particleCount: decideParticleCountCommit(e.target.value, prefs.particleCount) })}
                                aria-label="Particle count, 0 parks the layer off, up to 8000"
                                aria-describedby="settingsParticlesValue"
                            />
                            <output id="settingsParticlesValue" className="mono" htmlFor="settingsParticles">
                                {prefs.particleCount === 0 ? "Off" : prefs.particleCount.toLocaleString("en-US")}
                            </output>
                        </div>
                        <div className="settingsRow">
                            <label className="settingsLabel" htmlFor="settingsParticleSize">Particle size</label>
                            <input
                                id="settingsParticleSize"
                                type="range"
                                min={PARTICLE_SIZE_MIN}
                                max={PARTICLE_SIZE_MAX}
                                step={0.002}
                                value={prefs.particleSize}
                                onChange={(e) => onPatch({ particleSize: Number(e.target.value) })}
                                aria-describedby="settingsParticleSizeValue"
                            />
                            <output id="settingsParticleSizeValue" className="mono" htmlFor="settingsParticleSize">
                                {prefs.particleSize.toFixed(3)}
                            </output>
                        </div>
                        <div className="settingsRow">
                            <span className="settingsLabel" id="particleColorLabel">Particle color</span>
                            <div className="swatchRow" role="radiogroup" aria-labelledby="particleColorLabel">
                                {PARTICLE_COLOR_OPTIONS.map((opt) => (
                                    <button
                                        key={opt.id}
                                        type="button"
                                        role="radio"
                                        aria-checked={prefs.particleColor === opt.id}
                                        aria-label={`Particle color ${opt.label}`}
                                        className={prefs.particleColor === opt.id ? "swatch active" : "swatch"}
                                        onClick={() => onPatch({ particleColor: opt.id as ParticleColorMode })}
                                    >
                                        <span
                                            className="swatchChip"
                                            style={opt.hex === null
                                                ? { background: "conic-gradient(#ff79c6, #8be9fd, #50fa7b, #ffb86c, #ff79c6)" }
                                                : { background: opt.hex }}
                                            aria-hidden="true"
                                        />
                                        <span className="swatchLabel">{opt.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </section>
                    <section className="settingsSection" aria-label="Resolution">
                        <h3>RESOLUTION</h3>
                        <p className="hint mono" id="settingsGridHint">Fixed grid {activeGrid} x {activeGrid}, 512 only.</p>
                    </section>
                </div>
                <div className="settingsFooter">
                    <p className="hint mono">Re and the wake model are handled by the solver. This panel changes display only.</p>
                    <button type="button" className="settingsReset" onClick={onReset}>
                        Reset defaults
                    </button>
                </div>
            </div>
        </div>
    );
}
