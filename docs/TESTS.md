# GearFlow Test Results
Last updated: 2026-10-28

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

## 2026-10-27 - Phase B4: Test Report (freeze hardening verification, no production changes)

### Test Results
npm test: 69 files, 809 tests, all passed. Baseline at the prior entry was 766 tests; delta is Phase 12b UI and flow coverage (fieldBar12b, turbulenceSection12b, displayStore12b, SettingsModal, streamlines, lbm providers, baseten disabled, chat migration, session spend).
npm run build: tsc noEmit plus vite build succeeded. dist index.html 1.01 kB, CSS 26.23 kB, JS split into lbmWorker 6.62 kB plus gearflow_wasm loader 6.12 kB plus glue 5.03 kB plus purify 30.47 kB plus react 141.00 kB plus index.es 150.93 kB plus index 274.73 kB plus html2canvas 201.42 kB plus jspdf 390.50 kB plus three 465.13 kB, wasm asset gearflow_wasm_bg 193.24 kB (chunk size warning only, pre-existing pattern).
VITE_DEMO_OFFLINE=true npm run build: tsc noEmit plus vite build succeeded with identical asset set (index bundle 274.82 kB vs 274.73 kB, hash rename only). Worker chunk lbmWorker 6.62 kB and wasm asset 193.24 kB present in both builds.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| npm test (69 files, 809 tests) | PASS | Full suite green, no drift, 2.75s duration |
| fieldBar12b.test.tsx (11) | PASS | FieldBar regression held, untouched by B4 |
| turbulenceSection12b.test.tsx (7) | PASS | TURBULENCE section regression held, untouched by B4 |
| agentConsoleWiring.test.tsx (9) | PASS | Confirm chip, busy guard, offline zero fetch, spend cap still green |
| agentConsoleBaseten.test.tsx (18) | PASS | Pinned model id assertions still green |
| basetenDisabled.test.ts (5) | PASS | Kill switch plus offline mapping still green |
| npm run build | PASS | tsc plus vite, worker chunk plus wasm asset emitted |
| VITE_DEMO_OFFLINE=true npm run build | PASS | Same asset set, offline default on, no key in bundle |

### Manual Matrix (reasoned from code, no browser tool)
| Case | Verdict | Notes |
|------|---------|-------|
| Offline static, no key, no network: console Explain completes | PASS | onSubmit routes forcedLocal (offline toggle, VITE_DEMO_OFFLINE, or spend cap) to pushOfflineAssistant, which calls pure local localReply with no fetch; engineer note variant cites live Cl, CpMin, Re, regime |
| Offline static: Setup plus Apply with zero fetch | PASS | settleParsedEnvelope auto applies SETUP_KINDS via onAgentAction synchronously and renders Applied lines; run kinds park as pendingRuns; wiring tests assert zero client calls on all three offline paths (toggle, 503, fetch failure) |
| Preview with key: streams | PASS | Live path calls port.streamChat with incremental flush every STREAM_FLUSH_MS, cached fallback on empty or invalid JSON, AbortError renders stopped badge; spend ledger records model, tokens, cost |
| LBM run via agent confirm chip | PASS | run_lbm and cancel_lbm park on pendingRuns and render Confirm Run LBM chips; onConfirmRun fires onAgentAction once on click; gated fields and out of bounds alpha rejected with zero live state |
| FieldBar plus TURBULENCE regression | PASS | Both suites green (11 plus 7); B4 made zero production changes so no interaction surface changed |
| Print styles intact | PASS | src/styles.css @media print block present: white sheet, rails plus bars plus run card plus colorbar hidden, printValidation shown; phase5 hardening pins still green |

### Grep Proofs
| Proof | Verdict | Notes |
|------|---------|-------|
| No VITE_BASENET key | PASS | Zero BASENET references repo wide excluding node_modules, dist, and git; keys live server side only (BASETEN_API_KEY, META_API_KEY, no VITE prefix, read by vite proxy middleware) |
| No secret in dist | PASS | Strict scan for BASETEN_API_KEY, META_API_KEY, and VITE key names across dist returns zero hits; only false positive is a dompurify license comment containing double hyphens |
| No em dashes or double hyphens in chat templates and status copy | PASS | No U+2014 or U+2013 in src; no double hyphen sequences in src/agent outside comments and tests |
| Model id pinned to meta-models/muse-spark-open-1026 in agent path | PASS | BASETEN_MODEL_ID constant in src/agent/basetenGate.ts, imported by AgentConsole, asserted verbatim in basetenGate.test.ts and both console suites; zero llama references in src/agent |

### Coverage Summary
Happy path covered (809 tests green, offline console completes Explain plus Setup plus Apply, live preview streams, LBM confirm fires once, print sheet intact).
Edge cases covered (offline toggle plus env flag plus spend cap all force local, busy guard, Stop abort, spend boundary).
Error conditions covered (503 proxy fallback, fetch failure fallback, gated run rejection, executor faults stay local to the confirm control).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 766 prior tests still pass plus 43 new, 809 total).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| (none) | Full suite green on this run, 809 passed, both builds green | No fix needed |

### Notes for Orchestrator
README Demo and Offline section describes the offline toggle and judged demo booth copy but never names the agent harness; noted as missing per B4 scope, docs left untouched.
Pre-existing scope note, not blocking: legacy src/meta/sparkSpec, sparkEngineer, and sparkChat still import META_DEFAULT_SPARK_MODEL (Llama names in the cost table); the agent console path (src/agent plus AgentConsole) is fully pinned to meta-models/muse-spark-open-1026 and never touches the legacy default. Recommend a post freeze rename or removal of the legacy default, not a freeze change.
No blocking defect found. No production changes made. Freeze ready for Nov 4.

### Verification Checklist
- [x] All tests pass (69 files, 809 tests)
- [x] Happy path covered
- [x] Edge cases covered
- [x] Error conditions covered
- [x] No em dashes, double hyphens, or dash equivalents; proper punctuation used
- [x] Phase tests integrate with prior phase tests
- [x] Both builds green with worker chunk (6.62 kB) and wasm asset (193.24 kB)
- [x] Grep proofs recorded (no key, no secret, no dashes, model pinned)

## 2026-10-27 - Phase A Major F2: Test Report (Run gate plus death step behavioral coverage, no production changes)

### Test Results
npm test: 73 files, 852 tests, all passed. Baseline at the prior entry was 809 tests across 69 files. Delta is src/flow/lbmRunGateBehavior.test.ts (5 tests). No production code touched. No commit made.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| lbmRunGateBehavior.test.ts (5) | PASS | Hard block posts notice plus one block log entry with zero run posts, 200 row cap drops oldest, warnings still post run with warn entry, fresh run pre progress failover names no stale step, landed progress still threads the death step |
| all other Node suites (847) | PASS | No regressions, 852 total |

### Coverage Summary
Happy path covered (warn gate allows run with warn notice plus warn log, landed progress threads the death step with step and target).
Edge cases covered (log at 200 rows stays capped with oldest dropped, fresh run reset clears the stale 576 step before failover).
Error conditions covered (hard block at predicted tau floor never posts run, notice plus single block log entry).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 809 prior tests still pass plus 5 new, 852 total).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| (none) | Full suite green on this run, 852 passed | No fix needed |

### Verification Checklist
- [x] All tests pass (73 files, 852 tests)
- [x] Happy path covered
- [x] Edge cases covered
- [x] Error conditions covered
- [x] No em dashes, double hyphens, or dash equivalents; proper punctuation used
- [x] Phase tests integrate with prior phase tests

## 2026-10-28 - Phase 16: Test Report (Settings manual toggle behavioral coverage, no production changes)

### Test Results
npm test: 88 files, 1076 tests, all passed. Baseline at the prior full run was lower; delta on this task is src/ui/settingsManualToggle.test.tsx (11 tests). No production code touched. No commit made.

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| settingsManualToggle.test.tsx (11) | PASS | Rendered checkbox handlers invoked through the real component tree with a minimal hook dispatcher (repo has no DOM renderer); Contours on from fresh speed defaults yields contours true plus streamlines true; Streamlines off yields both false; Streamlines on from cp defaults keeps contours on; uncheck from pinned both on keeps streamlines on; captured patch resolves to user pinned both on; Reset restores contract defaults plus grid auto; reset clears pin back to auto source; closed modal returns null; debug truth table plus VALIDATION and EXPORT inside the debug gate plus telemetry and terminal outside the gate |
| all other Node suites (1065) | PASS | No regressions, 1076 total |

### Coverage Summary
Happy path covered (Contours on from fresh speed defaults pins both overlays on for speed; Streamlines on from cp defaults keeps contours on).
Edge cases covered (second toggle from a pinned pair follows the effective pair; closed modal returns null; debug flag combined with engine flag).
Error conditions covered (Reset from a pinned non default state restores every default field and returns grid to auto; stale pin clears back to the auto source).
No em dashes, double hyphens, or dash equivalents; proper punctuation used.
Phase tests integrate with prior phase tests (all 1065 prior tests still pass plus 11 new, 1076 total).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| settingsManualToggle initial transform (before run) | Filler test removal left a brace mismatch at the end of the new file | Repaired the closing braces; no production impact, suite green |
| (none further) | Full suite green on this run, 1076 passed | No fix needed |

### Verification Checklist
- [x] All tests pass (88 files, 1076 tests)
- [x] Happy path covered
- [x] Edge cases covered
- [x] Error conditions covered
- [x] No em dashes, double hyphens, or dash equivalents; proper punctuation used
- [x] Phase tests integrate with prior phase tests

## 2026-10-28 - E2E Dataset Dry Run e2e01: Test Report (7 case local pilot to merge to verification gate)

### Test Results
Spec generator reported 73 cases (BGK 12, LES 14, airfoil 47) with min tau 0.505407 at naca0012_a00_re1200_airfoil. Filter preserved spec order to 7 cases, all present, no substitution needed. Release pilot ran 6 of 7 completed (1 diverged) in 243.7 seconds total wall. Merge failed closed with exit 2 on 5 phase contract errors, so no manifest was written. Gate on data/lbm/e2e01 reports DATA_FAILURE exit 2 for missing manifest. Raw pilot rows show 5 harmonic valid of 7 measured with median explained 0.749588 on valid rows. Gate does not approve training.

Exact commands use a temp root recorded at /tmp/e2e01_tmp_path.txt (example /tmp/e2e01_hzuwfP). Output lands under that temp root plus gitignored data/lbm/e2e01. No source, spec, or config file was modified.

```
uv run --project training python training/make_sweep_spec_v2.py e2e01 --out <tmp>/cases_full.jsonl
python3 filter to <tmp>/cases.jsonl preserving spec order for the 7 case ids
./rust/gearflow-wasm/target/release/dataset_pilot cases <tmp>/cases.jsonl out <tmp>/raw transient 8000 window 12000
python3 assemble <tmp>/workers/<case_id>/fragment.jsonl plus <tmp>/workers/<case_id>/case/*.f32 from <tmp>/raw
uv run --project training python training/merge_sweep.py e2e01 --spec <tmp>/cases.jsonl --workers <tmp>/workers --out data/lbm/e2e01
uv run --project training python training/verify_lbm_dataset.py data/lbm/e2e01 --out <tmp>/verify
```

### Results Table
| Test | Verdict | Notes |
|------|---------|-------|
| spec 73 cases plus min tau line | PASS | 73 lines, BGK 12 plus LES 14 plus airfoil 47, min tau 0.505407 at naca0012_a00_re1200_airfoil |
| filter 7 ids present in order | PASS | All 7 requested ids found, order preserved, no substitution needed |
| pilot cyl_r020_a00_re020_resolved | PASS | Completed, steady BGK, harmonic invalid as expected |
| pilot cyl_r020_a00_re100_les | PASS | Diverged at step 4800, recorded as data, no retry |
| pilot cyl_r020_a00_re400_les | PASS | Completed, harmonic valid |
| pilot cyl_r020_a00_re700_les | PASS | Completed, harmonic valid |
| pilot block_040_a00_re400_les | PASS | Completed, harmonic valid |
| pilot naca0012_a00_re700_airfoil | PASS | Completed, harmonic valid |
| pilot naca0012_a04_re700_airfoil | PASS | Completed, harmonic valid |
| merge sweep e2e01 | FAIL | Exit 2, failed closed, 5 phase contract errors, no manifest written |
| gate data/lbm/e2e01 | FAIL | Exit 2, DATA_FAILURE, V0 manifest missing |

Per case pilot detail from <tmp>/raw/manifest.jsonl (St is strouhal, Exp is explained_variance, Cyc is harmonic_cycles, Samp is harmonic_samples):

| Case | Status | St | Exp | Cyc/Samp | Valid | Reason | Wall s |
|------|--------|----|-----|----------|-------|--------|--------|
| cyl_r020_a00_re020_resolved | completed | 0.22710 | 0.000000 | 0/0 | false | no_period | 13.89 |
| cyl_r020_a00_re100_les | diverged step 4800 | null | 0 | 0/0 | false | not_shedding | 4.20 |
| cyl_r020_a00_re400_les | completed | 0.23489 | 0.901295 | 6/508 | true | ok | 21.96 |
| cyl_r020_a00_re700_les | completed | 0.23975 | 0.879793 | 6/498 | true | ok | 21.93 |
| block_040_a00_re400_les | completed | 0.15738 | 0.542302 | 6/758 | true | ok | 24.11 |
| naca0012_a00_re700_airfoil | completed | 0.25818 | 0.749588 | 6/524 | true | ok | 79.10 |
| naca0012_a04_re700_airfoil | completed | 0.28121 | 0.633178 | 6/525 | true | ok | 78.45 |

Merge report (data/lbm/e2e01/merge_report.json, status failed, exit 2):

| Field | Value |
|-------|-------|
| total | 7 |
| completed | 1 |
| diverged | 1 |
| setup_error | 0 |
| substituted | 0 |
| harmonic_valid | 0 |
| harmonic_invalid | 1 |
| errors | 5 identical shape: <case_id> malformed phase_ref_step outside [transient, transient plus window] for cyl Re400, cyl Re700, block Re400, naca a00 Re700, naca a04 Re700 |

Measured phase values that the merge rejected (transient 8000, window 12000, window start 20000):

| Case | phase_ref_step | harmonic_window_start | harmonic_extra_steps |
|------|----------------|-----------------------|----------------------|
| cyl_r020_a00_re400_les | 21682 | 20000 | 5080 |
| cyl_r020_a00_re700_les | 23504 | 20000 | 4980 |
| block_040_a00_re400_les | 23979 | 20000 | 7580 |
| naca0012_a00_re700_airfoil | 22089 | 20000 | 5240 |
| naca0012_a04_re700_airfoil | 20287 | 20000 | 5250 |

Gate report (<tmp>/verify/verify_report.json, exit 2):

| Field | Value |
|-------|-------|
| status | DATA_FAILURE |
| exit_code | 2 |
| v8_harmonic.n_valid | absent (no manifest, no usable rows) |
| completed rows | 0 (manifest missing) |
| split sizes | train 0, val 0 (no V3 section emitted on manifest missing path) |
| median manifest_explained_variance over valid rows | undefined (no valid rows through the gate) |
| total warnings | 0 |
| data failures | 1: V0 manifest missing |
| adapter failures | 0 |

Raw measured harmonic summary used only for projection (bypasses the failed merge, not a gate pass):

| Metric | Value |
|--------|-------|
| valid of measured | 5 of 7 (71.4 percent) |
| valid explained values sorted | 0.542302, 0.633178, 0.749588, 0.879793, 0.901295 |
| median over 5 valid | 0.749588 |

### Coverage Summary
Happy path covered (spec generation, ordered filter, 6 completed pilot rows with sha v3 twelve bin layout, worker layout workers per case id with fragment plus case bins matching merge_sweep expectations).
Edge cases covered (steady BGK correctly harmonic invalid with no_period, diverged Re100 preserved verbatim with fragment only and no case dir, high Re LES and airfoil shedding valid with 6 cycles).
Error conditions covered (merge fail closed on phase contract with no manifest and no cases written, gate fail closed on manifest missing with exit 2).
No em dashes, double hyphens, or dash equivalents in prose; proper punctuation used. Code fences hold the exact commands verbatim.
Phase tests integrate with prior phase tests (no prior suite rerun on this dry run task; this entry records the paid pipeline local proof only).

### Failure Analysis
| Test | Root Cause | Suggested Fix |
|------|-----------|---------------|
| merge 5 phase_ref_step rejections | Solver fitting window sits past the main window. Close anchors at step 20000 (transient plus window), extra steps run to about 25000 to 27500, and phase_ref_step records the Cl maximum inside the fitting window (20287 to 23979). Merge check allows only [8000, 20000], and verify V8 repeats the same bound, so every shedding valid row is rejected | Delegate to backend-dev: widen the accepted phase range to the fitting window, for example [transient, transient plus window plus harmonic_extra_steps] or [harmonic_window_start, harmonic_window_start plus harmonic_extra_steps], in both training/merge_sweep.py and training/verify_lbm_dataset.py, with a review of whether phase should instead be reported inside the main window. Do not run the 73 case paid sweep until the merge passes on this 7 case set |
| gate manifest missing | Consequence of the merge failure, not an independent data problem. Failed merge removes manifest and cases, leaving only merge_report.json, so the gate has nothing to certify | Fix the phase contract above, rerun merge, then rerun the gate. No training spend before gate exit 0 |

### Verification Checklist
- [ ] All tests pass (merge exit 2, gate exit 2, gate does not approve training)
- [x] Happy path covered
- [x] Edge cases covered
- [x] Error conditions covered
- [x] No em dashes, double hyphens, or dash equivalents in prose; proper punctuation used
- [x] Phase tests integrate with prior phase tests (dry run only, no suite regression claimed)

### Gate Approval and Runbook Stop Conditions
Gate does not approve training. Exit code is 2, not 0. Harmonic valid count through the gate is 0 usable (manifest missing), which is below the 20 valid threshold. Median explained through the gate is undefined, so the 0.45 threshold cannot be met. All three runbook stop conditions therefore hold in the stop sense: do not spend on training.

Projection from measured rows, stated honestly with uncertainty: 5 valid of 7 measured is 71.4 percent, and a naive scale to 73 cases gives about 52 valid. That naive number is optimistic because the 7 were selected for shedding (3 bluff high Re plus 2 airfoil Re700) plus one known steady invalid plus one known confined Re100 diverged case. The full 73 holds 12 steady BGK rows that should stay harmonic invalid like cyl Re020, plus bluff Re100 rows at the same confined divergence risk seen here, plus unmeasured Re200, Re600, and airfoil Re100, Re400, Re1200 behavior. A stratified read is: high Re shedding looks healthy (5 of 5 shedding candidates valid, median 0.749588 well above 0.45), while steady and Re100 confined rows contribute near zero. Twenty valid across 73 remains plausible if high Re airfoil and bluff shedding hold, but it is not proven by n equals 7, and the merge contract bug blocks any paid sweep conclusion. Rerun this exact 7 case set after the phase range fix and require merge exit 0 plus gate exit 0 before the user spends on the 73 case sweep.
