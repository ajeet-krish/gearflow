// TelemetryBar: Zenith StatusBar style strip pinned under the field bar.
// Engine state, grid, cells, solve time, Cl, CpMin, regime on the left,
// provenance plus validation counts on the right. Pure props only.

export interface TelemetryBarProps {
    engine: string;
    dotClass: string;
    gridLabel: string;
    cells: number;
    solveMs: number;
    cl: number;
    cpMin: number;
    regime: string;
    provenanceLabel: string;
    pass: number;
    warn: number;
    fail: number;
    isFixture: boolean;
}

function finite(v: number, digits: number): string {
    return Number.isFinite(v) ? v.toFixed(digits) : "n/a";
}

export default function TelemetryBar({
    engine,
    dotClass,
    gridLabel,
    cells,
    solveMs,
    cl,
    cpMin,
    regime,
    provenanceLabel,
    pass,
    warn,
    fail,
    isFixture,
}: TelemetryBarProps) {
    return (
        <div className="telemetryBar" role="status" aria-label="Solver telemetry">
            <span className="teleGroup">
                <span className={`dot ${dotClass}`} aria-hidden="true" />
                <span className="barLabel">ENGINE</span>
                <span className="teleValue">{engine}</span>
            </span>
            <span className="divider" aria-hidden="true" />
            <span className="teleGroup">
                <span className="barLabel">GRID</span>
                <span className="teleValue">{gridLabel}</span>
            </span>
            <span className="teleGroup">
                <span className="barLabel">CELLS</span>
                <span className="teleValue">{cells.toLocaleString("en-US")}</span>
            </span>
            <span className="teleGroup">
                <span className="barLabel">SOLVE</span>
                <span className="teleValue">{finite(solveMs, 1)} ms</span>
            </span>
            <span className="teleGroup">
                <span className="barLabel">CL</span>
                <span className="teleValue">{isFixture ? "n/a" : finite(cl, 3)}</span>
            </span>
            <span className="teleGroup">
                <span className="barLabel">CPMIN</span>
                <span className="teleValue">{isFixture ? "n/a" : finite(cpMin, 3)}</span>
            </span>
            <span className="teleGroup">
                <span className="barLabel">REGIME</span>
                <span className="teleValue teleRegime">{regime}</span>
            </span>
            <span className="spacer" aria-hidden="true" />
            <span className="teleProv" title={provenanceLabel}>
                {provenanceLabel}
            </span>
            <span className="divider" aria-hidden="true" />
            <span className="teleGroup" aria-label={`${pass} passing, ${warn} warnings, ${fail} failures`}>
                <span className="barLabel">PASS</span>
                <span className="telePass">{pass}</span>
                <span className="barLabel">WARN</span>
                <span className="teleWarn">{warn}</span>
                <span className="barLabel">FAIL</span>
                <span className="teleFail">{fail}</span>
            </span>
        </div>
    );
}
