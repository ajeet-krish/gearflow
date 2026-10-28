// GearFlow top navbar, Zenith instrument-room style. 56px tall, deep
// background, purple active states. Single STUDIO link plus FOCUS, the
// settings gear, and the WASM badge. No network state here: the offline
// chip lives in the agent rail behind the debug flag.

export type NavId = "studio";

export interface TopNavProps {
    active: NavId;
    onNav: (id: NavId) => void;
    settingsOpen: boolean;
    onOpenSettings: () => void;
    wasmActive: boolean;
    focusMode?: boolean;
    onToggleFocus?: () => void;
}

function BrandMark() {
    return (
        <svg
            width="32"
            height="32"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden="true"
        >
            <path
                d="M3 21 C 9 21, 12 8, 20 8 L 29 8"
                stroke="#bd93f9"
                strokeWidth="2"
                strokeLinecap="round"
            />
            <path
                d="M3 25 C 10 25, 13 15, 21 15 L 27 15"
                stroke="#8be9fd"
                strokeWidth="1.5"
                strokeLinecap="round"
                opacity="0.8"
            />
            <path
                d="M6 12 C 12 12, 15 18, 24 18"
                stroke="#8be9fd"
                strokeWidth="1"
                strokeLinecap="round"
                opacity="0.45"
            />
        </svg>
    );
}

const NAV_ITEMS: Array<{ id: NavId; label: string }> = [
    { id: "studio", label: "STUDIO" },
];

export default function TopNav({
    active,
    onNav,
    settingsOpen,
    onOpenSettings,
    wasmActive,
    focusMode = false,
    onToggleFocus,
}: TopNavProps) {
    return (
        <header className="topNav">
            <div className="brand">
                <BrandMark />
                <span className="wordmark">GearFlow</span>
            </div>
            <nav className="navLinks" aria-label="Studio sections">
                {NAV_ITEMS.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        className={active === item.id ? "navLink active" : "navLink"}
                        aria-current={active === item.id ? "page" : undefined}
                        onClick={() => onNav(item.id)}
                    >
                        {item.label}
                    </button>
                ))}
            </nav>
            <div className="navRight">
                {onToggleFocus && (
                    <button
                        type="button"
                        className={focusMode ? "navLink active" : "navLink"}
                        aria-pressed={focusMode}
                        onClick={onToggleFocus}
                        aria-label={focusMode ? "Exit focus mode and restore panels" : "Enter focus mode and collapse panels"}
                        title="Full tunnel view (backtick)"
                    >
                        FOCUS
                    </button>
                )}
                <button
                    type="button"
                    className="navIcon"
                    onClick={onOpenSettings}
                    aria-haspopup="dialog"
                    aria-expanded={settingsOpen}
                    aria-label="Open settings"
                    title="Display settings"
                >
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                    >
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1 -2.83 2.83l-.06-.06a1.65 1.65 0 0 0 -1.82-.33 1.65 1.65 0 0 0 -1 1.51V21a2 2 0 1 1 -4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0 -1.82.33l-.06.06a2 2 0 1 1 -2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0 -1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0 -.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0 -.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0 -1.51 1z" />
                    </svg>
                </button>
                {wasmActive && (
                    <span className="wasmBadge mono" role="status">
                        WASM
                    </span>
                )}
            </div>
        </header>
    );
}
