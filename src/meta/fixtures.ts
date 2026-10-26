// Loads and validates the Phase 1 demo pack over fetch.

import { validateDemoPack, validatePackFlowConsistency, validateAirfoilPoints, validateLoadedGeometryMatchesPack, validatePackFilePath, coerceFlowField } from "@/contracts/schema";
import type { DemoPack, FlowField, GeometrySpec, GridSpec, Provenance } from "@/contracts/types";

export interface LoadedPack {
    pack: DemoPack;
    geometry: GeometrySpec;
    grid: GridSpec;
    provenance: Provenance;
    flow: FlowField;
    airfoilPoints: { x: number; y: number }[];
}

const LOAD_FAILURE_MESSAGE = "Failed to load demo pack. Check connection and retry.";

/** Join baseUrl and an allowlisted fixture path, verifying the result stays under base. */
export function resolveFixtureUrl(baseUrl: string, file: string): string {
    validatePackFilePath(file);
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const absolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(base);
    const baseUrlObj = absolute ? new URL(base) : new URL(base, "http://localhost");
    const resolved = new URL(file, baseUrlObj);
    if (absolute ? resolved.origin !== baseUrlObj.origin : false) {
        throw new Error(`Fixture path escapes pack base: ${file}`);
    }
    if (!resolved.pathname.startsWith(baseUrlObj.pathname)) {
        throw new Error(`Fixture path escapes pack base: ${file}`);
    }
    return `${baseUrl}/${file}`;
}

export async function loadDemoPack(baseUrl = "/demo-pack"): Promise<LoadedPack> {
    try {
        return await loadDemoPackInner(baseUrl);
    } catch (e) {
        console.error("loadDemoPack failed:", e instanceof Error ? e.message : String(e));
        throw new Error(LOAD_FAILURE_MESSAGE);
    }
}

async function loadDemoPackInner(baseUrl: string): Promise<LoadedPack> {
    const manifestRes = await fetch(`${baseUrl}/manifest.json`);
    if (!manifestRes.ok) throw new Error(`Demo pack manifest missing at ${baseUrl}/manifest.json`);
    const manifest = await manifestRes.json();
    validateDemoPack(manifest);
    const pack = manifest as DemoPack;

    const [geomRes, flowRes] = await Promise.all([
        fetch(resolveFixtureUrl(baseUrl, pack.files.geometry)),
        fetch(resolveFixtureUrl(baseUrl, pack.files.flow)),
    ]);
    if (!geomRes.ok) throw new Error(`Geometry file missing: ${pack.files.geometry}`);
    if (!flowRes.ok) throw new Error(`Flow file missing: ${pack.files.flow}`);
    const geomJson = await geomRes.json();
    const flowJson = await flowRes.json();
    validateLoadedGeometryMatchesPack(pack.geometry, (geomJson as { geometry?: unknown }).geometry);
    const flow = coerceFlowField(flowJson);
    validatePackFlowConsistency(pack, flow);
    const airfoilPoints = Array.isArray((geomJson as { points?: unknown }).points)
        ? (geomJson as { points: { x: number; y: number }[] }).points
        : [];
    validateAirfoilPoints(airfoilPoints, { requireNonEmpty: pack.geometry.kind === "naca4" });
    return { pack, geometry: pack.geometry, grid: pack.grid, provenance: pack.provenance, flow, airfoilPoints };
}
