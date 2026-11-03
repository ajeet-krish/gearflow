// EditorTabs: Body selector tab strip above the FIELD bar. One tab per
// body (NACA Airfoil, Cylinder, Rectangle, Orifice), active tab carries the
// top border accent. No close buttons: tabs are body memories, never
// closable documents. The dot renders only when the memory is dirty. Full
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
            <div className="ideTabs bodyTabs" role="tablist" aria-label="Body">
                {tabs.map((t) => {
                    const selected = t.id === activeId;
                    return (
                        <div
                            key={t.id}
                            role="tab"
                            aria-selected={selected}
                            aria-label={`${t.title}, body tab${t.dirty ? ", unsaved changes" : ""}`}
                            tabIndex={selected ? 0 : -1}
                            className={selected ? "ideTab selected" : "ideTab"}
                            onClick={() => onActivate(t.id)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onActivate(t.id);
                                }
                            }}
                        >
                            {t.dirty ? <span className="ideTabDot" aria-hidden="true" /> : null}
                            <span className="ideTabName">{t.title}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
