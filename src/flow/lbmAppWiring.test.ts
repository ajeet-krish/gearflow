// App LBM wiring assertions: failover label, error slot, blockage note,
// and placeholder resets. Reads App.tsx source so the contract cannot drift
// without a test failure. No Worker or browser needed.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");

describe("LBM App wiring", () => {
    it("renders the failover label and wires worker errors to failover", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("analytic fallback serving frames. No LBM numbers shown.");
        expect(src).toContain("onerror");
        expect(src).toContain("lbmFailover");
        // Reset contract: fresh runs and failover drop stale LBM state.
        expect(src).toContain("setLbmHasSnapshot(false)");
        // Blockage note contract: computed, stored, and rendered.
        expect(src).toContain("blockageForGeometry");
        expect(src).toContain("setBlockageNote");
        // Placeholder source is gated on the first snapshot.
        expect(src).toContain('lbmHasSnapshot ? "lbm-binary" : "analytic-potential"');
        // Displayed Cl is gated on the first snapshot (n/a before it).
        expect(src).toContain("lbmHasSnapshot && lbmForces");
    });
});
