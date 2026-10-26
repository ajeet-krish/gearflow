// GearFlow Phase 4 Meta orchestration panel. Quiet logbook beside the hero
// canvas: Spark proposes a spec from plain words, SAM turns a sketch into a
// custom polygon, the engineer explains the current run, the poster renders
// one labeled illustration per session. Spark and SAM write to the canvas
// only through Apply (via onApplySpec). The suggested engineer change applies
// only when its own Apply button is clicked. No em dashes in copy.

import { useRef, useState } from "react";
import type { GeometrySpec, OfflineCase, ParametricSpec, RaceEngineerResult, SamResult } from "@/contracts/types";
import type { HashCache } from "@/meta/cache";
import type { MetaClient } from "@/meta/client";
import { PRESETS } from "@/meta/presets";
import { generatePoster, createPosterSession, type PosterSession } from "@/meta/poster";
import { sketchToSpec } from "@/meta/samSegment";
import { explainRun, type RunMetrics } from "@/meta/sparkEngineer";
import { promptToSpec } from "@/meta/sparkSpec";

export interface MetaPanelProps {
    spec: GeometrySpec;
    reynolds: number;
    cl: number;
    cpMin: number;
    offline: boolean;
    onOfflineChange: (next: boolean) => void;
    onApplySpec: (next: ParametricSpec) => void;
    client: MetaClient;
    cache: HashCache;
    posterUrl: string | null;
    onPosterUrl: (url: string | null) => void;
    offlineCases?: OfflineCase[] | null;
}

function shortSpec(spec: ParametricSpec): string {
    const g = spec.geometry;
    const name = g.kind === "naca4" && g.naca ? `NACA ${g.naca.code}` : g.kind;
    return `${name} a${g.alphaDeg} Re${spec.reynolds}`;
}

function describeError(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    return raw.length > 220 ? `${raw.slice(0, 217)}...` : raw;
}

/** Sketch upload guards: 5 MiB cap plus PNG/JPEG allowlist, checked before any network call. */
export const MAX_SKETCH_BYTES = 5 * 1024 * 1024;
const ACCEPTED_SKETCH_TYPES = ["image/png", "image/jpeg"];
const ACCEPTED_SKETCH_EXT = /\.(png|jpe?g)$/i;

function describeSketchRejection(file: File): string | null {
    if (file.size > MAX_SKETCH_BYTES) {
        const mib = (file.size / (1024 * 1024)).toFixed(1);
        return `Sketch is ${mib} MiB, the cap is 5 MiB. Export a smaller PNG or JPEG and retry.`;
    }
    if (file.type !== "" && !ACCEPTED_SKETCH_TYPES.includes(file.type)) {
        return `Sketch type ${file.type} is not supported. Upload a PNG or JPEG.`;
    }
    const name = file.name ?? "";
    if (file.type === "" && !ACCEPTED_SKETCH_EXT.test(name)) {
        return "Sketch must be a PNG or JPEG file. Rename with a .png or .jpg extension and retry.";
    }
    return null;
}

/** Map an engineer suggested field onto canvas controls. Returns null when the field has no canvas control. */
function applySuggestedChange(
    current: GeometrySpec,
    currentRe: number,
    field: string,
    to: number
): { spec: GeometrySpec; reynolds: number } | null {
    const f = field.trim().toLowerCase();
    if (f === "alphadeg" || f === "alpha" || f === "aoa") {
        const alphaDeg = Math.min(12, Math.max(-4, to));
        return { spec: { ...current, alphaDeg }, reynolds: currentRe };
    }
    if (f === "reynolds" || f === "re" || f === "rey") {
        const reynolds = Math.min(1_000_000, Math.max(1000, Math.round(to)));
        return { spec: current, reynolds };
    }
    const naca = current.naca;
    if (naca === undefined) return null;
    if (f === "camber" || f === "m") {
        const m = Math.min(0.09, Math.max(0, to));
        return { spec: { ...current, naca: { ...naca, m } }, reynolds: currentRe };
    }
    if (f === "camberposition" || f === "camber position" || f === "p") {
        const p = Math.min(0.8, Math.max(0.2, to));
        return { spec: { ...current, naca: { ...naca, p } }, reynolds: currentRe };
    }
    if (f === "thickness" || f === "t") {
        const t = Math.min(0.18, Math.max(0.06, to));
        return { spec: { ...current, naca: { ...naca, t } }, reynolds: currentRe };
    }
    return null;
}

export default function MetaPanel({
    spec,
    reynolds,
    cl,
    cpMin,
    offline,
    onOfflineChange,
    onApplySpec,
    client,
    cache,
    posterUrl,
    onPosterUrl,
    offlineCases = null,
}: MetaPanelProps) {
    const [sparkText, setSparkText] = useState("High lift study, cambered section, moderate Reynolds");
    const [sparkBusy, setSparkBusy] = useState(false);
    const [sparkError, setSparkError] = useState<string | null>(null);
    const [sparkResult, setSparkResult] = useState<{ spec: ParametricSpec; cached: boolean } | null>(null);

    const [engineerBusy, setEngineerBusy] = useState(false);
    const [engineerError, setEngineerError] = useState<string | null>(null);
    const [engineer, setEngineer] = useState<RaceEngineerResult | null>(null);
    const [suggestNote, setSuggestNote] = useState<string | null>(null);

    const [samBusy, setSamBusy] = useState(false);
    const [samError, setSamError] = useState<string | null>(null);
    const [samResult, setSamResult] = useState<{ spec: GeometrySpec; sam: SamResult } | null>(null);

    const [posterBusy, setPosterBusy] = useState(false);
    const [posterError, setPosterError] = useState<string | null>(null);
    const [posterCached, setPosterCached] = useState(false);

    const fileRef = useRef<HTMLInputElement | null>(null);
    const posterSessionRef = useRef<PosterSession | null>(null);
    if (posterSessionRef.current === null) posterSessionRef.current = createPosterSession();

    const metricsReady = Number.isFinite(cl) && Number.isFinite(cpMin);

    async function onSparkSubmit(): Promise<void> {
        const text = sparkText.trim();
        if (text.length === 0 || sparkBusy) return;
        setSparkBusy(true);
        setSparkError(null);
        try {
            const result = await promptToSpec(client, cache, text);
            setSparkResult(result);
        } catch (e) {
            setSparkError(describeError(e));
        } finally {
            setSparkBusy(false);
        }
    }

    async function onEngineerExplain(): Promise<void> {
        if (engineerBusy || !metricsReady) return;
        setEngineerBusy(true);
        setEngineerError(null);
        setSuggestNote(null);
        try {
            const metrics: RunMetrics = { cl, cpMin, reynolds };
            const current: ParametricSpec = {
                geometry: spec,
                reynolds,
                rationale: "Current canvas run.",
            };
            const result = await explainRun(client, cache, current, metrics);
            setEngineer(result);
        } catch (e) {
            setEngineerError(describeError(e));
        } finally {
            setEngineerBusy(false);
        }
    }

    function onApplySuggested(): void {
        if (engineer === null) return;
        const mapped = applySuggestedChange(spec, reynolds, engineer.suggestedChange.field, engineer.suggestedChange.to);
        if (mapped === null) {
            setSuggestNote(`Field ${engineer.suggestedChange.field} has no canvas control, noted only.`);
            return;
        }
        setSuggestNote(null);
        onApplySpec({ geometry: mapped.spec, reynolds: mapped.reynolds, rationale: engineer.suggestedChange.rationale });
    }

    async function onSamUpload(): Promise<void> {
        const file = fileRef.current?.files?.[0];
        if (!file || samBusy) return;
        const rejection = describeSketchRejection(file);
        if (rejection !== null) {
            setSamError(rejection);
            return;
        }
        setSamBusy(true);
        setSamError(null);
        try {
            const result = await sketchToSpec(client, cache, file);
            setSamResult(result);
        } catch (e) {
            setSamError(describeError(e));
        } finally {
            setSamBusy(false);
        }
    }

    async function onPosterRender(): Promise<void> {
        if (posterBusy) return;
        if (offline && offlineCases !== null && offlineCases.length > 0) {
            setPosterCached(true);
            onPosterUrl(offlineCases[0].poster);
            return;
        }
        setPosterBusy(true);
        setPosterError(null);
        try {
            const current: ParametricSpec = { geometry: spec, reynolds, rationale: "Current canvas run." };
            const { url, cached } = await generatePoster(client, cache, current, posterSessionRef.current!);
            setPosterCached(cached);
            onPosterUrl(url);
        } catch (e) {
            setPosterError(describeError(e));
        } finally {
            setPosterBusy(false);
        }
    }

    return (
        <div className="metaPanel">
            <div className="mRow mToggleRow">
                <input
                    id="metaOffline"
                    type="checkbox"
                    checked={offline}
                    onChange={(e) => onOfflineChange(e.target.checked)}
                    aria-label="Go offline, disable Meta network calls"
                />
                <label htmlFor="metaOffline">
                    Go offline
                    <span className="mSub">Local only. Spark, SAM, and poster calls are blocked and served from cache or templates.</span>
                </label>
                <span className={`mDot ${offline ? "off" : "on"}`} aria-hidden="true" />
            </div>

            <div className="mRow">
                <h3>Spark, text to spec</h3>
                <label className="mLabel" htmlFor="sparkPrompt">Describe the design point in plain words</label>
                <textarea
                    id="sparkPrompt"
                    className="mText"
                    rows={3}
                    value={sparkText}
                    onChange={(e) => setSparkText(e.target.value)}
                    placeholder="High lift study, cambered section, moderate Reynolds"
                />
                <button type="button" className="mBtn" onClick={() => void onSparkSubmit()} disabled={sparkBusy}>
                    {sparkBusy ? "Proposing (standard mode)" : "Propose spec"}
                </button>
                {sparkError !== null && <p className="mError" role="alert">{sparkError}</p>}
                {sparkResult !== null && (
                    <div className="mResult" role="status">
                        <p className="mono">{shortSpec(sparkResult.spec)}{sparkResult.cached ? " (cached)" : ""}</p>
                        <p>{sparkResult.spec.rationale}</p>
                        <button type="button" className="mBtn mApply" onClick={() => onApplySpec(sparkResult.spec)}>
                            Apply to canvas
                        </button>
                    </div>
                )}
            </div>

            <div className="mRow">
                <h3>Engineer, explain this run</h3>
                <button
                    type="button"
                    className="mBtn"
                    onClick={() => void onEngineerExplain()}
                    disabled={engineerBusy || !metricsReady}
                    aria-describedby="engineerHint"
                >
                    {engineerBusy ? "Reading run" : "Explain this run"}
                </button>
                <p className="mSub mono" id="engineerHint">
                    {metricsReady
                        ? `Reads Cl ${cl.toFixed(3)}, CpMin ${cpMin.toFixed(3)}, Re${reynolds}. Proposal applies only on click.`
                        : "Needs a solved run with finite Cl and CpMin."}
                </p>
                {engineerError !== null && <p className="mError" role="alert">{engineerError}</p>}
                {engineer !== null && (
                    <div className="mResult" role="status">
                        <p className="mHeadline">{engineer.headline}</p>
                        <p>{engineer.explanation}</p>
                        <p className="mono">
                            Suggests {engineer.suggestedChange.field} {engineer.suggestedChange.from} to {engineer.suggestedChange.to}: {engineer.suggestedChange.predictedEffect}
                        </p>
                        <button type="button" className="mBtn mApply" onClick={onApplySuggested}>
                            Apply suggested change
                        </button>
                        {suggestNote !== null && <p className="mSub">{suggestNote}</p>}
                        <p className="mSub">Caveat: {engineer.caveats}</p>
                    </div>
                )}
            </div>

            <div className="mRow">
                <h3>SAM, sketch to shape</h3>
                <label className="mLabel" htmlFor="samFile">Upload a planform sketch (PNG or JPEG, max 5 MiB)</label>
                <input
                    id="samFile"
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg"
                    className="mFile"
                    aria-label="Upload a planform sketch for SAM segmentation"
                />
                <button type="button" className="mBtn" onClick={() => void onSamUpload()} disabled={samBusy}>
                    {samBusy ? "Segmenting" : "Segment sketch"}
                </button>
                {samError !== null && <p className="mError" role="alert">{samError}</p>}
                {samResult !== null && (
                    <div className="mResult" role="status">
                        <p className="mono">
                            IoU {samResult.sam.maskIou.toFixed(2)}, confidence {samResult.sam.confidence.toFixed(2)}
                            {samResult.sam.usedFallback ? ", bbox fallback (mask missing)" : ", mask polygon"}
                        </p>
                        <button
                            type="button"
                            className="mBtn mApply"
                            onClick={() => onApplySpec({ geometry: samResult.spec, reynolds, rationale: "SAM sketch polygon." })}
                        >
                            Apply sketch to canvas
                        </button>
                    </div>
                )}
            </div>

            <div className="mRow">
                <h3>Poster, one render per session</h3>
                <button type="button" className="mBtn" onClick={() => void onPosterRender()} disabled={posterBusy}>
                    {posterBusy ? "Rendering" : posterUrl !== null ? "Reuse session render" : "Render poster"}
                </button>
                {posterError !== null && <p className="mError" role="alert">{posterError}</p>}
                {posterUrl !== null && (
                    <figure className="mPoster">
                        <img src={posterUrl} alt="Labeled illustrative poster of the current wing study" loading="lazy" />
                        <figcaption className="mono">
                            Illustrative render, not physics.{posterCached ? " Reused session url." : ""}
                        </figcaption>
                    </figure>
                )}
            </div>

            <div className="mRow">
                <h3>Style presets</h3>
                <div className="presetGrid" role="group" aria-label="Style inspired airfoil presets">
                    {PRESETS.map((preset) => (
                        <button
                            key={preset.id}
                            type="button"
                            className="mBtn presetBtn"
                            onClick={() => onApplySpec(preset.spec)}
                        >
                            {preset.id === "monaco-style" ? "Monaco style" : "Monza style"}
                        </button>
                    ))}
                </div>
                <p className="mSub">Style inspired airfoil proxies, not car models. No logos. Local only, no network call.</p>
            </div>

            {offline && (
                <div className="mRow">
                    <h3>Offline pack, baked cases</h3>
                    {offlineCases === null || offlineCases.length === 0 ? (
                        <p className="mSub">Offline pack loading, zero network. Baked specs appear here.</p>
                    ) : (
                        <div className="presetGrid" role="group" aria-label="Baked offline cases">
                            {offlineCases.map((baked) => (
                                <button
                                    key={baked.id}
                                    type="button"
                                    className="mBtn presetBtn"
                                    onClick={() => {
                                        onPosterUrl(baked.poster);
                                        onApplySpec(baked.spec);
                                    }}
                                >
                                    {baked.label}
                                </button>
                            ))}
                        </div>
                    )}
                    <p className="mSub">Baked specs, engineer notes, and posters. No fetch, served from public/offline-pack.</p>
                </div>
            )}

            <p className="mFoot mono">
                Provenance: analytic path runs offline, API keys stay in env. Spark, SAM, and image calls are standard mode,
                cached by content hash, and logged to the eval ledger below.
            </p>
        </div>
    );
}
