// AnalysisSection: one collapsible window in the stacked analysis rail.
// Content stays mounted when collapsed (hidden via CSS) so slider and
// ledger state never resets. Pure props, no window access.

import type { ReactNode } from "react";

export interface AnalysisSectionProps {
    id: string;
    label: string;
    open: boolean;
    onToggle: (id: string) => void;
    children: ReactNode;
}

export default function AnalysisSection({
    id,
    label,
    open,
    onToggle,
    children,
}: AnalysisSectionProps) {
    return (
        <section className="asec" aria-label={`${label} section`}>
            <button
                type="button"
                className="asecBtn"
                aria-expanded={open}
                aria-controls={`asec-${id}`}
                onClick={() => onToggle(id)}
            >
                <span className={open ? "asecLabel open" : "asecLabel"}>
                    {label}
                </span>
                <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className={open ? "chev open" : "chev"}
                    aria-hidden="true"
                >
                    <polyline points="9 18 15 12 9 6" />
                </svg>
            </button>
            <div
                id={`asec-${id}`}
                className={open ? "asecBody" : "asecBody closed"}
                aria-hidden={open ? undefined : true}
            >
                {children}
            </div>
        </section>
    );
}
