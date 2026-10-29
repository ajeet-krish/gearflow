// GeometrySection: right rail GEOMETRY window. Owns the body preset
// select (NACA 0012, 2412, 4412, cylinder, block, orifice), the full rotation
// AoA slider plus numeric entry, and the per body fields. Legacy duct specs
// resolve through migrateDuctToOrifice so the rail never shows a duct body.
// Pure props plus small local alpha text state, same commit pattern as the
// SIMULATION section.

import { useEffect, useState } from "react";
import type { GeometrySpec } from "@/contracts/types";
import {
    ALPHA_HARD_MAX,
    ALPHA_HARD_MIN,
    ALPHA_MAX,
    ALPHA_MIN,
    ORIFICE_GAP_DEFAULT,
    ORIFICE_GAP_MAX,
    ORIFICE_GAP_MIN,
    ORIFICE_THICKNESS_DEFAULT,
    ORIFICE_THICKNESS_MAX,
    ORIFICE_THICKNESS_MIN,
    alphaOutOfBandNote,
} from "@/contracts/schema";
import { migrateDuctToOrifice } from "@/geometry/parametric";
import { applyBodyPreset, bodySelectValue, CANONICAL_BODY_VALUES } from "@/geometry/bodyPresets";

function nacaCodeFromParams(m: number, p: number, t: number): string {
    const d1 = Math.max(0, Math.min(9, Math.round(m * 100)));
    const d2 = Math.max(0, Math.min(9, Math.round(p * 10)));
    const d34 = Math.max(1, Math.min(99, Math.round(t * 100)));
    return `${d1}${d2}${String(d34).padStart(2, "0")}`;
}

function withNaca(spec: GeometrySpec, patch: Partial<{ m: number; p: number; t: number }>): GeometrySpec {
    const prev = spec.naca ?? { code: "2412", m: 0.02, p: 0.4, t: 0.12 };
    const next = { ...prev, ...patch };
    return { ...spec, naca: { ...next, code: nacaCodeFromParams(next.m, next.p, next.t) } };
}

/** Resolve a legacy duct spec to the orifice plate. Non-duct specs pass through untouched. */
export function resolveLegacyDuct(spec: GeometrySpec): GeometrySpec {
    if ((spec as unknown as { kind: string }).kind === "duct") {
        return migrateDuctToOrifice(spec);
    }
    return spec;
}

/**
 * Commit decision for the AoA numeric entry. The hard envelope accepts full
 * rotation, anything outside holds the last good value with no setter.
 * Never throws.
 */
export function commitAlphaValue(raw: unknown, fallback: number): {
    ok: boolean;
    value: number;
} {
    const n = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : Number.NaN;
    if (!Number.isFinite(n)) return { ok: false, value: fallback };
    if (n < ALPHA_HARD_MIN || n > ALPHA_HARD_MAX) return { ok: false, value: fallback };
    return { ok: true, value: n };
}

/**
 * Clamp a body dimension to its envelope. Non-numeric input holds the
 * fallback, out of envelope input clamps. Never throws.
 */
export function clampBodyDim(raw: unknown, min: number, max: number, fallback: number): number {
    const n = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : Number.NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

export interface GeometrySectionProps {
    spec: GeometrySpec;
    onSpec: (next: GeometrySpec) => void;
    blockageWarning: string | null;
    orificeResolutionWarning: string | null;
}

export interface GeometrySectionViewProps extends GeometrySectionProps {
    alphaText: string;
    onAlphaText: (next: string) => void;
    alphaPopup: string | null;
    onAlphaPopup: (next: string | null) => void;
}

/**
 * Pure view split: no hooks, so rail tests drive every commit path through
 * direct element calls with no worker threads. The default export owns the
 * alpha text state and passes it down.
 */
export function GeometrySectionView(props: GeometrySectionViewProps): JSX.Element {
    const { spec: incoming, onSpec, blockageWarning, orificeResolutionWarning } = props;
    const { alphaText, onAlphaText, alphaPopup, onAlphaPopup } = props;
    const legacyDuct = (incoming as unknown as { kind: string }).kind === "duct";
    const spec = legacyDuct ? migrateDuctToOrifice(incoming) : incoming;
    const isNaca = spec.kind === "naca4";
    const isAlphaWakeOnly = spec.kind === "cylinder" || spec.kind === "orifice";
    const alphaNote = alphaOutOfBandNote(spec.alphaDeg);
    const bodyValue = bodySelectValue(spec);
    const isCustomNaca = isNaca && !CANONICAL_BODY_VALUES.has(bodyValue);

    const commitAlpha = () => {
        const decision = commitAlphaValue(alphaText, spec.alphaDeg);
        if (decision.ok) {
            onAlphaPopup(null);
            onSpec({ ...spec, alphaDeg: decision.value });
        } else {
            onAlphaPopup(
                `Alpha holds at ${spec.alphaDeg.toFixed(1)} deg, valid range is [${ALPHA_HARD_MIN}, ${ALPHA_HARD_MAX}].`
            );
        }
    };

    return (
        <div className="controls">
            <div className="field">
                <label htmlFor="geoBody">Body kind</label>
                <select
                    id="geoBody"
                    value={bodyValue}
                    onChange={(e) => onSpec(applyBodyPreset(spec, e.target.value))}
                    aria-label="Body kind"
                >
                    <option value="naca0012">NACA 0012</option>
                    <option value="naca2412">NACA 2412</option>
                    <option value="naca4412">NACA 4412</option>
                    {isCustomNaca && (
                        <option value={bodyValue}>
                            {`NACA ${bodyValue.slice(4).toUpperCase()} (custom)`}
                        </option>
                    )}
                    <option value="cylinder">Cylinder</option>
                    <option value="block">Block</option>
                    <option value="orifice">Orifice plate</option>
                </select>
                {legacyDuct && (
                    <p className="hint" role="note">Legacy duct spec resolved as an orifice plate.</p>
                )}
                {isNaca && (
                    <p className="hint mono">
                        NACA {spec.naca ? nacaCodeFromParams(spec.naca.m, spec.naca.p, spec.naca.t) : "2412"}, derived from the sliders below.
                    </p>
                )}
            </div>

            <div className="field">
                <label htmlFor="geoAlpha">
                    Angle of attack <output htmlFor="geoAlpha" className="mono">{spec.alphaDeg.toFixed(1)} deg</output>
                </label>
                <input
                    id="geoAlpha"
                    type="range"
                    min={ALPHA_HARD_MIN}
                    max={ALPHA_HARD_MAX}
                    step={0.5}
                    value={spec.alphaDeg}
                    onChange={(e) => onSpec({ ...spec, alphaDeg: Number(e.target.value) })}
                    aria-label="Angle of attack in degrees, minus 180 to 180"
                />
                <input
                    id="geoAlphaNumber"
                    className="barInput"
                    type="number"
                    min={ALPHA_HARD_MIN}
                    max={ALPHA_HARD_MAX}
                    step={0.5}
                    value={alphaText}
                    onChange={(e) => onAlphaText(e.target.value)}
                    onBlur={commitAlpha}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") commitAlpha();
                        else if (e.key === "Escape") {
                            onAlphaText(String(spec.alphaDeg));
                            onAlphaPopup(null);
                        }
                    }}
                    aria-label="Angle of attack value, commits on Enter"
                />
                {alphaPopup !== null && (
                    <p className="mError" role="alert">{alphaPopup}</p>
                )}
                {alphaNote !== null && (
                    <p className="hint" role="note">{alphaNote}</p>
                )}
                {isAlphaWakeOnly && (
                    <p className="hint">Symmetric body, angle leaves the geometry unchanged and tilts the wake only.</p>
                )}
            </div>

            <div className="field">
                <label htmlFor="geoThick">
                    Thickness <output htmlFor="geoThick" className="mono">{(spec.naca?.t ?? 0.12).toFixed(3)}</output>
                </label>
                <input
                    id="geoThick"
                    type="range"
                    min={0.06}
                    max={0.18}
                    step={0.005}
                    value={spec.naca?.t ?? 0.12}
                    disabled={!isNaca}
                    onChange={(e) => onSpec(withNaca(spec, { t: Number(e.target.value) }))}
                    aria-label="Thickness fraction, 0.06 to 0.18, NACA only"
                />
                {!isNaca && <p className="hint">Thickness applies to NACA bodies only.</p>}
            </div>

            <div className="field">
                <label htmlFor="geoCamber">
                    Camber <output htmlFor="geoCamber" className="mono">{(spec.naca?.m ?? 0).toFixed(3)}</output>
                </label>
                <input
                    id="geoCamber"
                    type="range"
                    min={0}
                    max={0.09}
                    step={0.005}
                    value={spec.naca?.m ?? 0}
                    disabled={!isNaca}
                    onChange={(e) => onSpec(withNaca(spec, { m: Number(e.target.value) }))}
                    aria-label="Camber fraction, 0 to 0.09, NACA only"
                />
            </div>

            <div className="field">
                <label htmlFor="geoCamberPos">
                    Camber position <output htmlFor="geoCamberPos" className="mono">{(spec.naca?.p ?? 0.4).toFixed(2)}</output>
                </label>
                <input
                    id="geoCamberPos"
                    type="range"
                    min={0.2}
                    max={0.8}
                    step={0.05}
                    value={spec.naca?.p ?? 0.4}
                    disabled={!isNaca || (spec.naca?.m ?? 0) <= 1e-10}
                    onChange={(e) => onSpec(withNaca(spec, { p: Number(e.target.value) }))}
                    aria-label="Camber position fraction, 0.2 to 0.8, NACA only"
                />
            </div>

            {spec.kind === "cylinder" && (
                <div className="field">
                    <label htmlFor="geoRadius">
                        Radius <output htmlFor="geoRadius" className="mono">{(spec.radius ?? 0.25).toFixed(2)}</output>
                    </label>
                    <input
                        id="geoRadius"
                        type="range"
                        min={0.05}
                        max={1}
                        step={0.01}
                        value={spec.radius ?? 0.25}
                        onChange={(e) => onSpec({ ...spec, radius: clampBodyDim(Number(e.target.value), 0.05, 1, spec.radius ?? 0.25) })}
                        aria-label="Cylinder radius, 0.05 to 1"
                    />
                </div>
            )}

            {spec.kind === "block" && (
                <div className="field">
                    <label htmlFor="geoLength">
                        Length <output htmlFor="geoLength" className="mono">{(spec.width ?? 0.5).toFixed(2)}</output>
                    </label>
                    <input
                        id="geoLength"
                        type="range"
                        min={0.1}
                        max={3}
                        step={0.05}
                        value={spec.width ?? 0.5}
                        onChange={(e) => onSpec({ ...spec, width: clampBodyDim(Number(e.target.value), 0.1, 3, spec.width ?? 0.5) })}
                        aria-label="Block length, 0.1 to 3"
                    />
                    <label htmlFor="geoHeight">
                        Height <output htmlFor="geoHeight" className="mono">{(spec.height ?? 0.5).toFixed(2)}</output>
                    </label>
                    <input
                        id="geoHeight"
                        type="range"
                        min={0.1}
                        max={3}
                        step={0.05}
                        value={spec.height ?? 0.5}
                        onChange={(e) => onSpec({ ...spec, height: clampBodyDim(Number(e.target.value), 0.1, 3, spec.height ?? 0.5) })}
                        aria-label="Block height, 0.1 to 3"
                    />
                </div>
            )}

            {spec.kind === "orifice" && (
                <div className="field">
                    <label htmlFor="geoGap">
                        Gap <output htmlFor="geoGap" className="mono">{(spec.height ?? ORIFICE_GAP_DEFAULT).toFixed(2)}</output>
                    </label>
                    <input
                        id="geoGap"
                        type="range"
                        min={ORIFICE_GAP_MIN}
                        max={ORIFICE_GAP_MAX}
                        step={0.01}
                        value={spec.height ?? ORIFICE_GAP_DEFAULT}
                        onChange={(e) => onSpec({
                            ...spec,
                            height: clampBodyDim(Number(e.target.value), ORIFICE_GAP_MIN, ORIFICE_GAP_MAX, spec.height ?? ORIFICE_GAP_DEFAULT),
                        })}
                        aria-label="Orifice gap opening, 0.05 to 1.8"
                    />
                    <label htmlFor="geoThickPlate">
                        Plate thickness <output htmlFor="geoThickPlate" className="mono">{(spec.width ?? ORIFICE_THICKNESS_DEFAULT).toFixed(3)}</output>
                    </label>
                    <input
                        id="geoThickPlate"
                        type="range"
                        min={ORIFICE_THICKNESS_MIN}
                        max={ORIFICE_THICKNESS_MAX}
                        step={0.005}
                        value={spec.width ?? ORIFICE_THICKNESS_DEFAULT}
                        onChange={(e) => onSpec({
                            ...spec,
                            width: clampBodyDim(Number(e.target.value), ORIFICE_THICKNESS_MIN, ORIFICE_THICKNESS_MAX, spec.width ?? ORIFICE_THICKNESS_DEFAULT),
                        })}
                        aria-label="Orifice plate thickness, 0.02 to 0.2"
                    />
                    {orificeResolutionWarning !== null && (
                        <p className="hint" role="note">{orificeResolutionWarning}</p>
                    )}
                </div>
            )}

            {blockageWarning !== null && (
                <p className="fallbackNote notice" role="status">{blockageWarning}</p>
            )}
            <p className="hint mono">Characterized band [{ALPHA_MIN}, {ALPHA_MAX}] deg, hard envelope [{ALPHA_HARD_MIN}, {ALPHA_HARD_MAX}] deg.</p>
        </div>
    );
}

export default function GeometrySection(props: GeometrySectionProps): JSX.Element {
    const [alphaText, setAlphaText] = useState(String(props.spec.alphaDeg));
    const [alphaPopup, setAlphaPopup] = useState<string | null>(null);

    useEffect(() => {
        setAlphaText(String(props.spec.alphaDeg));
    }, [props.spec.alphaDeg]);

    // Commit a legacy duct spec to App state once: the view above only
    // resolves duct for display, this effect migrates the owned state so the
    // solver, intake, and persistence never see the retired kind again.
    const incomingKind = (props.spec as unknown as { kind: string }).kind;
    useEffect(() => {
        if (incomingKind === "duct") {
            try {
                props.onSpec(resolveLegacyDuct(props.spec));
            } catch {
                // Migration must never break the rail on a malformed legacy spec.
            }
        }
    }, [incomingKind, props.spec, props.onSpec]);

    return (
        <GeometrySectionView
            {...props}
            alphaText={alphaText}
            onAlphaText={setAlphaText}
            alphaPopup={alphaPopup}
            onAlphaPopup={setAlphaPopup}
        />
    );
}
