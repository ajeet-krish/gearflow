// Instrument tab container. Keep-alive panels: every tab renders and the
// inactive ones hide, so canvas backed panels never lose local state.

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface InstrumentTab {
    id: string;
    label: string;
    content: ReactNode;
}

export interface InstrumentTabsProps {
    tabs: InstrumentTab[];
    initial?: string;
    ariaLabel?: string;
}

/**
 * WAI-APG tabs keyboard target. Returns the tab index to move to for a
 * navigation key, or null when the key is not a tab navigation key.
 * Wrap-around follows the APG automatic activation pattern.
 */
export function tabKeyTarget(count: number, current: number, key: string): number | null {
    if (count <= 0) return null;
    const last = count - 1;
    switch (key) {
        case "ArrowRight":
        case "ArrowDown":
            return current >= last ? 0 : current + 1;
        case "ArrowLeft":
        case "ArrowUp":
            return current <= 0 ? last : current - 1;
        case "Home":
            return 0;
        case "End":
            return last;
        default:
            return null;
    }
}

export function tabId(id: string): string {
    return `inst-tab-${id}`;
}

export function panelId(id: string): string {
    return `inst-panel-${id}`;
}

export default function InstrumentTabs({ tabs, initial, ariaLabel = "Instrument tabs" }: InstrumentTabsProps) {
    const [active, setActive] = useState<string>(() => {
        if (initial !== undefined && tabs.some((t) => t.id === initial)) return initial;
        return tabs.length > 0 ? tabs[0].id : "";
    });
    const current = tabs.some((t) => t.id === active) ? active : (tabs[0]?.id ?? "");
    const currentIndex = Math.max(0, tabs.findIndex((t) => t.id === current));
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

    function activate(index: number, focus: boolean): void {
        const tab = tabs[index];
        if (tab === undefined) return;
        setActive(tab.id);
        if (focus) tabRefs.current[index]?.focus();
    }

    function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number): void {
        const target = tabKeyTarget(tabs.length, index, e.key);
        if (target === null) return;
        e.preventDefault();
        activate(target, true);
    }

    return (
        <div className="instTabs">
            <div className="tabBar" role="tablist" aria-label={ariaLabel} aria-orientation="horizontal">
                {tabs.map((t, i) => (
                    <button
                        key={t.id}
                        ref={(el) => {
                            tabRefs.current[i] = el;
                        }}
                        type="button"
                        role="tab"
                        id={tabId(t.id)}
                        aria-controls={panelId(t.id)}
                        aria-selected={t.id === current}
                        tabIndex={t.id === current ? 0 : -1}
                        className={t.id === current ? "tabBtn tabActive" : "tabBtn"}
                        onClick={() => activate(i, false)}
                        onKeyDown={(e) => onTabKeyDown(e, i)}
                    >
                        {t.label}
                    </button>
                ))}
            </div>
            {tabs.map((t) => (
                <div
                    key={t.id}
                    role="tabpanel"
                    id={panelId(t.id)}
                    aria-labelledby={tabId(t.id)}
                    tabIndex={t.id === current ? 0 : -1}
                    hidden={t.id !== current}
                >
                    {t.content}
                </div>
            ))}
            {tabs.length > 0 && <span className="visuallyHidden" aria-live="polite">{`Tab ${currentIndex + 1} of ${tabs.length} selected`}</span>}
        </div>
    );
}
