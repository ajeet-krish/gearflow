# GearFlow Test Results
Last updated: 2026-10-26

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
