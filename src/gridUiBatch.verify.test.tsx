// Grid ceiling plus UI batch verification. Static checks only, no live
// solves, no worker threads. Pins each orchestrator claim in one place.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANALYTIC_MAX_CELLS,
  ANALYTIC_MAX_NX,
  ANALYTIC_MAX_NY,
  validateGridSpec,
} from "@/contracts/schema";
import {
  CUSTOM_GRID_MAX,
  CUSTOM_GRID_MIN,
  DEFAULT_DISPLAY_PREFS,
  GRID_1024,
  GRID_256,
  GRID_512,
  GRID_OPTIONS,
  PARTICLE_COUNT_MAX,
  PARTICLE_COUNT_MIN,
  PARTICLE_SIZE_MAX,
  DEFAULT_DOMAIN,
} from "@/contracts/types";
import { LBM_MAX_CELLS, LBM_MAX_NX, LBM_MAX_NY, lbmGridFor } from "@/flow/engineMode";
import { initialResolution, parseCustomGrid, setGridMode } from "@/flow/gridController";
import { isLbmMainMessage, isLbmWorkerMessage } from "@/flow/lbmProtocol";
import SettingsModal, { decideParticleCountCommit } from "@/ui/SettingsModal";
import EditorTabs from "@/ui/EditorTabs";
import FieldBar from "@/ui/FieldBar";
import { GeometrySectionView } from "@/ui/GeometrySection";
import { defaultCaseTabs } from "@/ui/caseTabs";
import type { GeometrySpec } from "@/contracts/types";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "./styles.css"), "utf8");
const appSrc = readFileSync(resolve(here, "./App.tsx"), "utf8");
const lbmRs = readFileSync(resolve(here, "../rust/gearflow-wasm/src/lbm.rs"), "utf8");

function ruleOf(selector: string): string {
  const at = css.indexOf(selector);
  expect(at).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

const NACA: GeometrySpec = {
  kind: "naca4",
  naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
  chord: 1,
  alphaDeg: 6,
  nPoints: 120,
};
const noop = () => {};

describe("grid ceiling: analytic 1024 accepted", () => {
  it("analytic ceiling is 1024 per side with 1048576 cells", () => {
    expect(ANALYTIC_MAX_NX).toBe(1024);
    expect(ANALYTIC_MAX_NY).toBe(1024);
    expect(ANALYTIC_MAX_CELLS).toBe(1048576);
  });

  it("accepts a 1024 square analytic grid without throwing", () => {
    expect(() =>
      validateGridSpec({ nx: 1024, ny: 1024, domain: { ...DEFAULT_DOMAIN } }),
    ).not.toThrow();
  });

  it("rejects above the analytic ceiling", () => {
    expect(() =>
      validateGridSpec({ nx: 1025, ny: 1024, domain: { ...DEFAULT_DOMAIN } }),
    ).toThrow(/1024/);
  });
});

describe("grid ceiling: LBM constructor rejects over 512", () => {
  it("TS LBM envelope stays at 512 per side and 262144 cells", () => {
    expect(LBM_MAX_NX).toBe(512);
    expect(LBM_MAX_NY).toBe(512);
    expect(LBM_MAX_CELLS).toBe(262144);
  });

  it("a 1024 request still derives an LBM grid within 512 per side", () => {
    const g = lbmGridFor(DEFAULT_DOMAIN, 1024);
    expect(g.reason).toBeNull();
    expect(g.nx).toBeLessThanOrEqual(512);
    expect(g.ny).toBeLessThanOrEqual(512);
  });

  it("LBM protocol init and snapshot messages reject nx over 512", () => {
    const baseInit = {
      type: "init",
      gen: 0,
      nx: 512,
      ny: 256,
      domain: { ...DEFAULT_DOMAIN },
      geomJson: JSON.stringify(NACA),
      re: 1000,
      uLattice: 0.05,
      lesEnabled: false,
      targetSteps: 8000,
      batchSteps: 512,
      statsStartStep: 0,
    };
    expect(isLbmMainMessage(baseInit)).toBe(true);
    expect(isLbmMainMessage({ ...baseInit, nx: 513 })).toBe(false);
    expect(isLbmMainMessage({ ...baseInit, nx: 1024 })).toBe(false);
    const n = 8 * 8;
    const chan = new Float32Array(n).fill(0.5);
    const snap = {
      type: "snapshot",
      gen: 0,
      step: 8,
      cd: 1.1,
      cl: 0.2,
      nx: 8,
      ny: 8,
      domain: { ...DEFAULT_DOMAIN },
      u: chan,
      v: chan,
      p: chan,
      omega: chan,
      obstacle: chan,
    };
    expect(isLbmWorkerMessage(snap)).toBe(true);
    expect(isLbmWorkerMessage({ ...snap, nx: 513 })).toBe(false);
  });

  it("Rust LbmState constructor rejects over 512", () => {
    expect(lbmRs).toContain("lbm: nx and ny must be <= 512");
  });
});

describe("grid presets plus custom envelope", () => {
  it("offers exactly the 256, 512, and 1024 presets", () => {
    expect(GRID_256).toBe(256);
    expect(GRID_512).toBe(512);
    expect(GRID_1024).toBe(1024);
    expect(GRID_OPTIONS).toEqual([256, 512, 1024]);
  });

  it("custom squares span 128 to 1024 inclusive", () => {
    expect(CUSTOM_GRID_MIN).toBe(128);
    expect(CUSTOM_GRID_MAX).toBe(1024);
    expect(parseCustomGrid(128).ok).toBe(true);
    expect(parseCustomGrid(1024).ok).toBe(true);
    expect(parseCustomGrid(127).ok).toBe(false);
    expect(parseCustomGrid(1025).ok).toBe(false);
  });

  it("pins 1024 directly and parses a custom 128", () => {
    expect(setGridMode(initialResolution("auto"), "1024").active).toBe(1024);
    expect(setGridMode(initialResolution("auto"), "custom", 128).active).toBe(128);
  });
});

describe("shared outlined selected style on Body and Field", () => {
  it("Body tabs and Field chips share the outlined box rule", () => {
    const chip = ruleOf(".sceneBar.fieldBar .chip.active");
    const tab = ruleOf(".ideTab.selected");
    for (const rule of [chip, tab]) {
      expect(rule).toContain("1px solid var(--purple)");
      expect(rule).toContain("background: transparent");
      expect(rule).toContain("box-shadow: none");
    }
  });

  it("active Body tab and active Field chip render the shared classes", () => {
    const tabs = defaultCaseTabs();
    const tabHtml = renderToStaticMarkup(
      <EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />,
    );
    expect(tabHtml).toContain("ideTab selected");
    const chipHtml = renderToStaticMarkup(<FieldBar variable="speed" onVariable={noop} />);
    expect(chipHtml).toContain("chip active");
  });
});

describe("analysis rail restored with conditional per-tab sections", () => {
  it("App mounts SIMULATION plus GEOMETRY in the ANALYSIS rail body", () => {
    expect(appSrc).toContain('bodyId="analysisBody"');
    expect(appSrc).toContain('bladeLabel="ANALYSIS"');
    expect(appSrc).toContain("<SimulationSection");
    expect(appSrc).toContain("<GeometrySection");
    expect(appSrc).toContain('aria-label="Simulation controls"');
    expect(appSrc).toContain('aria-label="Geometry controls"');
  });

  it("GEOMETRY renders conditional per-body sections", () => {
    const cyl = renderToStaticMarkup(
      GeometrySectionView({
        spec: { ...NACA, kind: "cylinder", radius: 0.25 },
        onSpec: noop,
        orificeResolutionWarning: null,
      }) as never,
    );
    expect(cyl).toContain('id="geoRadius"');
    expect(cyl).not.toContain('id="geoGap"');
    const ori = renderToStaticMarkup(
      GeometrySectionView({
        spec: {
          kind: "orifice",
          chord: 1,
          alphaDeg: 0,
          nPoints: 64,
          width: 0.08,
          height: 0.4,
          center: { x: 0.5, y: 0 },
        },
        onSpec: noop,
        orificeResolutionWarning: null,
      }) as never,
    );
    expect(ori).toContain('id="geoGap"');
    expect(ori).toContain('id="geoThickPlate"');
    expect(ori).not.toContain('id="geoRadius"');
    const naca = renderToStaticMarkup(
      GeometrySectionView({ spec: NACA, onSpec: noop, orificeResolutionWarning: null }) as never,
    );
    expect(naca).not.toContain('id="geoGap"');
    expect(naca).not.toContain('id="geoRadius"');
  });
});

describe("particle count 0 to 8000 plus size max 0.12", () => {
  it("count envelope is 0 to 8000 and size max is 0.12", () => {
    expect(PARTICLE_COUNT_MIN).toBe(0);
    expect(PARTICLE_COUNT_MAX).toBe(8000);
    expect(PARTICLE_SIZE_MAX).toBe(0.12);
  });

  it("Settings sliders carry the envelope and commit clamps into it", () => {
    const html = renderToStaticMarkup(
      <SettingsModal
        open={true}
        onClose={noop}
        prefs={{ ...DEFAULT_DISPLAY_PREFS }}
        onPatch={noop}
        gridMode="auto"
        activeGrid={256}
        onGridMode={noop}
        variable="speed"
      />,
    );
    expect(html).toContain('id="settingsParticles"');
    expect(html).toContain('max="8000"');
    expect(html).toContain('id="settingsParticleSize"');
    expect(html).toContain('max="0.12"');
    expect(decideParticleCountCommit("99999", 3000)).toBe(8000);
    expect(decideParticleCountCommit("-5", 3000)).toBe(0);
    expect(decideParticleCountCommit("0", 3000)).toBe(0);
    expect(html).toContain("parks the layer off");
    const offHtml = renderToStaticMarkup(
      <SettingsModal
        open={true}
        onClose={noop}
        prefs={{ ...DEFAULT_DISPLAY_PREFS, particleCount: 0 }}
        onPatch={noop}
        gridMode="auto"
        activeGrid={256}
        onGridMode={noop}
        variable="speed"
      />,
    );
    expect(offHtml).toContain("Off");
  });
});

describe("mean toggle gone", () => {
  it("Settings carries no time mean velocity control", () => {
    for (const mean of [false, true]) {
      const html = renderToStaticMarkup(
        <SettingsModal
          open={true}
          onClose={noop}
          prefs={{ ...DEFAULT_DISPLAY_PREFS, meanFields: mean }}
          onPatch={noop}
          gridMode="auto"
          activeGrid={256}
          onGridMode={noop}
          variable="speed"
        />,
      );
      expect(html).not.toContain('id="settingsMeanFields"');
      expect(html).not.toContain("Time mean velocity fields");
      expect(html).not.toContain("time averaged u and v");
    }
  });
});

describe("agent setups reflect in UI", () => {
  it("rail plus scene bars read live spec, Re, and tab sources", () => {
    expect(appSrc).toContain("reynolds={reynolds}");
    expect(appSrc).toContain("alphaDeg={spec.alphaDeg}");
    expect(appSrc).toContain("spec={spec}");
    expect(appSrc).toContain("activeId={caseTabs.activeId}");
    expect(appSrc).toContain("variable={effectiveVariable}");
  });
});
