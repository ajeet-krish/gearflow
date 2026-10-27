// Phase 6 hardening: chat store, intent routing, grid controller fallback,
// field texture quantity packing, colormap LUT, theme toggle.
// Covers happy path, localStorage quota plus private mode, grid disposal plus
// shader fallback, and NaN plus corrupt plus oversize plus invalid colormap.

import { describe, expect, it, beforeEach } from "vitest";
import {
  loadTurns,
  saveTurns,
  clearTurns,
  appendTurns,
  CHAT_CAP,
  CHAT_STORAGE_KEY,
} from "@/agent/chatStore";
import { routeIntent } from "@/agent/intents";
import {
  initialResolution,
  recordSolve,
  resolveGridSize,
  setGridMode,
  SLOW_SOLVE_MS,
} from "@/flow/gridController";
import {
  sampleColormap,
  buildLut,
  isDiverging,
  readQuantity,
  variableRange,
  viridisColormap,
  type ColormapName,
} from "@/flow/colormap";
import {
  createFieldTextures,
  updateFieldTextures,
  disposeFieldTextures,
  buildLutTexture,
  decodeVelocityComponent,
  decodeQuantity,
} from "@/render/fieldTexture";
import {
  FIELD_VERTEX_SHADER,
  FIELD_FRAGMENT_SHADER,
  createFieldShaderMaterial,
  updateFieldShaderMaterial,
} from "@/render/fieldShader";
import { loadDisplayPrefs, storeDisplayPrefs } from "@/ui/displayStore";
import { loadTheme, storeTheme, applyTheme } from "@/ui/theme";
import { GRID_128, GRID_256, DEFAULT_DISPLAY_PREFS } from "@/contracts/types";
import type { ChatTurn, FlowField } from "@/contracts/types";

function installMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      store.set(k, String(v));
    },
    removeItem: (k: string): void => {
      store.delete(k);
    },
    clear: (): void => {
      store.clear();
    },
    key: (i: number): string | null => [...store.keys()][i] ?? null,
    get length(): number {
      return store.size;
    },
  };
  return store;
}

function turn(id: string, text: string, role: ChatTurn["role"] = "user"): ChatTurn {
  return { id, role, text, at: new Date("2026-10-27T00:00:00Z").toISOString() };
}

function makeFlow(nx = 4, ny = 4): FlowField {
  const n = nx * ny;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const p = new Float32Array(n);
  const omega = new Float32Array(n);
  const obstacle = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    u[k] = (k % nx) - nx / 2 + 0.5;
    v[k] = Math.floor(k / nx) - ny / 2 + 0.5;
    p[k] = -0.02 * k;
    omega[k] = 0.03 * k - 0.1;
    obstacle[k] = k === 0 ? 1 : 0;
  }
  return { nx, ny, domain: { xMin: -0.5, xMax: 2, yMin: -1, yMax: 1 }, u, v, p, omega, obstacle };
}

describe("phase6 hardening chat store roundtrip", () => {
  beforeEach(() => {
    installMemoryStorage();
    clearTurns();
  });

  it("round trips turns with roles and timestamps intact", () => {
    const turns: ChatTurn[] = [
      { id: "u1", role: "user", text: "explain this run", at: "2026-10-27T00:00:01Z" },
      { id: "a1", role: "assistant", text: "Cl holds near 0.8", at: "2026-10-27T00:00:02Z", tool: "chat", status: "offline" },
    ];
    saveTurns(turns);
    const loaded = loadTurns();
    expect(loaded).toEqual(turns);
  });

  it("appends single and batch turns and caps at 50 newest", () => {
    let list = appendTurns([], turn("t0", "first"));
    expect(list.length).toBe(1);
    expect(loadTurns().length).toBe(1);
    const batch = Array.from({ length: CHAT_CAP + 5 }, (_, i) => turn(`b${i}`, `msg ${i}`));
    list = appendTurns(list, batch);
    expect(list.length).toBe(CHAT_CAP);
    expect(list[0].id).toBe("b5");
    expect(loadTurns()[0].id).toBe("b5");
  });

  it("filters invalid turn rows instead of rejecting the transcript", () => {
    const raw = {
      version: 1,
      turns: [turn("ok", "kept"), { id: "bad", role: "user" }, null, "junk", { id: "ok2", role: "assistant", text: "hi", at: "2026-10-27T00:00:03Z" }],
    };
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(raw));
    const loaded = loadTurns();
    expect(loaded.map((t) => t.id)).toEqual(["ok", "ok2"]);
  });
});

describe("phase6 hardening chat store edge and error", () => {
  beforeEach(() => {
    installMemoryStorage();
    clearTurns();
  });

  it("survives localStorage quota errors without throwing", () => {
    const orig = localStorage;
    const throwing = {
      ...orig,
      setItem: (): void => {
        throw new Error("QuotaExceededError");
      },
    };
    (globalThis as Record<string, unknown>).localStorage = throwing;
    expect(() => saveTurns([turn("a", "hello")])).not.toThrow();
    expect(() => clearTurns()).not.toThrow();
  });

  it("survives private mode where every storage call throws", () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (): never => {
        throw new Error("denied");
      },
      setItem: (): never => {
        throw new Error("denied");
      },
      removeItem: (): never => {
        throw new Error("denied");
      },
      clear: (): never => {
        throw new Error("denied");
      },
      key: (): null => null,
      get length(): number {
        throw new Error("denied");
      },
    };
    expect(loadTurns()).toEqual([]);
    expect(() => saveTurns([turn("a", "x")])).not.toThrow();
    expect(() => clearTurns()).not.toThrow();
    expect(loadDisplayPrefs().colormap).toBe("viridis");
    expect(initialResolution().mode).toBe("auto");
  });

  it("returns [] on corrupt chat JSON, wrong version, and non array turns", () => {
    localStorage.setItem(CHAT_STORAGE_KEY, "not json{{{");
    expect(loadTurns()).toEqual([]);
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ version: 999, turns: [turn("x", "y")] }));
    expect(loadTurns()).toEqual([]);
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ version: 1, turns: "nope" }));
    expect(loadTurns()).toEqual([]);
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ version: 1 }));
    expect(loadTurns()).toEqual([]);
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(null));
    expect(loadTurns()).toEqual([]);
  });
});

describe("phase6 hardening intent routing", () => {
  it("routes each intent happy path", () => {
    expect(routeIntent("please explain this run").kind).toBe("explain");
    expect(routeIntent("thicken the section").kind).toBe("spec");
    expect(routeIntent("raise alpha to 8").kind).toBe("spec");
    expect(routeIntent("segment this sketch").kind).toBe("sam");
    expect(routeIntent("render a poster of this study").kind).toBe("poster");
    expect(routeIntent("hello there").kind).toBe("chat");
  });

  it("is case insensitive and reads sketch and figure keywords", () => {
    expect(routeIntent("EXPLAIN WHY Cl changed").kind).toBe("explain");
    expect(routeIntent("Trace the polygon from my drawing").kind).toBe("sam");
    expect(routeIntent("Figure for the report").kind).toBe("poster");
    expect(routeIntent("What happened on the last solve").kind).toBe("explain");
  });

  it("prioritizes explain over spec over sam over poster", () => {
    expect(routeIntent("explain why alpha raise changed lift").kind).toBe("explain");
    expect(routeIntent("propose a poster style spec change").kind).toBe("spec");
    expect(routeIntent("segment outline for a poster").kind).toBe("sam");
  });

  it("falls back to chat on empty and punctuation only input", () => {
    expect(routeIntent("").kind).toBe("chat");
    expect(routeIntent("???").kind).toBe("chat");
    const chat = routeIntent("hello, what can you do");
    expect(chat.kind).toBe("chat");
    expect(chat.confidence).toBeLessThanOrEqual(0.5);
    expect(chat.reason.length).toBeGreaterThan(0);
  });
});

describe("phase6 hardening grid controller fallback", () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it("defaults to auto 256 and resolves the active size", () => {
    const state = initialResolution("auto");
    expect(state.mode).toBe("auto");
    expect(resolveGridSize(state)).toBe(GRID_256);
    expect(resolveGridSize(initialResolution("128"))).toBe(GRID_128);
  });

  it("falls back after two consecutive slow solves only in auto", () => {
    let state = initialResolution("auto");
    const first = recordSolve(state, SLOW_SOLVE_MS + 50);
    expect(first.fellBack).toBe(false);
    expect(resolveGridSize(first.state)).toBe(GRID_256);
    const second = recordSolve(first.state, SLOW_SOLVE_MS + 50);
    expect(second.fellBack).toBe(true);
    expect(resolveGridSize(second.state)).toBe(GRID_128);
    expect(second.state.autoDropped).toBe(true);
    expect(second.state.notice).toContain("128");
  });

  it("resets the streak on a fast solve and ignores non finite timings", () => {
    let state = recordSolve(initialResolution("auto"), SLOW_SOLVE_MS + 10).state;
    state = recordSolve(state, 12).state;
    expect(state.slowStreak).toBe(0);
    const nan = recordSolve(state, Number.NaN);
    expect(nan.fellBack).toBe(false);
    expect(nan.state.slowStreak).toBe(0);
  });

  it("never falls back when pinned and pinning clears an auto drop", () => {
    let pinned = setGridMode(initialResolution("auto"), "256");
    for (let i = 0; i < 3; i++) {
      const next = recordSolve(pinned, SLOW_SOLVE_MS + 500);
      expect(next.fellBack).toBe(false);
      pinned = next.state;
    }
    expect(resolveGridSize(pinned)).toBe(GRID_256);
    let dropped = initialResolution("auto");
    dropped = recordSolve(dropped, SLOW_SOLVE_MS + 1).state;
    dropped = recordSolve(dropped, SLOW_SOLVE_MS + 1).state;
    expect(dropped.autoDropped).toBe(true);
    const repinned = setGridMode(dropped, "256");
    expect(resolveGridSize(repinned)).toBe(GRID_256);
    expect(repinned.autoDropped).toBe(false);
    expect(repinned.notice).toBeNull();
  });

  it("pins 128 directly and ignores further slow solves", () => {
    const state = setGridMode(initialResolution("auto"), "128");
    expect(resolveGridSize(state)).toBe(GRID_128);
    const next = recordSolve(state, SLOW_SOLVE_MS + 900);
    expect(next.fellBack).toBe(false);
    expect(resolveGridSize(next.state)).toBe(GRID_128);
  });
});

describe("phase6 hardening grid switch disposal", () => {
  it("reuses textures on the same grid and rewrites quantity and LUT", () => {
    const flow = makeFlow(4, 4);
    const first = createFieldTextures(flow, "viridis", "speed");
    const fieldHandle = first.field;
    const same = updateFieldTextures(first, flow, "plasma", "cp");
    expect(same).toBe(first);
    expect(same.field).toBe(fieldHandle);
    expect(same.colormap).toBe("plasma");
    expect(same.variable).toBe("cp");
    expect(same.qMax).toBeGreaterThan(same.qMin);
    disposeFieldTextures(same);
  });

  it("recreates the field texture on a grid change", () => {
    const small = makeFlow(4, 4);
    const prev = createFieldTextures(small, "viridis", "speed");
    const oldField = prev.field;
    const big = makeFlow(8, 6);
    const grown = updateFieldTextures(prev, big, "viridis", "omega");
    expect(grown.nx).toBe(8);
    expect(grown.ny).toBe(6);
    expect(grown.variable).toBe("omega");
    expect(grown.field).not.toBe(oldField);
    disposeFieldTextures(grown);
  });

  it("creates from null prev and disposes without throwing", () => {
    const flow = makeFlow(4, 3);
    const tex = updateFieldTextures(null, flow, "turbo", "u");
    expect(tex.nx).toBe(4);
    expect(tex.colormap).toBe("turbo");
    expect(() => disposeFieldTextures(tex)).not.toThrow();
  });
});

describe("phase6 hardening field texture quantity packing", () => {
  it("round trips every field variable within one quantum", () => {
    const flow = makeFlow(4, 4);
    for (const variable of ["speed", "cp", "omega", "u", "v"] as const) {
      const tex = createFieldTextures(flow, "viridis", variable);
      const data = tex.field.image.data as Uint8Array;
      const span = tex.qMax - tex.qMin || 1;
      for (let k = 0; k < flow.nx * flow.ny; k++) {
        const expected = readQuantity(variable, flow, k);
        const got = decodeQuantity(data[k * 4 + 2], tex.qMin, tex.qMax);
        expect(Math.abs(got - expected)).toBeLessThanOrEqual(span / 255 + 1e-6);
      }
      expect(tex.variable).toBe(variable);
      disposeFieldTextures(tex);
    }
  });

  it("packs velocity components and the obstacle mask honestly", () => {
    const flow = makeFlow(4, 4);
    const tex = createFieldTextures(flow, "viridis", "speed");
    const data = tex.field.image.data as Uint8Array;
    const quantum = (2 * tex.speedMax) / 255;
    for (let k = 0; k < flow.nx * flow.ny; k++) {
      expect(Math.abs(decodeVelocityComponent(data[k * 4], tex.speedMax) - flow.u[k])).toBeLessThanOrEqual(quantum / 2 + 1e-6);
      expect(Math.abs(decodeVelocityComponent(data[k * 4 + 1], tex.speedMax) - flow.v[k])).toBeLessThanOrEqual(quantum / 2 + 1e-6);
    }
    expect(data[0 * 4 + 3]).toBe(255);
    expect(data[1 * 4 + 3]).toBe(0);
    disposeFieldTextures(tex);
  });

  it("maps extremes to byte 0 and 255", () => {
    const flow: FlowField = {
      nx: 2,
      ny: 1,
      domain: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
      u: new Float32Array([3, -3]),
      v: new Float32Array([0, 0]),
      p: new Float32Array(2),
      omega: new Float32Array(2),
      obstacle: new Float32Array(2),
    };
    const tex = createFieldTextures(flow);
    const data = tex.field.image.data as Uint8Array;
    expect(data[0]).toBe(255);
    expect(data[4]).toBe(0);
    disposeFieldTextures(tex);
  });
});

describe("phase6 hardening field texture errors", () => {
  it("rejects NaN and Infinity field channels", () => {
    const nanFlow = makeFlow();
    nanFlow.u[3] = Number.NaN;
    expect(() => createFieldTextures(nanFlow)).toThrow(/finite/);
    const infFlow = makeFlow();
    infFlow.v[5] = Number.POSITIVE_INFINITY;
    expect(() => createFieldTextures(infFlow)).toThrow(/finite/);
    const obsFlow = makeFlow();
    obsFlow.obstacle[1] = Number.NaN;
    expect(() => createFieldTextures(obsFlow)).toThrow(/finite/);
  });

  it("rejects mismatched channel lengths and degenerate grids", () => {
    const flow = makeFlow();
    const short: FlowField = { ...flow, u: new Float32Array(3) };
    expect(() => createFieldTextures(short)).toThrow(/match/);
    const zero: FlowField = { ...flow, nx: 0, ny: 4, u: new Float32Array(0), v: new Float32Array(0), p: new Float32Array(0), omega: new Float32Array(0), obstacle: new Float32Array(0) };
    expect(() => createFieldTextures(zero)).toThrow(/positive/);
  });

  it("rejects oversize grids before allocating", () => {
    const wide: FlowField = {
      nx: 600,
      ny: 4,
      domain: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
      u: new Float32Array(0),
      v: new Float32Array(0),
      p: new Float32Array(0),
      omega: new Float32Array(0),
      obstacle: new Float32Array(0),
    };
    expect(() => createFieldTextures(wide)).toThrow(/cap|exceed/);
    const nMax = 512 * 512;
    const atCap: FlowField = {
      nx: 512,
      ny: 512,
      domain: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
      u: new Float32Array(nMax),
      v: new Float32Array(nMax),
      p: new Float32Array(nMax),
      omega: new Float32Array(nMax),
      obstacle: new Float32Array(nMax),
    };
    const capTex = createFieldTextures(atCap);
    expect(capTex.nx).toBe(512);
    disposeFieldTextures(capTex);
  });
});

describe("phase6 hardening colormap LUT", () => {
  it("samples every catalog entry with finite bytes across the range", () => {
    const names: ColormapName[] = ["viridis", "turbo", "plasma", "inferno", "magma", "cividis", "jet", "rdbu", "coolwarm", "grayscale"];
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const [r, g, b] = sampleColormap(name, t);
        expect([r, g, b].every((c) => Number.isInteger(c) && c >= 0 && c <= 255)).toBe(true);
      }
      const lut = buildLut(name, 16);
      expect(lut.length).toBe(48);
    }
  });

  it("builds a full 256 entry LUT with matching endpoints", () => {
    const lut = buildLut("viridis", 256);
    expect(lut.length).toBe(256 * 3);
    const [r0, g0, b0] = viridisColormap(0);
    const [r1, g1, b1] = viridisColormap(1);
    expect([lut[0], lut[1], lut[2]]).toEqual([r0, g0, b0]);
    expect([lut[255 * 3], lut[255 * 3 + 1], lut[255 * 3 + 2]]).toEqual([r1, g1, b1]);
  });

  it("clamps out of range t and keeps grayscale monotonic", () => {
    expect(sampleColormap("viridis", -2)).toEqual(sampleColormap("viridis", 0));
    expect(sampleColormap("turbo", 5)).toEqual(sampleColormap("turbo", 1));
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const [r, g, b] = sampleColormap("grayscale", i / 10);
      expect(r).toBe(g);
      expect(g).toBe(b);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it("flags only the diverging maps", () => {
    expect(isDiverging("rdbu")).toBe(true);
    expect(isDiverging("coolwarm")).toBe(true);
    for (const name of ["viridis", "turbo", "plasma", "inferno", "magma", "cividis", "jet", "grayscale"] as ColormapName[]) {
      expect(isDiverging(name)).toBe(false);
    }
  });

  it("defaults invalid colormap names to viridis and sanitizes prefs", () => {
    installMemoryStorage();
    const fallback = sampleColormap("viridis", 0.5);
    expect(sampleColormap("nope" as unknown as ColormapName, 0.5)).toEqual(fallback);
    const lutBad = buildLut("nope" as unknown as ColormapName, 8);
    expect(lutBad).toEqual(buildLut("viridis", 8));
    storeDisplayPrefs({ colormap: "nope" as unknown as ColormapName, variable: "nope" as never, theme: "nope" as never, showLegend: true });
    const prefs = loadDisplayPrefs();
    expect(prefs).toEqual(DEFAULT_DISPLAY_PREFS);
  });

  it("builds a 256x1 RGBA LUT texture with opaque alpha", () => {
    const lut = buildLutTexture("plasma");
    expect(lut.image.width).toBe(256);
    expect(lut.image.height).toBe(1);
    const data = lut.image.data as Uint8Array;
    expect(data.length).toBe(256 * 4);
    for (let i = 0; i < 256; i++) {
      expect(data[i * 4 + 3]).toBe(255);
    }
    lut.dispose();
  });

  it("reports honest ranges with labels and units and a finite fallback", () => {
    const flow = makeFlow();
    const speed = variableRange("speed", flow);
    expect(speed.max).toBeGreaterThan(speed.min);
    expect(speed.label.length).toBeGreaterThan(0);
    expect(speed.units.length).toBeGreaterThan(0);
    const u = variableRange("u", flow);
    expect(u.min).toBeLessThan(u.max);
    const allNaN: FlowField = {
      nx: 2,
      ny: 2,
      domain: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
      u: new Float32Array([Number.NaN, Number.NaN, Number.NaN, Number.NaN]),
      v: new Float32Array(4),
      p: new Float32Array(4),
      omega: new Float32Array(4),
      obstacle: new Float32Array(4),
    };
    const guarded = variableRange("u", allNaN);
    expect(Number.isFinite(guarded.min)).toBe(true);
    expect(Number.isFinite(guarded.max)).toBe(true);
    expect(guarded.max).toBeGreaterThan(guarded.min);
  });
});

describe("phase6 hardening theme toggle", () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it("defaults to dark and round trips a light choice", () => {
    expect(DEFAULT_DISPLAY_PREFS.theme).toBe("dark");
    expect(loadTheme()).toBe("dark");
    storeTheme("light");
    expect(loadTheme()).toBe("light");
    storeTheme("dark");
    expect(loadTheme()).toBe("dark");
  });

  it("applies without a DOM and never throws in private mode", () => {
    expect(() => applyTheme("dark")).not.toThrow();
    expect(() => applyTheme("light")).not.toThrow();
    expect(() => storeTheme("light")).not.toThrow();
  });

  it("computes the toggle next label the way ThemeToggle does", () => {
    const nextFor = (theme: "dark" | "light"): "dark" | "light" => (theme === "dark" ? "light" : "dark");
    expect(nextFor("dark")).toBe("light");
    expect(nextFor("light")).toBe("dark");
    storeTheme(nextFor(loadTheme()));
    expect(loadTheme()).toBe("light");
  });

  it("keeps quota errors local to the session", () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (): string | null => null,
      setItem: (): never => {
        throw new Error("QuotaExceededError");
      },
      removeItem: (): void => undefined,
      clear: (): void => undefined,
      key: (): null => null,
      get length(): number {
        return 0;
      },
    };
    expect(() => storeTheme("light")).not.toThrow();
    expect(() => storeDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, colormap: "turbo" })).not.toThrow();
  });
});

describe("phase6 hardening shader fallback", () => {
  it("exposes the packed field plus LUT plus range uniforms", () => {
    expect(FIELD_VERTEX_SHADER).toContain("vUv");
    expect(FIELD_FRAGMENT_SHADER).toContain("tField");
    expect(FIELD_FRAGMENT_SHADER).toContain("tLut");
    expect(FIELD_FRAGMENT_SHADER).toContain("vMin");
    expect(FIELD_FRAGMENT_SHADER).toContain("vMax");
    expect(FIELD_FRAGMENT_SHADER).toContain("dimObstacle");
    expect(FIELD_FRAGMENT_SHADER).toContain("contour");
  });

  it("builds a material with defaults and pushes partial updates", async () => {
    const THREE = await import("three");
    const field = new THREE.DataTexture(new Uint8Array(4 * 4 * 4), 4, 4, THREE.RGBAFormat);
    const lut = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat);
    const mat = createFieldShaderMaterial({ field, lut, vMin: 0, vMax: 1 });
    expect(mat.uniforms.tField.value).toBe(field);
    expect(mat.uniforms.tLut.value).toBe(lut);
    expect(mat.uniforms.dimObstacle.value).toBe(0.25);
    expect(mat.uniforms.showContours.value).toBe(0);
    expect(mat.uniforms.contourCount.value).toBe(12);
    updateFieldShaderMaterial(mat, { vMin: 0.1, vMax: 0.9, showContours: true, contourCount: 8 });
    expect(mat.uniforms.vMin.value).toBe(0.1);
    expect(mat.uniforms.vMax.value).toBe(0.9);
    expect(mat.uniforms.showContours.value).toBe(1);
    expect(mat.uniforms.contourCount.value).toBe(8);
    mat.dispose();
    field.dispose();
    lut.dispose();
  });

  it("falls back to vertex colors when the shader path throws", () => {
    const bad = makeFlow();
    bad.u[0] = Number.NaN;
    let shaderOk = false;
    try {
      createFieldTextures(bad, "viridis", "speed");
      shaderOk = true;
    } catch {
      shaderOk = false;
    }
    expect(shaderOk).toBe(false);
    const good = makeFlow();
    const { min, max } = variableRange("speed", good);
    const span = max - min || 1;
    for (let k = 0; k < good.nx * good.ny; k++) {
      const q = readQuantity("speed", good, k);
      const t = Math.min(1, Math.max(0, (q - min) / span));
      const [r, g, b] = sampleColormap("viridis", t);
      expect([r, g, b].every((c) => c >= 0 && c <= 255)).toBe(true);
    }
  });

  it("pins grid constants for the resolution controller", () => {
    expect(GRID_128).toBe(128);
    expect(GRID_256).toBe(256);
  });
});
