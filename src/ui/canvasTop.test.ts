// Phase B canvas top contract: the tunnel column keeps TopNav and the
// TelemetryBar strip plus the run card and the bottom terminal, while the
// SolverBar, FieldBar, and LbmSetupRow scene bars are gone from the canvas
// path and the right rail carries no DISPLAY section. Reads App.tsx source
// so the contract cannot drift without a test failure. No DOM needed.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");

describe("Phase B canvas top", () => {
    it("keeps TopNav, TelemetryBar, the run card, and the bottom terminal", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("<TopNav");
        expect(src).toContain("<TelemetryBar");
        expect(src).toContain('className="runCard"');
        expect(src).toContain("<RunTerminal");
        expect(src).toContain("terminalOpen");
    });

    it("mounts no scene bars above the canvas", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toContain("<SolverBar");
        expect(src).not.toContain("<FieldBar");
        expect(src).not.toContain("<LbmSetupRow");
        expect(src).not.toContain("<SceneBars");
        expect(src).not.toContain("sceneBarsBody");
    });

    it("routes field selection through Settings with the same gating", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("variable={effectiveVariable}");
        expect(src).toContain("hasTke={hasTke}");
        expect(src).toContain("hasRecirc={hasRecirc}");
    });

    it("carries no DISPLAY section in the right rail", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toMatch(/id:\s*"display"/);
        expect(src).not.toContain("displaySummary");
    });

    it("keeps the terminal collapsed on load with Escape interplay", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("const [terminalOpen, setTerminalOpen] = useState(false)");
        expect(src).toContain("if (terminalOpen) setTerminalOpen(false)");
        expect(src).toContain("clearTerminal");
    });
});
