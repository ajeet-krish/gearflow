// EditorTabs: Body selector chip strip above the FIELD bar. One chip per
// body (NACA Airfoil, Cylinder, Rectangle, Orifice). The tabs share the
// exact Field selector chip rules (same chip classes, same 11px mono type,
// same outlined Dracula selected box), seated on black. No dots, no close
// buttons: tabs are body memories, never closable documents, and the
// unsaved state rides the accessible label only. Native buttons carry full
// keyboard support, no vendored code.

import type { CaseTabMemory } from "./caseTabs";

export interface EditorTabsProps {
    tabs: CaseTabMemory[];
    activeId: string;
    onActivate: (id: string) => void;
}

export default function EditorTabs({ tabs, activeId, onActivate }: EditorTabsProps) {
    return (
        <div className="sceneBar bodyBar" role="toolbar" aria-label="Body selector">
            <span className="barLabel">BODY</span>
            <div className="chipGroup" role="tablist" aria-label="Body">
                {tabs.map((t) => {
                    const selected = t.id === activeId;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            aria-label={`${t.title}, body tab${t.dirty ? ", unsaved changes" : ""}`}
                            tabIndex={selected ? 0 : -1}
                            className={selected ? "chip active" : "chip"}
                            onClick={() => onActivate(t.id)}
                        >
                            {t.title}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
