// SimulationSection: right rail SIMULATION window. Owns the run controls
// now that the scene bars are gone: grid presets plus custom square,
// read only solver path status (current path, neural availability, domain
// line with reasons), the Re slider plus non-blocking number
// entry, and the full LBM run block (U, STEPS, LES, Run, Cancel, progress,
// pre-flight warnings, fault lamp with Recover). Pure props plus small local
// field text state. The terminal owns live status, this section never shows
// a status dot, only the progress readout text.

import { useEffect, useState } from "react";
import type { GeometrySpec } from "@/contracts/types";
import { parseCustomGrid, type GridMode } from "@/flow/gridController";
import { parseReynoldsField } from "@/flow/reynoldsField";
import { buildPolygons } from "@/geometry/parametric";
import { LBM_STEPS_OPTIONS, LBM_U_OPTIONS, LbmEntryNotice, LbmFailoverNotice } from "./LbmSetupRow";
import type { NeuralStatus, SolverPath } from "@/flow/solverRouter";

const LOG_RE_MIN = 2;
const LOG_RE_MAX = 6;

function formatRe(re: number): string {
    if (re >= 1_000_000) return `${(re / 1_000_000).toFixed(2)}M`;
    if (re >= 10_000) return `${(re / 1000).toFixed(1)}k`;
    if (re >= 1000) return `${(re / 1000).toFixed(2)}k`;
    return String(Math.round(re));
}

/**
 * Commit decision for the custom grid field. Valid input fires onGridMode
 * with the parsed side, invalid input keeps the last good size and carries
 * the parser reason for the popup. Never throws.
 */
export function decideCustomGridCommit(raw: unknown, fallbackSize: number): {
    fire: boolean;
    size: number;
    message: string | null;
} {
    const parsed = parseCustomGrid(raw);
    if (parsed.ok) return { fire: true, size: parsed.size, message: null };
    return {
        fire: false,
        size: fallbackSize,
        message: parsed.reason ?? "Custom grid needs a number in [32, 512].",
    };
}

/**
 * Commit decision for the Re number entry. Empty and non-numeric input
 * never fires the setter so the solve holds last good, every other kind
 * commits through the shared parser funnel in App. The message carries the
 * clamp note or the LBM LES band warning when present, so a committable
 * value still warns while it commits. Never throws.
 */
export function decideReCommit(raw: unknown, lbmActive: boolean): {
    fire: boolean;
    message: string | null;
} {
    const parsed = parseReynoldsField(raw, lbmActive);
    if (parsed.value === null) {
        return { fire: false, message: parsed.message ?? "Reynolds number must be numeric." };
    }
    return { fire: true, message: parsed.message ?? parsed.lbmBandWarning };
}

export interface SimulationSectionProps {
    gridMode: GridMode;
    customSize: number;
    activeGrid: number;
    gridNotice: string | null;
    onGridMode: (mode: GridMode, customRaw?: unknown) => void;
    onClearGridNotice: () => void;
    solverPath: SolverPath;
    neuralStatus: NeuralStatus;
    neuralNote: string | null;
    domainIn: boolean;
    domainReason: string | null;
    reynolds: number;
    lbmActive: boolean;
    onCommitReynolds: (raw: number | string) => void;
    lbmULattice: number;
    onLbmULattice: (next: number) => void;
    lbmTargetSteps: number;
    onLbmTargetSteps: (next: number) => void;
    lbmLesAuto: boolean;
    onLbmLesAuto: (next: boolean) => void;
    lbmLesManual: boolean;
    onLbmLesManual: (next: boolean) => void;
    lbmStatus: string;
    lbmProgressText: string;
    onLbmRun: () => void;
    onLbmCancel: () => void;
    preflightWarnings: string[];
    lbmNotice: string | null;
    onDismissLbmNotice: () => void;
    lbmFailed: string | null;
    onLbmRecover: () => void;
    blockageWarning: string | null;
}

export interface SimulationSectionViewProps extends SimulationSectionProps {
    customText: string;
    onCustomText: (next: string) => void;
    customError: string | null;
    onCustomError: (next: string | null) => void;
    reText: string;
    onReText: (next: string) => void;
    rePopup: string | null;
    onRePopup: (next: string | null) => void;
}

const GRID_PRESETS: Array<{ mode: GridMode; label: string }> = [
    { mode: "64", label: "64" },
    { mode: "128", label: "128" },
    { mode: "256", label: "256" },
    { mode: "custom", label: "Custom" },
];

/**
 * Pure view split: no hooks, so rail tests drive every commit path through
 * direct element calls with no worker threads. The default export owns the
 * field text state and passes it down.
 */
export function SimulationSectionView(props: SimulationSectionViewProps): JSX.Element {
    const {
        gridMode, customSize, activeGrid, gridNotice, onGridMode, onClearGridNotice,
        customText, onCustomText, customError, onCustomError,
        solverPath, neuralStatus, neuralNote, domainIn, domainReason,
        reynolds, lbmActive, onCommitReynolds,
        reText, onReText, rePopup, onRePopup,
        lbmULattice, onLbmULattice, lbmTargetSteps, onLbmTargetSteps,
        lbmLesAuto, onLbmLesAuto, lbmLesManual, onLbmLesManual,
        lbmStatus, lbmProgressText, onLbmRun, onLbmCancel,
        preflightWarnings, lbmNotice, onDismissLbmNotice,
        lbmFailed, onLbmRecover, blockageWarning,
    } = props;
    const running = lbmStatus === "running";
    const logRe = Math.min(LOG_RE_MAX, Math.max(LOG_RE_MIN, Math.log10(Math.max(1, reynolds))));

    const commitCustom = () => {
        const decision = decideCustomGridCommit(customText, customSize);
        if (decision.fire) {
            onCustomError(null);
            onGridMode("custom", decision.size);
        } else {
            onCustomError(decision.message);
        }
    };

    const commitRe = () => {
        const decision = decideReCommit(reText, lbmActive);
        if (decision.fire) {
            // Committable values still warn: clamp notes and the LBM LES
            // band ride in the popup while App mirrors the same note in
            // the notice stack, the value always commits.
            onRePopup(decision.message);
            onCommitReynolds(reText);
        } else {
            onRePopup(decision.message);
        }
    };

    return (
        <div className="controls">
            <div className="field">
                <span className="settingsLabel" id="simGridLabel">Solve grid</span>
                <div className="segRow" role="group" aria-labelledby="simGridLabel">
                    {GRID_PRESETS.map((p) => (
                        <button
                            key={p.mode}
                            type="button"
                            className={gridMode === p.mode ? "segBtn active" : "segBtn"}
                            aria-pressed={gridMode === p.mode}
                            onClick={() => {
                                if (p.mode === "custom") onGridMode("custom", customSize);
                                else onGridMode(p.mode);
                            }}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>
                {gridMode === "custom" && (
                    <input
                        id="simCustomGrid"
                        className="barInput"
                        type="number"
                        min={32}
                        max={512}
                        step={1}
                        value={customText}
                        onChange={(e) => onCustomText(e.target.value)}
                        onBlur={commitCustom}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") commitCustom();
                            else if (e.key === "Escape") {
                                onCustomText(String(customSize));
                                onCustomError(null);
                            }
                        }}
                        aria-label="Custom square grid side, 32 to 512"
                    />
                )}
                {customError !== null && (
                    <p className="mError" role="alert">{customError}</p>
                )}
                <p className="hint mono">Active grid {activeGrid} x {activeGrid}.</p>
                {gridNotice !== null && (
                    <p className="fallbackNote notice" role="status">
                        {gridNotice}
                        <button type="button" className="noticeDismiss" onClick={onClearGridNotice} aria-label="Dismiss resolution notice">Dismiss</button>
                    </p>
                )}
            </div>

            <div className="field">
                <span className="settingsLabel" id="simPathLabel">Solver path</span>
                <p className="mono" role="status" id="simPathCurrent">
                    Current path {solverPath === "neural-v2" ? "neural-v2 predicted, not validated" : "analytic potential flow, not validated"}
                </p>
                <p className="hint mono" id="simNeuralLine">
                    Neural {neuralStatus}{neuralNote !== null && neuralNote.length > 0 ? `, ${neuralNote}` : ""}
                </p>
                <p className="hint" id="simDomainLine">
                    Domain {domainIn ? "inside the provisional envelope" : `outside the provisional envelope${domainReason !== null && domainReason.length > 0 ? ` (${domainReason})` : ""}`}
                </p>
            </div>

            <div className="field">
                <label htmlFor="simRey">
                    Reynolds <output htmlFor="simRey" className="mono">Re {formatRe(reynolds)}</output>
                </label>
                <input
                    id="simRey"
                    type="range"
                    min={LOG_RE_MIN}
                    max={LOG_RE_MAX}
                    step={0.05}
                    value={logRe}
                    onChange={(e) => onCommitReynolds(Math.round(10 ** Number(e.target.value)))}
                    aria-label="Reynolds number, log scale, 100 to 1 million"
                />
                <input
                    id="simReNumber"
                    className="barInput"
                    type="number"
                    min={100}
                    max={lbmActive ? 2000 : 1000000}
                    step={1000}
                    value={reText}
                    onChange={(e) => onReText(e.target.value)}
                    onBlur={commitRe}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") commitRe();
                        else if (e.key === "Escape") {
                            onReText(String(Math.round(reynolds)));
                            onRePopup(null);
                        }
                    }}
                    aria-label="Reynolds number value, commits on Enter"
                />
                {rePopup !== null && (
                    <p className="mError" role="alert">{rePopup}</p>
                )}
                <p className="hint">Log scale. Re shades the wake deficit only, the potential core stays inviscid. Invalid typing holds the last good solve.</p>
            </div>

            <div className="field">
                <span className="settingsLabel" id="simLbmLabel">LBM run</span>
                <div className="chipRow" role="group" aria-labelledby="simLbmLabel">
                    <button
                        type="button"
                        className="chip"
                        onClick={onLbmRun}
                        disabled={running}
                        aria-label="Run LBM solve"
                    >
                        Run
                    </button>
                    <button
                        type="button"
                        className="chip"
                        onClick={onLbmCancel}
                        disabled={!running}
                        aria-label="Cancel LBM solve"
                    >
                        Cancel
                    </button>
                </div>
                <p className="hint mono" role="status">{lbmProgressText}</p>
            </div>

            <div className="field">
                <label htmlFor="simLbmU">Lattice velocity</label>
                <select
                    id="simLbmU"
                    value={String(lbmULattice)}
                    onChange={(e) => onLbmULattice(Number(e.target.value))}
                    aria-label="Lattice velocity"
                >
                    {LBM_U_OPTIONS.map((v) => (
                        <option key={v} value={String(v)}>{v.toFixed(2)}</option>
                    ))}
                </select>
            </div>

            <div className="field">
                <label htmlFor="simLbmSteps">Target steps</label>
                <select
                    id="simLbmSteps"
                    value={String(lbmTargetSteps)}
                    onChange={(e) => onLbmTargetSteps(Number(e.target.value))}
                    aria-label="Target steps"
                >
                    {LBM_STEPS_OPTIONS.map((v) => (
                        <option key={v} value={String(v)}>{v.toLocaleString("en-US")}</option>
                    ))}
                </select>
            </div>

            <div className="field">
                <div className="toggleRow">
                    <input
                        id="simLesAuto"
                        type="checkbox"
                        checked={lbmLesAuto}
                        onChange={(e) => onLbmLesAuto(e.target.checked)}
                        aria-label="Automatic LES above Re 500"
                    />
                    <label htmlFor="simLesAuto">LES auto above Re 500</label>
                </div>
                {!lbmLesAuto && (
                    <div className="toggleRow">
                        <input
                            id="simLesManual"
                            type="checkbox"
                            checked={lbmLesManual}
                            onChange={(e) => onLbmLesManual(e.target.checked)}
                            aria-label="Manual LES toggle, applies while Auto is off"
                        />
                        <label htmlFor="simLesManual">LES manual</label>
                    </div>
                )}
                <p className="hint">Stable below about Re 480 at u 0.05 on the default grid, scales with body cells. LES modeled above Re 500.</p>
            </div>

            {preflightWarnings.length > 0 && (
                <div className="field">
                    {preflightWarnings.map((w, i) => (
                        <p key={i} className="hint" role="note">{w}</p>
                    ))}
                </div>
            )}
            {blockageWarning !== null && (
                <p className="fallbackNote notice" role="status">{blockageWarning}</p>
            )}
            {lbmNotice !== null && (
                <LbmEntryNotice message={lbmNotice} onDismiss={onDismissLbmNotice} />
            )}
            {lbmFailed !== null && (
                <LbmFailoverNotice
                    message={lbmFailed}
                    onRecover={onLbmRecover}
                    suffix="analytic fallback serving frames. No LBM numbers shown."
                    recoverLabel="Recover at Re 200"
                />
            )}
        </div>
    );
}

export default function SimulationSection(props: SimulationSectionProps): JSX.Element {
    const [customText, setCustomText] = useState(String(props.customSize));
    const [customError, setCustomError] = useState<string | null>(null);
    const [reText, setReText] = useState(String(Math.round(props.reynolds)));
    const [rePopup, setRePopup] = useState<string | null>(null);

    useEffect(() => {
        setCustomText(String(props.customSize));
    }, [props.customSize]);
    useEffect(() => {
        setReText(String(Math.round(props.reynolds)));
    }, [props.reynolds]);

    return (
        <SimulationSectionView
            {...props}
            customText={customText}
            onCustomText={setCustomText}
            customError={customError}
            onCustomError={setCustomError}
            reText={reText}
            onReText={setReText}
            rePopup={rePopup}
            onRePopup={setRePopup}
        />
    );
}

/** Polygon gap check shared with rail tests: orifice specs build two walls. */
export function orificeGapOf(polygons: Array<Array<{ x: number; y: number }>>): number | null {
    if (polygons.length !== 2) return null;
    const upperMinY = Math.min(...polygons[0].map((p) => p.y));
    const lowerMaxY = Math.max(...polygons[1].map((p) => p.y));
    return upperMinY - lowerMaxY;
}

export function gapMatchesSpec(spec: GeometrySpec): boolean {
    try {
        const gap = orificeGapOf(buildPolygons(spec));
        if (gap === null || spec.height === undefined) return false;
        return Math.abs(gap - spec.height) < 1e-9;
    } catch {
        return false;
    }
}
