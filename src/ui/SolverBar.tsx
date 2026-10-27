// SolverBar: pinned scene bar over the tunnel. Engine chips, body select,
// alpha and Re inputs, live state. Pure presentational props.

import type { FlowMode } from "./FlowControls";

export interface SolverBarProps {
    mode: FlowMode;
    onMode: (next: FlowMode) => void;
    body: string;
    onBody: (next: string) => void;
    alpha: number;
    onAlpha: (next: number) => void;
    reynolds: number;
    onReynolds: (next: number) => void;
    live: boolean;
    maxRe?: number;
}

const MODES: Array<{ value: FlowMode; label: string }> = [
    { value: "analytic", label: "ANALYTIC" },
    { value: "surrogate", label: "SURROGATE" },
    { value: "fixture", label: "FIXTURE" },
];

const BODIES: Array<{ value: string; label: string }> = [
    { value: "naca0012", label: "NACA 0012" },
    { value: "naca2412", label: "NACA 2412" },
    { value: "naca4412", label: "NACA 4412" },
    { value: "cylinder", label: "CYLINDER" },
    { value: "duct", label: "DUCT" },
    { value: "block", label: "BLOCK" },
];

export default function SolverBar({
    mode,
    onMode,
    body,
    onBody,
    alpha,
    onAlpha,
    reynolds,
    onReynolds,
    live,
    maxRe = 1000000,
}: SolverBarProps) {
    return (
        <div className="sceneBar solverBar" role="toolbar" aria-label="Solver controls">
            <span className="barLabel">SOLVER</span>
            <div className="chipGroup" role="group" aria-label="Flow backend">
                {MODES.map((m) => (
                    <button
                        key={m.value}
                        type="button"
                        className={mode === m.value ? "chip active" : "chip"}
                        aria-pressed={mode === m.value}
                        onClick={() => onMode(m.value)}
                    >
                        {m.label}
                    </button>
                ))}
            </div>
            <span className="divider" aria-hidden="true" />
            <label className="barLabeled" htmlFor="solverBody">
                <span className="barLabel">BODY</span>
                <select
                    id="solverBody"
                    className="barSelect"
                    value={body}
                    onChange={(e) => onBody(e.target.value)}
                    aria-label="Body kind"
                >
                    {BODIES.map((b) => (
                        <option key={b.value} value={b.value}>
                            {b.label}
                        </option>
                    ))}
                    {body === "custom" && (
                        <option value="custom">CUSTOM (SKETCH)</option>
                    )}
                </select>
            </label>
            <label className="barLabeled" htmlFor="solverAlpha">
                <span className="barLabel">ALPHA</span>
                <input
                    id="solverAlpha"
                    className="barInput"
                    type="number"
                    min={-4}
                    max={12}
                    step={0.5}
                    value={alpha}
                    onChange={(e) => onAlpha(Number(e.target.value))}
                    aria-label="Angle of attack in degrees, minus 4 to 12"
                />
            </label>
            <label className="barLabeled" htmlFor="solverRe">
                <span className="barLabel">RE</span>
                <input
                    id="solverRe"
                    className="barInput barInputWide"
                    type="number"
                    min={100}
                    max={maxRe}
                    step={1000}
                    value={Math.round(reynolds)}
                    onChange={(e) => onReynolds(Number(e.target.value))}
                    aria-label={`Reynolds number, 100 to ${maxRe.toLocaleString("en-US")}`}
                />
            </label>
            <span className="spacer" aria-hidden="true" />
            <span className="liveState" role="status">
                <span className={live ? "dot on" : "dot held"} aria-hidden="true" />
                {live ? "LIVE" : "HELD"}
            </span>
        </div>
    );
}
