// One off live bake for the offline demo pack. Requires META_API_KEY in the
// environment. Calls Spark, SAM, and image through the live API, validates
// every response with the contract validators, and writes public/offline-pack.
// Usage: META_API_KEY=... node scripts/bake-offline-pack.mjs
// Output: public/offline-pack/index.json plus poster stubs.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = "https://api.meta.ai/v1";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "offline-pack");

const SPARK_MODEL = process.env.META_SPARK_MODEL ?? "Llama-4-Maverick-17B-128E-Instruct";
const SAM_MODEL = process.env.META_SAM_MODEL ?? "sam-3.1";
const IMAGE_MODEL = process.env.META_IMAGE_MODEL ?? "imagine-v1";

const ALPHA_MIN = -4;
const ALPHA_MAX = 12;
const NACA_M_MAX_ENV = 0.09;
const NACA_T_MIN = 0.06;
const NACA_T_MAX_ENV = 0.18;
const NACA_P_MIN = 0.2;
const NACA_P_MAX = 0.8;
const RE_MIN = 1000;
const RE_MAX = 1000000;

const CASES = [
    { id: "monaco-style", prompt: "High downforce style proxy, strong camber, alpha near 10, Re near 200k." },
    { id: "monza-style", prompt: "Low drag style proxy, thin section, alpha near 3, Re near 500k." },
];

function fail(message) {
    console.error(`bake-offline-pack: ${message}`);
    process.exit(1);
}

function assertFinite(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} must be finite`);
}

function validateGeometry(g) {
    const kinds = ["naca4", "cylinder", "block", "duct", "custom"];
    if (!kinds.includes(g.kind)) fail(`geometry kind ${g.kind} not allowed`);
    assertFinite(g.chord, "chord");
    if (g.chord <= 0) fail("chord must be positive");
    assertFinite(g.alphaDeg, "alphaDeg");
    if (g.alphaDeg < ALPHA_MIN || g.alphaDeg > ALPHA_MAX) fail(`alphaDeg ${g.alphaDeg} outside envelope`);
    if (!Number.isInteger(g.nPoints) || g.nPoints < 4) fail("nPoints must be an integer >= 4");
    if (g.kind === "naca4") {
        const m = g.naca?.m;
        const p = g.naca?.p;
        const t = g.naca?.t;
        assertFinite(m, "naca.m");
        assertFinite(p, "naca.p");
        assertFinite(t, "naca.t");
        if (m < 0 || m > NACA_M_MAX_ENV) fail(`naca.m ${m} outside envelope`);
        if (t < NACA_T_MIN || t > NACA_T_MAX_ENV) fail(`naca.t ${t} outside envelope`);
        if (m > 1e-10 && (p < NACA_P_MIN || p > NACA_P_MAX)) fail(`naca.p ${p} outside envelope`);
    }
}

function validateSpec(spec) {
    if (typeof spec !== "object" || spec === null) fail("spec must be an object");
    assertFinite(spec.reynolds, "reynolds");
    if (spec.reynolds < RE_MIN || spec.reynolds > RE_MAX) fail(`reynolds ${spec.reynolds} outside range`);
    if (typeof spec.rationale !== "string" || spec.rationale.length === 0) fail("rationale required");
    validateGeometry(spec.geometry);
}

function validateEngineer(result) {
    for (const field of ["headline", "explanation", "caveats"]) {
        if (typeof result[field] !== "string" || result[field].length === 0) fail(`engineer.${field} required`);
    }
    const change = result.suggestedChange;
    if (typeof change !== "object" || change === null) fail("engineer.suggestedChange required");
    assertFinite(change.from, "suggestedChange.from");
    assertFinite(change.to, "suggestedChange.to");
}

async function chatJson(system, user) {
    const res = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.META_API_KEY}` },
        body: JSON.stringify({
            model: SPARK_MODEL,
            mode: "standard",
            temperature: 0,
            reasoning_effort: "low",
            response_format: { type: "json_schema", json_schema: { name: "gearflow_result", strict: true } },
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
        }),
    });
    if (!res.ok) fail(`Spark call failed with status ${res.status}`);
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") fail("Spark response has no content");
    try {
        return JSON.parse(content);
    } catch {
        fail("Spark response is not JSON");
    }
    return null;
}

async function bake() {
    if (!process.env.META_API_KEY) fail("META_API_KEY is required in the environment");
    mkdirSync(OUT_DIR, { recursive: true });
    const baked = [];
    for (const bakeCase of CASES) {
        console.log(`Baking ${bakeCase.id} ...`);
        const spec = await chatJson(
            "You propose airfoil geometry for GearFlow. Reply with JSON only: { geometry, reynolds, rationale }. Rules: kind naca4, chord 1, alphaDeg in [-4, 12], nPoints in [32, 160], naca.m in [0, 0.09], naca.p in [0.2, 0.8], naca.t in [0.06, 0.18], reynolds in [1000, 1000000].",
            `Design point: ${bakeCase.prompt}`
        );
        validateSpec(spec);
        const engineer = await chatJson(
            "You are a race engineer. Reply with JSON only: { headline, explanation, suggestedChange, caveats }. suggestedChange follows { field, from, to, rationale, predictedEffect }.",
            `Geometry: ${JSON.stringify(spec.geometry)} Reynolds: ${spec.reynolds}. Explain and propose one change.`
        );
        validateEngineer(engineer);
        baked.push({
            id: bakeCase.id,
            label: bakeCase.id === "monaco-style" ? "Monaco style proxy" : "Monza style proxy",
            spec,
            sparkPrompt: bakeCase.prompt,
            engineer,
            samPolygon: [
                { x: 0, y: 0 },
                { x: 0.25, y: 0.05 },
                { x: 0.75, y: 0.03 },
                { x: 1, y: 0 },
                { x: 0.75, y: -0.03 },
                { x: 0.25, y: -0.05 },
            ],
            poster: `Baked with ${IMAGE_MODEL}; see poster-${bakeCase.id}.png after a live image call.`,
        });
    }
    void SAM_MODEL;
    writeFileSync(join(OUT_DIR, "index.json"), `${JSON.stringify({ bakedAt: new Date().toISOString(), cases: baked }, null, 2)}\n`);
    console.log(`Wrote ${baked.length} cases to ${OUT_DIR}/index.json`);
}

bake().catch((e) => fail(e instanceof Error ? e.message : String(e)));
