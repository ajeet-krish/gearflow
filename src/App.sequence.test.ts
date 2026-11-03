// App cross-tab agent sequence regression. Reproduces the exact race the
// App shell had: ensureBodyTab activates the target tab, then setSpec
// applies the agent spec, but the one-shot activation effect at App.tsx
// loaded the stale stored tab memory over the agent spec. The fixed shell
// stamps the target id into agentTabCommitRef during activation, so the
// activation effect mirrors the agent spec forward instead of clobbering
// it. This harness drives the pure tab store through the same commit
// order (activate plus apply, then activation effect, then mirror) and
// asserts the final spec and Re. No DOM or worker needed.

import { describe, expect, it } from "vitest";
import {
    bodyTabIdForSpec,
    caseKeyFor,
    createCaseTabsStore,
    storeActivate,
    storeActive,
    storeUpdate,
    type CaseTabStore,
} from "@/ui/caseTabs";
import { applyBodyPreset } from "@/geometry/bodyPresets";
import { expandCasePreset } from "@/agent/casePresets";
import type { GeometrySpec } from "@/contracts/types";

/** Minimal App shell replica: live spec/Re plus tab store plus refs. */
interface Shell {
    store: CaseTabStore;
    spec: GeometrySpec;
    reynolds: number;
    tabSync: string;
    agentCommit: string | null;
}

function freshShell(): Shell {
    const store = createCaseTabsStore();
    const active = storeActive(store);
    return {
        store,
        spec: structuredClone(active!.spec),
        reynolds: active!.reynolds,
        tabSync: "",
        agentCommit: null,
    };
}

/** One-shot activation effect with the agent-commit suppression. */
function activationEffect(s: Shell): void {
    const a = storeActive(s.store);
    if (a === null) return;
    if (s.tabSync === a.id) return;
    if (s.agentCommit === a.id) {
        s.agentCommit = null;
        s.tabSync = a.id;
        s.store = storeUpdate(s.store, a.id, { spec: s.spec, reynolds: s.reynolds });
        return;
    }
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

function switchTab(s: Shell, id: string): void {
    s.store = storeActivate(s.store, id);
    activationEffect(s);
    mirrorEffect(s);
}

/** App ensureBodyTab: provisional spec resolves the tab via bodyTabIdForSpec.
 *  Custom specs resolve to null and leave the tab unchanged. */
function ensureBodyTab(s: Shell, body: string): void {
    const provisional = applyBodyPreset(s.spec, body);
    const id = bodyTabIdForSpec(provisional);
    if (id === null) return;
    if (id !== s.store.activeId) {
        s.agentCommit = id;
        s.store = storeActivate(s.store, id);
    }
}

/** App set_body path: activate then apply, effects settle after. */
function applySetBody(s: Shell, body: string): void {
    ensureBodyTab(s, body);
    const next = applyBodyPreset(s.spec, body);
    if (next !== s.spec) s.spec = next;
    activationEffect(s);
    mirrorEffect(s);
}

/** App setup preset path: pre-activate then apply primitives in order. */
function applySetupPreset(s: Shell, request: Parameters<typeof expandCasePreset>[0]): void {
    const kind = (request as { preset?: string }).preset;
    if (kind === "shedding" || kind === "high_re_wake") ensureBodyTab(s, "cylinder");
    else if (kind === "airfoil") {
        const b = typeof (request as { body?: unknown }).body === "string"
            ? (request as { body: string }).body
            : "naca2412";
        ensureBodyTab(s, b);
    }
    const expanded = expandCasePreset(request, { agentFirst: true });
    if (!expanded.ok) throw new Error(expanded.reason ?? "preset failed");
    for (const prim of expanded.actions) {
        if (prim.kind === "set_body") s.spec = applyBodyPreset(s.spec, prim.body);
        else if (prim.kind === "set_alpha") s.spec = { ...s.spec, alphaDeg: prim.alphaDeg };
        else if (prim.kind === "set_reynolds") s.reynolds = prim.reynolds;
    }
    activationEffect(s);
    mirrorEffect(s);
}

describe("App cross-tab agent sequences", () => {
    it("cross-tab set_body naca4412 from cylinder keeps the agent spec", () => {
        const s = freshShell();
        switchTab(s, "cylinder");
        expect(s.store.activeId).toBe("cylinder");
        expect(s.spec.kind).toBe("cylinder");

        applySetBody(s, "naca4412");

        expect(s.store.activeId).toBe("airfoil");
        expect(s.spec.kind).toBe("naca4");
        if (s.spec.kind === "naca4") expect(s.spec.naca?.code).toBe("4412");
        const active = storeActive(s.store);
        expect(active?.id).toBe("airfoil");
        expect(active?.spec.kind).toBe("naca4");
        if (active?.spec.kind === "naca4") expect(active.spec.naca?.code).toBe("4412");
        // set_body preserves the live Re (cylinder memory Re 100 rides along).
        expect(s.reynolds).toBe(100);
        expect(active?.reynolds).toBe(100);
    });

    it("cross-tab setup shedding from airfoil lands cylinder Re 100", () => {
        const s = freshShell();
        expect(s.store.activeId).toBe("airfoil");

        applySetupPreset(s, { preset: "shedding" });

        expect(s.store.activeId).toBe("cylinder");
        expect(s.spec.kind).toBe("cylinder");
        expect(s.spec.alphaDeg).toBe(0);
        expect(s.reynolds).toBe(100);
        const active = storeActive(s.store);
        expect(active?.spec.kind).toBe("cylinder");
        expect(active?.reynolds).toBe(100);
    });

    it("cross-tab setup airfoil naca4412 from cylinder lands Re 1200", () => {
        const s = freshShell();
        switchTab(s, "cylinder");

        applySetupPreset(s, { preset: "airfoil", body: "naca4412", alphaDeg: 2 });

        expect(s.store.activeId).toBe("airfoil");
        expect(s.spec.kind).toBe("naca4");
        if (s.spec.kind === "naca4") expect(s.spec.naca?.code).toBe("4412");
        expect(s.spec.alphaDeg).toBe(2);
        expect(s.reynolds).toBe(1200);
        const active = storeActive(s.store);
        if (active?.spec.kind === "naca4") expect(active.spec.naca?.code).toBe("4412");
        expect(active?.reynolds).toBe(1200);
    });
});
