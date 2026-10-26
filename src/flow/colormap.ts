// Colormaps for GearFlow. Viridis is default. Jet, RdBu, Coolwarm available.
// Adapted from AK-Vortex colormap.ts conventions (jet for velocity, diverging for signed fields).

export type RGB = [number, number, number];
export type ColormapName = "viridis" | "jet" | "rdbu" | "coolwarm";

/** Viridis approx via sampled stops. t in [0,1]. */
export function viridisColormap(t: number): RGB {
  const tt = Math.max(0, Math.min(1, t));
  const stops: RGB[] = [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ];
  const pos = tt * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function jetColormap(t: number): RGB {
  const tt = Math.max(0, Math.min(1, t));
  let r: number, g: number, b: number;
  if (tt < 0.125) { r = 0; g = 0; b = 0.5 + tt * 4; }
  else if (tt < 0.375) { r = 0; g = (tt - 0.125) * 4; b = 1; }
  else if (tt < 0.625) { r = (tt - 0.375) * 4; g = 1; b = 1 - (tt - 0.375) * 4; }
  else if (tt < 0.875) { r = 1; g = 1 - (tt - 0.625) * 4; b = 0; }
  else { r = 1 - (tt - 0.875) * 4; g = 0; b = 0; }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function rdbuColormap(t: number): RGB {
  const tt = Math.max(0, Math.min(1, t));
  let r: number, g: number, b: number;
  if (tt < 0.5) {
    const s = tt / 0.5;
    r = 0.3 + s * 0.7; g = 0.3 + s * 0.7; b = 1;
  } else {
    const s = (tt - 0.5) / 0.5;
    r = 1; g = 1 - s * 0.7; b = 1 - s * 0.7;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function coolwarmColormap(t: number): RGB {
  const tt = Math.max(0, Math.min(1, t));
  const r = Math.round(59 + tt * (180 - 59));
  const g = Math.round(76 + Math.sin(tt * Math.PI) * 120);
  const b = Math.round(192 - tt * (192 - 110));
  return [r, Math.max(0, Math.min(255, g)), b];
}

export function sampleColormap(name: ColormapName, t: number): RGB {
  switch (name) {
    case "jet": return jetColormap(t);
    case "rdbu": return rdbuColormap(t);
    case "coolwarm": return coolwarmColormap(t);
    case "viridis":
    default: return viridisColormap(t);
  }
}

/** Build a 256 entry LUT for fast texture or particle coloring. */
export function buildLut(name: ColormapName, size = 256): Uint8Array {
  const lut = new Uint8Array(size * 3);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = sampleColormap(name, i / (size - 1));
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}
