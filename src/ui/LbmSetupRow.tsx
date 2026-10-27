// LBM setup row: third scene bar under SolverBar and FieldBar. Quiet Zenith
// toolbar with Run and Cancel plus U and STEPS selects, LES controls, a
// progress readout, and a short stability note. The tau failover notice is
// the one bold element, an amber instrument fault lamp with a remedy action.
// Notices stay in the notice stack, this module owns their markup only.

import { isLbmTauFailover } from "@/flow/lbmRunConfig";

export const LBM_U_OPTIONS = [0.02, 0.05, 0.08, 0.12];
export const LBM_STEPS_OPTIONS = [8000, 40000, 120000];

export interface LbmSetupRowProps {
    uLattice: number;
    onULattice: (next: number) => void;
    targetSteps: number;
    onTargetSteps: (next: number) => void;
    lesAuto: boolean;
    onLesAuto: (next: boolean) => void;
    lesManual: boolean;
    onLesManual: (next: boolean) => void;
    status: string;
    onRun: () => void;
    onCancel: () => void;
    progressText: string;
}

export default function LbmSetupRow({
    uLattice,
    onULattice,
    targetSteps,
    onTargetSteps,
    lesAuto,
    onLesAuto,
    lesManual,
    onLesManual,
    status,
    onRun,
    onCancel,
    progressText,
}: LbmSetupRowProps) {
    const running = status === "running";
    return (
        <div className="sceneBar lbmSetupBar" role="toolbar" aria-label="LBM setup">
            <span className="barLabel">LBM</span>
            <div className="chipGroup" role="group" aria-label="LBM run control">
                <button
                    type="button"
                    className="chip"
                    onClick={onRun}
                    disabled={running}
                    aria-label="Run LBM solve"
                >
                    Run
                </button>
                <button
                    type="button"
                    className="chip"
                    onClick={onCancel}
                    disabled={!running}
                    aria-label="Cancel LBM solve"
                >
                    Cancel
                </button>
            </div>
            <span className="divider" aria-hidden="true" />
            <label className="barLabeled" htmlFor="lbmSetupU">
                <span className="barLabel">U</span>
                <select
                    id="lbmSetupU"
                    className="barSelect"
                    value={String(uLattice)}
                    onChange={(e) => onULattice(Number(e.target.value))}
                    aria-label="Lattice velocity"
                >
                    {LBM_U_OPTIONS.map((v) => (
                        <option key={v} value={String(v)}>
                            {v.toFixed(2)}
                        </option>
                    ))}
                </select>
            </label>
            <label className="barLabeled" htmlFor="lbmSetupSteps">
                <span className="barLabel">STEPS</span>
                <select
                    id="lbmSetupSteps"
                    className="barSelect"
                    value={String(targetSteps)}
                    onChange={(e) => onTargetSteps(Number(e.target.value))}
                    aria-label="Target steps"
                >
                    {LBM_STEPS_OPTIONS.map((v) => (
                        <option key={v} value={String(v)}>
                            {v.toLocaleString("en-US")}
                        </option>
                    ))}
                </select>
            </label>
            <label className="barLabeled" htmlFor="lbmSetupLesAuto">
                <span className="barLabel">LES AUTO</span>
                <input
                    id="lbmSetupLesAuto"
                    className="lbmCheck"
                    type="checkbox"
                    checked={lesAuto}
                    onChange={(e) => onLesAuto(e.target.checked)}
                    aria-label="Automatic LES above Re 500"
                />
            </label>
            {!lesAuto && (
                <label className="barLabeled" htmlFor="lbmSetupLesManual">
                    <span className="barLabel">LES</span>
                    <input
                        id="lbmSetupLesManual"
                        className="lbmCheck"
                        type="checkbox"
                        checked={lesManual}
                        onChange={(e) => onLesManual(e.target.checked)}
                        aria-label="Manual LES toggle, applies while Auto is off"
                    />
                </label>
            )}
            <span className="divider" aria-hidden="true" />
            <span className="teleGroup">
                <span className="barLabel">PROGRESS</span>
                <span className="teleValue mono" role="status">{progressText}</span>
            </span>
            <span className="lbmStable mono" role="note">
                Stable below about Re 480 at u 0.05 on the default grid, scales with body cells. LES modeled above Re 500.
            </span>
        </div>
    );
}

export interface LbmFailoverNoticeProps {
    message: string;
    onRecover: () => void;
    suffix: string;
    recoverLabel: string;
}

export function LbmFailoverNotice({ message, onRecover, suffix, recoverLabel }: LbmFailoverNoticeProps) {
    if (isLbmTauFailover(message)) {
        return (
            <p className="notice lbmFault" role="alert">
                <span className="lbmFaultLamp" aria-hidden="true" />
                <span className="lbmFaultLabel">FAULT</span>
                <span className="lbmFaultText">{message}, {suffix}</span>
                <button type="button" className="noticeDismiss lbmFaultRecover" onClick={onRecover} aria-label={recoverLabel}>
                    {recoverLabel}
                </button>
            </p>
        );
    }
    return (
        <p className="fallbackNote notice" role="status">{message}, {suffix}</p>
    );
}

export interface LbmEntryNoticeProps {
    message: string;
    onDismiss: () => void;
}

export function LbmEntryNotice({ message, onDismiss }: LbmEntryNoticeProps) {
    return (
        <p className="reNote notice" role="status">
            {message}
            <button type="button" className="noticeDismiss" onClick={onDismiss} aria-label="Dismiss LBM notice">
                Dismiss
            </button>
        </p>
    );
}
