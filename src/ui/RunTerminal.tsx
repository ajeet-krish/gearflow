// RunTerminal: collapsible bottom terminal for the tunnel column. A quiet
// 24px status strip (dot plus engine, grid, Re, step mono groups, Log
// toggle right aligned with the row count) with an expandable log panel
// above it. The panel is session only, collapsed on load, mono 11px, auto
// scrolls to the latest row, Clear sticks to the bottom right, error rows
// carry the red alert tint. New rows never steal focus, role log announces
// politely. Escape closes the panel through the toggle path, the strip
// stays put in every layout including focus mode.

import { useEffect, useRef, type KeyboardEvent, type Ref } from "react";

export type TerminalTone = "info" | "warn" | "block" | "error";

export interface TerminalRow {
    key: string;
    text: string;
    tone: TerminalTone;
}

export type TerminalStatus = "idle" | "ready" | "running" | "failed";

export interface RunTerminalProps {
    status: TerminalStatus;
    engine: string;
    gridLabel: string;
    reynolds: number;
    stepText: string;
    rows: TerminalRow[];
    expanded: boolean;
    onToggle: () => void;
    onClear: () => void;
}

const DOT: Record<TerminalStatus, string> = {
    idle: "dot",
    ready: "dot analytic",
    running: "dot running",
    failed: "dot failed",
};

export interface RunTerminalViewProps extends RunTerminalProps {
    panelRef?: Ref<HTMLDivElement>;
}

/**
 * Pure view split: no hooks, so wiring tests can call it directly while
 * the default export owns the auto scroll effect. Never steal focus here,
 * row updates only ever re-render text.
 */
export function RunTerminalView({
    status,
    engine,
    gridLabel,
    reynolds,
    stepText,
    rows,
    expanded,
    onToggle,
    onClear,
    panelRef,
}: RunTerminalViewProps) {
    const onSectionKey = (e: KeyboardEvent<HTMLElement>) => {
        if (e.key === "Escape" && expanded) {
            e.stopPropagation();
            onToggle();
        }
    };
    return (
        <section className="runTerm" aria-label="Run terminal" onKeyDown={onSectionKey}>
            {expanded && (
                <div
                    ref={panelRef}
                    id="runTermPanel"
                    className="runTermPanel"
                    role="log"
                    aria-label="Run event log"
                >
                    {rows.length === 0 ? (
                        <p className="runTermEmpty mono">No run events this session. LBM runs and failovers land here.</p>
                    ) : (
                        <ol className="runTermRows">
                            {rows.map((r) => (
                                <li
                                    key={r.key}
                                    className={r.tone === "info" ? "runTermRow mono" : `runTermRow mono tone-${r.tone}`}
                                >
                                    {r.text}
                                </li>
                            ))}
                        </ol>
                    )}
                    <div className="runTermClear">
                        <button
                            type="button"
                            className="runTermClearBtn"
                            onClick={onClear}
                            aria-label="Clear run log"
                        >
                            Clear
                        </button>
                    </div>
                </div>
            )}
            <div className="runTermStrip">
                <span className={DOT[status]} aria-hidden="true" />
                <span className="teleGroup">
                    <span className="barLabel">ENGINE</span>
                    <span className="teleValue mono">{engine}</span>
                </span>
                <span className="teleGroup">
                    <span className="barLabel">GRID</span>
                    <span className="teleValue mono">{gridLabel}</span>
                </span>
                <span className="teleGroup">
                    <span className="barLabel">RE</span>
                    <span className="teleValue mono">{Math.round(reynolds).toLocaleString("en-US")}</span>
                </span>
                <span className="teleGroup">
                    <span className="barLabel">STEP</span>
                    <span className="teleValue mono">{stepText}</span>
                </span>
                <button
                    type="button"
                    className="runTermToggle"
                    aria-expanded={expanded}
                    aria-controls="runTermPanel"
                    aria-label={expanded ? "Collapse run log" : "Expand run log"}
                    onClick={onToggle}
                >
                    LOG
                    <span className="runTermCount mono" aria-hidden="true">{rows.length}</span>
                </button>
            </div>
        </section>
    );
}

export default function RunTerminal(props: RunTerminalProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const { expanded, rows } = props;
    // Auto scroll to the latest row while expanded. Instant jump, no
    // animation, so reduced motion needs no override and focus stays put.
    useEffect(() => {
        if (!expanded) return;
        const el = panelRef.current;
        if (el === null) return;
        try {
            el.scrollTop = el.scrollHeight;
        } catch {
            // Auto scroll must never break the strip.
        }
    }, [expanded, rows]);
    return <RunTerminalView {...props} panelRef={panelRef} />;
}
