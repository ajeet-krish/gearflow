# Reviews
Placeholder for reviewer notes. Append only.

## Format
* Date:
* Reviewer:
* Scope:
* Findings:
* Actions:

## 2026-10-26 - Phase 1: Contracts and Skeleton Review

Date: 2026-10-26
Reviewer: code-reviewer
Scope: Phase 1 contracts and skeleton (src/contracts, src/geometry, src/flow, src/render, src/meta, scripts/generate-fixtures.mjs and tests)
Verdict: FAIL

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Critical | src/render/FlowCanvas.tsx:63,68 | Field plane vertices set to absolute domain coords then mesh offset by domain centre, double offset shifts field +0.75 in x vs airfoil/particles | backend-dev/frontend-dev: use local centred coords or zero plane position, add alignment test |
| Critical | src/render/fieldTexture.ts:26-27 | u,v packing compresses range: (u/range)*0.5+0.5 with range=2*speedMax gives 0.25..0.75 not 0..1 | backend-dev: use u/(2*speedMax)+0.5, hoist range, add round-trip test |
| Major | src/render/FlowCanvas.tsx:41-42 and src/render/fieldTexture.ts:14-50 | DataTexture/LUT created, voided, unused, never disposed; comment claims GPU LUT but rendering is CPU vertex colours | frontend-dev: wire shader or remove textures, dispose textures/materials in cleanup (FlowCanvas.tsx:126-134) |
| Major | src/flow/fakeFlow.ts:35-40,78 | obstaclePolygon() regenerated per grid cell (16384x per field) | backend-dev: hoist polygon once like scripts/generate-fixtures.mjs:98 |
| Major | src/flow/fakeFlow.ts:93 vs scripts/generate-fixtures.mjs:112 | v-phase seed diverges (full hashSeed vs seedKey hash) so TS flow != generated fixtures; duplicated NACA/flow logic in script lines 10-119 | backend-dev: single shared impl or sync + parity test |
| Major | src/geometry/parametric.ts:51-60 applied at fakeFlow.ts:30 | Positive alpha rotates TE up (CCW about LE), likely negative AoA in y-up aero convention, untested | backend-dev: verify vs AK-Vortex, fix sign or document, add transform test at (1,0) |
| Major | src/geometry/parametric.ts:13,78-84,87 | No input validation: nPoints<2 div-zero, p=0 with m>0 silently zero camber, unrealistic codes like 9999, chord=0 div-zero in sdf | backend-dev: validate ranges, throw specific errors, add tests |
| Major | (missing tests) src/geometry/parametric.test.ts:4-36, src/flow/fakeFlow.test.ts:5-23 | No direct tests for closed TE (yt(1)=0, TE coincidence), SDF sign/zero, pointInPolygon, transform, bilinear, advection, DataTexture | tester: add tests |
| Minor | src/render/particles.ts:37-54,56,69 | Bilinear returns zero at last row/col edges, Math.random default respawn breaks determinism, Euler step in FlowCanvas.tsx:113 can tunnel thin TE | backend-dev: clamp indices, inject seeded rand, substep |
| Minor | src/meta/fixtures.ts:30-34 | Loader does not check flow nx/ny/domain matches pack.grid or validate airfoilPoints | backend-dev: cross-check and validate points |
| Minor | scripts/generate-fixtures.mjs:143 | File named 128x64 contains 128x128 flow | backend-dev: remove or rename alias |
| Minor | all src/*.ts(x) e.g. parametric.ts:14-18 | 2-space indent vs required 4-space convention | backend-dev: reformat |
| Minor | src/contracts/types.ts:4, schema.ts | duct kind has no obstacleMask handling (fakeFlow.ts:35-55 returns false); JSON schemas unused at runtime and validateDemoPack (schema.ts:64-73) checks far less than demopack.schema.json | backend-dev: implement or remove duct, align validators |

Note recurring pattern: duplicated fixture logic drifts, untested geometry/render mapping.

## 2026-10-26 - Phase 1: Re-review After Fixes

Date: 2026-10-26
Reviewer: code-reviewer
Scope: Phase 1 re-review of prior FAIL fixes (src/render/FlowCanvas.tsx, src/render/fieldTexture.ts, src/render/particles.ts, src/flow/fakeFlow.ts, src/geometry/parametric.ts, src/contracts/schema.ts, src/meta/fixtures.ts, scripts/generate-fixtures.mjs, tests, public/demo-pack fixtures)
Verdict: PASS

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Minor | src/render/fieldTexture.ts:1-2 | Stale header claims LUT is applied on GPU via shader, but no ShaderMaterial exists and createFieldTextures is only imported by its test, not production code | frontend-dev: correct header to say packing utility for a future shader path, or wire it in Phase 2 |
| Minor | src/render/particles.test.ts:46-59 | Substep test uses uniform flow with no obstacle, so it cannot detect TE tunneling regression (assertions pass even for a single Euler hop) | tester: add a thin obstacle strip fixture and assert the particle respawns or stops inside it |
| Minor | src/render/FlowCanvas.tsx:8-12, src/render/particles.ts:6-10, src/contracts/types.ts:6-15 | 4-space indent still not applied in several pre-existing files (2-space remains), deferred per fix note | backend-dev/frontend-dev: run a formatter pass in a separate chore commit |

Note recurring pattern: none new. Prior critical and major findings (plane offset, texture packing range, dead textures in canvas, per-cell polygon, TS/script seed drift, alpha sign, validation, duct mask, 128x64 alias) all verified fixed in source and guarded by tests (fixtures.parity.test.ts, fieldTexture.test.ts, particles.test.ts, parametric.test.ts, fakeFlow.test.ts, schema.test.ts). Tests were inspected, not executed, in this review session (no shell tool available to the reviewer).

## 2026-10-26 - Phase 1: Security Review

Date: 2026-10-26
Reviewer: security-engineer (05)
Scope: Phase 1 of 5, static Vite shell, fixture JSON only, Three.js canvas (src/meta/fixtures.ts, src/contracts/schema.ts, src/render/particles.ts, src/render/fieldTexture.ts, src/render/FlowCanvas.tsx, src/App.tsx, .env.example, .gitignore)
Verdict: FAIL

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Medium | src/meta/fixtures.ts:22-24, src/contracts/schema.ts:128-130 | Fetch path traversal: pack.files.geometry/flow only checked non-empty, then interpolated into fetch URL. Values containing ../, leading /, backslash, or URL schemes can escape /demo-pack/ on the origin. | backend-dev: allowlist ^(geometry\|flow)/[A-Za-z0-9._-]+[.]json$, reject .., /, backslash and schemes, or resolve URL and require pathname starts with baseUrl + /. Add traversal tests in schema.test.ts. |
| Medium | src/contracts/schema.ts:67-68,24-25,134-145, src/render/fieldTexture.ts:16-18, src/flow/fakeFlow.ts:100-105 | No upper bounds on nx, ny, nPoints, or airfoil point count. Crafted manifest/flow can force nx*ny typed-array, texture, and PlaneGeometry allocations and exhaust browser memory (DoS). Committed 128x128 fixtures are safe. | backend-dev: cap nx, ny (for example each <= 512 and nx*ny <= 262144), cap nPoints and airfoilPoints length, enforce caps before allocation in coerceFlowField and createFieldTextures. |
| Medium | src/contracts/schema.ts:78-96,161-188, src/render/particles.ts:40-58 | Flow channel elements are not checked for finiteness. JSON numbers such as 1e999 parse to Infinity, strings coerce to NaN in Float32Array, then NaN/Infinity poisons speedMax, bilinear sampling, and particles permanently. | backend-dev: validate every channel element with Number.isFinite during coerceFlowField (before or after conversion, reject non-number), and make sampleBilinear return inside:false for non-finite px, py, or sampled values. |
| Low | .env.example:2-3, .gitignore:9-10 | VITE_META_API_KEY would be embedded in the client bundle if set (all VITE_ vars are public), and .gitignore covers .env and .env.local but not .env.production or other .env.* files. No real key is committed. | backend-dev/tech-lead: never put a real Meta secret in a VITE_ var in Phase 4, use a server proxy, rename to a public-only name if truly public, and change .gitignore to .env.* with !.env.example. |
| Low | src/meta/fixtures.ts:28-35 | Geometry fixture file is not validated as a whole: only points are extracted and checked, geomJson.geometry is ignored and unbounded in length, so a geometry file can silently diverge from the validated manifest geometry. | backend-dev: run validateGeometrySpec on geomJson.geometry, require it matches pack.geometry, and cap points length (see grid cap fix). |
| Low | src/App.tsx:37, src/meta/fixtures.ts:17,26-27 | Error messages echo baseUrl and pack file paths to the page. React escapes them (no XSS), but path disclosure should stay minimal once remote packs arrive. | frontend-dev: show a generic fixture load failure in UI and keep detailed paths in console only. |

Checks: memory safety (bilinear indices) PASS, Float32Array bounds PASS with DoS and finiteness caveats above, JSON input validation FAIL (no caps, no finite elements, geometry file not fully validated), manifest path traversal FAIL, XSS PASS (no dangerouslySetInnerHTML, React text rendering in App.tsx:31,37,41-42 escapes fixture strings), secrets PASS for Phase 1 (no keys in src, .env.example:3 empty) with Low Phase 4 advisory above, shell/code injection PASS (no eval, exec, system, popen, or subprocess in src).

Note recurring pattern: validators check shape and exact lengths but not magnitude caps or element finiteness. Fix both before Phase 2 accepts surrogate, LBM, or remote pack data.
