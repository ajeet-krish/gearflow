// AnalysisPanel: vertically stacked collapsible analysis windows, Zenith
// style. Multiple sections open at once, the rail scrolls. Pure props.

import type { ReactNode } from "react";
import AnalysisSection from "./AnalysisSection";

export interface AnalysisSectionDef {
    id: string;
    label: string;
    content: ReactNode;
}

export interface AnalysisPanelProps {
    sections: AnalysisSectionDef[];
    open: Set<string> | string[];
    onToggle: (id: string) => void;
}

function isOpen(open: Set<string> | string[], id: string): boolean {
    if (Array.isArray(open)) return open.includes(id);
    return open.has(id);
}

export default function AnalysisPanel({ sections, open, onToggle }: AnalysisPanelProps) {
    return (
        <div className="analysisPanel" role="group" aria-label="Analysis windows">
            <div className="analysisScroll">
                {sections.map((s) => (
                    <AnalysisSection
                        key={s.id}
                        id={s.id}
                        label={s.label}
                        open={isOpen(open, s.id)}
                        onToggle={onToggle}
                    >
                        {s.content}
                    </AnalysisSection>
                ))}
            </div>
        </div>
    );
}
