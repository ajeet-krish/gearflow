// IdeTitleBar: VS Code Dark+ title emulation. 30px, deep editor chrome,
// centered case search, window dots on the right. Visual emulation only,
// no vendored code.

import { BrandMark } from "./TopNav";

export interface IdeTitleBarProps {
    title: string;
    subtitle?: string;
    offline: boolean;
    onOpenSettings: () => void;
}

const MENU = ["File", "Edit", "Selection", "View", "Go", "Run"] as const;

export default function IdeTitleBar({ title, subtitle, offline, onOpenSettings }: IdeTitleBarProps) {
    return (
        <header className="ideTitleBar" aria-label="IDE title bar">
            <span className="ideBrandMark" aria-hidden="true">
                <BrandMark size={18} />
            </span>
            <nav className="ideMenu" aria-label="Title bar menu">
                {MENU.map((m) => (
                    <span key={m} className="ideMenuItem" aria-hidden="true">
                        {m}
                    </span>
                ))}
            </nav>
            <div className="ideTitleSearch" role="search" aria-label="Case search">
                <span className="ideSearchGlyph" aria-hidden="true">
                    &#8981;
                </span>
                <span className="ideSearchText" title={subtitle ?? title}>
                    {title}
                </span>
                <span className={`ideSearchDot ${offline ? "off" : "on"}`} aria-hidden="true" />
                <span className="visuallyHidden">{offline ? "Offline" : "Live"}</span>
            </div>
            <div className="ideTitleRight">
                <button
                    type="button"
                    className="ideTitleBtn"
                    onClick={onOpenSettings}
                    aria-haspopup="dialog"
                    aria-label="Open display settings"
                    title="Display settings"
                >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1 -2.83 2.83l-.06-.06a1.65 1.65 0 0 0 -1.82-.33 1.65 1.65 0 0 0 -1 1.51V21a2 2 0 1 1 -4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0 -1.82.33l-.06.06a2 2 0 1 1 -2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0 -1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0 -.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0 -.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0 -1.51 1z" />
                    </svg>
                </button>
                <span className="ideTraffic" aria-hidden="true">
                    <i className="ideDotMin" />
                    <i className="ideDotMax" />
                    <i className="ideDotClose" />
                </span>
            </div>
        </header>
    );
}
