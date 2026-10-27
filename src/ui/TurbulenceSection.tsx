// TurbulenceSection: LBM time mean statistics readout for the analysis
// rail. Renders only when the LBM provider is active. Numbers render only
// when statsReady() is true and samples are above zero; before any samples
// it shows a single waiting line. Copy never claims resolved turbulence:
// k is a time mean of velocity variance at this grid.

import type { ReactNode } from "react";
import type { LbmStats } from "@/contracts/types";

export interface TurbulenceSectionProps {
    ready: boolean;
    stats: LbmStats | null;
}

function sig3(v: number): string {
    if (!Number.isFinite(v)) return "n/a";
    if (v === 0) return "0.00";
    const a = Math.abs(v);
    if (a >= 1000) return v.toPrecision(3);
    if (a >= 100) return v.toPrecision(3);
    if (a >= 1) return v.toFixed(2);
    if (a >= 0.01) return v.toFixed(3);
    return v.toPrecision(2);
}

export function formatTurbRow(v: number): string {
    return sig3(v);
}

export default function TurbulenceSection({ ready, stats }: TurbulenceSectionProps) {
    if (!ready || stats === null || !(stats.samples > 0)) {
        return (
            <div className="turb">
                <p className="mono turbEmpty">Time means start at step 8,000. Run the solver to populate them.</p>
            </div>
        );
    }
    const recircPct = Number.isFinite(stats.recircFraction)
        ? `${(Math.min(1, Math.max(0, stats.recircFraction)) * 100).toFixed(1)} percent`
        : "n/a";
    return (
        <div className="turb">
            <dl className="turbRows">
                <div className="turbRow"><dt>SAMPLES</dt><dd className="mono">{stats.samples}</dd></div>
                <div className="turbRow"><dt>CD MEAN</dt><dd className="mono">{sig3(stats.cdMean)}</dd></div>
                <div className="turbRow"><dt>CL MEAN</dt><dd className="mono">{sig3(stats.clMean)}</dd></div>
                <div className="turbRow"><dt>CL RMS</dt><dd className="mono">{sig3(stats.clRms)}</dd></div>
                <div className="turbRow"><dt>ST</dt><dd className="mono">{stats.strouhal === null ? "n/a" : sig3(stats.strouhal)}</dd></div>
                <div className="turbRow"><dt>RECIRC AREA</dt><dd className="mono">{recircPct}</dd></div>
            </dl>
            <p className="hint mono turbNote">Time means over the sampled window. Cd and St are solver reference values for this tunnel, not free cylinder literature values.</p>
        </div>
    );
}

export interface TurbulenceDef {
    id: string;
    label: string;
    content: ReactNode;
}

/** Rail entry for the TURBULENCE window. Returns null outside the active
 *  LBM provider so placeholder and failover states show no stats at all. */
export function turbulenceSectionDef(
    lbmEffective: boolean,
    ready: boolean,
    stats: LbmStats | null,
): TurbulenceDef | null {
    if (!lbmEffective) return null;
    return {
        id: "turbulence",
        label: "TURBULENCE",
        content: <TurbulenceSection ready={ready} stats={stats} />,
    };
}
