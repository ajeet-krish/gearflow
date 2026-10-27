// VerticalColorbar: bottom-right tunnel overlay dock. 14px wide, 180px
// tall gradient strip sampled from the active colormap with 8 stops.
// TKE gets endpoint accurate log ticks (actual scale minimum and maximum
// plus interior decades, placed with the same normaliser the field uses),
// recirculation gets a two state readout. An all zero TKE field collapses
// to a single explicit zero tick. Hidden when visible is false. Pure
// props. Guards divide by zero and NaN.

import { useMemo } from "react";
import { sampleColormap, variableRange, kLogScaleFor, kColorTicks, type ColormapName, type KColorTick } from "@/flow/colormap";
import type { FieldMode, FlowField } from "@/contracts/types";

export interface VerticalColorbarProps {
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
    return `linear-gradient(to top, ${stops.join(", ")})`;
}

function finiteOr(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
}

function formatTick(v: number): string {
    if (!Number.isFinite(v)) return "n/a";
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1000 || a < 0.01)) {
        const exp = Math.floor(Math.log10(a));
        const mant = v / Math.pow(10, exp);
        return `${mant.toFixed(1)}e${exp}`;
    }
    return v.toFixed(2);
}

export default function VerticalColorbar({
    flow,
    variable,
    colormap,
    visible,
    meanFields = false,
    min,
    max,
}: VerticalColorbarProps) {
    const range = useMemo(() => {
        if (flow === null) {
            const fallback = variable === "cp" ? "coef" : variable === "omega" ? "1/s (nondim)" : "U/Uinf";
            const fallbackLabel = variable === "cp" ? "Cp" : variable === "omega" ? "Vorticity" : variable === "u" ? "u velocity" : variable === "v" ? "v velocity" : variable === "k" ? "TKE" : variable === "recirc" ? "Recirculation" : "Speed";
            const label = meanFields && (variable === "u" || variable === "v") ? `${fallbackLabel} (mean)` : fallbackLabel;
            return { min: min ?? 0, max: max ?? 1, label, units: fallback, kTicks: null as KColorTick[] | null, zeroK: variable === "k", twoState: variable === "recirc" };
        }
        const r = variableRange(variable, flow, meanFields);
        const lo = min ?? r.min;
        const hi = max ?? r.max;
        const safeMin = Number.isFinite(lo) ? lo : 0;
        let safeMax = Number.isFinite(hi) ? hi : 1;
        if (!(safeMax > safeMin)) safeMax = safeMin + 1e-9;
        if (variable === "k") {
            const scale = kLogScaleFor(flow);
            const ticks = scale === null ? null : kColorTicks(scale);
            return { min: safeMin, max: safeMax, label: r.label, units: r.units, kTicks: ticks, zeroK: scale === null, twoState: false };
        }
        if (variable === "recirc") {
            return { min: 0, max: 1, label: r.label, units: r.units, kTicks: null as KColorTick[] | null, zeroK: false, twoState: true };
        }
        return { min: safeMin, max: safeMax, label: r.label, units: r.units, kTicks: null as KColorTick[] | null, zeroK: false, twoState: false };
    }, [flow, variable, min, max, meanFields]);
    if (!visible) return null;
    const span = range.max - range.min || 1;
    const at = (f: number) => range.min + span * f;
    if (range.twoState) {
        return (
            <div className="colorbarDock" role="img" aria-label="Vertical colorbar">
                <p className="cbSr mono">
                    {range.label} reverse or attached {range.units}
                </p>
                <div className="cbHead">
                    <span className="cbLabel">{range.label}</span>
                    <span className="cbUnits">{range.units}</span>
                </div>
                <div className="cbBody">
                    <div
                        className="cbStrip cbTwoState"
                        style={{ background: gradientFor(colormap) }}
                        aria-hidden="true"
                    />
                    <div className="cbTicks" aria-hidden="true">
                        <span className="mono">REVERSE</span>
                        <span className="mono">FLOW</span>
                    </div>
                </div>
                <div className="cbFoot">
                    <span className="mono">{colormap}</span>
                </div>
            </div>
        );
    }
    if (range.zeroK || range.kTicks !== null) {
        const ticks = range.kTicks ?? [];
        const srText = ticks.length > 0
            ? `${range.label} from ${ticks[ticks.length - 1].label} to ${ticks[0].label} ${range.units}`
            : `${range.label} from 0 to 0 ${range.units}`;
        return (
            <div className="colorbarDock" role="img" aria-label="Vertical colorbar">
                <p className="cbSr mono">
                    {srText}
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
                        {ticks.length > 0 ? ticks.map((t, i) => (
                            <span key={i} className="mono cbTickPlaced" style={{ top: `${(1 - t.position) * 100}%` }} data-value={t.value}>{t.label}</span>
                        )) : (
                            <span key={0} className="mono cbTickPlaced" style={{ top: "100%" }}>0</span>
                        )}
                    </div>
                </div>
                <div className="cbFoot">
                    <span className="mono">{colormap}</span>
                </div>
            </div>
        );
    }
    const ticks = [formatTick(finiteOr(range.max, 1)), formatTick(finiteOr(at(0.75), 0.75)), formatTick(finiteOr(at(0.5), 0.5)), formatTick(finiteOr(at(0.25), 0.25)), formatTick(finiteOr(range.min, 0))];
    return (
        <div className="colorbarDock" role="img" aria-label="Vertical colorbar">
            <p className="cbSr mono">
                {range.label} from {Number.isFinite(range.min) ? range.min.toFixed(2) : "n/a"} to {Number.isFinite(range.max) ? range.max.toFixed(2) : "n/a"} {range.units}
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
                    {ticks.map((t, i) => (
                        <span key={i} className="mono">{t}</span>
                    ))}
                </div>
            </div>
            <div className="cbFoot">
                <span className="mono">{colormap}</span>
            </div>
        </div>
    );
}
