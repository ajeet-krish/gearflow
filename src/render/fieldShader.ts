// GPU field shader path. The vertex stage passes UV through; the fragment
// stage samples the packed field texture (R is u, G is v, B is the selected
// quantity, A is obstacle), normalizes B by the vMin/vMax uniforms, looks up
// the 256x1 LUT texture, dims obstacle cells, and optionally draws contour
// lines. Falls back to vertex colors when shaders are unavailable.

import * as THREE from "three";

export const FIELD_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const FIELD_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;
varying vec2 vUv;
uniform sampler2D tField;
uniform sampler2D tLut;
uniform float vMin;
uniform float vMax;
uniform float dimObstacle;
uniform float showContours;
uniform float contourCount;
void main() {
    vec4 packed = texture2D(tField, vUv);
    float span = max(vMax - vMin, 1e-9);
    float t = clamp((packed.b - vMin) / span, 0.0, 1.0);
    vec3 color = texture2D(tLut, vec2(t, 0.5)).rgb;
    if (packed.a > 0.5) {
        color *= dimObstacle;
    }
    if (showContours > 0.5) {
        float lines = abs(fract(t * contourCount) - 0.5);
        float edge = fwidth(t * contourCount);
        float line = 1.0 - smoothstep(0.0, max(edge, 1e-3) * 1.5, 0.5 - lines);
        color = mix(color, vec3(1.0), line * 0.25);
    }
    gl_FragColor = vec4(color, 1.0);
}
`;

export interface FieldShaderOptions {
    field: THREE.DataTexture;
    lut: THREE.DataTexture;
    vMin: number;
    vMax: number;
    dimObstacle?: number;
    showContours?: boolean;
    contourCount?: number;
}

const DEFAULT_DIM_OBSTACLE = 0.25;
const DEFAULT_CONTOUR_COUNT = 12;
const MIN_CONTOUR_COUNT = 1;
const MAX_CONTOUR_COUNT = 64;

function requireFiniteRange(value: number, name: string): number {
    if (!Number.isFinite(value)) {
        throw new Error(`fieldShader: ${name} must be finite, got ${String(value)}`);
    }
    return value;
}

/** Clamp obstacle dimming into [0, 1]. Non-finite input falls back to default. */
function sanitizeDimObstacle(value: number | undefined): number {
    if (value === undefined) return DEFAULT_DIM_OBSTACLE;
    if (!Number.isFinite(value)) return DEFAULT_DIM_OBSTACLE;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

/** Clamp contour count into [1, 64] as an integer. Non-finite input falls back to default. */
function sanitizeContourCount(value: number | undefined): number {
    if (value === undefined) return DEFAULT_CONTOUR_COUNT;
    if (!Number.isFinite(value)) return DEFAULT_CONTOUR_COUNT;
    const rounded = Math.round(value);
    if (rounded < MIN_CONTOUR_COUNT) return MIN_CONTOUR_COUNT;
    if (rounded > MAX_CONTOUR_COUNT) return MAX_CONTOUR_COUNT;
    return rounded;
}

/** Build the field ShaderMaterial. Caller owns disposal via material.dispose().
 * Rejects non-finite vMin/vMax by throwing so a direct caller can never
 * silently blank the field with NaN or Infinity uniforms. dimObstacle is
 * clamped to [0, 1] and contourCount to [1, 64], with non-finite values
 * falling back to defaults. */
export function createFieldShaderMaterial(opts: FieldShaderOptions): THREE.ShaderMaterial {
    requireFiniteRange(opts.vMin, "vMin");
    requireFiniteRange(opts.vMax, "vMax");
    return new THREE.ShaderMaterial({
        vertexShader: FIELD_VERTEX_SHADER,
        fragmentShader: FIELD_FRAGMENT_SHADER,
        uniforms: {
            tField: { value: opts.field },
            tLut: { value: opts.lut },
            vMin: { value: opts.vMin },
            vMax: { value: opts.vMax },
            dimObstacle: { value: sanitizeDimObstacle(opts.dimObstacle) },
            showContours: { value: opts.showContours === true ? 1 : 0 },
            contourCount: { value: sanitizeContourCount(opts.contourCount) },
        },
    });
}

/** Push fresh ranges and texture handles into a live shader material.
 * Non-finite vMin/vMax updates are ignored so the material holds the last
 * good frame instead of blanking the field. Non-finite dimObstacle and
 * contourCount updates are likewise ignored; finite values are clamped
 * (dimObstacle to [0, 1], contourCount to [1, 64]). */
export function updateFieldShaderMaterial(
    material: THREE.ShaderMaterial,
    opts: Partial<FieldShaderOptions>
): void {
    const u = material.uniforms as Record<string, { value: unknown }>;
    if (opts.field !== undefined) u.tField.value = opts.field;
    if (opts.lut !== undefined) u.tLut.value = opts.lut;
    if (opts.vMin !== undefined && Number.isFinite(opts.vMin)) u.vMin.value = opts.vMin;
    if (opts.vMax !== undefined && Number.isFinite(opts.vMax)) u.vMax.value = opts.vMax;
    if (opts.dimObstacle !== undefined) {
        if (Number.isFinite(opts.dimObstacle)) {
            u.dimObstacle.value = sanitizeDimObstacle(opts.dimObstacle);
        }
    }
    if (opts.showContours !== undefined) u.showContours.value = opts.showContours ? 1 : 0;
    if (opts.contourCount !== undefined) {
        if (Number.isFinite(opts.contourCount)) {
            u.contourCount.value = sanitizeContourCount(opts.contourCount);
        }
    }
}
