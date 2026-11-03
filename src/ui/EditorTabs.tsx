// EditorTabs: VS Code style editor tab strip. One tab per case memory,
// active tab carries the top border accent. No close buttons: tabs are
// case memories, never closable documents. The dot renders only when the
// memory is dirty. Full keyboard support, no vendored code.

import type { CaseTabMemory } from "./caseTabs";

export interface EditorTabsProps {
    tabs: CaseTabMemory[];
    activeId: string;
    onActivate: (id: string) => void;
}

export default function EditorTabs({ tabs, activeId, onActivate }: EditorTabsProps) {
    return (
        <div className="ideTabs" role="tablist" aria-label="Open cases">
            {tabs.map((t) => {
                const selected = t.id === activeId;
                return (
                    <div
                        key={t.id}
                        role="tab"
                        aria-selected={selected}
                        aria-label={`${t.title}, case tab${t.dirty ? ", unsaved changes" : ""}`}
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
    );
}
