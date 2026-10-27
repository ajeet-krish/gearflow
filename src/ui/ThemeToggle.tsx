// Theme toggle: dark default, light available. One button, 44px target.

import type { ThemeName } from "./theme";

export interface ThemeToggleProps {
    theme: ThemeName;
    onTheme: (next: ThemeName) => void;
}

export default function ThemeToggle({ theme, onTheme }: ThemeToggleProps) {
    const next: ThemeName = theme === "dark" ? "light" : "dark";
    return (
        <button
            type="button"
            className="themeToggle"
            onClick={() => onTheme(next)}
            aria-label={`Switch to ${next} theme, current is ${theme}`}
            title={`Current theme ${theme}, switch to ${next}`}
        >
            {theme === "dark" ? "Light theme" : "Dark theme"}
        </button>
    );
}
