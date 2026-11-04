// App follow-up agent regression. The first chat setup applies to the
// canvas, and every follow-up (radius change, block resize plus rotate)
// must recompute too. This harness mirrors the fixed App shell: the
// agent-commit suppression is one-shot per commit and always cleared
// (consumed before the tabSync early return), the mirror plus a
// synchronous target-tab write forwards the exact applied spec, and the
// debounced solver copies sync in the same tick so the solve refires on
// every spec change. Two consecutive applies are asserted end to end
// through the analytic solve plus frame cache: the second frame and
// numbers must move.

import { describe, expect, it } from "vitest";
import {
    bodyTabIdForSpec,
    CaseFrameCache,
    caseKeyFor,
    createCaseTabsStore,
    storeActivate,
    storeActive,
    storeUpdate,
    type CaseTabStore,
} from "@/ui/caseTabs";
import { applyBodyPreset } from "@/geometry/bodyPresets";
import { buildPolygons } from "@/geometry/parametric";
import { expandCasePreset } from "@/agent/casePresets";
import { AnalyticFlowProvider } from "@/flow/frameSource";
import { DEFAULT_DOMAIN, type GeometrySpec } from "@/contracts/types";

const GRID = { nx: 48, ny: 48, domain: { ...DEFAULT_DOMAIN } };

interface SolvedLite {
    key: string;
    polygons: { x: number; y: number }[][];
    cl: number;
    obstacleCells: number;
}

/** Minimal fixed App shell replica: live spec/Re, debounced copies, tab
 *  store, one-shot commit suppression, mirror, and solve cache. */
interface Shell {
    store: CaseTabStore;
    spec: GeometrySpec;
    reynolds: number;
    debouncedSpec: GeometrySpec;
    debouncedRe: number;
    tabSync: string;
    agentCommit: string | null;
    cache: CaseFrameCache<SolvedLite>;
    provider: AnalyticFlowProvider | null;
}

function freshShell(): Shell {
    const store = createCaseTabsStore();
    const active = storeActive(store);
    const spec = structuredClone(active!.spec);
    return {
        store,
        spec: structuredClone(spec),
        reynolds: active!.reynolds,
        debouncedSpec: structuredClone(spec),
        debouncedRe: active!.reynolds,
        tabSync: "",
        agentCommit: null,
        cache: new CaseFrameCache<SolvedLite>(),
        provider: null,
    };
}

/** Fixed activation effect: consume the one-shot commit first, always
 *  clear, stale stamps fall through to the normal tab load. */
function activationEffect(s: Shell): void {
    const a = storeActive(s.store);
    if (a === null) return;
    const commit = s.agentCommit;
    if (commit !== null) {
        s.agentCommit = null;
        if (commit === a.id) {
            s.tabSync = a.id;
            s.store = storeUpdate(s.store, a.id, { spec: s.spec, reynolds: s.reynolds });
            return;
        }
    }
    if (s.tabSync === a.id) return;
    s.tabSync = a.id;
    s.spec = structuredClone(a.spec);
    s.reynolds = a.reynolds;
}

/** Mirror effect: live edits write back into the active memory. */
function mirrorEffect(s: Shell): void {
    const a = storeActive(s.store);
    if (a === null) return;
    const liveKey = caseKeyFor(s.spec, s.reynolds, 0).split("|g")[0];
    const tabKey = caseKeyFor(a.spec, a.reynolds, 0).split("|g")[0];
    if (liveKey === tabKey) return;
    s.store = storeUpdate(s.store, a.id, { spec: s.spec, reynolds: s.reynolds });
}

/** Fixed ensureBodyTab: returns the target id for synchronous forwarding. */
function ensureBodyTab(s: Shell, body: string): string {
    const norm = body.trim().toLowerCase();
    let id: string | null = null;
    if (norm === "airfoil" || norm === "naca4" || norm.startsWith("naca")) id = "airfoil";
    else if (norm === "cylinder") id = "cylinder";
    else if (norm === "block" || norm === "rectangle") id = "block";
    else if (norm === "orifice") id = "orifice";
    if (id === null) {
        const provisional = applyBodyPreset(s.spec, body);
        const mapped = bodyTabIdForSpec(provisional);
        if (mapped === null) return s.store.activeId;
        id = mapped;
    }
    if (id !== s.store.activeId) {
        s.agentCommit = id;
        s.store = storeActivate(s.store, id);
    }
    return id;
}

/** Synchronous forward of the exact applied values into the target tab
 *  plus the debounced solver copies, so the solve refires every apply. */
function syncAgentCommit(s: Shell, targetId: string, nextSpec: GeometrySpec, nextRe: number): void {
    s.store = storeUpdate(s.store, targetId, { spec: nextSpec, reynolds: nextRe });
    s.debouncedSpec = structuredClone(nextSpec);
    s.debouncedRe = nextRe;
}

function settle(s: Shell): void {
    activationEffect(s);
    mirrorEffect(s);
}

function applySetupPreset(s: Shell, request: Parameters<typeof expandCasePreset>[0]): void {
    const kind = (request as { preset?: string }).preset;
    let targetId = s.store.activeId;
    if (kind === "shedding" || kind === "high_re_wake") targetId = ensureBodyTab(s, "cylinder");
    else if (kind === "airfoil") {
        const b = typeof (request as { body?: unknown }).body === "string"
            ? (request as { body: string }).body
            : "naca2412";
        targetId = ensureBodyTab(s, b);
    }
    const expanded = expandCasePreset(request, { agentFirst: true });
    if (!expanded.ok) throw new Error(expanded.reason ?? "preset failed");
    let finalSpec = s.spec;
    let finalRe = s.reynolds;
    for (const prim of expanded.actions) {
        if (prim.kind === "set_body") finalSpec = applyBodyPreset(finalSpec, prim.body);
        else if (prim.kind === "set_alpha") finalSpec = { ...finalSpec, alphaDeg: prim.alphaDeg };
        else if (prim.kind === "set_reynolds") finalRe = prim.reynolds;
    }
    s.spec = structuredClone(finalSpec);
    s.reynolds = finalRe;
    if (expanded.actions.length > 0) syncAgentCommit(s, targetId, finalSpec, finalRe);
    settle(s);
}

/** App set_spec path: map the geometry kind to its body tab, commit the
 *  parametric spec plus Re, then synchronously forward the exact applied
 *  values into the target tab and debounced copies. */
function applySetSpec(s: Shell, geometry: GeometrySpec, reynolds: number): void {
    let targetId = s.store.activeId;
    const gkind = (geometry as { kind?: unknown }).kind;
    if (gkind === "naca4") targetId = ensureBodyTab(s, "airfoil");
    else if (typeof gkind === "string" && gkind.length > 0) targetId = ensureBodyTab(s, gkind);
    s.spec = structuredClone(geometry);
    s.reynolds = reynolds;
    syncAgentCommit(s, targetId, geometry, reynolds);
    settle(s);
}

function solve(s: Shell): SolvedLite {
    const key = caseKeyFor(s.debouncedSpec, s.debouncedRe, GRID.nx);
    const hit = s.cache.get(key);
    if (hit !== null) return hit;
    if (s.provider === null) {
        s.provider = new AnalyticFlowProvider(GRID, s.debouncedSpec, { Re: s.debouncedRe });
    } else {
        s.provider.setGeometry(s.debouncedSpec);
        s.provider.setRe(s.debouncedRe);
    }
    const flow = s.provider.getFrame();
    const { cl } = s.provider.getResult();
    const polygons = buildPolygons(s.debouncedSpec);
    let obstacleCells = 0;
    for (let k = 0; k < flow.obstacle.length; k++) {
        if (flow.obstacle[k] > 0.5) obstacleCells += 1;
    }
    const lite: SolvedLite = { key, polygons, cl, obstacleCells };
    s.cache.set(key, lite);
    return lite;
}

const CYL_R025: GeometrySpec = {
    kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 120, radius: 0.25, center: { x: 0.5, y: 0 },
};
const CYL_R050: GeometrySpec = {
    kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 120, radius: 0.5, center: { x: 0.5, y: 0 },
};
const BLOCK_SMALL: GeometrySpec = {
    kind: "block", chord: 1, alphaDeg: 0, nPoints: 120, width: 0.5, height: 0.5, center: { x: 0.5, y: 0 },
};
const BLOCK_RESIZED_ROTATED: GeometrySpec = {
    kind: "block", chord: 1, alphaDeg: 8, nPoints: 120, width: 1.2, height: 0.8, center: { x: 0.5, y: 0 },
};

describe("App follow-up agent applies recompute", () => {
    it("setup cylinder then radius change updates the second frame", () => {
        const s = freshShell();
        applySetupPreset(s, { preset: "shedding" });
        expect(s.spec.kind).toBe("cylinder");
        expect(s.store.activeId).toBe("cylinder");
        const first = solve(s);
        expect(first.obstacleCells).toBeGreaterThan(0);

        // Follow-up: same-tab radius change. The canvas must not keep the
        // old frame: debounced spec, tab memory, cache key, polygons, and
        // obstacle coverage all move with the applied radius.
        applySetSpec(s, CYL_R050, 100);

        expect(s.agentCommit).toBeNull();
        expect(s.spec.radius).toBe(0.5);
        expect(s.debouncedSpec.radius).toBe(0.5);
        const active = storeActive(s.store);
        expect(active?.id).toBe("cylinder");
        expect(active?.spec.radius).toBe(0.5);
        const second = solve(s);
        expect(second.key).not.toBe(first.key);
        expect(second.obstacleCells).toBeGreaterThan(first.obstacleCells);
        expect(JSON.stringify(second.polygons)).not.toBe(JSON.stringify(first.polygons));
    });

    it("setup square then resize plus rotate updates the second frame", () => {
        const s = freshShell();
        applySetSpec(s, BLOCK_SMALL, 1000);
        expect(s.store.activeId).toBe("block");
        const first = solve(s);

        // Follow-up: same-tab resize plus rotate. Width, height, and alpha
        // land together and the solved frame plus Cl move off the old case.
        applySetSpec(s, BLOCK_RESIZED_ROTATED, 1000);

        expect(s.agentCommit).toBeNull();
        expect(s.spec.width).toBe(1.2);
        expect(s.spec.height).toBe(0.8);
        expect(s.spec.alphaDeg).toBe(8);
        expect(s.debouncedSpec.width).toBe(1.2);
        expect(s.debouncedSpec.alphaDeg).toBe(8);
        const active = storeActive(s.store);
        expect(active?.id).toBe("block");
        expect(active?.spec.width).toBe(1.2);
        expect(active?.spec.alphaDeg).toBe(8);
        const second = solve(s);
        expect(second.key).not.toBe(first.key);
        expect(JSON.stringify(second.polygons)).not.toBe(JSON.stringify(first.polygons));
        expect(second.cl).not.toBe(first.cl);
    });

    it("cross-tab follow-up clears the one-shot suppression", () => {
        const s = freshShell();
        applySetupPreset(s, { preset: "shedding" });
        expect(s.store.activeId).toBe("cylinder");
        expect(s.agentCommit).toBeNull();
        solve(s);

        // Cross-tab follow-up onto block: the stale suppression must not
        // restore the old memory, the block case commits and clears.
        applySetSpec(s, BLOCK_SMALL, 1000);
        expect(s.store.activeId).toBe("block");
        expect(s.agentCommit).toBeNull();
        expect(s.spec.kind).toBe("block");
        expect(s.debouncedSpec.kind).toBe("block");
        const active = storeActive(s.store);
        expect(active?.spec.kind).toBe("block");
    });
});
