// SimulationSection: right rail SIMULATION window. P1 agent-first
// simplification: the panel is a single honest readout (body, alpha, Re,
// Cl, regime) plus the one control that stays, the Re slider with its
// non-blocking number entry. The Solve Grid and Solver Path fields are
// gone outright (grid lives in Settings, the path is forced analytic and
// named in the readout note). The full LBM run block (Run/Cancel,
// lattice U, steps, LES, preflight, failover) renders only when agentFirst
// is false, so legacy VITE_AGENT_FIRST=off builds keep their controls.
// The agent console is the control surface; this section never shows a
// status dot, only readout text. Pure props plus small local Re text state.

import { useEffect, useState } from "react";
import { parseReynoldsField } from "@/flow/reynoldsField";
import { LBM_STEPS_OPTIONS, LBM_U_OPTIONS, LbmEntryNotice, LbmFailoverNotice } from "./LbmSetupRow";

const LOG_RE_MIN = 2;
const LOG_RE_MAX = 6;

function formatRe(re: number): string {
    if (re >= 1_000_000) return `${(re / 1_000_000).toFixed(2)}M`;
    if (re >= 10_000) return `${(re / 1000).toFixed(1)}k`;
    if (re >= 1000) return `${(re / 1000).toFixed(2)}k`;
    return String(Math.round(re));
}

function formatCl(cl: number | null): string {
    if (typeof cl !== "number" || !Number.isFinite(cl)) return "n/a";
    return cl.toFixed(3);
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
    /** Agent-first master switch: true hides the whole LBM run block. */
    agentFirst: boolean;
    /** Honest readout rows, served by the analytic frame. */
    bodyLabel: string;
    alphaDeg: number;
    reynolds: number;
    cl: number | null;
    regime: string;
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
}

export interface SimulationSectionViewProps extends SimulationSectionProps {
    reText: string;
    onReText: (next: string) => void;
    rePopup: string | null;
    onRePopup: (next: string | null) => void;
}

/**
 * Pure view split: no hooks, so rail tests drive every commit path through
 * direct element calls with no worker threads. The default export owns the
 * Re field text state and passes it down.
 */
export function SimulationSectionView(props: SimulationSectionViewProps): JSX.Element {
    const {
        agentFirst, bodyLabel, alphaDeg, reynolds, cl, regime,
        lbmActive, onCommitReynolds,
        reText, onReText, rePopup, onRePopup,
        lbmULattice, onLbmULattice, lbmTargetSteps, onLbmTargetSteps,
        lbmLesAuto, onLbmLesAuto, lbmLesManual, onLbmLesManual,
        lbmStatus, lbmProgressText, onLbmRun, onLbmCancel,
        preflightWarnings, lbmNotice, onDismissLbmNotice,
        lbmFailed, onLbmRecover,
    } = props;
    const running = lbmStatus === "running";
    const logRe = Math.min(LOG_RE_MAX, Math.max(LOG_RE_MIN, Math.log10(Math.max(1, reynolds))));

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
                <span className="settingsLabel" id="simReadoutLabel">Run readout</span>
                <dl className="runRows" aria-labelledby="simReadoutLabel">
                    <div className="runRow"><dt>BODY</dt><dd className="mono">{bodyLabel}</dd></div>
                    <div className="runRow"><dt>ALPHA</dt><dd className="mono">{alphaDeg.toFixed(1)} deg</dd></div>
                    <div className="runRow"><dt>CL</dt><dd className="mono">{formatCl(cl)}</dd></div>
                    <div className="runRow"><dt>REGIME</dt><dd className="mono">{regime}</dd></div>
                </dl>
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

            {!agentFirst && (
                <>
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
                </>
            )}
        </div>
    );
}

export default function SimulationSection(props: SimulationSectionProps): JSX.Element {
    const [reText, setReText] = useState(String(Math.round(props.reynolds)));
    const [rePopup, setRePopup] = useState<string | null>(null);

    useEffect(() => {
        setReText(String(Math.round(props.reynolds)));
    }, [props.reynolds]);

    return (
        <SimulationSectionView
            {...props}
            reText={reText}
            onReText={setReText}
            rePopup={rePopup}
            onRePopup={setRePopup}
        />
    );
}
