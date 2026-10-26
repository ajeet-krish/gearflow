import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { FlowField } from "@/contracts/types";
import type { Point } from "@/geometry/parametric";
import { createParticles, advectParticles, sampleBilinear, mulberry32 } from "./particles";
import { sampleColormap } from "@/flow/colormap";

interface Props {
  flow: FlowField;
  airfoil: Point[];
  colormap?: "viridis" | "jet" | "rdbu" | "coolwarm";
}

/**
 * FlowCanvas: plane with speed tint + airfoil outline + 3000 speed colored points.
 * RAF loop, respects prefers-reduced-motion by rendering one static frame.
 * Phase 1 uses CPU vertex colors (no GPU field/LUT textures on this path).
 */
export default function FlowCanvas({ flow, airfoil, colormap = "viridis" }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const w = mount.clientWidth || 800;
    const h = Math.max(320, Math.min(560, Math.round(w * 0.55)));
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const { domain } = flow;
    const dw = domain.xMax - domain.xMin;
    const dh = domain.yMax - domain.yMin;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(domain.xMin, domain.xMax, domain.yMax, domain.yMin, -10, 10);
    camera.position.z = 5;

    // Local speedMax (CPU path does not create GPU field/LUT textures, so none leak).
    let speedMax = 1e-6;
    for (let k = 0; k < flow.nx * flow.ny; k++) {
      const s = Math.sqrt(flow.u[k] * flow.u[k] + flow.v[k] * flow.v[k]);
      if (s > speedMax) speedMax = s;
    }

    // Field plane: keep PlaneGeometry local centred coords, position mesh at
    // domain centre so world bounds equal flow.domain (no double offset).
    const segX = flow.nx;
    const segY = flow.ny;
    const planeGeo = new THREE.PlaneGeometry(dw, dh, segX - 1, segY - 1);
    const pos = planeGeo.getAttribute("position");
    const colors = new Float32Array(pos.count * 3);
    for (let k = 0; k < pos.count; k++) {
      const ix = k % segX;
      const iy = Math.floor(k / segX);
      // PlaneGeometry starts at top row; map to flow j=0 bottom
      const j = segY - 1 - iy;
      const idx = j * segX + ix;
      const speed = Math.sqrt(flow.u[idx] * flow.u[idx] + flow.v[idx] * flow.v[idx]);
      const t = Math.min(1, speed / (speedMax || 1));
      const [r, g, b] = sampleColormap(colormap, t);
      const dim = flow.obstacle[idx] > 0.5 ? 0.25 : 1;
      colors[k * 3] = (r / 255) * dim;
      colors[k * 3 + 1] = (g / 255) * dim;
      colors[k * 3 + 2] = (b / 255) * dim;
    }
    planeGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const planeMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    const plane = new THREE.Mesh(planeGeo, planeMat);
    plane.position.set((domain.xMin + domain.xMax) / 2, (domain.yMin + domain.yMax) / 2, -1);
    scene.add(plane);
    plane.updateMatrixWorld(true);
    {
      const box = new THREE.Box3().setFromObject(plane);
      const eps = 1e-6;
      const aligned =
        Math.abs(box.min.x - domain.xMin) < eps &&
        Math.abs(box.max.x - domain.xMax) < eps &&
        Math.abs(box.min.y - domain.yMin) < eps &&
        Math.abs(box.max.y - domain.yMax) < eps;
      if (!aligned) {
        console.warn("FlowCanvas plane world bounds differ from flow.domain", box.min, box.max, domain);
      }
    }

    // Airfoil outline
    const linePts = airfoil.map((p) => new THREE.Vector3(p.x, p.y, 0));
    if (linePts.length > 0) linePts.push(new THREE.Vector3(airfoil[0].x, airfoil[0].y, 0));
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xf5f2e9 });
    const line = new THREE.Line(lineGeo, lineMat);
    scene.add(line);

    // Particles as points, speed colored
    const COUNT = 3000;
    const ps = createParticles(COUNT, 20261026);
    const respawnRand = mulberry32(20261027);
    const pGeo = new THREE.BufferGeometry();
    const pPos = new Float32Array(COUNT * 3);
    const pCol = new Float32Array(COUNT * 3);
    pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
    const pMat = new THREE.PointsMaterial({ size: 0.018, vertexColors: true, transparent: true, opacity: 0.9, sizeAttenuation: true });
    const points = new THREE.Points(pGeo, pMat);
    scene.add(points);

    const updatePoints = () => {
      for (let i = 0; i < COUNT; i++) {
        pPos[i * 3] = ps.x[i];
        pPos[i * 3 + 1] = ps.y[i];
        pPos[i * 3 + 2] = 0.1;
        const s = sampleBilinear(flow, ps.x[i], ps.y[i]);
        const speed = Math.sqrt(s.u * s.u + s.v * s.v);
        const [r, g, b] = sampleColormap(colormap, Math.min(1, speed / (speedMax || 1)));
        pCol[i * 3] = r / 255;
        pCol[i * 3 + 1] = g / 255;
        pCol[i * 3 + 2] = b / 255;
      }
      (pGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      (pGeo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    };
    updatePoints();
    renderer.render(scene, camera);

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      advectParticles(ps, flow, dt, respawnRand);
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
      planeGeo.dispose();
      planeMat.dispose();
      lineGeo.dispose();
      lineMat.dispose();
      pGeo.dispose();
      pMat.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [flow, airfoil, colormap]);

  return <div ref={mountRef} className="flowcanvas" role="img" aria-label="Live particle flow canvas over fixture field" />;
}
