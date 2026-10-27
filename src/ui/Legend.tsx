// Field legend: colorbar with min/max ticks, variable label, and units.
// Gradient is sampled from the active colormap so it always matches the canvas.
// Time mean fields carry a mean suffix in the label.

import { useMemo } from "react";
import { sampleColormap, type ColormapName } from "@/flow/colormap";
import type { FieldMode } from "@/contracts/types";
import { variableRange } from "@/flow/colormap";
import type { FlowField } from "@/contracts/types";

export interface LegendProps {
    flow: FlowField | null;
    variable: FieldMode;
    colormap: ColormapName;
    visible: boolean;
    meanFields?: boolean;
    min?: number;
    max?: number;
}

function gradientFor(cmap: ColormapName): string {
    const stops: string[] = [];
    const n = 8;
    for (let i = 0; i < n; i++) {
        const [r, g, b] = sampleColormap(cmap, i / (n - 1));
        stops.push(`rgb(${r},${g},${b}) ${(i / (n - 1)) * 100}%`);
    }
    return `linear-gradient(to right, ${stops.join(", ")})`;
}

export default function Legend({ flow, variable, colormap, visible, meanFields = false, min, max }: LegendProps) {
    const range = useMemo(() => {
        if (flow === null) {
            const base = variable;
            const label = meanFields && (variable === "u" || variable === "v") ? `${base} (mean)` : base;
            return { min: min ?? 0, max: max ?? 1, label, units: "" };
        }
        const r = variableRange(variable, flow, meanFields);
        return { min: min ?? r.min, max: max ?? r.max, label: r.label, units: r.units };
    }, [flow, variable, min, max, meanFields]);
    if (!visible) return null;
    const lo = Number.isFinite(range.min) ? range.min.toFixed(2) : "n/a";
    const hi = Number.isFinite(range.max) ? range.max.toFixed(2) : "n/a";
    return (
        <div className="legend" role="img" aria-label={`${range.label} legend from ${lo} to ${hi} ${range.units}`}>
            <div className="legendRow">
                <span className="mono">{range.label}</span>
                <span className="mono legendUnits">{range.units}</span>
            </div>
            <div className="legendBar" style={{ background: gradientFor(colormap) }} aria-hidden="true" />
            <div className="legendRow">
                <span className="mono">{lo}</span>
                <span className="mono">{hi}</span>
            </div>
        </div>
    );
}
