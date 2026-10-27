// FieldBar: pinned scene bar for the field layer. Quantity chips, field
// and contour toggles, particle density chips, colormap name. Pure props.

import type { FieldMode } from "@/contracts/types";

export interface FieldBarProps {
    variable: FieldMode;
    onVariable: (next: FieldMode) => void;
    fieldVisible: boolean;
    onFieldVisible: (next: boolean) => void;
    contours: boolean;
    onContours: (next: boolean) => void;
    particleCount: number;
    onParticles: (next: number) => void;
    colormapName: string;
}

const QUANTITIES: Array<{ value: FieldMode; label: string }> = [
    { value: "speed", label: "SPEED" },
    { value: "cp", label: "PRESSURE" },
    { value: "omega", label: "VORTICITY" },
];

const PARTICLES = [0, 1200, 2000, 3000];

function particleLabel(n: number): string {
    return n === 0 ? "OFF" : String(n);
}

export default function FieldBar({
    variable,
    onVariable,
    fieldVisible,
    onFieldVisible,
    contours,
    onContours,
    particleCount,
    onParticles,
    colormapName,
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
            <span className="divider" aria-hidden="true" />
            <div className="chipGroup" role="group" aria-label="Field layers">
                <button
                    type="button"
                    className={fieldVisible ? "chip cyan active" : "chip cyan"}
                    aria-pressed={fieldVisible}
                    onClick={() => onFieldVisible(!fieldVisible)}
                >
                    FIELD
                </button>
                <button
                    type="button"
                    className={contours ? "chip cyan active" : "chip cyan"}
                    aria-pressed={contours}
                    onClick={() => onContours(!contours)}
                >
                    CONTOURS
                </button>
            </div>
            <span className="spacer" aria-hidden="true" />
            <div className="chipGroup" role="group" aria-label="Particle count">
                {PARTICLES.map((n) => (
                    <button
                        key={n}
                        type="button"
                        className={particleCount === n ? "chip active" : "chip"}
                        aria-pressed={particleCount === n}
                        aria-label={n === 0 ? "Particles off" : `${n} particles`}
                        onClick={() => onParticles(n)}
                    >
                        {particleLabel(n)}
                    </button>
                ))}
            </div>
            <span className="mono colormapName" role="status" aria-label={`Colormap ${colormapName}`}>
                {colormapName}
            </span>
        </div>
    );
}
