// GearFlow Phase 3 validation panel. Compares the analytic backend against
// vendored XFOIL and literature anchors (fixtures/validation JSON, offline).
// Renders the 9 architecture rows: expected, got, tolerance, source, tier,
// status. Only a fail on a PASS tier row blocks the demo.

import { useMemo } from "react";
import { generateAnalyticFlow } from "@/flow/analyticFlow";
import { alphaZero, fitSlope } from "@/validation/metrics";
import { TIER_TABLE, evaluateTier, isBlocking } from "@/validation/tiers";
import {
    POLAR_0012_RE100K,
    POLAR_0012_RE500K,
    POLAR_2412_RE100K,
    POLAR_2412_RE500K,
    clAtAlpha,
} from "@/validation/datasets";
import type { GeometrySpec, GridSpec, ValidationRow } from "@/contracts/types";
import { DEFAULT_DOMAIN } from "@/contracts/types";

const COARSE_GRID: GridSpec = { nx: 32, ny: 32, domain: { ...DEFAULT_DOMAIN } };

function airfoilSpec(code: "0012" | "2412", alphaDeg: number): GeometrySpec {
    if (code === "0012") {
        return { kind: "naca4", naca: { code: "0012", m: 0, p: 0.4, t: 0.12 }, chord: 1, alphaDeg, nPoints: 60 };
    }
    return { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg, nPoints: 60 };
}

function analyticCl(code: "0012" | "2412", alphaDeg: number): number {
    return generateAnalyticFlow(COARSE_GRID, airfoilSpec(code, alphaDeg)).cl;
}

function maxClErr(code: "0012" | "2412", alphas: number[], refAlphas: { alpha: number; cl: number }[]): number {
    let max = 0;
    for (const a of alphas) {
        const got = analyticCl(code, a);
        const ref = clAtAlpha(refAlphas, a);
        const err = Math.abs(got - ref);
        if (err > max) max = err;
    }
    return max;
}

const CHECK_ALPHAS = [4, 6, 8];

function buildRows(): ValidationRow[] {
    const e12hi = maxClErr("0012", CHECK_ALPHAS, POLAR_0012_RE500K.records);
    const e12lo = maxClErr("0012", CHECK_ALPHAS, POLAR_0012_RE100K.records);
    const e24hi = maxClErr("2412", CHECK_ALPHAS, POLAR_2412_RE500K.records);
    const e24lo = maxClErr("2412", CHECK_ALPHAS, POLAR_2412_RE100K.records);
    const fitPts = [-2, 0, 2, 4, 6].map((a) => ({
        alpha: a,
        cl: analyticCl("2412", a),
        cd: 0,
        cdp: 0,
        cm: 0,
        topXtr: 1,
        botXtr: 1,
    }));
    const analyticAlpha0 = alphaZero(fitSlope(fitPts, -2, 6));
    const expAlpha0 = alphaZero(fitSlope(POLAR_2412_RE500K.records, -2, 6));
    const rows: ValidationRow[] = [
        {
            id: "cl-0012-500k",
            label: "0012 Cl at 4, 6, 8 deg vs XFOIL Re 500k",
            tier: "PASS",
            status: evaluateTier("PASS", e12hi, TIER_TABLE.clAbsolute.passTol, TIER_TABLE.clAbsolute.warnTol),
            expected: "XFOIL 500k within 0.05",
            got: `max err ${e12hi.toFixed(3)}`,
            tolerance: "0.05",
            source: "xf-n0012-il-500000.csv",
        },
        {
            id: "cl-0012-100k",
            label: "0012 Cl at 4, 6, 8 deg vs XFOIL Re 100k",
            tier: "WARN",
            status: evaluateTier("WARN", e12lo, TIER_TABLE.re100kDisplay.passTol, TIER_TABLE.re100kDisplay.warnTol),
            expected: "XFOIL 100k display only",
            got: `max err ${e12lo.toFixed(3)}`,
            tolerance: "review 0.20",
            source: "xf-n0012-il-100000.csv",
            note: "Bubble kink near 1 to 2 deg, never PASS",
        },
        {
            id: "cl-2412-500k",
            label: "2412 Cl at 4, 6, 8 deg vs XFOIL Re 500k",
            tier: "PASS",
            status: evaluateTier("PASS", e24hi, TIER_TABLE.clAbsolute.passTol, TIER_TABLE.clAbsolute.warnTol),
            expected: "XFOIL 500k within 0.05",
            got: `max err ${e24hi.toFixed(3)}`,
            tolerance: "0.05",
            source: "xf-naca2412-il-500000.csv",
        },
        {
            id: "cl-2412-100k",
            label: "2412 Cl at 4, 6, 8 deg vs XFOIL Re 100k",
            tier: "WARN",
            status: evaluateTier("WARN", e24lo, TIER_TABLE.re100kDisplay.passTol, TIER_TABLE.re100kDisplay.warnTol),
            expected: "XFOIL 100k display only",
            got: `max err ${e24lo.toFixed(3)}`,
            tolerance: "review 0.20",
            source: "xf-naca2412-il-100000.csv",
            note: "Bubble kink near 1 to 2 deg, never PASS",
        },
        {
            id: "alpha0-2412-theory",
            label: "2412 alpha0 vs thin airfoil theory",
            tier: "PASS",
            status: evaluateTier("PASS", Math.abs(analyticAlpha0 + 2.07), TIER_TABLE.alphaZero.passTol, TIER_TABLE.alphaZero.warnTol),
            expected: "-2.07 deg",
            got: `${analyticAlpha0.toFixed(2)} deg`,
            tolerance: "0.25 deg",
            source: "analytic fit on -2 to 6 deg",
        },
        {
            id: "alpha0-2412-exp",
            label: "2412 alpha0 analytic vs XFOIL 500k fit",
            tier: "INFO",
            status: "info",
            expected: `${expAlpha0.toFixed(2)} deg (XFOIL 500k fit reference)`,
            got: `${analyticAlpha0.toFixed(2)} deg (analytic, delta ${(analyticAlpha0 - expAlpha0).toFixed(2)} deg)`,
            tolerance: "n/a",
            source: "analytic fit vs xf-naca2412-il-500000.csv",
            note: "Display only, compares analytic fit on -2 to 6 deg against XFOIL fit",
        },
        {
            id: "cyl-st",
            label: "Cylinder Strouhal band",
            tier: "INFO",
            status: "info",
            expected: "0.164 to 0.167",
            got: "n/a (steady solver)",
            tolerance: "n/a",
            source: "literature band",
            note: "No unsteady solver in scope",
        },
        {
            id: "cyl-cd",
            label: "Cylinder mean Cd",
            tier: "INFO",
            status: "info",
            expected: "1.32 to 1.38",
            got: "n/a (inviscid, Cd 0)",
            tolerance: "n/a",
            source: "literature band",
            note: "Cd never validated, inviscid gives 0",
        },
        {
            id: "cyl-clamp",
            label: "Cylinder Cl amplitude",
            tier: "INFO",
            status: "info",
            expected: "0.32 to 0.35",
            got: "n/a (steady solver)",
            tolerance: "n/a",
            source: "literature band",
            note: "No unsteady solver in scope",
        },
    ];
    return rows;
}

export default function ValidationPanel() {
    const rows = useMemo(() => {
        try {
            return buildRows();
        } catch (e) {
            console.error("Validation panel solve failure:", e instanceof Error ? e.message : String(e));
            return [];
        }
    }, []);
    const counts = useMemo(() => {
        const c = { pass: 0, warn: 0, fail: 0, info: 0 };
        for (const r of rows) c[r.status]++;
        return c;
    }, [rows]);
    const blocking = rows.filter((r) => isBlocking(r.tier, r.status));
    const allClear = blocking.length === 0;
    if (rows.length === 0) {
        return <p className="mono" role="status">Validation unavailable (solve failure). Adjust controls and retry.</p>;
    }
    return (
        <div className="validation">
            <div className="vSummary" role="status" aria-live="polite" aria-label="Validation summary counts">
                <ul className="vCounts" aria-label="Result counts">
                    <li><span className="badge status-pass" aria-label={`${counts.pass} passing`}>{counts.pass} pass</span></li>
                    <li><span className="badge status-warn" aria-label={`${counts.warn} warnings`}>{counts.warn} warn</span></li>
                    <li><span className="badge status-fail" aria-label={`${counts.fail} failures`}>{counts.fail} fail</span></li>
                    <li><span className="badge status-info" aria-label={`${counts.info} informational`}>{counts.info} info</span></li>
                </ul>
                <p className="vVerdict mono">{allClear ? "All PASS rows within tolerance." : `${blocking.length} PASS row${blocking.length === 1 ? "" : "s"} failing.`}</p>
            </div>
            {!allClear && (
                <p className="vAlert" role="alert">
                    Blocking: {blocking.map((r) => r.label).join("; ")}. Demo hold, check analytic fit.
                </p>
            )}
            <div className="vScroll" tabIndex={0} role="region" aria-label="Validation results table, scroll sideways on narrow screens">
                <table className="validationTable">
                    <caption className="visuallyHidden">
                        Nine offline anchors comparing the analytic backend against vendored XFOIL and literature bands. Only PASS tier failures block the demo.
                    </caption>
                    <thead>
                        <tr>
                            <th scope="col">Metric</th>
                            <th scope="col">Expected</th>
                            <th scope="col">Got</th>
                            <th scope="col">Tol</th>
                            <th scope="col">Tier</th>
                            <th scope="col">Status</th>
                            <th scope="col">Source</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.id} className={`tier-${r.tier.toLowerCase()} status-${r.status}`}>
                                <th scope="row" className="vMetric">
                                    {r.label}
                                    {r.note ? <span className="vNote">{r.note}</span> : null}
                                </th>
                                <td className="mono">{r.expected}</td>
                                <td className="mono">{r.got}</td>
                                <td className="mono">{r.tolerance}</td>
                                <td><span className={`badge tier-${r.tier.toLowerCase()}`}>{r.tier}</span></td>
                                <td><span className={`badge status-${r.status}`}>{r.status}</span></td>
                                <td className="mono vSource">{r.source}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="vFoot mono">Offline anchors, vendored JSON. Cylinder rows are INFO only, steady solver has no unsteady wake.</p>
        </div>
    );
}
