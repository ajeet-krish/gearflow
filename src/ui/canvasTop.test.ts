// Phase 13 canvas top contract: the tunnel column keeps TopNav, the FIELD
// bar inside the collapsible SceneBars, the TelemetryBar strip plus the run
// card and the bottom terminal, while SolverBar and LbmSetupRow stay gone
// from the canvas path and the right rail carries no DISPLAY section.
// VALIDATION and EXPORT mount only behind ?debug=1. Reads App.tsx source
// so the contract cannot drift without a test failure. No DOM needed.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");

describe("Phase 13 canvas top", () => {
    it("keeps TopNav, the FIELD bar, TelemetryBar, the run card, and the bottom terminal", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("<TopNav");
        expect(src).toContain("<SceneBars");
        expect(src).toContain("<FieldBar");
        expect(src).toContain("<TelemetryBar");
        expect(src).toContain('className="runCard"');
        expect(src).toContain("<RunTerminal");
        expect(src).toContain("terminalOpen");
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

    it("keeps the terminal collapsed on load with Escape interplay", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("const [terminalOpen, setTerminalOpen] = useState(false)");
        expect(src).toContain("if (terminalOpen) setTerminalOpen(false)");
        expect(src).toContain("clearTerminal");
    });
});
