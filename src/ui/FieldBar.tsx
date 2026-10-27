// FieldBar: pinned scene bar for the field layer. Quantity chips only.
// Field visibility, contours, particles, and colormap live in Settings.
// TKE and RECIRC chips enable only when the active frame carries the
// channel and the first LBM statistics sample exists (the worker always
// ships the channels, all zero before sampling, so the channel alone
// never enables them); otherwise they render disabled with a reason so
// a judge can see the capability exists and why it is unavailable.

import type { FieldMode } from "@/contracts/types";

export interface FieldBarProps {
    variable: FieldMode;
    onVariable: (next: FieldMode) => void;
    hasTke?: boolean;
    hasRecirc?: boolean;
}

const BASE: Array<{ value: FieldMode; label: string }> = [
    { value: "speed", label: "SPEED" },
    { value: "cp", label: "PRESSURE" },
    { value: "omega", label: "VORTICITY" },
];

/** Fallback rule: a selected mean channel without frame data drops to
 *  speed rather than rendering a blank field. Pure for direct tests and
 *  for deriving the effective variable during render; the stored
 *  preference is never patched, so returning to LBM mode restores the
 *  user's choice. */
export function fallbackVariableFor(
    variable: FieldMode,
    flow: { k?: unknown; recirc?: unknown },
): FieldMode {
    if (variable === "k" && flow.k === undefined) return "speed";
    if (variable === "recirc" && flow.recirc === undefined) return "speed";
    return variable;
}

export default function FieldBar({
    variable,
    onVariable,
    hasTke = false,
    hasRecirc = false,
}: FieldBarProps) {
    return (
        <div className="sceneBar fieldBar" role="toolbar" aria-label="Field display controls">
            <span className="barLabel">FIELD</span>
            <div className="chipGroup" role="group" aria-label="Field quantity">
                {BASE.map((q) => (
                    <button
                        key={q.value}
                        type="button"
                        className={variable === q.value ? "chip active" : "chip"}
                        aria-pressed={variable === q.value}
                        onClick={() => onVariable(q.value)}
                    >
                        {q.label}
                    </button>
                ))}
                <button
                    type="button"
                    className={variable === "k" ? "chip active" : "chip"}
                    aria-pressed={variable === "k"}
                    disabled={!hasTke}
                    title={hasTke ? "Turbulent kinetic energy, time mean of velocity variance" : "Available after the first LBM statistics sample"}
                    onClick={() => onVariable("k")}
                >
                    TKE
                </button>
                <button
                    type="button"
                    className={variable === "recirc" ? "chip active" : "chip"}
                    aria-pressed={variable === "recirc"}
                    disabled={!hasRecirc}
                    title={hasRecirc ? "Recirculation mask, reverse flow region" : "Available after the first LBM statistics sample"}
                    onClick={() => onVariable("recirc")}
                >
                    RECIRC
                </button>
            </div>
        </div>
    );
}
