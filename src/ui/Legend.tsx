// Field legend: colorbar with min/max ticks, variable label, and units.
// Gradient is sampled from the active colormap so it always matches the canvas.

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

export default function Legend({ flow, variable, colormap, visible, min, max }: LegendProps) {
    const range = useMemo(() => {
        if (flow === null) return { min: min ?? 0, max: max ?? 1, label: variable, units: "" };
        const r = variableRange(variable, flow);
        return { min: min ?? r.min, max: max ?? r.max, label: r.label, units: r.units };
    }, [flow, variable, min, max]);
    if (!visible) return null;
    return (
        <div className="legend" role="img" aria-label={`${range.label} legend from ${range.min.toFixed(2)} to ${range.max.toFixed(2)} ${range.units}`}>
            <div className="legendRow">
                <span className="mono">{range.label}</span>
                <span className="mono legendUnits">{range.units}</span>
            </div>
            <div className="legendBar" style={{ background: gradientFor(colormap) }} aria-hidden="true" />
            <div className="legendRow">
                <span className="mono">{range.min.toFixed(2)}</span>
                <span className="mono">{range.max.toFixed(2)}</span>
            </div>
        </div>
    );
}
