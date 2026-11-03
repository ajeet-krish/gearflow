// EditorTabs: Body selector chip strip above the FIELD bar. One chip per
// body (NACA Airfoil, Cylinder, Rectangle, Orifice). The tabs share the
// exact Field selector chip rules (same chip classes, same 11px mono type,
// same outlined Dracula selected box), seated on black. No dots, no close
// buttons: tabs are body memories, never closable documents, and the
// unsaved state rides the accessible label only. Native buttons carry
// Enter/Space activation; the tablist adds the WAI-ARIA arrow-key pattern
// (Left/Right move with wrap, Home/End jump) with automatic activation.

import type { KeyboardEvent } from "react";
import type { CaseTabMemory } from "./caseTabs";

export interface EditorTabsProps {
    tabs: CaseTabMemory[];
    activeId: string;
    onActivate: (id: string) => void;
}

export default function EditorTabs({ tabs, activeId, onActivate }: EditorTabsProps) {
    function handleTablistKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        if (buttons.length === 0) return;
        const target = event.target as HTMLElement | null;
        const current = target ? buttons.indexOf(target as HTMLButtonElement) : -1;
        if (current < 0) return;
        event.preventDefault();
        let next = current;
        if (event.key === "ArrowRight") next = (current + 1) % buttons.length;
        else if (event.key === "ArrowLeft") next = (current - 1 + buttons.length) % buttons.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = buttons.length - 1;
        if (next === current) return;
        const id = tabs[next]?.id;
        if (id) onActivate(id);
        buttons[next]?.focus();
    }

    return (
        <div className="sceneBar bodyBar" role="toolbar" aria-label="Body selector">
            <span className="barLabel">BODY</span>
            <div className="chipGroup" role="tablist" aria-label="Body" onKeyDown={handleTablistKeyDown}>
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
