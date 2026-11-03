// Case tab store for the P1 IDE shell emulation. Visual emulation only,
// no vendored code. Tabs hold data memories (spec plus Reynolds number)
// for the single solver and single canvas. The solver reads only the
// active tab. Frame cache is a bounded LRU capped at 4 and cleared on
// grid change. Never throws.

import { useCallback, useMemo, useState } from "react";
import type { GeometrySpec } from "@/contracts/types";

/** One case tab memory. Data only, never a solver instance. Dirty marks
 *  an edited memory that differs from its last saved snapshot. */
export interface CaseTabMemory {
    id: string;
    title: string;
    spec: GeometrySpec;
    reynolds: number;
    dirty: boolean;
}

/** Frame cache bound. Small on purpose, mirrors a tab preview cache. */
export const FRAME_CACHE_CAP = 4;

/** Short tab title from a spec plus Re, file style for the tab strip. */
export function tabTitleFor(spec: GeometrySpec, reynolds: number): string {
    try {
        const body = spec.kind === "naca4" && spec.naca?.code
            ? `naca${spec.naca.code}`
            : spec.kind;
        const alpha = Number.isFinite(spec.alphaDeg) ? `a${Math.round(spec.alphaDeg)}` : "a?";
        const re = Number.isFinite(reynolds) && reynolds > 0
            ? `Re${reynolds >= 1000 ? `${Math.round(reynolds / 1000)}k` : Math.round(reynolds)}`
            : "Re?";
        return `${body}_${alpha}_${re}`;
    } catch {
        return "case";
    }
}

/** Stable key for the frame cache. Grid is part of the key, last so
 *  callers can strip it with split("|g")[0] and still compare full
 *  geometry. Every GeometrySpec field that changes the solved field is
 *  included: kind, NACA code plus m/p/t fractions, alpha, chord,
 *  nPoints, radius, width, height, center, and polygon, plus Re and grid.
 *  Never throws. */
export function caseKeyFor(spec: GeometrySpec, reynolds: number, gridNx: number): string {
    try {
        const kind = typeof spec.kind === "string" ? spec.kind : "?";
        const naca = spec.kind === "naca4" ? spec.naca : undefined;
        const nacaPart = naca !== undefined
            ? `${String(naca.code ?? "?")}:${fmtNum(naca.m)}:${fmtNum(naca.p)}:${fmtNum(naca.t)}`
            : "no-naca";
        const alpha = Number.isFinite(spec.alphaDeg) ? `a${Number(spec.alphaDeg)}` : "a?";
        const re = Number.isFinite(reynolds) ? `Re${Math.round(reynolds)}` : "Re?";
        const chord = `c${fmtNum(spec.chord)}`;
        const nPts = Number.isFinite(spec.nPoints) ? `n${Math.trunc(Number(spec.nPoints))}` : "n?";
        const radius = `r${fmtNum(spec.radius ?? 0)}`;
        const width = `w${fmtNum(spec.width ?? 0)}`;
        const height = `h${fmtNum(spec.height ?? 0)}`;
        const center = spec.center !== undefined
            ? `ctr${fmtNum(spec.center.x)},${fmtNum(spec.center.y)}`
            : "no-center";
        const polygon = spec.polygon !== undefined
            ? `len${spec.polygon.length}:${spec.polygon.map((p) => `${fmtNum(p.x)},${fmtNum(p.y)}`).join(";")}`
            : "no-poly";
        const grid = Number.isFinite(gridNx) ? `g${Math.trunc(Number(gridNx))}` : "g?";
        return `${kind}|${nacaPart}|${alpha}|${chord}|${nPts}|${radius}|${width}|${height}|${center}|${polygon}|${re}|${grid}`;
    } catch {
        return "invalid";
    }
}

/** Finite number serializer for the cache key. Non-finite becomes "?". */
function fmtNum(value: unknown): string {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

/** Bounded frame cache. Oldest entry evicts past the cap. Never throws. */
export class CaseFrameCache<T> {
    private map = new Map<string, T>();
    private order: string[] = [];

    get size(): number {
        return this.map.size;
    }

    get(key: string): T | null {
        try {
            return this.map.has(key) ? (this.map.get(key) as T) : null;
        } catch {
            return null;
        }
    }

    has(key: string): boolean {
        try {
            return this.map.has(key);
        } catch {
            return false;
        }
    }

    set(key: string, value: T): void {
        try {
            if (this.map.has(key)) {
                this.map.set(key, value);
                this.order = [...this.order.filter((k) => k !== key), key];
                return;
            }
            this.map.set(key, value);
            this.order = [...this.order, key];
            while (this.order.length > FRAME_CACHE_CAP) {
                const oldest = this.order.shift();
                if (oldest !== undefined) this.map.delete(oldest);
            }
        } catch {
            // Cache faults never break the solve path.
        }
    }

    clear(): void {
        try {
            this.map.clear();
            this.order = [];
        } catch {
            // Never throws.
        }
    }

    keys(): string[] {
        try {
            return [...this.order];
        } catch {
            return [];
        }
    }
}

/** Error count selector for the status bar problems item. Errors are
 *  validation fail rows. Blocking is already a fail on a PASS tier row,
 *  so it is not added twice. Never throws. */
export function selectErrorCount(summary: { fail?: unknown; blocking?: unknown } | null | undefined): number {
    try {
        const f = (summary as { fail?: unknown } | null | undefined)?.fail;
        return typeof f === "number" && Number.isFinite(f) && f > 0 ? Math.floor(f) : 0;
    } catch {
        return 0;
    }
}

/** Warning count selector, paired with the error count above. */
export function selectWarningCount(summary: { warn?: unknown } | null | undefined): number {
    try {
        const w = (summary as { warn?: unknown } | null | undefined)?.warn;
        return typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.floor(w) : 0;
    } catch {
        return 0;
    }
}

function cloneSpec(spec: GeometrySpec): GeometrySpec {
    try {
        return JSON.parse(JSON.stringify(spec)) as GeometrySpec;
    } catch {
        return { ...spec };
    }
}

function baseSpec2412(alphaDeg: number): GeometrySpec {
    return {
        kind: "naca4",
        naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
        chord: 1,
        alphaDeg,
        nPoints: 120,
    };
}

function baseSpecCylinder(): GeometrySpec {
    return { kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 120, radius: 0.25, center: { x: 0.5, y: 0 } };
}

function baseSpecBlock(): GeometrySpec {
    return { kind: "block", chord: 1, alphaDeg: 0, nPoints: 120, width: 0.5, height: 0.5, center: { x: 0.5, y: 0 } };
}

function baseSpecOrifice(): GeometrySpec {
    return { kind: "orifice", chord: 1, alphaDeg: 0, nPoints: 120, width: 0.08, height: 0.4, center: { x: 0.5, y: 0 } };
}

/** Fixed Body selector tabs. Ids are stable, block means rectangle. */
export const BODY_TABS = [
    { id: "airfoil", label: "NACA Airfoil" },
    { id: "cylinder", label: "Cylinder" },
    { id: "block", label: "Rectangle" },
    { id: "orifice", label: "Orifice" },
] as const;

export type BodyTabId = (typeof BODY_TABS)[number]["id"];

/** Display label for a body tab id. Block reads as Rectangle. Never throws. */
export function bodyTabLabelForId(id: string): string {
    try {
        const found = (BODY_TABS as ReadonlyArray<{ id: string; label: string }>).find((t) => t.id === id);
        return found !== undefined ? found.label : id;
    } catch {
        return id;
    }
}

/** Display label for a spec kind. Naca4 family reads as NACA Airfoil, block reads as Rectangle. Never throws. */
export function bodyTabLabelFor(spec: GeometrySpec): string {
    try {
        if (spec.kind === "naca4") return "NACA Airfoil";
        if (spec.kind === "cylinder") return "Cylinder";
        if (spec.kind === "block") return "Rectangle";
        if (spec.kind === "orifice") return "Orifice";
        return spec.kind;
    } catch {
        return "Body";
    }
}

/** Body tab id for a spec kind. Naca4 family maps to airfoil. Never throws. */
export function bodyTabIdForSpec(spec: GeometrySpec): BodyTabId {
    try {
        if (spec.kind === "naca4") return "airfoil";
        if (spec.kind === "cylinder") return "cylinder";
        if (spec.kind === "block") return "block";
        return "orifice";
    } catch {
        return "airfoil";
    }
}

/** Default spec for a body tab id. Naca4 family uses 2412. Never throws. */
export function defaultSpecForBodyTab(id: string): GeometrySpec {
    try {
        if (id === "cylinder") return baseSpecCylinder();
        if (id === "block") return baseSpecBlock();
        if (id === "orifice") return baseSpecOrifice();
        return baseSpec2412(6);
    } catch {
        return baseSpec2412(6);
    }
}

/** Default Reynolds for a body tab id. Never throws. */
export function defaultReForBodyTab(id: string): number {
    try {
        if (id === "airfoil") return 50000;
        if (id === "cylinder") return 100;
        if (id === "block") return 1000;
        if (id === "orifice") return 1000;
        return 50000;
    } catch {
        return 50000;
    }
}

/** Default four body tab memories for first paint. Isolated objects, no sharing. */
export function defaultCaseTabs(): CaseTabMemory[] {
    const a = baseSpec2412(6);
    const b = baseSpecCylinder();
    const c = baseSpecBlock();
    const d = baseSpecOrifice();
    return [
        { id: "airfoil", title: "NACA Airfoil", spec: a, reynolds: 50000, dirty: false },
        { id: "cylinder", title: "Cylinder", spec: b, reynolds: 100, dirty: false },
        { id: "block", title: "Rectangle", spec: c, reynolds: 1000, dirty: false },
        { id: "orifice", title: "Orifice", spec: d, reynolds: 1000, dirty: false },
    ];
}

/** Pure store for tests and the React hook below. No React inside. */
export interface CaseTabStore {
    tabs: CaseTabMemory[];
    activeId: string;
}

export function createCaseTabsStore(initial?: CaseTabMemory[]): CaseTabStore {
    const tabs = (initial ?? defaultCaseTabs()).map((t) => ({
        id: t.id,
        title: t.title,
        reynolds: t.reynolds,
        spec: cloneSpec(t.spec),
        dirty: t.dirty === true,
    }));
    return { tabs, activeId: tabs.length > 0 ? tabs[0].id : "" };
}

export function storeActive(store: CaseTabStore): CaseTabMemory | null {
    try {
        return store.tabs.find((t) => t.id === store.activeId) ?? store.tabs[0] ?? null;
    } catch {
        return null;
    }
}

/** Activate a tab id. Unknown ids leave the store unchanged. Pure. */
export function storeActivate(store: CaseTabStore, id: string): CaseTabStore {
    try {
        if (!store.tabs.some((t) => t.id === id)) return store;
        return { tabs: store.tabs, activeId: id };
    } catch {
        return store;
    }
}

/** Update one tab memory by id, returning a new store. Other tabs are
 *  untouched by reference, so memories stay isolated. Any spec or Re
 *  change marks the memory dirty. Body tab titles stay fixed (NACA Airfoil,
 *  Cylinder, Rectangle, Orifice), never regenerated from the spec. Pure. */
export function storeUpdate(
    store: CaseTabStore,
    id: string,
    patch: { spec?: GeometrySpec; reynolds?: number },
): CaseTabStore {
    try {
        let changed = false;
        const tabs = store.tabs.map((t) => {
            if (t.id !== id) return t;
            const nextSpec = patch.spec !== undefined ? cloneSpec(patch.spec) : t.spec;
            const nextRe = patch.reynolds !== undefined ? patch.reynolds : t.reynolds;
            if (nextSpec === t.spec && nextRe === t.reynolds) return t;
            changed = true;
            return {
                id: t.id,
                title: t.title,
                spec: nextSpec,
                reynolds: nextRe,
                dirty: true,
            };
        });
        if (!changed) return store;
        return { tabs, activeId: store.activeId };
    } catch {
        return store;
    }
}

/** React binding. Single active tab drives the single solver. Memories
 *  are data only, body tab titles stay fixed. */
export function useCaseTabs(seed?: CaseTabMemory[]) {
    const [store, setStore] = useState<CaseTabStore>(() => createCaseTabsStore(seed));
    const activate = useCallback((id: string) => {
        setStore((prev) => storeActivate(prev, id));
    }, []);
    const updateActive = useCallback((patch: { spec?: GeometrySpec; reynolds?: number }) => {
        setStore((prev) => {
            const active = storeActive(prev);
            if (active === null) return prev;
            return storeUpdate(prev, active.id, patch);
        });
    }, []);
    const upsertTab = useCallback((tab: CaseTabMemory, makeActive: boolean) => {
        setStore((prev) => {
            const exists = prev.tabs.some((t) => t.id === tab.id);
            const clean: CaseTabMemory = {
                id: tab.id,
                title: tab.title.length > 0 ? tab.title : tabTitleFor(tab.spec, tab.reynolds),
                spec: cloneSpec(tab.spec),
                reynolds: tab.reynolds,
                dirty: tab.dirty === true,
            };
            if (exists) {
                const tabs = prev.tabs.map((t) => (t.id === clean.id ? clean : t));
                return { tabs, activeId: makeActive ? clean.id : prev.activeId };
            }
            return { tabs: [...prev.tabs, clean], activeId: makeActive ? clean.id : prev.activeId };
        });
    }, []);
    const closeTab = useCallback((id: string) => {
        setStore((prev) => {
            if (prev.tabs.length <= 1) return prev;
            if (!prev.tabs.some((t) => t.id === id)) return prev;
            const tabs = prev.tabs.filter((t) => t.id !== id);
            const activeId = prev.activeId === id ? tabs[0].id : prev.activeId;
            return { tabs, activeId };
        });
    }, []);
    const active = useMemo(() => storeActive(store), [store]);
    return { tabs: store.tabs, activeId: store.activeId, active, activate, updateActive, upsertTab, closeTab };
}
