// FieldBar: pinned scene bar for the field layer. Quantity chips only.
// Field visibility, contours, particles, and colormap live in Settings.

import type { FieldMode } from "@/contracts/types";

export interface FieldBarProps {
    variable: FieldMode;
    onVariable: (next: FieldMode) => void;
}

const QUANTITIES: Array<{ value: FieldMode; label: string }> = [
    { value: "speed", label: "SPEED" },
    { value: "cp", label: "PRESSURE" },
    { value: "omega", label: "VORTICITY" },
];

export default function FieldBar({
    variable,
    onVariable,
}: FieldBarProps) {
    return (
        <div className="sceneBar fieldBar" role="toolbar" aria-label="Field display controls">
            <span className="barLabel">FIELD</span>
            <div className="chipGroup" role="group" aria-label="Field quantity">
                {QUANTITIES.map((q) => (
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
            </div>
        </div>
    );
}
