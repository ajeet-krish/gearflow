// GearFlow top navbar, Zenith instrument-room style. 56px tall, deep
// background, purple active states. STUDIO plus THEORY links centered
// via a 3-zone grid, FULL SCREEN toggle, the settings gear. The brand
// mark is the Tsunami/Storm surges wave: a white wave on a dark square,
// decorative where the GearFlow wordmark is present.

export type NavId = "studio" | "theory";

export interface TopNavProps {
    active: NavId;
    onNav: (id: NavId) => void;
    settingsOpen: boolean;
    onOpenSettings: () => void;
    focusMode?: boolean;
    onToggleFocus?: () => void;
}

export function BrandMark({ size = 32 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 60.601 60.601"
            aria-hidden="true"
            focusable="false"
        >
            <rect
                x="4.601"
                y="4.603"
                width="51.396"
                height="51.396"
                rx="7"
                fill="#0d0d12"
                stroke="#44475a"
                strokeWidth="1.5"
            />
            <path
                d="m51.741 38.818c-5.6441 1.305-14.982 2.3517-22.272-2.0335-3.7074-2.2226-5.1507-6.6078-3.2417-9.7941 1.9229-3.1817 6.4649-3.961 10.163-1.743 0.54873 0.3274 1.0375 0.69629 1.4756 1.1067l0.5395-0.31355c-2.7805-6.9398-11.763-13.608-29.479-4.2653v-12.888h42.815z"
                fill="#f8f8f2"
            />
        </svg>
    );
}

const NAV_ITEMS: Array<{ id: NavId; label: string }> = [
    { id: "studio", label: "STUDIO" },
    { id: "theory", label: "THEORY" },
];

export default function TopNav({
    active,
    onNav,
    settingsOpen,
    onOpenSettings,
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
                        aria-label={focusMode ? "Exit full screen mode and restore panels" : "Enter full screen mode and collapse panels"}
                        title="Full tunnel view (backtick)"
                    >
                        FULL SCREEN
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
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1 -2.83 2.83l-.06-.06a1.65 1.65 0 0 0 -1.82-.33 1.65 1.65 0 0 0 -1 1.51V21a2 2 0 1 1 -4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0 -1.82.33l-.06.06a2 2 0 1 1 -2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0 -1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0 -.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l.06.06a1.65 1.65 0 0 0 -.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0 -1.51 1z" />
                    </svg>
                </button>
            </div>
        </header>
    );
}
