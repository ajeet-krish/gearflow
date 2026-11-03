// P2 IDE shell canvas top contract: the tunnel column keeps the IDE
// title bar, the top navbar with STUDIO and THEORY, activity bar, sidebar,
// editor tabs, and status bar with the FIELD bar inside the collapsible
// SceneBars plus the run card. SolverBar and LbmSetupRow stay gone from the
// canvas path and the right rail carries no DISPLAY section. TelemetryBar
// and RunTerminal stay unmounted, single solver and single canvas only.
// THEORY replaces the tunnel column while studio keeps the canvas.
// VALIDATION and EXPORT mount only behind ?debug=1. Reads App.tsx source
// so the contract cannot drift without a test failure. No DOM needed.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");

describe("Phase 13 canvas top", () => {
    it("keeps the IDE shell, the top navbar, the FIELD bar, the run card, and the status bar", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("<IdeTitleBar");
        expect(src).toContain("<TopNav");
        expect(src).toContain("<ActivityBar");
        expect(src).toContain("<IdeSidebar");
        expect(src).toContain("<EditorTabs");
        expect(src).toContain("<SceneBars");
        expect(src).toContain("<FieldBar");
        expect(src).not.toContain("<TelemetryBar");
        expect(src).not.toContain("<RunTerminal");
        expect(src).toContain('className="runCard"');
        expect(src).toContain("<IdeStatusBar");
    });

    it("routes studio versus theory through the top navbar with the canvas hidden on theory", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("<TheoryPage");
        expect(src).toContain("activeNav");
        expect(src).toContain("handleNav");
        expect(src).toContain('activeNav === "theory"');
        expect(src).toContain("FULL SCREEN");
        expect(src).toContain("Exit full screen mode and restore panels");
        expect(src).not.toContain("EXIT FOCUS");
    });

    it("mounts no solver or LBM setup bars above the canvas", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toContain("<SolverBar");
        expect(src).not.toContain("<LbmSetupRow");
    });

    it("routes field selection through the single funnel with the same gating", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("variable={effectiveVariable}");
        expect(src).toContain("hasTke={hasTke}");
        expect(src).toContain("hasRecirc={hasRecirc}");
        expect(src).toContain("overlays={effectiveOverlays}");
        expect(src).toContain("overlayPatchForFieldChange(next)");
    });

    it("derives effective overlays and passes booleans plus particle size to the canvas", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("resolveOverlays(effectiveVariable, prefs)");
        expect(src).toContain("showContours={effectiveOverlays.contours}");
        expect(src).toContain("showStreamlines={effectiveOverlays.showStreamlines}");
        expect(src).toContain("particleSize={prefs.particleSize}");
    });

    it("carries no DISPLAY section in the right rail", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toMatch(/id:\s*"display"/);
        expect(src).not.toContain("displaySummary");
    });

    it("gates VALIDATION and EXPORT behind the debug flag", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("readDebugPanels");
        expect(src).toContain("debugPanels");
        expect(src).toMatch(/debugPanels\s*\?\s*\[/);
    });

    it("owns no terminal state: Escape only exits focus, status carries counts", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toContain("terminalOpen");
        expect(src).not.toContain("clearTerminal");
        expect(src).not.toContain("<RunTerminal");
        expect(src).toContain("exitFocus");
        expect(src).toContain("<IdeStatusBar");
    });
});
