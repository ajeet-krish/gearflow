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

## 2026-10-26 - Phase 2: Geometry and Analytic Flow Review

Date: 2026-10-26
Reviewer: code-reviewer
Scope: Phase 2 of 5 geometry plus analytic flow (src/flow/potential.ts, src/flow/sdf.ts, src/flow/wake.ts, src/flow/analyticFlow.ts, src/flow/frameSource.ts, src/geometry/parametric.ts, src/ui/FlowControls.tsx, src/App.tsx, src/render/FlowCanvas.tsx, tests)
Verdict: FAIL

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Major | src/flow/analyticFlow.ts:59-60, src/flow/potential.ts:212-240 | Multi-body and blunt bodies forced through single-body Hess-Smith solve: all polygons flatMapped into one solve with one global gamma and one Kutta equation pairing panels[0] with panels[n-1]. For duct those are unrelated upper and lower wall panels; for cylinder and block there is no TE Kutta condition. Spurious circulation and lift risk. | backend-dev: solve per body (gamma per body, Kutta only for naca4 TE pair, gamma=0 or no Kutta row for blunt bodies), or restrict solvePanels contract and add duct, block, cylinder gamma and Cl regression tests. |
| Major | src/App.tsx:71-81, src/flow/frameSource.ts:85-89 | App defeats provider Re caching: every debounced memo calls setGeometry (unconditionally sets panelsDirty) before setRe, so Re-only slider changes re-resolve panels despite comments at App.tsx:43-44 and frameSource.ts:25-27. Provider unit test uses setRe alone and misses this wiring. | backend-dev/frontend-dev: make setGeometry value-compare (deep for naca and center) or have App diff geometry versus Re and only call setters that changed; add App or provider sequence test asserting solveCount unchanged on Re-only update via the App call order. |
| Major | src/App.tsx:82-83,97, src/render/FlowCanvas.tsx:8-12 | Duct second wall never outlined: App keeps only polygons[0] and FlowCanvas accepts a single airfoil polyline, so duct shows one wall line while the field and SDF treat both walls as obstacles. | frontend-dev: pass Point[][] outlines through FlowCanvas and render one line per polygon, disposing all swapped geometries; add duct render test or story check. |
| Minor | src/flow/frameSource.ts:1-2 | Stale header says Phase 1 ships FixtureFlowProvider only and LBM arrives in Phase 2, but Phase 2 adds AnalyticFlowProvider and no LBM provider. | backend-dev: update header to describe fixture plus analytic providers. |
| Minor | src/ui/FlowControls.tsx:27-30,98-131 | NACA code string goes stale: thickness, camber and camber position sliders mutate m, p, t but never update naca.code, so spec.code 2412 can describe a 2418 shape. Physics uses m, p, t so field is right, exported spec is inconsistent. | frontend-dev: recompute code from m, p, t on slider change or drop code from editable spec and derive it at display and export. |
| Minor | src/ui/FlowControls.tsx:82-96, src/geometry/parametric.ts:349-362 | AoA slider stays enabled for cylinder and duct where geometry ignores alpha (cylinder symmetric, duct explicitly ignores rotation); only the wake slope at analyticFlow.ts:112 changes, which reads as geometry response. | frontend-dev: disable AoA for cylinder and duct with a hint, or document wake-only effect in the label. |
| Minor | src/flow/sdf.ts:38-41,63-71 | polygonSdf and buildSdfGrid validate polygon length but not point finiteness (circles are validated); NaN points silently yield NaN sdf and obstacle 0. | backend-dev: validate finite points once in buildSdfGrid and polygonSdf, throw specific errors. |
| Minor | src/flow/analyticFlow.ts:153-158 | Non-finite field values silently replaced (u=U, others 0), masking solver singularities instead of surfacing them. | backend-dev: count replacements and throw or report via result metadata when any occur. |
| Minor | src/App.tsx:1-172, src/ui/FlowControls.tsx:1-178, src/render/FlowCanvas.tsx:1-249, src/flow/frameSource.ts:1-120 | 2-space indent in UI and frameSource files vs 4-space in new Phase 2 math modules (potential.ts, sdf.ts, wake.ts, analyticFlow.ts). No UI tests exist for FlowControls, App wiring, or canvas outline swap. | frontend-dev/tester: formatter pass in a separate chore commit; add FlowControls and App provider wiring tests. |

Checks detail for orchestrator report: Panel math (single body) PASS: buildPanels CCW and outward normal (ty,-tx) at potential.ts:76-108 correct for CCW; source influence log and angle terms at 130-153 and vortex rotation (-ws,us) consistent; self terms cnS 0.5 and ctV -0.5 at 198-200 and 286-288; Kutta row at 212-240 correctly sums TE tangential velocities for a single airfoil (first and last remain TE adjacent after CCW reversal); Cp and Cl integration at 278-300 correct (minus cp times ny times len over chord). Cylinder analytic PASS as standalone (potential.ts:330-369, zero inside, doublet plus circulation), but note it is only exercised in tests, production cylinder path uses panels plus exact circle SDF. SDF sign PASS: sdf.ts:23-56 negative inside, zero on surface, obstacle sdf<=0 at 101-103, union min correct, exact circle overrides faceting. Duct handling FAIL per Major rows above (field speedup test passes, solver Kutta and outline do not). Wake Re-only PASS: wake.ts:59-77 amplitude and width Re-only, upstream untouched, analyticFlow.ts cl and cpMin from panels unaffected; provider caching in isolation PASS (frameSource.test.ts Re test) but FAIL as wired in App. UI wiring (no shim) PASS for direct controlled sliders (FlowControls.tsx:86-164, log Re conversion correct, no shim layer found, no em dashes in src prose, commas and colons only) with FAIL items above. Conventions FAIL minor (indent split, stale header). Maintainability FAIL minor (duplicated signedArea and dedup helpers between potential.ts:38-46 and parametric.ts:281-308, silent non-finite cleanup). Tests inspected, not executed (reviewer has no shell tool in this session).

Note recurring pattern: unit tests pass each module in isolation while cross-module wiring (App setter order, multi-polygon rendering and solving) is untested; Phase 1 pattern of isolated passes masking integration drift repeats.

## 2026-10-26 - Phase 2: Re-review After Major Fixes

Date: 2026-10-26
Reviewer: code-reviewer
Scope: Phase 2 re-review of Major fixes (per-body gamma with Kutta only for naca4, setGeometry deep equal, duct both walls rendered, NACA code derived, AoA hint, SDF finite validation, non-finite throw)
Verdict: PASS

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Minor | src/flow/frameSource.ts:10-13, src/App.tsx:9-15, src/ui/FlowControls.tsx:8-15, src/render/FlowCanvas.tsx:8-12 | 2-space indent persists in UI and frameSource files vs 4-space in Phase 2 math modules, pre-existing convention split | frontend-dev/backend-dev: formatter pass in a separate chore commit |
| Minor | src/flow/potential.ts:28,331 | Legacy gamma comment says gammas[0], code returns first Kutta body gamma | backend-dev: correct comment wording |
| Minor | src/ui/FlowControls.tsx:27-32,89 | NACA code derived on slider change, but stored code is displayed (not re-derived at display) and m=0 keeps a nonzero camber-position digit (for example 0412 for t=0.12) instead of conventional 0012 | frontend-dev: display nacaCodeFromParams(m,p,t) and zero the p digit when m rounds to 0; add FlowControls unit test |
| Minor | src/flow/analyticFlow.ts:155-162, src/flow/analyticFlow.test.ts:14-22 | Non-finite throw implemented but no direct test triggers it; tests only assert finite happy-path fields. No UI tests for FlowControls or duct two-line rendering | tester: add a stubbed singular or poisoned solution test for the throw, plus FlowControls and FlowCanvas outline-count tests |
| Minor | src/flow/sdf.ts:45-50,108-111 | polygonSdf revalidates every polygon point on every grid cell after buildSdfGrid already validated at sdf.ts:80-85, redundant O(cells x points) work | backend-dev: internal unchecked SDF used by buildSdfGrid after upfront validation, keep public polygonSdf validating |

Checks: per-body gamma and Kutta PASS (src/flow/potential.ts:180-355, src/flow/analyticFlow.ts:59-61, tests potential.test.ts:87-125, analyticFlow.test.ts:133-175); setGeometry deep equal PASS (src/flow/frameSource.ts:35-51,114-119, test frameSource.test.ts:77-108 including App setter order); duct both walls PASS (src/App.tsx:82,96, src/render/FlowCanvas.tsx:23-36,97-119,164-168,242-246); NACA code derived PASS with Minor above (FlowControls.tsx:27-38,89); AoA hint PASS (FlowControls.tsx:49,92-109, geometry rotates only naca4 and block at parametric.ts:346-362, wake slope analyticFlow.ts:114); SDF finite validation PASS (sdf.ts:38-50,72-98, test sdf.test.ts:55-59); non-finite throw PASS (analyticFlow.ts:147-162). Stale frameSource header fixed (frameSource.ts:1-4). Panel math, SDF sign, wake Re-only and provider caching unchanged from prior review and still PASS on inspection. No em dashes in src prose. Tests inspected, not executed (reviewer has no shell tool in this session).

Note recurring pattern: integration wiring now has provider-order coverage (frameSource.test.ts:89-108), closing the prior isolated-test gap for Re caching; remaining gaps are UI-level tests for controls and canvas.

## 2026-10-26 - Phase 2: Security Review

Date: 2026-10-26
Reviewer: security-engineer (05)
Scope: Phase 2 of 5, analytic solver TS (src/flow/potential.ts, src/flow/sdf.ts, src/flow/wake.ts, src/flow/analyticFlow.ts, src/flow/frameSource.ts, src/ui/FlowControls.tsx, src/App.tsx, src/contracts/schema.ts, src/geometry/parametric.ts)
Verdict: FAIL

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| Medium | src/flow/potential.ts:186-220,363-368 | Total panel DoS not capped: buildPanels caps one body at MAX_PANELS 160 (potential.ts:40-41,78-82) and buildPolygons caps one polygon at 160 (parametric.ts:176-177,311-318), but solveBodies allocates an N by N+1 dense augmented matrix at lines 219-220 and runs O(N^3) Gauss elimination with no cap on bodies, panels per body, or total N, and solvePanels forwards any panel array. A direct or future imported caller bypassing buildPanels (for example 5000 panels, about 200 MB matrix plus freeze) bypasses the 160 cap. Not reachable from the current UI, which yields at most 2 bodies (parametric.ts:326-363). | backend-dev: enforce MAX_BODIES and total N <= 320 (or 2 times MAX_PANELS) in solveBodies and panels.length <= MAX_PANELS in solvePanels before any allocation, add oversize tests |
| Medium | src/App.tsx:71-92, src/main.tsx:6-10 | Unhandled solver throw crashes the whole app: the new throw on non-finite fields (analyticFlow.ts:155-162) and singular system throws (potential.ts:303-305,324-326) propagate through the useMemo at App.tsx:71-92 with no try/catch, last-good fallback, or React ErrorBoundary (main.tsx renders App bare). Any crafted spec, singular geometry, or future Phase 3 imported geometry white-screens the demo (availability). | frontend-dev: wrap the analytic useMemo in try/catch keeping the last good field plus an inline error, or add an ErrorBoundary around the canvas section, add a poisoned-spec render test |
| Medium | src/contracts/schema.ts:43,61-65 vs src/ui/FlowControls.tsx:99-103,118-158 | Slider envelope is UI-only, not enforced by the validator: FlowControls clamps AoA to -4..12, thickness 0.06..0.18, camber 0..0.09, camber position 0.2..0.8, but validateGeometrySpec checks alphaDeg for finiteness only (line 43) and allows t up to 0.4 and p anywhere in (0,1) (lines 61-65). Any non-slider caller (state tampering, future import, Phase 4 payload) bypasses the stated -4..12 and 0.06..0.18 envelope. Numerically still finite-checked downstream, so this is an envelope gap, not a crash by itself. | backend-dev: enforce alphaDeg in [-4, 12] and naca t in [0.06, 0.18], m in [0, 0.09], p in [0.2, 0.8] in validateGeometrySpec if those are the product limits (or document a wider solver envelope in one place), add bypass tests via AnalyticFlowProvider |
| Low | src/flow/sdf.ts:72-86,103-115 | SDF total work unbounded for direct callers: grid is capped (schema.ts:92-95) but polygons count and total points are not, and polygonSdf revalidates every point on every cell (sdf.ts:45-50), giving O(cells x bodies x points) with validation overhead. Internal path is safe (polygons capped at parametric.ts:311-318). | backend-dev: cap bodies and total points in buildSdfGrid and validate once, then use an unchecked inner SDF in the cell loop |
| Low | src/flow/wake.ts:36-40,61-64 | applyWake accepts nx or ny of 1, then divides by (ny - 1) and (nx - 1) at lines 62-64, silently producing NaN coordinates and corrupting u and v instead of throwing. Grid validator requires >= 4 (schema.ts:90-91), so only direct callers hit this. | backend-dev: require nx, ny >= 2 (align with validateGridSpec at >= 4) in applyWake |
| Low | src/flow/analyticFlow.ts:175-177, src/flow/potential.ts:332-355 | cl and cpMin are not finiteness-checked: solveBodies checks solution x (lines 324-326) but cp and cl derived at lines 332-355 and cpMin at analyticFlow.ts:175-177 can surface NaN or Infinity to the metrics bar (App.tsx:132) if a forged PanelSolution or overflow occurs. Field values themselves are gated at analyticFlow.ts:155-162. | backend-dev: assert Number.isFinite on cl, cp entries, and cpMin before returning from solveBodies and generateAnalyticFlow |
| Low | src/flow/frameSource.ts:73-86,131-148 | Provider constructor clones grid and geometry without validating them (validation is deferred to getFrame, which does throw before allocation via resolveBody and fieldFromResolved), and getFrame returns the single mutable cached FlowField, so a caller mutating the returned arrays poisons the cache for later frames. Internal App and canvas use is read-only today. | backend-dev: validate grid and geometry in the constructor for fail-fast errors, document the returned field as read-only or return a copy if external callers appear |

Checks: panel cap per body PASS (160 enforced in buildPanels and buildPolygons, dense solve at the UI maximum of 320 panels is about 0.8 MB and fine), Gauss pivot PASS (partial pivoting potential.ts:293-317, singular and non-finite pivot throws at 303-305, back substitution finiteness at 319-326), NaN and Infinity PASS on the main pipeline (finite checks in buildPanels 65-70, solveBodies 194-199, panelVelocity 372-377, cylinderVelocity 409-423, sdf.ts 25-33 and 80-98, wake.ts 42-58, analyticFlow.ts 39-48, final non-finite field throw at 155-162, speed capped at 3U at 116-125 so no unbounded velocity reaches pressure), memory PASS (DEFAULT_GRID 128x128 is 16384 cells at types.ts:96, field plus SDF arrays in analyticFlow.ts:89-94 total under 0.5 MB, grid caps 512 per axis and 262144 cells at schema.ts:16-18,92-95 bound any other grid), provider cache PASS (single resolved body and single field cached at frameSource.ts:58-70, geometry cloned at 82-85, deep-equal skip at 114-119, setRe only dirties the field at 104-112, no unbounded cache growth), slider input validation PASS at the UI layer (AoA -4..12 FlowControls.tsx:99-103, thickness 0.06..0.18 at 118-120, camber and position at 133-160, log Reynolds 100..1e6 at 167-176, all via Number(e.target.value) on range inputs with no string interpolation into code), code injection PASS (no eval, exec, system, popen, Function, innerHTML, or dangerouslySetInnerHTML in src/flow, src/ui, or src/App.tsx), secrets PASS (no keys, tokens, or env reads in Phase 2 sources).

Note recurring pattern: caps and finiteness are enforced per module on the happy UI path but not as total-work limits at exported solver entry points (solveBodies, buildSdfGrid, applyWake), the same isolated-pass pattern as Phase 1. Fix total caps and the validator envelope before Phase 3 accepts surrogate or imported geometry.
