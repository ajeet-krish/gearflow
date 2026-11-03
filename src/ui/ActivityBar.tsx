// ActivityBar: far left VS Code style rail. 48px wide, full height,
// glyph buttons with labels below. Visual emulation only.

import { IDE_ACTIVITY_VIEWS, type IdeActivityView } from "./ideData";

export interface ActivityBarProps {
    active: IdeActivityView;
    onSelect: (view: IdeActivityView) => void;
}

export default function ActivityBar({ active, onSelect }: ActivityBarProps) {
    return (
        <nav className="ideActivity" aria-label="Activity bar">
            {IDE_ACTIVITY_VIEWS.map((v) => {
                const selected = v.id === active;
                return (
                    <button
                        key={v.id}
                        type="button"
                        className={selected ? "ideActBtn selected" : "ideActBtn"}
                        aria-label={v.label}
                        aria-pressed={selected}
                        title={v.label}
                        onClick={() => onSelect(v.id)}
                    >
                        <span className="ideActGlyph" aria-hidden="true">
                            {v.glyph}
                        </span>
                        <span className="ideActTick" aria-hidden="true" />
                    </button>
                );
            })}
            <span className="ideActSpacer" aria-hidden="true" />
            <span className="ideActAccount" aria-hidden="true">
                GF
            </span>
        </nav>
    );
}
