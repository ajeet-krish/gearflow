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
