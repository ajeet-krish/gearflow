import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import type { FlowField } from "@/contracts/types";
import type { Point } from "@/geometry/parametric";
import { createParticles, advectParticles, mulberry32, type ParticleSet } from "./particles";
import { sampleColormap, buildLut, type ColormapName } from "@/flow/colormap";

interface Props {
    flow: FlowField;
    airfoil: Point[] | Point[][];
    colormap?: ColormapName;
}

export interface FlowCanvasHandle {
    capturePng(): Promise<Blob | null>;
    // Pause is visibility only: the RAF loop pauses on tab hide and when the
    // canvas scrolls offscreen. There is no manual pause control on purpose,
    // the field stays live while visible.
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
    for (let k = 0; k < n; k++) {
        if (!Number.isFinite(flow.u[k]) || !Number.isFinite(flow.v[k])) return false;
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
 * Effect 2 (flow/airfoil/colormap): rewrite field vertex colors and swap the
 * outline line in place. Particle positions persist across field swaps.
 * Only replaced line geometry is disposed. Reduced motion renders one frame.
 * The per frame particle painter inlines bilinear sampling and a LUT lookup
 * with reused arrays only, so the hot loop performs no allocations.
 */
const FlowCanvas = forwardRef<FlowCanvasHandle, Props>(function FlowCanvas({ flow, airfoil, colormap = "viridis" }, ref) {
    const mountRef = useRef<HTMLDivElement>(null);

    // Mutable render state owned by effect 1, read by effect 2.
    const flowRef = useRef(flow);
    const airfoilRef = useRef(airfoil);
    const colormapRef = useRef<ColormapName>(colormap);
    flowRef.current = flow;
    airfoilRef.current = airfoil;
    colormapRef.current = colormap;

    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const planeGeoRef = useRef<THREE.PlaneGeometry | null>(null);
    const linesRef = useRef<THREE.Line[]>([]);
    const lineMatRef = useRef<THREE.LineBasicMaterial | null>(null);
    const pointsRef = useRef<THREE.Points | null>(null);
    const pGeoRef = useRef<THREE.BufferGeometry | null>(null);
    const psRef = useRef<ParticleSet | null>(null);
    const speedMaxRef = useRef(1);
    const readyRef = useRef(false);

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

    // Effect 2 helper: repaint field colors plus swap outline.
    const repaintRef = useRef(() => {});
    repaintRef.current = () => {
        const scene = sceneRef.current;
        const planeGeo = planeGeoRef.current;
        if (!scene || !planeGeo || !readyRef.current) return;
        const f = flowRef.current;
        const cm = colormapRef.current;
        // Poisoned frame guard: keep the last painted pixels instead of
        // smearing NaN colors or throwing inside the render loop.
        if (!fieldUsable(f)) {
            console.error("FlowCanvas: skipping repaint of non-finite field, holding last frame");
            return;
        }
        lutRef.current = buildLut(cm);
        const sm = speedMaxOf(f);
        speedMaxRef.current = sm;
        const pos = planeGeo.getAttribute("position");
        const colorAttr = planeGeo.getAttribute("color") as THREE.BufferAttribute;
        const segX = f.nx;
        const segY = f.ny;
        const n = Math.min(pos.count, segX * segY);
        for (let k = 0; k < n; k++) {
            const ix = k % segX;
            const iy = Math.floor(k / segX);
            const j = segY - 1 - iy;
            const idx = j * segX + ix;
            if (idx < 0 || idx >= f.nx * f.ny) continue;
            const speed = Math.sqrt(f.u[idx] * f.u[idx] + f.v[idx] * f.v[idx]);
            const t = Math.min(1, speed / (sm || 1));
            const [r, g, b] = sampleColormap(cm, t);
            const dim = f.obstacle[idx] > 0.5 ? 0.25 : 1;
            colorAttr.setXYZ(k, ((r / 255) * dim), ((g / 255) * dim), ((b / 255) * dim));
        }
        colorAttr.needsUpdate = true;

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

        // Single frame repaint for reduced motion, RAF loop covers the rest.
        if (rendererRef.current && sceneRef.current && cameraRef.current) {
            const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            if (reduced) rendererRef.current.render(sceneRef.current, cameraRef.current);
        }
    };

    // Effect 1: scene plus particles, mounted once.
    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return;
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const f0 = flowRef.current;

        const w = mount.clientWidth || 800;
        const h = Math.max(320, Math.min(560, Math.round(w * 0.55)));
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

        const segX = f0.nx;
        const segY = f0.ny;
        const planeGeo = new THREE.PlaneGeometry(dw, dh, segX - 1, segY - 1);
        planeGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(planeGeo.getAttribute("position").count * 3), 3));
        planeGeoRef.current = planeGeo;
        const planeMat = new THREE.MeshBasicMaterial({ vertexColors: true });
        const plane = new THREE.Mesh(planeGeo, planeMat);
        plane.position.set((domain.xMin + domain.xMax) / 2, (domain.yMin + domain.yMax) / 2, -1);
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
        const pMat = new THREE.PointsMaterial({ size: 0.018, vertexColors: true, transparent: true, opacity: 0.9, sizeAttenuation: true });
        const points = new THREE.Points(pGeo, pMat);
        pointsRef.current = points;
        scene.add(points);

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

        const onResize = () => {
            const nw = mount.clientWidth || w;
            const nh = Math.max(320, Math.min(560, Math.round(nw * 0.55)));
            renderer.setSize(nw, nh);
        };
        window.addEventListener("resize", onResize);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("resize", onResize);
            document.removeEventListener("visibilitychange", onVisibility);
            if (observer) observer.disconnect();
            readyRef.current = false;
            planeGeo.dispose();
            planeMat.dispose();
            for (const line of linesRef.current) {
                line.geometry.dispose();
                scene.remove(line);
            }
            linesRef.current = [];
            lineMat.dispose();
            pGeo.dispose();
            pMat.dispose();
            renderer.dispose();
            if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
            sceneRef.current = null;
            cameraRef.current = null;
            rendererRef.current = null;
            planeGeoRef.current = null;
            linesRef.current = [];
            lineMatRef.current = null;
            pointsRef.current = null;
            pGeoRef.current = null;
            psRef.current = null;
        };
    }, []);

    // Effect 2: field colors plus line update on flow or airfoil change.
    useEffect(() => {
        repaintRef.current();
    }, [flow, airfoil, colormap]);

    return <div ref={mountRef} className="flowcanvas" role="img" aria-label="Live particle flow canvas over analytic field" />;
});

export default FlowCanvas;
