# GearFlow Test Results
Last updated: 2026-10-27

## 2026-10-26 - Phase 1: Test Report (contracts+skeleton Vite shell, NACA kernel, fake flow, fixtures, particles, textures, loader hardened)

### Test Results
npm test: 7 files, 74 tests, all passed. Baseline before hardening was 6 files, 49 tests, all passed.
npm run build: tsc --noEmit plus vite build succeeded. dist/index.html 0.55 kB, CSS 3.20 kB, JS 625.79 kB (three.js, chunk size warning only).

New coverage added in src/phase1.hardening.test.ts (25 tests):
happy path 2412 6deg polygon well formed plus closed TE plus TE down at alpha,
fixture flow finite with body mask and wake deficit,
render readiness (textures pack, colormap samples, particles advect in domain),
bad AoA (NaN/Infinity/-Infinity/missing rejected, extreme finite alphas stay finite, wake slope sign),
bad sketch fallback (unknown kind, naca4 without valid naca params, bad codes),
NaN/Infinity per channel plus NaN domain/chord/center plus poisoned bilinear,
traversal plus scheme (resolveFixtureUrl allowlist and escapes, DemoPack.files traversal),
oversize (grid/nPoints/airfoil/texture caps, generateFakeFlow oversize),
offline pack loads via mocked fetch (validated flow and airfoil points, geometry divergence),
error conditions (truncated channel, mismatched nx/domain, missing manifest/flow/geometry files).

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| schema.test.ts (18) | PASS | Truncated, meta/files, chord/NACA ranges, cylinder/duct extents, grid match, airfoil points, traversal, caps, finiteness, geometry match |
| parametric.test.ts (11) | PASS | Thickness peak, camber, y-up, closed TE, invalid inputs, alpha sign, point in polygon, SDF |
| fakeFlow.test.ts (4) | PASS | Finite/deterministic, all kind masks, wake deflection, wakeProfile |
| fixtures.parity.test.ts (8) | PASS | Manifest validates, 5 flows match generateFakeFlow within 1e-4, 2 geometries exact |
| particles.test.ts (4) | PASS | Edge sampling, determinism, substep anti-tunneling, non-finite guards |
| fieldTexture.test.ts (4) | PASS | Full range packing, extremes 0/255, oversize cap, non-finite reject |
| phase1.hardening.test.ts (25) | PASS | Happy path, AoA, sketch fallback, NaN/Infinity, traversal, oversize, offline pack, truncated/mismatched/missing |
| npm run build | PASS | tsc plus vite, chunk size warning only |

### Coverage Summary
Happy path covered (2412 6deg loads, polygon, flow, textures, particles).
Edge cases covered (bad AoA clamp via finite reject plus finite extremes, sketch fallback, NaN/Infinity, traversal, oversize, offline pack).
Error conditions covered (truncated flow, mismatched grid nx/domain, missing manifest/flow/geometry files with friendly message).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| phase1.hardening traversal (initial run) | resolveFixtureUrl imported from wrong module (contracts/schema instead of meta/fixtures) | Import from meta/fixtures; fixed, now passes |
| phase1.hardening offline paths (initial run) | PACK_DIR used ../../public from src root, resolving outside repo | Use ../public/demo-pack from src/phase1.hardening.test.ts; fixed, now passes |

## 2026-10-26 - Phase 2: Test Report (analytic flow, Hess-Smith panels, cylinder analytic, SDF, wake, provider cache, sliders UI with error boundary)

### Test Results
npm test: 13 files, 139 tests, all passed. Baseline before hardening was 12 files, 121 tests, all passed.
npm run build: tsc --noEmit plus vite build succeeded. dist/index.html 0.55 kB, CSS 4.56 kB, JS 655.59 kB (three.js, chunk size warning only, pre-existing).

New coverage added in src/phase2.hardening.test.ts (18 tests):
happy path 2412 6deg analytic Cl oracle 0.975 in band plus CpMin oracle minus 2.49 plus panel Cp oracle plus cylinder stagnation and suction plus determinism,
edge cases AoA minus 4 to 12 monotonic Cl with sign flip plus thickness 0.06 to 0.18 stable Cl plus Re wake only with upstream bitwise equal plus duct speedup plus cylinder gamma 0 with symmetric field,
error conditions oversize panels and SDF rejected plus NaN table across all kernels plus poisoned spec keeps last good plus singular system caught,
provider cache alpha re-solves and Re and equal geometry reuse plus slider envelope matches validator plus ErrorBoundary static and fallback markup.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| phase2.hardening.test.ts (18) | PASS | Oracles Cl 0.974988 and CpMin minus 2.487990, AoA and thickness sweeps, wake only Re, duct speedup, gamma 0, oversize, NaN, last good, singular, cache, sliders, boundary |
| analyticFlow.test.ts (8) | PASS | Pre-existing Phase 2 analytic coverage still green |
| potential.test.ts (13) | PASS | Cylinder oracle, far field, RMS, gamma 0 bodies, caps |
| sdf.test.ts (9) | PASS | Sign, exact circle, surface zero, duct union, caps |
| wake.test.ts (2) | PASS | Grid guards, upstream untouched |
| frameSource.test.ts (11) | PASS | Cache, alpha and Re semantics, envelope no bypass |
| phase1.hardening.test.ts (25) | PASS | Phase 1 regression still green |
| all other Phase 1 suites (53) | PASS | schema, parametric, fakeFlow, parity, particles, fieldTexture unchanged |
| npm run build | PASS | tsc plus vite, chunk size warning only |

### Coverage Summary
Happy path covered (2412 6deg Cl in band with oracle, Cp oracle at field and panel level, cylinder stagnation and suction, determinism).
Edge cases covered (AoA minus 4 to 12 monotonic with sign flip, thickness sweep stable, Re wake only with bitwise upstream equality, duct speedup above 1.02, cylinder gamma exactly 0 with symmetric field and circulation delta).
Error conditions covered (oversize panels and SDF and nPoints rejected before allocation, NaN table across analyticFlow and potential and wake and SDF, poisoned spec keeps last good field reference with unchanged solveCount, singular triple panel system caught).
Provider cache and UI contract covered (alpha re-solves, Re and equal geometry reuse panels, slider bounds match ALPHA and NACA envelope with boundary accept and outside reject, ErrorBoundary static conversion plus alert role plus retry).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 121 pre-existing tests still pass, 139 total).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| (none) | All 18 new tests passed on the first run, full suite green | No fix needed |

## 2026-10-26 - Phase 3: Test Report (validation parsers, metrics, tiers, datasets, surrogate TS U-Net, ValidationPanel, App wiring)

### Test Results
npm test: 18 files, 205 tests, all passed. Baseline before hardening was 17 files, 177 tests, all passed.
npm run build: tsc --noEmit plus vite build succeeded. dist/index.html 0.55 kB, CSS 7.76 kB, JS 713.49 kB (three.js plus surrogate path, chunk size warning only, pre-existing pattern).

New coverage added in src/phase3.hardening.test.ts (28 tests):
happy path parsers on real fixtures with baked JSON parity plus CSV versus TXT tolerance plus TMR zone counts plus Gregory flat records,
happy path metrics on known values (2 pi slope, alpha0, cylinder stagnation and shoulder, uniform circulation zero, band CpMin) plus tier boundary pins,
edge Fortran D exponents (upper and lower D plus E forms plus McCroskey slope 0.1075 anchor),
edge Lednicer 66 plus 66 versus Selig 18 plus 18 TE to TE split,
edge header not on line 11 (shifted CSV metadata, TXT dashes skip, auto routing),
edge bubble corrupted Re 100k WARN (Re 100k versus 500k differ at 6 deg, WARN never passes and never blocks with 0.20 review band),
error NaN polar data (CSV NaN and TXT Infinity rejected, metrics and clAtAlpha throw),
error oversize fixtures (schema grid and nPoints caps, surrogate shape and manifest guards, TMR variables guard),
error corrupt weights fallback (bad paramCount and grid mismatch refuse activation, analytic fallback stays finite),
error non-finite surrogate output (Inf head bias, NaN decode, NaN alpha encoding),
wiring ValidationPanel anchors (clAtAlpha at 4, 6, 8 in all four polars, coarse 32x32 analytic finite, PASS plus WARN plus INFO contract) plus App backends (injected weights serve surrogate, offline fetch holds fallback, bad Re throws).

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| phase3.hardening.test.ts (28) | PASS | Happy path, D exponents, Lednicer vs Selig, shifted header, Re 100k WARN, NaN, oversize, corrupt weights, non-finite output, panel anchors, App backends |
| parsePolars.test.ts (pre-existing) | PASS | Real fixture CSV, TXT, TMR, coords coverage unchanged |
| metrics.test.ts (pre-existing) | PASS | Known value metric coverage unchanged |
| tiers.test.ts (pre-existing) | PASS | Tier boundary coverage unchanged |
| surrogate.test.ts (pre-existing) | PASS | Tiny weights forward plus fallback coverage unchanged |
| all other Phase 1 and 2 suites (177) | PASS | No regressions, 205 total |
| npm run build | PASS | tsc plus vite, chunk size warning only |

### Coverage Summary
Happy path covered (parsers on all four real polars with JSON parity, metrics on 2 pi slope and oracle Cp, tier PASS plus WARN plus INFO evaluation).
Edge cases covered (Fortran upper and lower D exponents with McCroskey slope anchor, Lednicer 66 plus 66 vs Selig 18 plus 18, shifted header not on line 11 with dashes skip and auto routing, Re 100k bubble rows WARN only with wider 0.20 review band that never blocks).
Error conditions covered (NaN and Infinity polar cells rejected, schema oversize caps before allocation, corrupt manifest and grid mismatch fall back to finite analytic, Inf head bias and NaN decode rejected, bad Re throws).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 177 pre-existing tests still pass, 205 total).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| phase3 CSV NaN reject (initial run) | Replacement token minus 0.5002 belongs to the Re 100k polar, absent from the Re 500k fixture, so no NaN was injected and no throw occurred | Replace minus 1.0298, the actual first Re 500k Cl value; fixed, now passes |

## 2026-10-26 - Phase 3 Full Suite: Test Report (232 Node plus 11 Python, review fixes included)

### Test Results
npm test: 19 files, 232 tests, all passed. Prior Phase 3 entry was 18 files, 205 tests. Delta is phase3.review fixes (21 tests) plus schema growth to 22 plus parsePolars growth to 14 plus surrogate growth to 14 plus metrics trim to 9.
npm run build: tsc plus vite build succeeded. dist index.html 0.55 kB, CSS 7.76 kB, JS 725.95 kB (three.js plus surrogate path, chunk size warning only, pre existing pattern).
Python training suite: 11 collected, 9 passed, 2 skipped (missing local data shards, expected without dataset generation). Root pytest has no runner, training project runner is canonical.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| schema.test.ts (22) | PASS | Contracts plus caps plus finiteness, growth from 18, still green |
| parsePolars.test.ts (14) | PASS | Real fixture CSV plus TXT plus TMR plus coords, still green |
| potential.test.ts (13) | PASS | Cylinder oracle plus far field plus RMS plus caps |
| surrogate.test.ts (14) | PASS | Tiny weights forward plus fallback, growth with export contract |
| phase3.review-fixes.test.ts (21) | PASS | Review follow ups, all green on first full run |
| phase3.hardening.test.ts (28) | PASS | D exponents, Lednicer vs Selig, shifted header, Re 100k WARN, NaN, oversize, corrupt weights, non finite output, panel anchors, App backends |
| parametric.test.ts (11) | PASS | Thickness peak plus camber plus closed TE, unchanged |
| metrics.test.ts (9) | PASS | Known value slopes plus stagnation plus CpMin, still green |
| sdf.test.ts (9) | PASS | Sign plus circle plus duct union plus caps |
| fieldTexture.test.ts (4) | PASS | Packing plus extremes plus caps plus non finite reject |
| fixtures.parity.test.ts (8) | PASS | Manifest plus 5 flows within 1e-4 plus 2 geometries exact |
| particles.test.ts (4) | PASS | Edge sampling plus determinism plus anti tunneling |
| tiers.test.ts (7) | PASS | Tier boundary pins, still green |
| frameSource.test.ts (11) | PASS | Cache plus alpha and Re semantics plus envelope guard |
| phase1.hardening.test.ts (25) | PASS | Phase 1 regression still green, mocked offline pack only stderr noise |
| wake.test.ts (2) | PASS | Grid guards plus upstream untouched |
| fakeFlow.test.ts (4) | PASS | Finite plus deterministic plus wake deflection |
| phase2.hardening.test.ts (18) | PASS | Cl oracle 0.974988 plus CpMin minus 2.487990 plus cache plus sliders plus boundary |
| analyticFlow.test.ts (8) | PASS | Analytic oracle coverage still green |
| npm run build | PASS | tsc plus vite, chunk size warning only |
| training test_export.py (2) | PASS | Flat params roundtrip plus safe load with weights only |
| training test_model.py (4) | PASS | Forward shapes plus param count TS contract plus base arg build plus reject out of range |
| training test_reserved.py (3) | PASS | Reserved kinds and alphas plus anchor combo plus non anchor combos |
| training test_dataset.py (1) | SKIP | Shards missing locally, needs generated dataset, expected skip |
| training test_leakage.py (1) | SKIP | Splits disjoint needs data dir, expected skip without dataset |

### Coverage Summary
Happy path covered (parsers on all four real polars with JSON parity, metrics on 2 pi slope and oracle Cp, tier PASS plus WARN plus INFO, surrogate forward shapes with TS param count match, export roundtrip).
Edge cases covered (Fortran upper and lower D exponents, Lednicer vs Selig TE split, shifted header not on line 11, Re 100k bubble WARN only with 0.20 review band, reserved anchors pinned).
Error conditions covered (NaN and Infinity polar cells rejected, schema oversize caps before allocation, corrupt manifest and grid mismatch fall back to finite analytic, Inf head bias and NaN decode rejected, bad Re throws, base arg out of range rejected).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 205 prior tests still pass, 232 total Node plus 9 passed Python with 2 expected skips).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| (none) | Full suite green on this run, 232 Node passed plus 9 Python passed with 2 expected skips | No fix needed, generate dataset to clear skips if full data coverage desired |

## 2026-10-26 - Phase 3 Final Verification: Test Report (232 Node plus 11 Python, security Lows resolved)

### Test Results
npm test: 19 files, 232 tests, all passed. Matches expected Phase 3 full suite count.
npm run build: tsc noEmit plus vite build succeeded. dist index.html 0.55 kB, CSS 7.76 kB, JS 726.51 kB (three.js plus surrogate path, chunk size warning only, pre existing pattern).
Python training suite via training project runner: 11 collected, 9 passed, 2 skipped (missing local data shards, expected without dataset generation). Root pytest has no runner, training project runner is canonical.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| schema.test.ts (22) | PASS | Contracts plus caps plus finiteness |
| parsePolars.test.ts (14) | PASS | Real fixture CSV plus TXT plus TMR plus coords |
| potential.test.ts (13) | PASS | Cylinder oracle plus far field plus RMS plus caps |
| surrogate.test.ts (14) | PASS | Tiny weights forward plus fallback plus export contract |
| phase3.review-fixes.test.ts (21) | PASS | Review follow ups, all green |
| phase3.hardening.test.ts (28) | PASS | D exponents, Lednicer vs Selig, shifted header, Re 100k WARN, NaN, oversize, corrupt weights, non finite output, panel anchors, App backends |
| validation metrics.test.ts (9) | PASS | Known value slopes plus stagnation plus CpMin |
| geometry parametric.test.ts (11) | PASS | Thickness peak plus camber plus closed TE |
| flow sdf.test.ts (9) | PASS | Sign plus circle plus duct union plus caps |
| render particles.test.ts (4) | PASS | Edge sampling plus determinism plus anti tunneling |
| fixtures.parity.test.ts (8) | PASS | Manifest plus 5 flows within 1e-4 plus 2 geometries exact |
| render fieldTexture.test.ts (4) | PASS | Packing plus extremes plus caps plus non finite reject |
| validation tiers.test.ts (7) | PASS | Tier boundary pins |
| flow frameSource.test.ts (11) | PASS | Cache plus alpha and Re semantics plus envelope guard |
| phase1.hardening.test.ts (25) | PASS | Phase 1 regression green, mocked offline pack stderr noise only |
| flow wake.test.ts (2) | PASS | Grid guards plus upstream untouched |
| flow fakeFlow.test.ts (4) | PASS | Finite plus deterministic plus wake deflection |
| phase2.hardening.test.ts (18) | PASS | Cl oracle 0.974988 plus CpMin minus 2.487990 plus cache plus sliders plus boundary |
| flow analyticFlow.test.ts (8) | PASS | Analytic oracle coverage |
| npm run build | PASS | tsc plus vite, chunk size warning only |
| training test_export.py (2) | PASS | Flat params roundtrip plus safe load with weights only |
| training test_model.py (4) | PASS | Forward shapes plus param count TS contract plus base arg build plus reject out of range |
| training test_reserved.py (3) | PASS | Reserved kinds and alphas plus anchor combo plus non anchor combos |
| training test_dataset.py (1) | SKIP | Shards missing locally, needs generated dataset, expected skip |
| training test_leakage.py (1) | SKIP | Splits disjoint needs data dir, expected skip without dataset |

### Coverage Summary
Happy path covered (parsers on all four real polars with JSON parity, metrics on 2 pi slope and oracle Cp, tier PASS plus WARN plus INFO, surrogate forward shapes with TS param count match, export roundtrip).
Edge cases covered (Fortran upper and lower D exponents, Lednicer vs Selig TE split, shifted header, Re 100k bubble WARN only with 0.20 review band, reserved anchors pinned).
Error conditions covered (NaN and Infinity polar cells rejected, schema oversize caps before allocation, corrupt manifest and grid mismatch fall back to finite analytic, Inf head bias and NaN decode rejected, bad Re throws, base arg out of range rejected).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all prior suites still pass, 232 total Node plus 9 passed Python with 2 expected skips).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| (none) | Full suite green on this run, 232 Node passed plus 9 Python passed with 2 expected skips | No fix needed, generate dataset to clear skips if full data coverage desired |

## 2026-10-26 - Phase 4: Test Report (Meta orchestration, Spark spec plus SAM plus cache plus poster plus offline pack)

### Test Results
npm test: 22 files, 285 tests, all passed. Baseline before hardening was 21 files, 249 tests, all passed.
npm run build: tsc noEmit plus vite build succeeded. dist index.html 0.55 kB, CSS 11.24 kB, JS 755.20 kB (three.js plus surrogate plus Meta panel, chunk size warning only, pre-existing pattern).

New coverage added in src/phase4.hardening.test.ts (36 tests):
happy path Spark spec parse plus validate with template envelope, SAM mask to polygon capped at 120 with chord normalized bounds, cache hit on second identical prompt with distinct prompt keys, offline pack load with per case spec and polygon validation,
edge cache TTL expiry with stale on request plus fresh Spark TTL plus stale served on network failure plus SAM 7 day TTL, bbox fallback on missing mask plus explicit bbox plus dimension mismatch, poster single render with url reuse plus lost session refusal plus brand free prompt, presets two local entries with valid specs inside the slider envelope,
error schema reject on bad Re and empty rationale and unknown kind plus polygon out of range plus repair once then template fallback, offline mode template spec with zero fetch plus typed offline errors on chat and segment and image plus offline engineer note, SAM empty mask to 6 point proxy plus sketch with empty mask, bad Re below 1000 and above 1000000, oversized upload with mismatched mask length and tiny dims and non Uint8 and 200 point polygon plus corrupt payload fallback plus empty IoU 1, offline pack missing index and empty cases and invalid case.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| phase4.hardening.test.ts (36) | PASS | Happy path, TTL, bbox, poster guard, presets, schema reject, offline no fetch, empty mask, bad Re, oversize, pack failures |
| meta.test.ts (pre-existing) | PASS | Spark cache, TTL, offline gate, SAM fallback, poster guard, custom polygon unchanged |
| samMask.test.ts (6) | PASS | Rect trace, empty fallback, dims, IoU unchanged |
| all other Phase 1 to 3 suites (243) | PASS | No regressions, 285 total |
| npm run build | PASS | tsc plus vite, chunk size warning only |

### Coverage Summary
Happy path covered (Spark spec parse plus validate, SAM mask to polygon, cache hit, offline pack load).
Edge cases covered (cache TTL expiry with stale serve, bbox fallback with explicit box, poster session guard with reuse, presets apply with local only specs).
Error conditions covered (schema reject with repair then template, offline mode with zero fetch, SAM empty mask to proxy, bad Re outside 1000 to 1000000, oversized upload with fallback).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 249 pre-existing tests still pass, 285 total).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| phase4 presets note (initial run) | Assertion checked the note does not contain car model, but the intended copy reads not a car model, which contains that substring | Assert the note contains not a car model instead; fixed, now passes |
| phase4 build (initial run) | VALID_SPEC inferred geometry.kind as string, rejected by explainRun ParametricSpec parameter under tsc noEmit | Annotate VALID_SPEC as ParametricSpec; fixed, build now passes |

## 2026-10-26 - Phase 4 Final Verification: Test Report (308 Node plus 11 Python, review and security fixes included)

### Test Results
npm test: 23 files, 308 tests, all passed. Prior Phase 4 entry was 22 files, 285 tests. Delta is meta/phase4.fixes.test.ts (23 tests) covering all code review and security fixes.
npm run build: tsc noEmit plus vite build succeeded. dist index.html 0.55 kB, CSS 11.32 kB, JS 763.26 kB (three.js plus surrogate plus Meta panel, chunk size warning only, pre-existing pattern).
Python training suite via training project runner: 11 collected, 11 passed, 0 skipped. The 2 previously skipped dataset and leakage tests now pass because data shards exist locally. Root pytest has no runner, training project runner is canonical.

New coverage in src/meta/phase4.fixes.test.ts (23 tests):
happy path proxy gate allowlist with method and dot segment and same origin checks plus rate limit, eval log verbatim hash plus cached events at the cache layer, SAM full byte hash with no fallback caching and strict payload validation, custom airfoil Kutta lift plus solved field Cl, offline pack bundled asset with allowlist and caps and fetch disabled,
edge cache LRU cap with expiry purge plus persist cap and namespaced clear, poster URL allowlist https and sized png base64, schema magnitude and string caps for provider payloads.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| schema.test.ts (22) | PASS | Contracts plus caps plus finiteness |
| surrogate.test.ts (14) | PASS | Tiny weights forward plus fallback plus export contract |
| phase3.review-fixes.test.ts (21) | PASS | Review follow ups, all green |
| phase3.hardening.test.ts (28) | PASS | D exponents, Lednicer vs Selig, shifted header, Re 100k WARN, NaN, oversize, corrupt weights, non finite output, panel anchors, App backends |
| phase4.fixes.test.ts (23) | PASS | Proxy gate, eval log hash, SAM byte hash, custom airfoil lift, offline pack bundle, cache LRU, poster URL, schema caps |
| parsePolars.test.ts (14) | PASS | Real fixture CSV plus TXT plus TMR plus coords |
| meta.test.ts (11) | PASS | Spark cache, TTL, offline gate, SAM fallback, poster guard, custom polygon |
| metrics.test.ts (9) | PASS | Known value slopes plus stagnation plus CpMin |
| parametric.test.ts (11) | PASS | Thickness peak plus camber plus closed TE |
| potential.test.ts (13) | PASS | Cylinder oracle plus far field plus RMS plus caps |
| sdf.test.ts (9) | PASS | Sign plus circle plus duct union plus caps |
| fixtures.parity.test.ts (8) | PASS | Manifest plus 5 flows within 1e-4 plus 2 geometries exact |
| fieldTexture.test.ts (4) | PASS | Packing plus extremes plus caps plus non finite reject |
| phase1.hardening.test.ts (25) | PASS | Phase 1 regression green, mocked offline pack stderr noise only |
| frameSource.test.ts (11) | PASS | Cache plus alpha and Re semantics plus envelope guard |
| particles.test.ts (4) | PASS | Edge sampling plus determinism plus anti tunneling |
| samMask.test.ts (6) | PASS | Rect trace, empty fallback, dims, IoU |
| tiers.test.ts (7) | PASS | Tier boundary pins |
| wake.test.ts (2) | PASS | Grid guards plus upstream untouched |
| fakeFlow.test.ts (4) | PASS | Finite plus deterministic plus wake deflection |
| phase2.hardening.test.ts (18) | PASS | Cl oracle 0.974988 plus CpMin minus 2.487990 plus cache plus sliders plus boundary |
| phase4.hardening.test.ts (36) | PASS | Happy path, TTL, bbox, poster guard, presets, schema reject, offline no fetch, empty mask, bad Re, oversize, pack failures |
| analyticFlow.test.ts (8) | PASS | Analytic oracle coverage |
| npm run build | PASS | tsc plus vite, chunk size warning only |
| training test_export.py (2) | PASS | Flat params roundtrip plus safe load with weights only |
| training test_model.py (4) | PASS | Forward shapes plus param count TS contract plus base arg build plus reject out of range |
| training test_reserved.py (3) | PASS | Reserved kinds and alphas plus anchor combo plus non anchor combos |
| training test_dataset.py (1) | PASS | Shards exist locally, previously skipped, now green |
| training test_leakage.py (1) | PASS | Splits disjoint, previously skipped, now green |

### Coverage Summary
Happy path covered (Spark spec parse plus validate, SAM mask to polygon, cache hit, offline pack load, proxy gate allowlist, eval log verbatim hash, custom airfoil lift, export roundtrip).
Edge cases covered (cache TTL expiry with stale serve plus LRU cap and purge, bbox fallback, poster session guard with URL allowlist, presets local only, Re 100k bubble WARN only).
Error conditions covered (schema reject with repair then template, offline mode with zero fetch, SAM empty mask to proxy with strict payload validation, bad Re outside 1000 to 1000000, oversized upload with fallback, NaN and Infinity polar cells rejected).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 285 prior Node tests still pass, 308 total Node plus 11 passed Python with 0 skips).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| (none) | Full suite green on this run, 308 Node passed plus 11 Python passed with 0 skips | No fix needed |

## 2026-10-26 - Phase 5: Test Report (polish, export, submission)

### Test Results
npm test: 25 files, 346 tests, all passed. Baseline before hardening was 24 files, 318 tests, all passed.
npm run build: tsc noEmit plus vite build succeeded. dist index.html 0.81 kB, CSS 13.07 kB, JS split into three, jspdf, html2canvas, and purify chunks plus react and flow chunks (three.js chunk, chunk size warning only, pre-existing pattern).

New coverage in src/phase5.hardening.test.ts (28 tests):
happy path exportFilename canonical plus fractional alpha p separator plus negative fractional free of double hyphens plus NaN alpha and Re tokens plus label and extension normalization,
happy path buildReportData twelve rows in stable order plus all NaN guards plus copy hygiene,
happy path composePng smoke with header plus image plus rows and 760px minimum width and bitmap close,
happy path exportPdf save through the lazy jspdf chunk plus snapshot decode fallback text,
edge adaptive particle tiers 3000 plus 2000 plus 1200 with slow frame guard plus deterministic tier counts plus large dt hold without tunneling,
edge capture null blob rejects instead of hanging plus missing canvas ref returns null plus not ready message plus ExportBar and App contract pins,
edge print stylesheet with print media query hiding rail plus footer plus export controls on a white sheet,
error 2d context unavailable plus canvas encode failure plus jsPDF construction failure with print fallback plus ExportBar print path pin,
error state export with NaN held frame keeps stable filenames plus n/a rows plus PDF still saves.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| phase5.hardening.test.ts (28) | PASS | Filename, NaN guard, rows, composePng, PDF mock, adaptive particles, null blob, print sheet, jsPDF fail, error frame |
| exportReport.test.ts (10) | PASS | Pre-existing Phase 5 export coverage still green |
| all other Phase 1 to 4 suites (308) | PASS | No regressions, 346 total |
| npm run build | PASS | tsc plus vite, chunk size warning only |

### Coverage Summary
Happy path covered (export filename canonical and fractional, NaN guard to n/a, twelve report rows, composePng smoke, PDF mock save).
Edge cases covered (adaptive particle tiers with slow frame guard and large dt hold, capture null blob with missing ref, print stylesheet hiding rail and controls).
Error conditions covered (jsPDF construction failure falls back to print, missing canvas ref, null 2d context, canvas encode failure, export during held error frame with NaN metrics).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 318 pre-existing tests still pass, 346 total).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| phase5 null snapshot reject (initial run) | Stubbed createImageBitmap ignored its argument, so composePng(null) resolved instead of rejecting like a real browser | Stub throws TypeError on null or undefined blob; fixed, now passes |
| phase5 ExportBar contract pin (initial run) | Assertion looked for the App side missing handle guard inside ExportBar, which checks the snapshot instead | Pin if (!snap) throw in ExportBar and if (!handle) return null in App; fixed, now passes |

## 2026-10-27 - Phase 5 Final Verification: Test Report (355 Node plus 11 Python, review and security fixes included)

### Test Results
npm test: 25 files, 355 tests, all passed. Prior Phase 5 entry was 25 files, 346 tests. Delta is review and security fixes (phase5.hardening 28 to 29, exportReport 10 to 18).
npm run build: tsc noEmit plus vite build succeeded. dist index.html 1.33 kB, CSS 13.42 kB, JS split into purify 30.47 kB plus react 141.00 kB plus index.es 150.93 kB plus index 169.05 kB plus html2canvas 201.42 kB plus jspdf 390.50 kB plus three 464.29 kB (chunk size warning only, pre existing pattern).
Python training suite via training project runner: 11 collected, 11 passed, 0 skipped. Root pytest has no runner, training project runner is canonical.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| schema.test.ts (22) | PASS | Contracts plus caps plus finiteness |
| phase5.hardening.test.ts (29) | PASS | Filename, NaN guard, rows, composePng, PDF mock, adaptive particles, null blob, print sheet, jsPDF fail, error frame |
| phase3.review-fixes.test.ts (21) | PASS | Review follow ups, all green |
| exportReport.test.ts (18) | PASS | Phase 5 export coverage with review fixes, still green |
| phase3.hardening.test.ts (28) | PASS | D exponents, Lednicer vs Selig, shifted header, Re 100k WARN, NaN, oversize, corrupt weights, non finite output, panel anchors, App backends |
| surrogate.test.ts (14) | PASS | Tiny weights forward plus fallback plus export contract |
| phase4.fixes.test.ts (23) | PASS | Proxy gate, eval log hash, SAM byte hash, custom airfoil lift, offline pack bundle, cache LRU, poster URL, schema caps |
| parsePolars.test.ts (14) | PASS | Real fixture CSV plus TXT plus TMR plus coords |
| meta.test.ts (11) | PASS | Spark cache, TTL, offline gate, SAM fallback, poster guard, custom polygon |
| potential.test.ts (13) | PASS | Cylinder oracle plus far field plus RMS plus caps |
| parametric.test.ts (11) | PASS | Thickness peak plus camber plus closed TE |
| metrics.test.ts (9) | PASS | Known value slopes plus stagnation plus CpMin |
| sdf.test.ts (9) | PASS | Sign plus circle plus duct union plus caps |
| phase1.hardening.test.ts (25) | PASS | Phase 1 regression green, mocked offline pack stderr noise only (expected error path logging) |
| fixtures.parity.test.ts (8) | PASS | Manifest plus 5 flows within 1e-4 plus 2 geometries exact |
| particles.test.ts (4) | PASS | Edge sampling plus determinism plus anti tunneling |
| fieldTexture.test.ts (4) | PASS | Packing plus extremes plus caps plus non finite reject |
| samMask.test.ts (6) | PASS | Rect trace, empty fallback, dims, IoU |
| tiers.test.ts (7) | PASS | Tier boundary pins |
| wake.test.ts (2) | PASS | Grid guards plus upstream untouched |
| frameSource.test.ts (11) | PASS | Cache plus alpha and Re semantics plus envelope guard |
| fakeFlow.test.ts (4) | PASS | Finite plus deterministic plus wake deflection |
| phase2.hardening.test.ts (18) | PASS | Cl oracle 0.974988 plus CpMin minus 2.487990 plus cache plus sliders plus boundary |
| phase4.hardening.test.ts (36) | PASS | Happy path, TTL, bbox, poster guard, presets, schema reject, offline no fetch, empty mask, bad Re, oversize, pack failures |
| analyticFlow.test.ts (8) | PASS | Analytic oracle coverage |
| npm run build | PASS | tsc plus vite, chunk size warning only |
| training test_export.py (2) | PASS | Flat params roundtrip plus safe load with weights only |
| training test_model.py (4) | PASS | Forward shapes plus param count TS contract plus base arg build plus reject out of range |
| training test_reserved.py (3) | PASS | Reserved kinds and alphas plus anchor combo plus non anchor combos |
| training test_dataset.py (1) | PASS | Shards exist locally, green |
| training test_leakage.py (1) | PASS | Splits disjoint, green |

### Coverage Summary
Happy path covered (export filename canonical and fractional, NaN guard to n/a, twelve report rows, composePng smoke, PDF mock save, Spark spec parse plus validate, SAM mask to polygon, parsers on all four real polars, surrogate forward shapes, export roundtrip).
Edge cases covered (adaptive particle tiers with slow frame guard and large dt hold, capture null blob with missing ref, print stylesheet hiding rail and controls, cache TTL expiry with LRU cap, Re 100k bubble WARN only).
Error conditions covered (jsPDF construction failure falls back to print, missing canvas ref, null 2d context, canvas encode failure, export during held error frame with NaN metrics, NaN and Infinity polar cells rejected, corrupt weights fall back to finite analytic).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 346 prior Node tests still pass plus 9 new, 355 total Node plus 11 passed Python with 0 skips).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| (none) | Full suite green on this run, 355 Node passed plus 11 Python passed with 0 skips | No fix needed |

## 2026-10-27 - Phase 5 Final Verification Rerun: Test Report (355 Node plus 11 Python, review and security fixes confirmed)

### Test Results
npm test: 25 files, 355 tests, all passed. Confirms prior Phase 5 final count of 355 with no drift.
npm run build: tsc noEmit plus vite build succeeded. dist index.html 1.03 kB, CSS 13.42 kB, JS split into purify 30.47 kB plus react 141.00 kB plus index.es 150.93 kB plus index 169.05 kB plus html2canvas 201.42 kB plus jspdf 390.50 kB plus three 464.29 kB (chunk size warning only, pre existing pattern).
Python training suite via training project runner: 11 collected, 11 passed, 0 skipped. Root pytest has no runner, training project runner is canonical.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| schema.test.ts (22) | PASS | Contracts plus caps plus finiteness |
| phase5.hardening.test.ts (29) | PASS | Filename, NaN guard, rows, composePng, PDF mock, adaptive particles, null blob, print sheet, jsPDF fail, error frame |
| phase3.review-fixes.test.ts (21) | PASS | Review follow ups, all green |
| exportReport.test.ts (18) | PASS | Phase 5 export coverage with review fixes, still green |
| phase3.hardening.test.ts (28) | PASS | D exponents, Lednicer vs Selig, shifted header, Re 100k WARN, NaN, oversize, corrupt weights, non finite output, panel anchors, App backends |
| surrogate.test.ts (14) | PASS | Tiny weights forward plus fallback plus export contract |
| phase4.fixes.test.ts (23) | PASS | Proxy gate, eval log hash, SAM byte hash, custom airfoil lift, offline pack bundle, cache LRU, poster URL, schema caps |
| parsePolars.test.ts (14) | PASS | Real fixture CSV plus TXT plus TMR plus coords |
| meta.test.ts (11) | PASS | Spark cache, TTL, offline gate, SAM fallback, poster guard, custom polygon |
| potential.test.ts (13) | PASS | Cylinder oracle plus far field plus RMS plus caps |
| parametric.test.ts (11) | PASS | Thickness peak plus camber plus closed TE |
| metrics.test.ts (9) | PASS | Known value slopes plus stagnation plus CpMin |
| sdf.test.ts (9) | PASS | Sign plus circle plus duct union plus caps |
| phase1.hardening.test.ts (25) | PASS | Phase 1 regression green, mocked offline pack stderr noise only (expected error path logging) |
| fixtures.parity.test.ts (8) | PASS | Manifest plus 5 flows within 1e-4 plus 2 geometries exact |
| particles.test.ts (4) | PASS | Edge sampling plus determinism plus anti tunneling |
| fieldTexture.test.ts (4) | PASS | Packing plus extremes plus caps plus non finite reject |
| samMask.test.ts (6) | PASS | Rect trace, empty fallback, dims, IoU |
| tiers.test.ts (7) | PASS | Tier boundary pins |
| wake.test.ts (2) | PASS | Grid guards plus upstream untouched |
| frameSource.test.ts (11) | PASS | Cache plus alpha and Re semantics plus envelope guard |
| fakeFlow.test.ts (4) | PASS | Finite plus deterministic plus wake deflection |
| phase2.hardening.test.ts (18) | PASS | Cl oracle 0.974988 plus CpMin minus 2.487990 plus cache plus sliders plus boundary |
| phase4.hardening.test.ts (36) | PASS | Happy path, TTL, bbox, poster guard, presets, schema reject, offline no fetch, empty mask, bad Re, oversize, pack failures |
| analyticFlow.test.ts (8) | PASS | Analytic oracle coverage |
| npm run build | PASS | tsc plus vite, chunk size warning only |
| training test_export.py (2) | PASS | Flat params roundtrip plus safe load with weights only |
| training test_model.py (4) | PASS | Forward shapes plus param count TS contract plus base arg build plus reject out of range |
| training test_reserved.py (3) | PASS | Reserved kinds and alphas plus anchor combo plus non anchor combos |
| training test_dataset.py (1) | PASS | Shards exist locally, green |
| training test_leakage.py (1) | PASS | Splits disjoint, green |

### Coverage Summary
Happy path covered (export filename canonical and fractional, NaN guard to n/a, twelve report rows, composePng smoke, PDF mock save, Spark spec parse plus validate, SAM mask to polygon, parsers on all four real polars, surrogate forward shapes, export roundtrip).
Edge cases covered (adaptive particle tiers with slow frame guard and large dt hold, capture null blob with missing ref, print stylesheet hiding rail and controls, cache TTL expiry with LRU cap, Re 100k bubble WARN only).
Error conditions covered (jsPDF construction failure falls back to print, missing canvas ref, null 2d context, canvas encode failure, export during held error frame with NaN metrics, NaN and Infinity polar cells rejected, corrupt weights fall back to finite analytic).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (full 355 Node plus 11 Python green, matches prior final verification with zero drift).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| (none) | Full suite green on this rerun, 355 Node passed plus 11 Python passed with 0 skips | No fix needed |

## 2026-10-27 - Phase 6: Test Report (UI/backend overhaul, C-1, C-3, C-4)

### Test Results
npm test: 30 files, 431 tests, all passed. Baseline before hardening was 29 files, 392 tests, all passed. Delta is src/phase6.hardening.test.ts (39 tests).
npm run build: tsc noEmit plus vite build succeeded. dist index.html 1.03 kB, CSS 19.49 kB, JS split into purify 30.47 kB plus react 141.00 kB plus index.es 150.93 kB plus index 195.18 kB plus html2canvas 201.42 kB plus jspdf 390.50 kB plus three 464.58 kB (chunk size warning only, pre existing pattern).
cargo test --manifest-path rust/gearflow-wasm/Cargo.toml: 15 passed, 0 failed.

New coverage in src/phase6.hardening.test.ts (39 tests):
happy path chat store roundtrip with roles and timestamps plus append single and batch capped at 50 plus invalid rows filtered, intent routing per kind plus case insensitive sketch and figure keywords plus priority explain over spec over sam over poster, grid controller auto 256 default plus two slow solve fallback with notice plus streak reset plus pinned modes, grid switch disposal reuse on same grid with quantity and LUT rewrite plus recreate on grid change plus null prev create, field texture quantity packing roundtrip for speed plus cp plus omega plus u plus v plus velocity and obstacle mask plus extremes 0 and 255, colormap LUT all 10 entries finite plus 256 entry endpoints plus clamp plus grayscale monotonic plus diverging flags plus RGBA LUT texture plus honest ranges, theme toggle dark default plus light roundtrip plus next label plus shader fallback uniforms plus partial updates plus vertex color fallback on NaN.
edge localStorage quota setItem throws plus private mode every call throws plus quota on theme and display prefs, NaN timing ignored, invalid rows filtered not rejected, all NaN range falls back finite.
error NaN and Infinity channels rejected plus mismatched lengths plus degenerate grid plus oversize 600 wide rejected plus at cap 512x512 accepted, corrupt chat JSON plus wrong version plus non array turns plus null payload all return empty, invalid colormap samples fall back to viridis plus prefs sanitize to defaults.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| phase6.hardening.test.ts (39) | PASS | Chat, intents, grid, textures, LUT, theme, shader fallback, quota, NaN, corrupt, oversize, invalid colormap |
| phase6.overhaul.test.ts (11) | PASS | Pre-existing Phase 6 pinning still green |
| chat.test.ts (11) | PASS | Transcript store plus intent router still green |
| resolution.test.ts (6) | PASS | Resolution controller still green |
| fieldTexture.test.ts (6) | PASS | Packing plus quantity plus reuse still green |
| all other Node suites (358) | PASS | No regressions, 431 total |
| npm run build | PASS | tsc plus vite, chunk size warning only |
| cargo test gearflow-wasm (15) | PASS | Geometry, potential, sdf, wake, field |

### Coverage Summary
Happy path covered (chat store roundtrip, intent routing, grid controller fallback, field texture quantity packing, colormap LUT, theme toggle).
Edge cases covered (localStorage quota, private mode, grid switch disposal, shader fallback).
Error conditions covered (NaN field, corrupt chat JSON, oversize grid, invalid colormap).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 392 pre-existing tests still pass, 431 total).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| phase6 hardening intent happy path (initial run) | Assertion expected segment this sketch to route to spec, but sketch keywords route to sam per router priority | Expect sam for segment this sketch; fixed, now passes |
| phase6 hardening oversize at cap (initial run) | 512x512 probe used empty channels, so the length check fired before the cap check | Allocate full 512x512 channels for the at cap probe; fixed, now passes |

## 2026-10-27 - Phase 6 Final Verification: Test Report (447 Node plus 22 Rust plus 11 Python, review and security fixes confirmed)

### Test Results
npm test: 33 files, 447 tests, all passed. Prior Phase 6 entry was 30 files, 431 tests. Delta is review and security fixes (new src/phase6.review-fixes.test.ts with 11 tests, new src/ui/InstrumentTabs.test.tsx with 4 tests, new src/render/FlowCanvas.grid.test.ts with 1 test, new src/flow/wasmParity.test.ts with 7 tests, fieldTexture growth from 4 to 6, frameSource and chat suites steady).
npm run build: tsc noEmit plus vite build succeeded. dist index.html 1.03 kB, CSS 19.53 kB, JS split into purify 30.47 kB plus react 141.00 kB plus index.es 150.93 kB plus index 205.13 kB plus html2canvas 201.42 kB plus jspdf 390.50 kB plus three 464.58 kB (chunk size warning only, pre existing pattern).
cargo test with manifest path rust gearflow-wasm Cargo.toml: 22 passed, 0 failed (prior Phase 6 entry logged 15, growth from geometry oversize, grid dims, and field pipeline guards).
Python training suite via training project runner: 11 collected, 11 passed, 0 skipped. Root pytest has no runner, training project runner is canonical.

New coverage in src/phase6.review-fixes.test.ts (11 tests):
happy path reload apply actions with rebuild from turns plus chat actions persist roundtrip, intent routing still correct on reload shaped turns,
edge intent false positives rejected (poster and sam and spec keywords need anchors, short greetings stay on chat),
error poisoned snapshots refused (NaN quantity packing rejected, oversize text capped, corrupt chat JSON returns empty with actions cleared).

New coverage in src/flow/wasmParity.test.ts (7 tests):
happy path golden fixtures match the TS solver self consistently plus Rust solver instantiates when the built package is present,
edge and error Rust vs TS parity (exact obstacle equality, tight Cl and CpMin agreement, max abs diff within 1e-6 on u, v, p, omega).

New coverage in src/ui/InstrumentTabs.test.tsx (4 tests) plus src/render/FlowCanvas.grid.test.ts (1 test):
happy path instrument tabs keyboard map (roving tabindex, arrow plus Home and End targets with wrap around) plus tab and panel linkage,
edge grid canvas contract pin (grid controller wiring held through the canvas lifecycle).

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| schema.test.ts (22) | PASS | Contracts plus caps plus finiteness |
| phase5.hardening.test.ts (29) | PASS | Filename, NaN guard, rows, composePng, PDF mock, adaptive particles, null blob, print sheet, jsPDF fail, error frame |
| phase6.hardening.test.ts (39) | PASS | Chat, intents, grid, textures, LUT, theme, shader fallback, quota, NaN, corrupt, oversize, invalid colormap |
| phase3.review-fixes.test.ts (21) | PASS | Review follow ups, all green |
| phase3.hardening.test.ts (28) | PASS | D exponents, Lednicer vs Selig, shifted header, Re 100k WARN, NaN, oversize, corrupt weights, non finite output, panel anchors, App backends |
| phase4.fixes.test.ts (23) | PASS | Proxy gate, eval log hash, SAM byte hash, custom airfoil lift, offline pack bundle, cache LRU, poster URL, schema caps |
| phase6.review-fixes.test.ts (11) | PASS | Reload apply actions, intent false positives, poisoned snapshots, oversize text, NaN quantity packing |
| surrogate.test.ts (14) | PASS | Tiny weights forward plus fallback plus export contract |
| phase6.overhaul.test.ts (11) | PASS | Phase 6 pinning still green |
| parsePolars.test.ts (14) | PASS | Real fixture CSV plus TXT plus TMR plus coords |
| exportReport.test.ts (18) | PASS | Phase 5 export coverage with review fixes, still green |
| phase1.hardening.test.ts (25) | PASS | Phase 1 regression green, mocked offline pack stderr noise only (expected error path logging) |
| meta.test.ts (11) | PASS | Spark cache, TTL, offline gate, SAM fallback, poster guard, custom polygon |
| potential.test.ts (13) | PASS | Cylinder oracle plus far field plus RMS plus caps |
| fieldTexture.test.ts (6) | PASS | Packing plus quantity plus reuse, growth from 4, still green |
| parametric.test.ts (11) | PASS | Thickness peak plus camber plus closed TE |
| metrics.test.ts (9) | PASS | Known value slopes plus stagnation plus CpMin |
| sdf.test.ts (9) | PASS | Sign plus circle plus duct union plus caps |
| chat.test.ts (11) | PASS | Transcript store plus intent router still green |
| wasmParity.test.ts (7) | PASS | Golden self consistency plus Rust vs TS parity within 1e-6 when built package present |
| frameSource.test.ts (11) | PASS | Cache plus alpha and Re semantics plus envelope guard |
| resolution.test.ts (6) | PASS | Resolution controller still green |
| InstrumentTabs.test.tsx (4) | PASS | Keyboard map plus tab and panel linkage |
| fixtures.parity.test.ts (8) | PASS | Manifest plus 5 flows within 1e-4 plus 2 geometries exact |
| FlowCanvas.grid.test.ts (1) | PASS | Grid canvas contract pin |
| particles.test.ts (4) | PASS | Edge sampling plus determinism plus anti tunneling |
| samMask.test.ts (6) | PASS | Rect trace, empty fallback, dims, IoU |
| tiers.test.ts (7) | PASS | Tier boundary pins |
| wake.test.ts (2) | PASS | Grid guards plus upstream untouched |
| phase2.hardening.test.ts (18) | PASS | Cl oracle 0.974988 plus CpMin minus 2.487990 plus cache plus sliders plus boundary |
| fakeFlow.test.ts (4) | PASS | Finite plus deterministic plus wake deflection |
| phase4.hardening.test.ts (36) | PASS | Happy path, TTL, bbox, poster guard, presets, schema reject, offline no fetch, empty mask, bad Re, oversize, pack failures |
| analyticFlow.test.ts (8) | PASS | Analytic oracle coverage |
| npm run build | PASS | tsc plus vite, chunk size warning only |
| cargo test gearflow-wasm (22) | PASS | Geometry, potential, sdf, wake, field, grid dims guards |
| training test_export.py (2) | PASS | Flat params roundtrip plus safe load with weights only |
| training test_model.py (4) | PASS | Forward shapes plus param count TS contract plus base arg build plus reject out of range |
| training test_reserved.py (3) | PASS | Reserved kinds and alphas plus anchor combo plus non anchor combos |
| training test_dataset.py (1) | PASS | Shards exist locally, green |
| training test_leakage.py (1) | PASS | Splits disjoint, green |

### Coverage Summary
Happy path covered (reload apply actions with rebuild from turns, golden fixtures self consistent plus Rust parity, instrument tabs keyboard map, chat store roundtrip, intent routing, grid controller fallback, field texture quantity packing, colormap LUT, theme toggle, export filename and rows, Spark spec parse, SAM mask to polygon, parsers on all four real polars, surrogate forward shapes, export roundtrip).
Edge cases covered (intent false positives need anchors, grid switch disposal, shader fallback, localStorage quota and private mode, cache TTL expiry with LRU cap, Re 100k bubble WARN only, adaptive particle tiers).
Error conditions covered (poisoned snapshots refused with NaN quantity reject, oversize text capped, corrupt chat JSON returns empty, oversize grid rejected before allocation, invalid colormap falls back, jsPDF failure falls back to print, NaN and Infinity polar cells rejected, corrupt weights fall back to finite analytic).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 431 prior Node tests still pass plus 16 new, 447 total Node plus 22 Rust plus 11 Python with 0 skips).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| (none) | Full suite green on this run, 447 Node passed plus 22 Rust passed plus 11 Python passed with 0 skips | No fix needed |

## 2026-10-27 - Phase 10 and 11 Verification: Test Report (Rust LBM core plus worker transport, Re dependence gate added)

### Test Results
cargo test in release mode with manifest path rust/gearflow-wasm/Cargo.toml: 71 passed, 0 failed, 2 ignored, test time 36.06 s, wall 36 s. Baseline before this verification was 70 passed, 0 failed, 2 ignored. Delta is the new lbm::tests::re_dependence_bubble_grows_and_drag_falls (5.24 s pure test time, bitwise identical values across 3 repeat runs).
npm test: 48 files, 561 tests, all passed, vitest duration 2.14 s, wall 2 s. Matches the claimed baseline exactly, no drift.
npm run build: tsc plus vite build succeeded. Worker chunk dist/assets/lbmWorker-Dm1ag16k.js (5.85 kB) and dist/assets/gearflow_wasm_bg-BvmF0FY9.wasm (184.02 kB) both emitted. No other build output change of note.

New coverage in rust/gearflow-wasm/src/lbm.rs (1 test plus 1 helper, no production code touched):
Re 20 versus Re 30 small steady cylinder pair (151 by 76 square cells, D_lat 12, u_lattice 0.05, 6000 steps, stats from step 3000, seed 42). Measured: Re 20 recirc 1.0833 D, mean Cd 2.8881, Cl amp 0.00120; Re 30 recirc 1.7500 D, mean Cd 2.4321, Cl amp 0.00199. Gates: both Cl amps below 0.05 (steady comparison stays valid), Re 20 bubble above 0.5 D (measured 1.08), bubble growth gap at least 0.25 D (measured 0.67), Cd fall gap at least 0.15 (measured 0.46). A kernel that ignored Re would produce identical runs and fail both difference gates.

Probe path that was rejected: Re 40 at D_lat 8 (tau 0.53) diverges near step 672, while Re 20 at D_lat 8 (tau 0.56) completes. Re 40 at D_lat 12 (tau 0.545) sits inside the observed BGK instability zone, so forcing the Re 40 pair would buy flakiness. Re 20 versus Re 30 at D_lat 12 keeps both runs above tau 0.55 with steady wakes and 2.7x or better margin on every gate. No order dependence observed: the new test passed 3 of 3 isolated runs plus the full suite run, no shared global state between Rust tests, vitest files run in isolated workers.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| lbm::tests::re_dependence_bubble_grows_and_drag_falls (new) | PASS | Bubble grows 1.0833 to 1.7500 D, Cd falls 2.8881 to 2.4321, both steady, 5.24 s, deterministic across 3 runs |
| lbm::tests::re20_recirculation_bubble | PASS | Pre-existing, still green |
| lbm::tests::cylinder_re100_confined_smoke | PASS | Pre-existing confined tunnel smoke, still green |
| lbm::tests::poiseuille_recovers_parabola_and_viscosity | PASS | Pre-existing Mach convergence, still green |
| lbm::tests::mass_drift_and_divergence_small | PASS | Pre-existing, still green |
| All other Rust unit tests (lattice, boundaries, forces, stats, geometry, sdf, potential, wake, field, lib) | PASS | 71 total passed, 0 failed, 2 ignored |
| Ignored: reference_cylinder_release_only, convergence_512x384_d16 | SKIP | By design, release only manual runs; rot risk noted below |
| npm test, all 48 files (561 tests) | PASS | Includes lbmWorker, lbmClient, lbmProtocol, lbmFlowProvider, engineMode, lbmAppWiring, all green, 2.14 s |
| npm run build | PASS | Worker chunk plus wasm asset emitted |

### Coverage Summary
Happy path covered (Re dependence: bubble growth plus Cd fall with direction gates; Poiseuille parabola plus viscosity recovery; cylinder shedding with St; mask parity bit identical to obstacle channel).
Edge cases covered (square cell gate with corrected ny message, tau floor and warn band, D_lat floor, blockage warn, cancel then resume, poison then reset, racing inits newest wins, lost snapshot wedge timers, generation guards).
Error conditions covered (absurd Re, non-finite u, u above cap, zero radius, diverged state refuses resume and steps, worker poisoned resume surfaces error not silent no-op, protocol validator rejects malformed messages and oversize payloads).
Worker transport is unit tested only (fake solver factory, fake worker port, injected timers). Real browser worker execution with the compiled wasm package is a manual check and is not covered by any automated test.
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 70 pre-existing Rust tests and all 561 Node tests still pass).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| Probe Re 40 at D_lat 8 (temporary, removed) | BGK instability: tau 0.53 is inside the observed instability zone, diverged at step 672 | Use the Re 20 versus Re 30 pair at D_lat 12 (taus 0.59 and 0.56), which is what the committed test does; do not force Re 40 at coarse resolution |
| Probe loop overshoot (temporary, fixed before commit) | Test looped run_steps(512) until done meets 6000, overshooting to 6144 since 6000 is not a multiple of 512 | Step with (remaining).min(512) like the other tests; fixed, now asserts step equals 6000 exactly |
| Compiler warnings (pre-existing, not failures) | Unused p1, c1, p2, c2 bindings in the Poiseuille helper plus never read panels field plus never used generate_flow | Hygiene cleanup for the owning agent; no behavior change needed for tests to pass |

## 2026-10-27 - Phase 12 B2 Wiring Hardening: Test Report (behavioral agent console coverage)

### Test Results
npm test: 65 files, 766 tests, all passed. Baseline before hardening was 64 files, 756 tests, all passed. Delta is src/ui/agentConsoleWiring.test.tsx (9 tests) plus agentAppWiring growth from 3 to 4 behavioral tests.
npm run build: tsc noEmit plus vite build succeeded, no new warnings.

New coverage in src/ui/agentConsoleWiring.test.tsx (9 tests, real component through a hook dispatcher shim, real BasetenClient with fake fetch, fake streaming port, zero live calls):
happy path run_lbm envelope parks on the confirm chip with zero executor calls, confirm click fires the executor exactly once with run_lbm then clears the chip and renders the applied note, setup set_alpha auto applies once with no confirm chip,
busy lock second submit while busy issues zero additional client calls with presets disabled and Send replaced by Stop, Stop aborts the hanging stream and renders the stopped badge with Send restored,
offline toggle answers locally with zero fetch calls plus offline badge, 503 from the proxy renders the offline badge with zero executor calls, outright fetch failure renders the offline badge with zero executor calls,
spend gate soft stop boundary pins plus over cap session forces local mode with the cap note and zero client calls, under cap session stays live with Send present.

Reworked coverage replacing source string matching:
src/agent/agentAppWiring.test.ts now drives the real envelope validator for all eight action kinds, the real gating on TKE plus recirc plus run plus alpha bounds, the real engine mode parser with URL round trip, and the real pending LBM snapshot through validation to a zero rejection run_lbm action.
src/ui/agentConsoleBaseten.test.tsx source read test replaced with a mount level wiring test that passes the real context plus executor plus fake port as props with zero calls on mount.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| agentConsoleWiring.test.tsx (9) | PASS | Real component runs, real confirm click, busy single call plus Stop, three offline badge paths, spend cap local mode |
| agentAppWiring.test.ts (4) | PASS | All eight kinds validate, gates hold, engine parser round trip, pending LBM run action with zero rejections |
| agentConsoleBaseten.test.tsx (18) | PASS | Pre-existing 17 plus 1 behavioral wiring mount test, source read test removed, still green |
| all other Node suites (735) | PASS | No regressions, 766 total |
| npm run build | PASS | tsc plus vite, chunk size warning only |

### Coverage Summary
Happy path covered (run_lbm parks on confirm then fires once on click, setup auto applies, live path under cap stays clean).
Edge cases covered (second submit ignored while busy, Stop aborts a hanging stream, spend boundary at exactly five dollars, custom cap respected, NaN spend never trips).
Error conditions covered (offline toggle with zero fetch, 503 proxy fallback to local badge, fetch failure fallback to local badge, gated fields and run rejected without live state, alpha outside bounds rejected).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 756 pre-existing tests still pass, 766 total).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| wiring offline and spend assertions (initial run) | Test expected the generic offline note, but the explain input takes the engineer note variant | Assert the engineer note variant that the explain path really renders; fixed, now passes |
| wiring baseten mount replacement (initial draft) | Draft used an invalid membership check on rendered HTML | Assert the Send control directly on the idle render; fixed, now passes |
| busy guard mutation probe (temporary, restored) | Removed the busyRef early return to prove sensitivity, the busy lock test failed as intended | Guard restored byte for byte, production file untouched; probe confirms the test catches the regression |
