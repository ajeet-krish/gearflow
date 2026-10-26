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
