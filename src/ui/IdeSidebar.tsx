// IdeSidebar: RIGHT sidebar with four disclosures. Explorer carries the
// curated project tree, Source Control is a labelled snapshot (not live
// git), Extensions is a static list, Analysis is a mount point for the
// analysis panel. The sidebar owns its disclosure view state internally;
// no activity bar drives it from App. Visual emulation only, no vendored
// code.

import { useState, type ReactNode } from "react";
import type { CaseTabMemory } from "./caseTabs";
import type { IdeActivityView } from "./ideData";

export interface IdeSidebarProps {
    tabs: CaseTabMemory[];
    activeId: string;
    onActivate: (id: string) => void;
    analysis?: ReactNode;
    initialView?: IdeActivityView;
}

const CURATED_TREE: ReadonlyArray<{ name: string; detail: string }> = [
    { name: "docs", detail: "Product and review docs" },
    { name: "src-agent", detail: "Agent console and tutor policy" },
    { name: "src-ui", detail: "IDE shell and instrument panels" },
    { name: "src-render", detail: "Flow canvas and colorbar" },
];

const EXTENSIONS: ReadonlyArray<{ name: string; detail: string }> = [
    { name: "GearFlow Solver", detail: "Analytic potential flow" },
    { name: "Validation Ledger", detail: "Offline anchors" },
    { name: "Export", detail: "PDF plus PNG snapshot" },
];

function Triangle({ open }: { open: boolean }) {
    return (
        <span className="ideTri" aria-hidden="true">
            {open ? "\u25BE" : "\u25B8"}
        </span>
    );
}

export default function IdeSidebar({ tabs, activeId, onActivate, analysis, initialView = "explorer" }: IdeSidebarProps) {
    const [view, setView] = useState<IdeActivityView>(initialView);
    const isOpen = (id: IdeActivityView): boolean => view === id;
    return (
        <aside className="ideSide right" aria-label="Right sidebar">
            <section className="ideSec" aria-label="Explorer">
                <button
                    type="button"
                    className="ideSecHead"
                    aria-expanded={isOpen("explorer")}
                    onClick={() => setView("explorer")}
                >
                    <Triangle open={isOpen("explorer")} />
                    <span className="ideSecLabel">Explorer</span>
                </button>
                {isOpen("explorer") && (
                    <div>
                        <ul className="ideFileList">
                            {CURATED_TREE.map((item) => (
                                <li key={item.name} className="ideStaticRow" title={item.detail}>
                                    <span className="ideFileGlyph dim" aria-hidden="true">
                                        &#9679;
                                    </span>
                                    <span className="ideFileName">{item.name}</span>
                                </li>
                            ))}
                        </ul>
                        <ul className="ideFileList" aria-label="Open cases">
                            {tabs.map((t) => (
                                <li key={t.id}>
                                    <button
                                        type="button"
                                        className={t.id === activeId ? "ideFile selected" : "ideFile"}
                                        aria-current={t.id === activeId ? "true" : undefined}
                                        onClick={() => onActivate(t.id)}
                                        title={t.title}
                                    >
                                        <span className="ideFileName">{t.title}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </section>
            <section className="ideSec" aria-label="Source Control">
                <button
                    type="button"
                    className="ideSecHead"
                    aria-expanded={isOpen("source-control")}
                    onClick={() => setView("source-control")}
                >
                    <Triangle open={isOpen("source-control")} />
                    <span className="ideSecLabel">Source Control</span>
                </button>
                {isOpen("source-control") && (
                    <p className="ideSnapshot mono" role="status">
                        snapshot, not live git. 0 changed.
                    </p>
                )}
            </section>
            <section className="ideSec" aria-label="Extensions">
                <button
                    type="button"
                    className="ideSecHead"
                    aria-expanded={isOpen("extensions")}
                    onClick={() => setView("extensions")}
                >
                    <Triangle open={isOpen("extensions")} />
                    <span className="ideSecLabel">Extensions</span>
                </button>
                {isOpen("extensions") && (
                    <ul className="ideFileList">
                        {EXTENSIONS.map((item) => (
                            <li key={item.name} className="ideStaticRow" title={item.detail}>
                                <span className="ideFileGlyph dim" aria-hidden="true">
                                    &#9679;
                                </span>
                                <span className="ideFileName">{item.name}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            <section className="ideSec" aria-label="Analysis">
                <button
                    type="button"
                    className="ideSecHead"
                    aria-expanded={isOpen("analysis")}
                    onClick={() => setView("analysis")}
                >
                    <Triangle open={isOpen("analysis")} />
                    <span className="ideSecLabel">Analysis</span>
                </button>
                {isOpen("analysis") && (
                    <div className="ideAnalysisMount">
                        {analysis ?? <p className="mSub mono">Analysis mounts here.</p>}
                    </div>
                )}
            </section>
        </aside>
    );
}
