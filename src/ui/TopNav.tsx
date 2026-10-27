// GearFlow top navbar, Zenith instrument-room style. 56px tall, deep
// background, purple active states. No window access during render.

import type { ThemeName } from "./theme";

export type NavId = "studio" | "validate" | "export";

export interface TopNavProps {
    offline: boolean;
    active: NavId;
    onNav: (id: NavId) => void;
    theme: ThemeName;
    onTheme: (next: ThemeName) => void;
    wasmActive: boolean;
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
    { id: "validate", label: "VALIDATE" },
    { id: "export", label: "EXPORT" },
];

export default function TopNav({
    offline,
    active,
    onNav,
    theme,
    onTheme,
    wasmActive,
}: TopNavProps) {
    const nextTheme: ThemeName = theme === "dark" ? "light" : "dark";
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
                <span
                    className="offlineChip"
                    role="status"
                    aria-label={offline ? "Offline, local only" : "Online"}
                >
                    <span
                        className={offline ? "dot off" : "dot on"}
                        aria-hidden="true"
                    />
                    {offline ? "OFFLINE" : "ONLINE"}
                </span>
                <button
                    type="button"
                    className="navExport"
                    onClick={() => onNav("export")}
                    aria-label="Open the export section"
                >
                    Export
                </button>
                <button
                    type="button"
                    className="navTheme"
                    onClick={() => onTheme(nextTheme)}
                    aria-label={`Switch to ${nextTheme} theme, current is ${theme}`}
                    title={`Current theme ${theme}, switch to ${nextTheme}`}
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
                        <circle cx="12" cy="12" r="4" />
                        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
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
