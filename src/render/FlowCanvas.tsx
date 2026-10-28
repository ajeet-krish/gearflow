import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import type { FieldMode, FlowField } from "@/contracts/types";
import type { Point } from "@/geometry/parametric";
import { createParticles, advectParticles, mulberry32, type ParticleSet } from "./particles";
import { fitDomainView } from "./fitView";
import type { Domain } from "@/contracts/types";
import { particleRgb } from "./particleColor";
import type { ParticleColorMode } from "@/contracts/types";
import { buildStreamlines } from "./streamlines";
import { sampleColormap, buildLut, readQuantity, variableRange, kLogScaleFor, normalizeKLogValue, normalizeRecircValue, type KLogScale, type ColormapName } from "@/flow/colormap";
import {
    createFieldTextures,
    updateFieldTextures,
    disposeFieldTextures,
    type FieldTextures,
} from "./fieldTexture";
import { createFieldShaderMaterial, updateFieldShaderMaterial } from "./fieldShader";

interface Props {
    flow: FlowField;
    airfoil: Point[] | Point[][];
    colormap?: ColormapName;
    fieldMode?: FieldMode;
    meanFields?: boolean;
    lineColor?: string;
    fieldVisible?: boolean;
    useShader?: boolean;
    particleCount?: number;
    particleColor?: ParticleColorMode;
    particleSize?: number;
    showContours?: boolean;
    showStreamlines?: boolean;
    streamlineColormap?: ColormapName;
}

export interface FlowCanvasHandle {
    capturePng(): Promise<Blob | null>;
    // Pause is visibility only: the RAF loop pauses on tab hide and when the
    // canvas scrolls offscreen. There is no manual pause control on purpose,
    // the field stays live while visible.
}

// Pure display helpers for the two LBM mean channels. TKE spans decades,
// so it maps through log10(max(k, floor)) with floor at a small fraction
// of the field maximum, normalised over the observed log range. The
// recirculation mask is binary: reverse flow reads as 1, attached as 0.
// Exported for direct unit tests. Solid cells are dimmed by the caller to
// the obstacle colour; these helpers only normalise the fluid value.

/** Log scale descriptor for the TKE display path. Null means no usable data. */
export type KDisplayScale = KLogScale;

export function kDisplayScaleFor(k: Float32Array | undefined): KDisplayScale | null {
    if (k === undefined) return null;
    const flow = { k } as FlowField;
    return kLogScaleFor(flow);
}

/** Normalise one TKE sample into [0, 1] through a log scale. A null scale
 *  (all zero or missing field) reads as 0. Non-finite input reads as 0. */
export function normalizeKDisplay(q: number, scale: KDisplayScale | null): number {
    if (scale === null) return 0;
    return normalizeKLogValue(q, scale);
}

/** Map one recirculation mask sample to the display fraction. Reverse flow
 *  (value at or above 0.5) reads as 1, attached or non-finite as 0. */
export function normalizeRecircDisplay(q: number): number {
    return normalizeRecircValue(q);
}

function speedMaxOf(flow: FlowField): number {
    let m = 1e-6;
    for (let k = 0; k < flow.nx * flow.ny; k++) {
        const s = Math.sqrt(flow.u[k] * flow.u[k] + flow.v[k] * flow.v[k]);
        if (s > m) m = s;
    }
    return m;
}

function fieldUsable(flow: FlowField): boolean {
    const n = flow.nx * flow.ny;
    if (flow.u.length !== n || flow.v.length !== n) return false;
    if (flow.p.length !== n || flow.omega.length !== n || flow.obstacle.length !== n) return false;
    for (let k = 0; k < n; k++) {
        if (!Number.isFinite(flow.u[k]) || !Number.isFinite(flow.v[k])) return false;
        if (!Number.isFinite(flow.p[k]) || !Number.isFinite(flow.omega[k])) return false;
    }
    return true;
}

function polyUsable(poly: Point[]): boolean {
    for (const p of poly) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    }
    return true;
}

function toPolygons(airfoil: Point[] | Point[][]): Point[][] {
    if (airfoil.length > 0 && Array.isArray(airfoil[0])) {
        return airfoil as Point[][];
    }
    return [airfoil as Point[]];
}

function closedLinePts(poly: Point[]): THREE.Vector3[] {
    const pts = poly.map((p) => new THREE.Vector3(p.x, p.y, 0));
    if (poly.length > 0) {
        pts.push(new THREE.Vector3(poly[0].x, poly[0].y, 0));
    }
    return pts;
}

// Adaptive particle steps. The FPS EMA drops a tier after 60 slow frames.
const PARTICLE_STEPS = [3000, 2000, 1200];
const SLOW_FPS = 55;
const SLOW_FRAMES = 60;

/**
 * FlowCanvas with split effects plus a Phase 5 export handle.
 * Effect 1 (mount once): renderer, scene, camera, plane shell, particle store,
 * RAF loop with adaptive density and hidden plus offscreen pause.
 * Effect 2 (flow/airfoil/display): rebuilds plane geometry on grid change
 * (keyed on nx x ny), repaints via the GPU shader path with a vertex color
 * fallback, and swaps the outline line in place.
 * Only replaced line geometry is disposed. Reduced motion renders one frame.
 * The per frame particle painter inlines bilinear sampling and a LUT lookup
 * with reused arrays only, so the hot loop performs no allocations.
 */
const FlowCanvas = forwardRef<FlowCanvasHandle, Props>(function FlowCanvas(
    {
        flow,
        airfoil,
        colormap = "viridis",
        fieldMode = "speed",
        meanFields = false,
        lineColor = "#f5f2e9",
        fieldVisible = true,
        useShader = true,
        particleCount = 3000,
        particleColor = "auto",
        particleSize = 0.018,
        showContours = false,
        showStreamlines = false,
        streamlineColormap,
    },
    ref
) {
    const mountRef = useRef<HTMLDivElement>(null);

    // Mutable render state owned by effect 1, read by effect 2.
    const flowRef = useRef(flow);
    const airfoilRef = useRef(airfoil);
    const colormapRef = useRef<ColormapName>(colormap);
    const fieldModeRef = useRef<FieldMode>(fieldMode);
    const meanFieldsRef = useRef(meanFields);
    const lineColorRef = useRef(lineColor);
    const fieldVisibleRef = useRef(fieldVisible);
    const useShaderRef = useRef(useShader);
    const particleCountRef = useRef(particleCount);
    const particleColorRef = useRef<ParticleColorMode>(particleColor);
    const particleSizeRef = useRef(particleSize);
    const showContoursRef = useRef(showContours);
    const showStreamlinesRef = useRef(showStreamlines);
    const streamlineColormapRef = useRef<ColormapName>(streamlineColormap ?? colormap);
    flowRef.current = flow;
    airfoilRef.current = airfoil;
    colormapRef.current = colormap;
    fieldModeRef.current = fieldMode;
    meanFieldsRef.current = meanFields;
    lineColorRef.current = lineColor;
    fieldVisibleRef.current = fieldVisible;
    useShaderRef.current = useShader;
    particleCountRef.current = particleCount;
    particleColorRef.current = particleColor;
    particleSizeRef.current = particleSize;
    showContoursRef.current = showContours;
    showStreamlinesRef.current = showStreamlines;
    streamlineColormapRef.current = streamlineColormap ?? colormap;

    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const meshRef = useRef<THREE.Mesh | null>(null);
    const planeGeoRef = useRef<THREE.PlaneGeometry | null>(null);
    const vertexMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
    const shaderMatRef = useRef<THREE.ShaderMaterial | null>(null);
    const texturesRef = useRef<FieldTextures | null>(null);
    const gridKeyRef = useRef("");
    const linesRef = useRef<THREE.Line[]>([]);
    const lineMatRef = useRef<THREE.LineBasicMaterial | null>(null);
    const pointsRef = useRef<THREE.Points | null>(null);
    const pGeoRef = useRef<THREE.BufferGeometry | null>(null);
    const psRef = useRef<ParticleSet | null>(null);
    const streamlinesRef = useRef<THREE.LineSegments | null>(null);
    const streamMatRef = useRef<THREE.LineBasicMaterial | null>(null);
    const streamKeyRef = useRef("");
    // Cache assumes each solve returns a new FlowField object (App solved memo guarantees it).
    const streamFlowRef = useRef<FlowField | null>(null);
    const speedMaxRef = useRef(1);
    const readyRef = useRef(false);
    // Fit to domain framing: the mount element is the measured box, and this
    // ref carries the fit closure from the mount effect to resize plus repaint.
    const fitCameraRef = useRef<((domain: Domain) => void) | null>(null);
    const domainKeyRef = useRef("");

    // Phase 5 render controls: visibility flags plus adaptive density.
    // pausedRef stays for the RAF guard below (tab hide plus offscreen).
    const pausedRef = useRef(false);
    const hiddenRef = useRef(false);
    const offscreenRef = useRef(false);
    const activeRef = useRef(PARTICLE_STEPS[0]);
    const tierRef = useRef(0);
    const lutRef = useRef<Uint8Array>(buildLut("viridis"));

    useImperativeHandle(ref, () => ({
        capturePng: () => {
            const renderer = rendererRef.current;
            const scene = sceneRef.current;
            const camera = cameraRef.current;
            if (!renderer || !scene || !camera) return Promise.resolve(null);
            // Render first, then toBlob in the same task so the drawing buffer
            // is still valid without needing preserveDrawingBuffer.
            renderer.render(scene, camera);
            const canvas = renderer.domElement;
            return new Promise<Blob | null>((resolve) => {
                canvas.toBlob((b) => resolve(b), "image/png");
            });
        },
    }), []);

    // Effect 2 helper: rebuild plane on grid change, repaint field, swap outline.
    const repaintRef = useRef(() => {});
    repaintRef.current = () => {
        const scene = sceneRef.current;
        const mesh = meshRef.current;
        let planeGeo = planeGeoRef.current;
        if (!scene || !mesh || !planeGeo || !readyRef.current) return;
        const f = flowRef.current;
        const cm = colormapRef.current;
        const variable = fieldModeRef.current;
        const meanOn = meanFieldsRef.current;
        // Poisoned frame guard: keep the last painted pixels instead of
        // smearing NaN colors or throwing inside the render loop.
        if (!fieldUsable(f)) {
            console.error("FlowCanvas: skipping repaint of non-finite field, holding last frame");
            return;
        }
        // Grid change: rebuild plane geometry in place, keyed on nx x ny.
        const gridKey = `${f.nx}x${f.ny}`;
        if (gridKeyRef.current !== gridKey) {
            const { domain } = f;
            const dw = domain.xMax - domain.xMin;
            const dh = domain.yMax - domain.yMin;
            const nextGeo = new THREE.PlaneGeometry(dw, dh, f.nx - 1, f.ny - 1);
            nextGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(nextGeo.getAttribute("position").count * 3), 3));
            mesh.geometry.dispose();
            mesh.geometry = nextGeo;
            planeGeoRef.current = nextGeo;
            planeGeo = nextGeo;
            gridKeyRef.current = gridKey;
            // Textures pack per cell, so a grid change forces recreation.
            if (texturesRef.current !== null) {
                disposeFieldTextures(texturesRef.current);
                texturesRef.current = null;
            }
        }
        // Domain change: refit the camera so the new extents frame fully.
        const dKey = `${f.domain.xMin}|${f.domain.xMax}|${f.domain.yMin}|${f.domain.yMax}`;
        if (domainKeyRef.current !== dKey) {
            domainKeyRef.current = dKey;
            try {
                fitCameraRef.current?.(f.domain);
            } catch {
                // Refit must never break repaint.
            }
        }
        lutRef.current = buildLut(cm);
        const sm = speedMaxOf(f);
        speedMaxRef.current = sm;
        mesh.visible = fieldVisibleRef.current;

        // Shader path with vertex color fallback.
        let shaderOk = false;
        if (useShaderRef.current) {
            try {
                const prev = texturesRef.current;
                const next = updateFieldTextures(prev, f, cm, variable, meanOn);
                texturesRef.current = next;
                let mat = shaderMatRef.current;
                if (mat === null) {
                    mat = createFieldShaderMaterial({
                        field: next.field,
                        lut: next.lut,
                        vMin: 0,
                        vMax: 1,
                        dimObstacle: 0.25,
                        showContours: showContoursRef.current,
                    });
                    shaderMatRef.current = mat;
                } else {
                    updateFieldShaderMaterial(mat, {
                        field: next.field,
                        lut: next.lut,
                        showContours: showContoursRef.current,
                    });
                }
                if (mesh.material !== mat) mesh.material = mat;
                shaderOk = true;
            } catch (e) {
                console.error("FlowCanvas: shader path failed, falling back to vertex colors", e instanceof Error ? e.message : String(e));
                shaderOk = false;
            }
        }
        if (!shaderOk) {
            if (vertexMatRef.current !== null && mesh.material !== vertexMatRef.current) {
                mesh.material = vertexMatRef.current;
            }
            const pos = planeGeo.getAttribute("position");
            const colorAttr = planeGeo.getAttribute("color") as THREE.BufferAttribute;
            const segX = f.nx;
            const segY = f.ny;
            const n = Math.min(pos.count, segX * segY);
            const { min, max } = variableRange(variable, f, meanOn);
            const span = max - min || 1;
            const kScale = variable === "k" ? kLogScaleFor(f) : null;
            for (let k = 0; k < n; k++) {
                const ix = k % segX;
                const iy = Math.floor(k / segX);
                const j = segY - 1 - iy;
                const idx = j * segX + ix;
                if (idx < 0 || idx >= f.nx * f.ny) continue;
                const q = readQuantity(variable, f, idx, meanOn);
                let t: number;
                if (variable === "k") {
                    t = kScale === null ? 0 : normalizeKLogValue(q, kScale);
                } else if (variable === "recirc") {
                    t = normalizeRecircValue(q);
                } else {
                    t = Math.min(1, Math.max(0, (q - min) / span));
                }
                const [r, g, b] = sampleColormap(cm, t);
                const dim = f.obstacle[idx] > 0.5 ? 0.25 : 1;
                colorAttr.setXYZ(k, ((r / 255) * dim), ((g / 255) * dim), ((b / 255) * dim));
            }
            colorAttr.needsUpdate = true;
        }

        // Outline color follows the lineColor prop.
        if (lineMatRef.current !== null) {
            try {
                lineMatRef.current.color.set(lineColorRef.current);
            } catch {
                // Invalid color strings keep the previous outline color.
            }
        }

        // Swap outlines: one line per polygon, dispose replaced line geometries only.
        const polys = toPolygons(airfoilRef.current);
        const lines = linesRef.current;
        while (lines.length < polys.length) {
            if (!lineMatRef.current || !scene) break;
            const line = new THREE.Line(new THREE.BufferGeometry(), lineMatRef.current);
            lines.push(line);
            scene.add(line);
        }
        while (lines.length > polys.length) {
            const extra = lines.pop();
            if (extra) {
                scene?.remove(extra);
                extra.geometry.dispose();
            }
        }
        polys.forEach((poly, i) => {
            const line = lines[i];
            if (!line) return;
            if (!polyUsable(poly)) return;
            const nextGeo = new THREE.BufferGeometry().setFromPoints(closedLinePts(poly));
            line.geometry.dispose();
            line.geometry = nextGeo;
        });

        rebuildStreamlines();

        // Single frame repaint for reduced motion, RAF loop covers the rest.
        if (rendererRef.current && sceneRef.current && cameraRef.current) {
            const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            if (reduced) rendererRef.current.render(sceneRef.current, cameraRef.current);
        }
    };

    // Streamline rebuild: runs only when the flow object, colormap, or
    // visibility changes, never per animation frame.
    const rebuildStreamlines = () => {
        const lines = streamlinesRef.current;
        if (!lines || !readyRef.current) return;
        const f = flowRef.current;
        const visible = showStreamlinesRef.current;
        const key = `${f.nx}x${f.ny}|${streamlineColormapRef.current}|${visible ? "on" : "off"}`;
        if (streamKeyRef.current === key && streamFlowRef.current === f) {
            lines.visible = visible;
            return;
        }
        if (!visible) {
            lines.visible = false;
            lines.geometry.dispose();
            lines.geometry = new THREE.BufferGeometry();
            lines.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
            lines.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
            streamKeyRef.current = key;
            streamFlowRef.current = f;
            return;
        }
        if (!fieldUsable(f)) {
            lines.geometry.dispose();
            lines.geometry = new THREE.BufferGeometry();
            lines.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
            lines.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
            lines.visible = false;
            return;
        }
        try {
            const built = buildStreamlines(f, { colormap: streamlineColormapRef.current, wakeHint: null });
            const nextGeo = new THREE.BufferGeometry();
            nextGeo.setAttribute("position", new THREE.BufferAttribute(built.positions, 3));
            nextGeo.setAttribute("color", new THREE.BufferAttribute(built.colors, 3));
            lines.geometry.dispose();
            lines.geometry = nextGeo;
            lines.visible = true;
            streamKeyRef.current = key;
            streamFlowRef.current = f;
        } catch (e) {
            console.error("FlowCanvas: streamline build failed", e instanceof Error ? e.message : String(e));
            lines.geometry.dispose();
            lines.geometry = new THREE.BufferGeometry();
            lines.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
            lines.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
            lines.visible = false;
        }
    };

    // Effect 1: scene plus particles, mounted once.
    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return;
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const f0 = flowRef.current;

        const w = mount.clientWidth || 800;
        const h0 = mount.clientHeight;
        const h = h0 > 100 ? h0 : Math.max(320, Math.min(560, Math.round(w * 0.55)));
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(w, h);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        mount.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const { domain } = f0;
        const dw = domain.xMax - domain.xMin;
        const dh = domain.yMax - domain.yMin;
        const scene = new THREE.Scene();
        sceneRef.current = scene;
        const camera = new THREE.OrthographicCamera(domain.xMin, domain.xMax, domain.yMax, domain.yMin, -10, 10);
        camera.position.z = 5;
        cameraRef.current = camera;
        // Frame the whole domain with a small margin at the live aspect, so
        // the full tunnel stays visible as rails collapse or the window moves.
        const fitCamera = (d: Domain): void => {
            const vw = mount.clientWidth || w;
            const vh = mount.clientHeight || h;
            const fit = fitDomainView(d, vw, vh);
            camera.left = fit.left;
            camera.right = fit.right;
            camera.top = fit.top;
            camera.bottom = fit.bottom;
            camera.updateProjectionMatrix();
        };
        fitCameraRef.current = fitCamera;
        fitCamera(f0.domain);
        domainKeyRef.current = `${f0.domain.xMin}|${f0.domain.xMax}|${f0.domain.yMin}|${f0.domain.yMax}`;

        const segX = f0.nx;
        const segY = f0.ny;
        gridKeyRef.current = `${segX}x${segY}`;
        const planeGeo = new THREE.PlaneGeometry(dw, dh, segX - 1, segY - 1);
        planeGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(planeGeo.getAttribute("position").count * 3), 3));
        planeGeoRef.current = planeGeo;
        const vertexMat = new THREE.MeshBasicMaterial({ vertexColors: true });
        vertexMatRef.current = vertexMat;
        const plane = new THREE.Mesh(planeGeo, vertexMat);
        plane.position.set((domain.xMin + domain.xMax) / 2, (domain.yMin + domain.yMax) / 2, -1);
        meshRef.current = plane;
        scene.add(plane);

        const lineMat = new THREE.LineBasicMaterial({ color: 0xf5f2e9 });
        lineMatRef.current = lineMat;
        for (const poly of toPolygons(airfoilRef.current)) {
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(closedLinePts(poly)), lineMat);
            linesRef.current.push(line);
            scene.add(line);
        }

        // Particles created once. Positions persist across field swaps.
        const COUNT = PARTICLE_STEPS[0];
        const ps = createParticles(COUNT, 20261026);
        psRef.current = ps;
        const respawnRand = mulberry32(20261027);
        const pGeo = new THREE.BufferGeometry();
        const pPos = new Float32Array(COUNT * 3);
        const pCol = new Float32Array(COUNT * 3);
        pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
        pGeo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
        pGeo.setDrawRange(0, COUNT);
        pGeoRef.current = pGeo;
        const pMat = new THREE.PointsMaterial({ size: particleSizeRef.current, vertexColors: true, transparent: true, opacity: 0.9, sizeAttenuation: true });
        const points = new THREE.Points(pGeo, pMat);
        pointsRef.current = points;
        points.position.z = 0.2;
        scene.add(points);

        // Streamline overlay, above the field plane, below particles.
        const streamMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
        streamMatRef.current = streamMat;
        const streamGeo = new THREE.BufferGeometry();
        streamGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
        streamGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
        const streamLines = new THREE.LineSegments(streamGeo, streamMat);
        streamLines.position.z = 0.05;
        streamLines.visible = showStreamlinesRef.current;
        streamlinesRef.current = streamLines;
        scene.add(streamLines);

        readyRef.current = true;
        repaintRef.current();

        // Hot loop painter with zero per frame allocation: inline bilinear
        // sampling plus a LUT lookup, reused attribute arrays only.
        const updatePoints = () => {
            const f = flowRef.current;
            const sm = speedMaxRef.current || 1;
            const invSm = 1 / sm;
            const store = psRef.current;
            const pg = pGeoRef.current;
            const lut = lutRef.current;
            if (!store || !pg) return;
            const active = activeRef.current;
            const posAttr = pg.getAttribute("position") as THREE.BufferAttribute;
            const colAttr = pg.getAttribute("color") as THREE.BufferAttribute;
            const arr = posAttr.array as Float32Array;
            const carr = colAttr.array as Float32Array;
            const fixed = particleRgb(particleColorRef.current);
            const fr = fixed !== null ? fixed[0] : 0;
            const fg = fixed !== null ? fixed[1] : 0;
            const fb = fixed !== null ? fixed[2] : 0;
            const nx = f.nx;
            const xMin = f.domain.xMin;
            const xMax = f.domain.xMax;
            const yMin = f.domain.yMin;
            const yMax = f.domain.yMax;
            const xRange = xMax - xMin;
            const yRange = yMax - yMin;
            const u = f.u;
            const v = f.v;
            const obs = f.obstacle;
            const nx1 = nx - 1;
            const ny1 = f.ny - 1;
            const inv255 = 1 / 255;
            for (let i = 0; i < active; i += 1) {
                const px = store.x[i];
                const py = store.y[i];
                const i3 = i * 3;
                arr[i3] = px;
                arr[i3 + 1] = py;
                arr[i3 + 2] = 0.1;
                if (fixed !== null) {
                    carr[i3] = fr;
                    carr[i3 + 1] = fg;
                    carr[i3 + 2] = fb;
                    continue;
                }
                let su = 0;
                let sv = 0;
                if (xRange > 0 && yRange > 0 && Number.isFinite(px) && Number.isFinite(py)) {
                    const fx = ((px - xMin) / xRange) * nx1;
                    const fy = ((py - yMin) / yRange) * ny1;
                    if (fx >= 0 && fy >= 0 && fx <= nx1 && fy <= ny1) {
                        let ix = Math.floor(fx);
                        if (ix > nx - 2) ix = nx - 2;
                        let jy = Math.floor(fy);
                        if (jy > f.ny - 2) jy = f.ny - 2;
                        let tx = fx - ix;
                        if (tx < 0) tx = 0;
                        else if (tx > 1) tx = 1;
                        let ty = fy - jy;
                        if (ty < 0) ty = 0;
                        else if (ty > 1) ty = 1;
                        const k00 = jy * nx + ix;
                        const k10 = k00 + 1;
                        const k01 = k00 + nx;
                        const k11 = k01 + 1;
                        const o00 = obs[k00];
                        const o10 = obs[k10];
                        const o01 = obs[k01];
                        const o11 = obs[k11];
                        const u00 = u[k00];
                        const u10 = u[k10];
                        const u01 = u[k01];
                        const u11 = u[k11];
                        const v00 = v[k00];
                        const v10 = v[k10];
                        const v01 = v[k01];
                        const v11 = v[k11];
                        const allOk = Number.isFinite(o00 + o10 + o01 + o11 + u00 + u10 + u01 + u11 + v00 + v10 + v01 + v11);
                        if (allOk && o00 <= 0.5 && o10 <= 0.5 && o01 <= 0.5 && o11 <= 0.5) {
                            const w00 = (1 - tx) * (1 - ty);
                            const w10 = tx * (1 - ty);
                            const w01 = (1 - tx) * ty;
                            const w11 = tx * ty;
                            su = u00 * w00 + u10 * w10 + u01 * w01 + u11 * w11;
                            sv = v00 * w00 + v10 * w10 + v01 * w01 + v11 * w11;
                        }
                    }
                }
                const sp = Math.sqrt(su * su + sv * sv);
                let t = sp * invSm;
                if (!(t >= 0)) t = 0;
                else if (t > 1) t = 1;
                const li = ((t * 255) | 0) * 3;
                carr[i3] = lut[li] * inv255;
                carr[i3 + 1] = lut[li + 1] * inv255;
                carr[i3 + 2] = lut[li + 2] * inv255;
            }
            posAttr.needsUpdate = true;
            colAttr.needsUpdate = true;
        };
        updatePoints();
        renderer.render(scene, camera);

        // Pause on tab hide or when the canvas scrolls offscreen.
        hiddenRef.current = document.hidden;
        const onVisibility = () => {
            hiddenRef.current = document.hidden;
        };
        document.addEventListener("visibilitychange", onVisibility);
        let observer: IntersectionObserver | null = null;
        if (typeof IntersectionObserver !== "undefined") {
            observer = new IntersectionObserver((entries) => {
                const first = entries[0];
                offscreenRef.current = first ? !first.isIntersecting : false;
            }, { threshold: 0 });
            observer.observe(mount);
        }

        let raf = 0;
        let last = performance.now();
        let fpsEma = 60;
        let slowFrames = 0;
        const tick = (now: number) => {
            const dtms = now - last;
            last = now;
            if (!pausedRef.current && !hiddenRef.current && !offscreenRef.current) {
                const dt = Math.min(0.033, dtms / 1000);
                const inst = dtms > 0 ? 1000 / dtms : 60;
                fpsEma = fpsEma * 0.95 + inst * 0.05;
                if (fpsEma < SLOW_FPS) {
                    slowFrames += 1;
                    if (slowFrames >= SLOW_FRAMES && tierRef.current < PARTICLE_STEPS.length - 1) {
                        tierRef.current += 1;
                        activeRef.current = PARTICLE_STEPS[tierRef.current];
                        const store = psRef.current;
                        if (store) store.count = activeRef.current;
                        const pg = pGeoRef.current;
                        if (pg) pg.setDrawRange(0, activeRef.current);
                        slowFrames = 0;
                    }
                } else {
                    slowFrames = 0;
                }
                const store = psRef.current;
                if (store) advectParticles(store, flowRef.current, dt, respawnRand);
                updatePoints();
                renderer.render(scene, camera);
            }
            raf = requestAnimationFrame(tick);
        };
        if (!reduced) raf = requestAnimationFrame(tick);

        // ResizeObserver keeps the canvas matched to its card on rail drags.
        // The mount sits inset zero in the tunnel, so rail collapse changes
        // its width directly and the observer fires without a window resize.
        const onResize = () => {
            const nw = mount.clientWidth || w;
            const availH = mount.clientHeight || 0;
            const targetH = availH > 100 ? availH : Math.max(320, Math.min(560, Math.round(nw * 0.55)));
            renderer.setSize(nw, targetH);
            try {
                fitCameraRef.current?.(flowRef.current.domain);
            } catch {
                // Refit must never break resize.
            }
        };
        let ro: ResizeObserver | null = null;
        if (typeof ResizeObserver !== "undefined") {
            ro = new ResizeObserver(() => onResize());
            ro.observe(mount);
        }
        window.addEventListener("resize", onResize);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("resize", onResize);
            if (ro) ro.disconnect();
            document.removeEventListener("visibilitychange", onVisibility);
            if (observer) observer.disconnect();
            readyRef.current = false;
            planeGeo.dispose();
            if (vertexMatRef.current) vertexMatRef.current.dispose();
            if (shaderMatRef.current) shaderMatRef.current.dispose();
            if (texturesRef.current) disposeFieldTextures(texturesRef.current);
            texturesRef.current = null;
            shaderMatRef.current = null;
            vertexMatRef.current = null;
            for (const line of linesRef.current) {
                line.geometry.dispose();
                scene.remove(line);
            }
            linesRef.current = [];
            lineMat.dispose();
            if (streamlinesRef.current) {
                streamlinesRef.current.geometry.dispose();
                scene.remove(streamlinesRef.current);
            }
            streamlinesRef.current = null;
            if (streamMatRef.current) streamMatRef.current.dispose();
            streamMatRef.current = null;
            streamKeyRef.current = "";
            streamFlowRef.current = null;
            pGeo.dispose();
            pMat.dispose();
            renderer.dispose();
            if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
            sceneRef.current = null;
            cameraRef.current = null;
            rendererRef.current = null;
            meshRef.current = null;
            planeGeoRef.current = null;
            linesRef.current = [];
            lineMatRef.current = null;
            pointsRef.current = null;
            pGeoRef.current = null;
            psRef.current = null;
        };
    }, []);

    // Effect 2: field colors plus line update on flow, airfoil, or display change.
    useEffect(() => {
        repaintRef.current();
    }, [flow, airfoil, colormap, fieldMode, meanFields, lineColor, fieldVisible, useShader, showContours, showStreamlines, streamlineColormap]);

    // Effect 3: particle density follows the display control.
    useEffect(() => {
        const next = Math.max(0, Math.min(PARTICLE_STEPS[0], Math.round(particleCount)));
        activeRef.current = next;
        tierRef.current = 0;
        const store = psRef.current;
        if (store) store.count = Math.min(next, store.x.length);
        const pg = pGeoRef.current;
        if (pg) pg.setDrawRange(0, Math.min(next, store?.x.length ?? next));
        const points = pointsRef.current;
        if (points) points.visible = next > 0;
    }, [particleCount]);

    // Effect 4: particle size follows the display control. Material only,
    // no geometry rebuild, so the field never repaints on a size change.
    useEffect(() => {
        const mat = pointsRef.current?.material as THREE.PointsMaterial | null | undefined;
        if (mat) {
            mat.size = particleSize;
            mat.needsUpdate = true;
        }
    }, [particleSize]);

    return <div ref={mountRef} className="flowcanvas" role="img" aria-label="Live particle flow canvas over analytic field" />;
});

export default FlowCanvas;
