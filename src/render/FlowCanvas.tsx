import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { FlowField } from "@/contracts/types";
import type { Point } from "@/geometry/parametric";
import { createParticles, advectParticles, sampleBilinear, mulberry32, type ParticleSet } from "./particles";
import { sampleColormap, type ColormapName } from "@/flow/colormap";

interface Props {
  flow: FlowField;
  airfoil: Point[] | Point[][];
  colormap?: ColormapName;
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

/**
 * FlowCanvas with split effects.
 * Effect 1 (mount once): renderer, scene, camera, plane shell, particle store,
 * RAF loop. Effect 2 (flow/airfoil/colormap): rewrite field vertex colors and
 * swap the outline line in place. Particle positions persist across field swaps.
 * Only replaced line geometry is disposed. Reduced motion renders one frame.
 */
export default function FlowCanvas({ flow, airfoil, colormap = "viridis" }: Props) {
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
    const COUNT = 3000;
    const ps = createParticles(COUNT, 20261026);
    psRef.current = ps;
    const respawnRand = mulberry32(20261027);
    const pGeo = new THREE.BufferGeometry();
    const pPos = new Float32Array(COUNT * 3);
    const pCol = new Float32Array(COUNT * 3);
    pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
    pGeoRef.current = pGeo;
    const pMat = new THREE.PointsMaterial({ size: 0.018, vertexColors: true, transparent: true, opacity: 0.9, sizeAttenuation: true });
    const points = new THREE.Points(pGeo, pMat);
    pointsRef.current = points;
    scene.add(points);

    readyRef.current = true;
    repaintRef.current();

    const updatePoints = () => {
      const f = flowRef.current;
      const cm = colormapRef.current;
      const sm = speedMaxRef.current || 1;
      const store = psRef.current;
      const pg = pGeoRef.current;
      if (!store || !pg) return;
      const posAttr = pg.getAttribute("position") as THREE.BufferAttribute;
      const colAttr = pg.getAttribute("color") as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      const carr = colAttr.array as Float32Array;
      for (let i = 0; i < store.count; i++) {
        arr[i * 3] = store.x[i];
        arr[i * 3 + 1] = store.y[i];
        arr[i * 3 + 2] = 0.1;
        const s = sampleBilinear(f, store.x[i], store.y[i]);
        const su = Number.isFinite(s.u) ? s.u : 0;
        const sv = Number.isFinite(s.v) ? s.v : 0;
        const speed = Math.sqrt(su * su + sv * sv);
        const t = Number.isFinite(speed) ? Math.min(1, speed / sm) : 0;
        const [r, g, b] = sampleColormap(cm, t);
        carr[i * 3] = r / 255;
        carr[i * 3 + 1] = g / 255;
        carr[i * 3 + 2] = b / 255;
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    };
    updatePoints();
    renderer.render(scene, camera);

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      const store = psRef.current;
      if (store) advectParticles(store, flowRef.current, dt, respawnRand);
      updatePoints();
      renderer.render(scene, camera);
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
}
