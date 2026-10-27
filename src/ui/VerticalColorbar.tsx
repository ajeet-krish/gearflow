// VerticalColorbar: bottom-right tunnel overlay dock. 14px wide, 180px
// tall gradient strip sampled from the active colormap with 8 stops,
// ticks at max, 75, 50, 25, min. Hidden when visible is false. Pure props.

import { useMemo } from "react";
import { sampleColormap, variableRange, type ColormapName } from "@/flow/colormap";
import type { FieldMode, FlowField } from "@/contracts/types";

export interface VerticalColorbarProps {
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
    return `linear-gradient(to top, ${stops.join(", ")})`;
}

export default function VerticalColorbar({
    flow,
    variable,
    colormap,
    visible,
    min,
    max,
}: VerticalColorbarProps) {
    const range = useMemo(() => {
        if (flow === null) {
            const fallback = variable === "cp" ? "coef" : variable === "omega" ? "1/s (nondim)" : "U/Uinf";
            const fallbackLabel = variable === "cp" ? "Cp" : variable === "omega" ? "Vorticity" : variable === "u" ? "u velocity" : variable === "v" ? "v velocity" : "Speed";
            return { min: min ?? 0, max: max ?? 1, label: fallbackLabel, units: fallback };
        }
        const r = variableRange(variable, flow);
        return { min: min ?? r.min, max: max ?? r.max, label: r.label, units: r.units };
    }, [flow, variable, min, max]);
    if (!visible) return null;
    const span = range.max - range.min;
    const at = (f: number) => range.min + span * f;
    return (
        <div className="colorbarDock" role="img" aria-label="Vertical colorbar">
            <p className="cbSr mono">
                {range.label} from {range.min.toFixed(2)} to {range.max.toFixed(2)} {range.units}
            </p>
            <div className="cbHead">
                <span className="cbLabel">{range.label}</span>
                <span className="cbUnits">{range.units}</span>
            </div>
            <div className="cbBody">
                <div
                    className="cbStrip"
                    style={{ background: gradientFor(colormap) }}
                    aria-hidden="true"
                />
                <div className="cbTicks" aria-hidden="true">
                    <span className="mono">{range.max.toFixed(2)}</span>
                    <span className="mono">{at(0.75).toFixed(2)}</span>
                    <span className="mono">{at(0.5).toFixed(2)}</span>
                    <span className="mono">{at(0.25).toFixed(2)}</span>
                    <span className="mono">{range.min.toFixed(2)}</span>
                </div>
            </div>
            <div className="cbFoot">
                <span className="mono">{colormap}</span>
            </div>
        </div>
    );
}
