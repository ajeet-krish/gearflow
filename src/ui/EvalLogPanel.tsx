// GearFlow Phase 4 eval log panel. Quiet ledger of Meta API calls: model,
// latency, estimated cost, cached flag. Export downloads the log as JSON for
// the submission record. No em dashes in copy.

import type { EvalLogEntry } from "@/contracts/types";

export interface EvalLogPanelProps {
    entries: EvalLogEntry[];
}

function downloadJson(entries: EvalLogEntry[]): void {
    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gearflow-eval-log.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function EvalLogPanel({ entries }: EvalLogPanelProps) {
    const totalCost = entries.reduce((sum, e) => sum + e.costUsd, 0);
    return (
        <div className="evalLog">
            <div className="evalHead">
                <p className="mono evalCount" role="status">
                    {entries.length === 0
                        ? "No Meta calls yet this session."
                        : `${entries.length} call${entries.length === 1 ? "" : "s"}, est. $${totalCost.toFixed(4)} total.`}
                </p>
                <button
                    type="button"
                    className="mBtn evalExport"
                    onClick={() => downloadJson(entries)}
                    disabled={entries.length === 0}
                >
                    Export JSON
                </button>
            </div>
            {entries.length === 0 ? (
                <p className="mSub">Calls appear here with model, latency, estimated cost, and cache state.</p>
            ) : (
                <div className="vScroll" tabIndex={0} role="region" aria-label="Eval log table, scroll sideways on narrow screens">
                    <table className="evalTable">
                        <caption className="visuallyHidden">
                            Ledger of Meta API calls this session. Costs are planning estimates, not live billing.
                        </caption>
                        <thead>
                            <tr>
                                <th scope="col">Feature</th>
                                <th scope="col">Model</th>
                                <th scope="col">Latency</th>
                                <th scope="col">Cost</th>
                                <th scope="col">Cached</th>
                                <th scope="col">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map((e) => (
                                <tr key={e.id} className={e.ok ? "" : "evalFail"}>
                                    <th scope="row" className="mono">{e.feature}</th>
                                    <td className="mono evalModel">{e.model}</td>
                                    <td className="mono">{e.latencyMs.toFixed(0)} ms</td>
                                    <td className="mono">${e.costUsd.toFixed(4)}{e.costEstimated ? " est" : ""}</td>
                                    <td>
                                        <span className={`mDot ${e.cached ? "on" : "off"} mDotInline`} aria-hidden="true" />
                                        <span className="mono">{e.cached ? "hit" : "live"}</span>
                                    </td>
                                    <td className="mono">{e.ok ? "ok" : `fail${e.fallback ? ` (${e.fallback})` : ""}`}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <p className="mSub mono">Costs are planning estimates, not live billing. Ring buffer keeps the last 50 calls.</p>
        </div>
    );
}
