// Display controls: colormap picker, field variable selector, resolution
// selector, particle density, and overlay toggles. Presentational only.

import { COLORMAPS, type ColormapName } from "@/flow/colormap";
import type { FieldMode, GridSize } from "@/contracts/types";
import type { GridMode } from "@/flow/gridController";

export interface DisplayControlsProps {
    colormap: ColormapName;
    onColormap: (next: ColormapName) => void;
    variable: FieldMode;
    onVariable: (next: FieldMode) => void;
    gridMode: GridMode;
    activeGrid: GridSize;
    onGridMode: (next: GridMode) => void;
    particles: number;
    onParticles: (next: number) => void;
    fieldVisible: boolean;
    onFieldVisible: (next: boolean) => void;
    contours: boolean;
    onContours: (next: boolean) => void;
    showLegend: boolean;
    onShowLegend: (next: boolean) => void;
}

const VARIABLES: Array<{ value: FieldMode; label: string }> = [
    { value: "speed", label: "Speed" },
    { value: "cp", label: "Cp" },
    { value: "omega", label: "Vorticity" },
    { value: "u", label: "u velocity" },
    { value: "v", label: "v velocity" },
];

const PARTICLE_OPTIONS = [0, 1200, 2000, 3000];

export default function DisplayControls({
    colormap,
    onColormap,
    variable,
    onVariable,
    gridMode,
    activeGrid,
    onGridMode,
    particles,
    onParticles,
    fieldVisible,
    onFieldVisible,
    contours,
    onContours,
    showLegend,
    onShowLegend,
}: DisplayControlsProps) {
    return (
        <div className="controls displayControls">
            <div className="field">
                <label htmlFor="cmap">Colormap</label>
                <select
                    id="cmap"
                    value={colormap}
                    onChange={(e) => onColormap(e.target.value as ColormapName)}
                    aria-label="Field colormap"
                >
                    {COLORMAPS.map((c) => (
                        <option key={c.name} value={c.name}>
                            {c.label}{c.diverging ? " (diverging)" : ""}
                        </option>
                    ))}
                </select>
            </div>
            <div className="field">
                <label htmlFor="fvar">Field variable</label>
                <select
                    id="fvar"
                    value={variable}
                    onChange={(e) => onVariable(e.target.value as FieldMode)}
                    aria-label="Field variable"
                >
                    {VARIABLES.map((v) => (
                        <option key={v.value} value={v.value}>{v.label}</option>
                    ))}
                </select>
            </div>
            <div className="field">
                <label htmlFor="res">Resolution</label>
                <select
                    id="res"
                    value={gridMode}
                    onChange={(e) => onGridMode(e.target.value as GridMode)}
                    aria-label="Solve resolution"
                    aria-describedby="resHint"
                >
                    <option value="auto">Auto (256, fallback to 128)</option>
                    <option value="256">256 x 256 pinned</option>
                    <option value="128">128 x 128 pinned</option>
                </select>
                <p className="hint mono" id="resHint">Active grid {activeGrid} x {activeGrid}. Surrogate stays at 128.</p>
            </div>
            <div className="field">
                <label htmlFor="pcount">Particles</label>
                <select
                    id="pcount"
                    value={particles}
                    onChange={(e) => onParticles(Number(e.target.value))}
                    aria-label="Particle count"
                >
                    {PARTICLE_OPTIONS.map((n) => (
                        <option key={n} value={n}>{n === 0 ? "Off" : n}</option>
                    ))}
                </select>
            </div>
            <div className="toggleRow">
                <input
                    id="fieldVis"
                    type="checkbox"
                    checked={fieldVisible}
                    onChange={(e) => onFieldVisible(e.target.checked)}
                />
                <label htmlFor="fieldVis">Field layer visible</label>
            </div>
            <div className="toggleRow">
                <input
                    id="contours"
                    type="checkbox"
                    checked={contours}
                    onChange={(e) => onContours(e.target.checked)}
                />
                <label htmlFor="contours">Contour lines</label>
            </div>
            <div className="toggleRow">
                <input
                    id="legendVis"
                    type="checkbox"
                    checked={showLegend}
                    onChange={(e) => onShowLegend(e.target.checked)}
                />
                <label htmlFor="legendVis">Legend visible</label>
            </div>
        </div>
    );
}
