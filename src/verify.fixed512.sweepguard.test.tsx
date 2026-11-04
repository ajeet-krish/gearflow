// Verification for fixed 512 grid plus narration gating plus sweep guards.
// Static plus unit checks only, no live solves, no network. Uses proper
// punctuation with commas and colons, no dash sequences in prose.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GRID_512 } from "@/contracts/types";
import {
  initialResolution,
  recordSolve,
  resolveGridSize,
  setGridMode,
} from "@/flow/gridController";
import {
  SWEEP_ALPHAS,
  describeSweepResult,
  isAlphaSweepIntent,
  sweepToTutorRows,
} from "@/agent/alphaSweep";
import { buildModalMessages } from "@/ui/AgentConsole";
import { buildTutorMessages } from "@/agent/tutorPrompt";
import SettingsModal from "@/ui/SettingsModal";
import { DEFAULT_DISPLAY_PREFS } from "@/contracts/types";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function promptSystem(): string {
  const messages = buildModalMessages("Explain this run", null, []);
  expect(messages.length).toBeGreaterThan(0);
  return messages[0].content;
}

function tutorSystem(): string {
  const messages = buildTutorMessages({
    after: null,
    rows: [],
    concept: "general",
    suggestion: null,
  });
  expect(messages.length).toBeGreaterThan(0);
  return messages[0].content;
}

describe("verify fixed 512 grid, only 512 reachable with no picker", () => {
  it("pins GRID_512 at 512 with the controller resolved to it", () => {
    expect(GRID_512).toBe(512);
    const fixed = initialResolution();
    expect(fixed.mode).toBe("512");
    expect(resolveGridSize(fixed)).toBe(512);
    expect(resolveGridSize(fixed)).toBe(GRID_512);
    expect(fixed.autoDropped).toBe(false);
    expect(fixed.slowStreak).toBe(0);
    expect(fixed.notice).toBeNull();
  });

  it("coerces every legacy mode to the fixed 512 state", () => {
    for (const mode of ["auto", "256", "512", "1024", "custom"] as const) {
      const pinned = setGridMode(initialResolution(), mode, 256);
      expect(pinned.mode).toBe("512");
      expect(pinned.active).toBe(GRID_512);
      expect(resolveGridSize(pinned)).toBe(GRID_512);
    }
  });

  it("never falls back on slow solves", () => {
    let state = initialResolution();
    for (let i = 0; i < 4; i += 1) {
      const next = recordSolve(state, 5000);
      expect(next.fellBack).toBe(false);
      expect(resolveGridSize(next.state)).toBe(GRID_512);
      expect(next.state.slowStreak).toBe(0);
      state = next.state;
    }
    expect(state.autoDropped).toBe(false);
    expect(state.notice).toBeNull();
  });

  it("renders Settings with display controls and no resolution section", () => {
    const html = renderToStaticMarkup(
      <SettingsModal
        open={true}
        onClose={() => {}}
        prefs={{ ...DEFAULT_DISPLAY_PREFS }}
        onPatch={() => {}}
        gridMode="512"
        activeGrid={512}
        onGridMode={() => {}}
        variable="speed"
      />,
    );
    expect(html).toContain("DISPLAY SETTINGS");
    expect(html).not.toContain("RESOLUTION");
    expect(html).not.toContain("Fixed grid");
    expect(html).not.toContain("512 x 512");
    expect(html).not.toContain("Grid mode");
    expect(html).not.toContain("Custom square");
    expect(html).not.toContain('id="settingsGrid"');
    expect(html).not.toContain('id="settingsCustomGrid"');
  });

  it("names the fixed 512 contract in the grid controller and App sources", () => {
    const controller = readFileSync(resolve(root, "src/flow/gridController.ts"), "utf8");
    expect(controller).toContain("512");
    const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
    expect(app).toContain("fixed 512");
  });
});

describe("verify NACA p rule plus rejection turns plus block chord in prompt", () => {
  it("teaches the NACA p bound with the allowed range", () => {
    const system = promptSystem();
    expect(system).toContain("when camber (m) is above 0");
    expect(system).toContain("(0, 1)");
  });

  it("teaches rejection turns with the nearest valid alternative", () => {
    const system = promptSystem();
    expect(system).toContain("nearest valid");
    expect(system).toContain("No teaching prose for unapplied cases");
    expect(system).toContain("canvas unchanged");
  });

  it("blocks block chord with fixed chord and center JSON", () => {
    const system = promptSystem();
    expect(system).toContain('"chord":1');
    expect(system).toContain('"center":{"x":0.5,"y":0}');
  });

  it("keeps the narration gate with Try next and no fence promises", () => {
    const system = promptSystem();
    expect(system).toContain("angle of attack (alpha) influence");
    expect(system).toContain("before versus after table plus Why plus Try next");
    expect(system).toContain("no action fence");
    expect(system).toContain("agent runs now");
    expect(tutorSystem()).toContain("Never promise a future run or sweep");
  });
});

describe("verify sweep fires on show plus run plus influence", () => {
  it("fires on show and run phrasings", () => {
    for (const text of [
      "show me a sweep",
      "run a sweep",
      "sweep alpha -4 to 12",
      "run the alpha staircase",
      "demonstrate the alpha sweep",
      "sweep through alpha",
    ]) {
      expect(isAlphaSweepIntent(text)).toBe(true);
    }
  });

  it("fires on influence and effect and across and impact phrasings", () => {
    for (const text of [
      "how does AoA influence lift",
      "show the influence of alpha",
      "show the effect of alpha",
      "effect of AoA across the band",
      "Cl across alpha",
      "what if alpha were higher",
      "how does AoA impact flow",
      "how do changes in alpha affect lift",
      "how does alpha affect suction",
      "impact of alpha on lift",
    ]) {
      expect(isAlphaSweepIntent(text)).toBe(true);
    }
  });

  it("holds the live staircase shape with 9 points", () => {
    expect(SWEEP_ALPHAS).toEqual([-4, -2, 0, 2, 4, 6, 8, 10, 12]);
  });
});

describe("verify sweep blocked on explain plus what plus why plus negation", () => {
  it("does not fire on explain or what or why guards", () => {
    for (const text of [
      "explain the effect of alpha",
      "explain how alpha influences lift",
      "what is a sweep",
      "what is the influence of AoA on suction",
      "why sweep alpha",
      "why should I sweep",
      "explain this run",
    ]) {
      expect(isAlphaSweepIntent(text)).toBe(false);
    }
  });

  it("does not fire on negation guards or bare setup text", () => {
    for (const text of [
      "do not sweep",
      "do not run a sweep",
      "never sweep",
      "no sweep please",
      "not a sweep",
      "set alpha 6",
      "",
    ]) {
      expect(isAlphaSweepIntent(text)).toBe(false);
    }
  });
});

describe("verify rejected setups never teach unapplied tables", () => {
  it("pins the rejected setup rule in the Physics Agent system prompt", () => {
    const system = tutorSystem();
    expect(system).toContain("When the setup was rejected");
    expect(system).toContain("canvas unchanged");
    expect(system).toContain("teach no table for the unapplied case");
  });

  it("narrates sweeps from table numbers only with the stall caveat", () => {
    const text = describeSweepResult({
      points: [
        { alphaDeg: -4, cl: 0.1, cpMin: -0.4, solveMs: 1, dClVsPrev: null, dCpVsPrev: null },
        { alphaDeg: 12, cl: 1.1, cpMin: -2.0, solveMs: 1, dClVsPrev: 1, dCpVsPrev: -1.6 },
      ],
      cancelled: false,
      startedFrom: 6,
      finalAlpha: 12,
    });
    expect(text).toContain("per deg");
    expect(text).toContain("Past 12 deg the potential model cannot show stall");
    expect(text).toContain("analytic");
    expect(sweepToTutorRows({ points: [], cancelled: true, startedFrom: null, finalAlpha: null })).toEqual([]);
  });
});
