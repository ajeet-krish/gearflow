// Settings modal: appearance, field, particles, resolution in one dialog.
// Rendered only when open. Focus trap, Escape and backdrop close, restore.

import { useEffect, useRef } from "react";
import { COLORMAPS, type ColormapName } from "@/flow/colormap";
import { DEFAULT_DISPLAY_PREFS, type DisplayPrefs, type ParticleColorMode } from "@/contracts/types";
import { PARTICLE_COLOR_OPTIONS } from "@/render/particleColor";
import type { GridMode } from "@/flow/gridController";
import type { GridSize } from "@/contracts/types";

export interface SettingsModalProps {
    open: boolean;
    onClose: () => void;
    prefs: DisplayPrefs;
    onPatch: (next: Partial<DisplayPrefs>) => void;
    gridMode: GridMode;
    activeGrid: GridSize;
    onGridMode: (next: GridMode) => void;
}

const THEMES: Array<{ value: DisplayPrefs["theme"]; label: string }> = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
];

const PARTICLE_COUNTS = [0, 1200, 2000, 3000];

function countLabel(n: number): string {
    return n === 0 ? "Off" : String(n);
}

export default function SettingsModal({
    open,
    onClose,
    prefs,
    onPatch,
    gridMode,
    activeGrid,
    onGridMode,
}: SettingsModalProps) {
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
            showStreamlines: DEFAULT_DISPLAY_PREFS.showStreamlines,
        });
        onGridMode("auto");
    };

    return (
        <div
            className="modalBackdrop"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                ref={dialogRef}
                className="settingsModal"
                role="dialog"
                aria-modal="true"
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
                                checked={prefs.contours}
                                onChange={(e) => onPatch({ contours: e.target.checked })}
                            />
                            <label htmlFor="settingsContours">Contour lines</label>
                        </div>
                        <div className="settingsRow toggleRow">
                            <input
                                id="settingsStream"
                                type="checkbox"
                                checked={prefs.showStreamlines}
                                onChange={(e) => onPatch({ showStreamlines: e.target.checked })}
                            />
                            <label htmlFor="settingsStream">Streamlines</label>
                        </div>
                    </section>
                    <section className="settingsSection" aria-label="Particles">
                        <h3>PARTICLES</h3>
                        <div className="settingsRow">
                            <label className="settingsLabel" htmlFor="settingsParticles">Count</label>
                            <select
                                id="settingsParticles"
                                className="barSelect"
                                value={prefs.particleCount}
                                onChange={(e) => onPatch({ particleCount: Number(e.target.value) })}
                                aria-label="Particle count"
                            >
                                {PARTICLE_COUNTS.map((n) => (
                                    <option key={n} value={n}>{n === 0 ? "Off" : n}</option>
                                ))}
                            </select>
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
                        <div className="settingsRow">
                            <label className="settingsLabel" htmlFor="settingsGrid">Grid mode</label>
                            <select
                                id="settingsGrid"
                                className="barSelect"
                                value={gridMode}
                                onChange={(e) => onGridMode(e.target.value as GridMode)}
                                aria-label="Solve resolution"
                                aria-describedby="settingsGridHint"
                            >
                                <option value="auto">Auto (256, fallback to 128)</option>
                                <option value="256">256 x 256 pinned</option>
                                <option value="128">128 x 128 pinned</option>
                            </select>
                        </div>
                        <p className="hint mono" id="settingsGridHint">Active grid {activeGrid} x {activeGrid}. Surrogate and fixture stay at 128.</p>
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
