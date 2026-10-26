# Architecture
Last updated: 2026-10-26. Phase 3 final, refined anchors with 2412 pair and 9 row list. Solo owner, demo must run offline.

## System Overview
GearFlow is a browser airfoil flow lab. Vite plus TypeScript, no backend, no network at demo time.
Phase 1 gives SDF geometry fixtures on a 128 by 128 grid. Phase 2 gives analytic potential flow (Hess Smith panels for airfoils, analytic doublet plus vortex for cylinder, Poiseuille baseline for duct). Phase 3 adds a learned surrogate provider behind the same frame interface plus a validation panel fed by vendored real datasets.
Text diagram: UI Controls to Frame Source (Analytic or Surrogate) to Render (Canvas plus Particles) to Validation Panel. Meta Orchestrator (Spark, SAM, Image, Glimmer) sits beside the loop for explanation, segmentation, and demo assets. Cache plus Eval Log sits under all calls.

## Components
* Geometry (src/geometry/parametric.ts): NACA 4 digit generator, cosine spacing, polygon plus SDF sign. Canonical TS source, plain node bake script mirrors it with parity test.
* Potential flow (src/flow/potential.ts, analyticFlow.ts, sdf.ts, wake.ts): Hess Smith constant source plus vortex, N 100 to 160 panels. Influence matrix factored once per geometry, backsolve per alpha. Cylinder uses analytic oracle. Wake stays cosmetic, scaled by Cl, never fed back into Cp or Cl.
* Frame source (src/flow/frameSource.ts): single interface over analytic and surrogate backends. UI and render never call providers directly. Deterministic seed phase (seed mod 7) shared across backends.
* Surrogate provider (Phase 3): compact U Net that maps SDF plus mask plus inflow plus alpha encoding to u, v, Cp on 128 by 128. Runs in browser via preprocessed weights or a small TS inference path. Falls back to analytic on load failure. Provider reports backend name, latency, and cached flag per frame.
* Validation panel (Phase 3): compares Cl, Cp stagnation, Cp shoulder, alpha0, and cylinder St against vendored JSON fixtures in fixtures/validation. Shows PASS, WARN, or INFO with tolerance and provenance per metric. No network calls.
* Render (src/render/FlowCanvas.tsx, fieldTexture.ts, particles.ts, colormap.ts): canvas field texture plus advected particles. Reads frames only, never physics.
* Contracts (src/contracts): DemoPack, FlowField, Grid, Geometry, Provenance schemas. DemoPack pins version, meta, files, and pack to flow consistency.
* Meta orchestration (src/meta/fixtures.ts): Spark for plan plus explanation, SAM for geometry masks, Image for demo visuals, Glimmer for fast status copy. Standard mode by default, hash input cache with TTL, cached demo pack for offline judging.

## Data Flow
1. User picks fixture (0012, 2412, cylinder, duct, block) plus alpha and thickness in UI.
2. Frame source selects backend (analytic default, surrogate when enabled and loaded).
3. Backend evaluates u, v, Cp on 128 by 128, masks inside solid via SDF, attaches provenance.
4. Render draws field plus particles. Validation panel integrates Cl from panel Cp and checks named metrics.
5. Meta calls (explanation, labels, assets) check cache first, then live API, then template or cached fallback. Eval log records model, latency, cost, cached flag.

## Surrogate Design (Phase 3)
* Input channels: normalized SDF over chord, solid mask, freestream u and v, alpha encoding tiled over grid. Grid fixed at x in [minus 0.5, 2.0], y in [minus 1.0, 1.0], chord 1, LE at (0,0).
* Output channels: u, v, Cp per cell. Cl derived by panel Cp integration for comparability with analytic path.
* Training data: analytic sweeps (alpha minus 4 to 12 deg, thickness 0.06 to 0.18) plus vendored validation anchors as held out checks, never as train targets for the reported metric. Leakage statement lives in docs/DATA_SOURCES.md.
* Inference budget: single frame under 100 ms on laptop CPU after warmup, Float32 path, frame cache by (fixture, alpha, backend).
* Sync path limitation (Phase 3 review): the exact TS forward pass in
  src/flow/surrogate.ts runs synchronously on the UI thread, so the
  production 128 by 128 shape can exceed one frame and freeze interaction.
  Mitigations in place: frame cache (repeat getFrame calls are free),
  analytic fallback on any inference throw, latency surfaced per frame in
  SurrogateMeta. A latency gate test pins sub 100 ms inference at the 8 by 8
  base-2 test shape only. The real fix is the async ONNX path in Phase 4
  (pinned onnxruntime-web runs model.onnx off the frame loop).
* Interface: predictSDF(input) to Frame, mirrored on analytic signature so A/B comparison and fallback stay trivial.
* Scope guard: inviscid training means Cd stays 0 by construction. Cd is displayed as not validated, never tuned to match viscous data.
* Sync TS conv limitation: unetForward is a synchronous triple loop, so a
  full 128 by 128 production frame can block the UI thread. The 100 ms
  budget is currently gated only at the 8 by 8 base-2 test shape
  (src/phase3.review-fixes.test.ts). Frame cache plus debounce plus the
  analytic fallback keep the demo interactive; the async ONNX provider is
  the Phase 4 fix.

## Validation Design (Phase 3, final)
* Vendored fixtures only: 13 files under fixtures/validation, committed to repo. CSV is primary ingest, TXT is fallback, TMR DAT uses Fortran D exponents, Selig DAT gives coordinates. Manual download checklist, no fetch at runtime. Raw files kept as is, JSON is what the panel reads.
* Validation case list is 9 rows. List below. 2412 pair added to prior 7. Re 100k rows stay WARN only (bubble kink near 1 to 2 deg). Cylinder St, Cd, and Cl amplitude are INFO rows. Cd is NOT validated for any airfoil (inviscid gives 0 by construction). AK Vortex removed from exit criteria.
* Row 1: 0012 Re 500k absolute Cl at 4, 6, 8 deg, PASS within 0.05. Row 2: 0012 Re 100k Cl, WARN only. Row 3: 2412 Re 500k absolute Cl at 4, 6, 8 deg, PASS within 0.05. Row 4: 2412 Re 100k Cl, WARN only. Row 5: 2412 alpha0 theory minus 2.07, PASS within 0.25 deg. Row 6: 2412 alpha0 experimental minus 2.29 from 500k fit, INFO reference. Row 7: cylinder St 0.164 to 0.167, INFO. Row 8: cylinder mean Cd 1.32 to 1.38, INFO. Row 9: cylinder Cl amplitude 0.32 to 0.35, INFO.
* Clean airfoil anchors: XFOIL NACA 0012 Re 500k Ncrit 9 plus XFOIL NACA 2412 Re 500k Ncrit 9. Re 100k for both airfoils is WARN display with bubble note. Absolute Cl check uses 4, 6, 8 deg within 0.05. Slope check uses 4 to 8 deg segment to avoid the kink. 2412 uses absolute Cl PASS, not slope percent (viscous slope sits about 18 percent below inviscid, so percent check fails honestly).
* High Re anchors: NASA TMR 2DN00 Ladson tripped force data at Re 6M M 0.15, Gregory Cp at Re 2.88M (upper surface only, not 6M), McCroskey best fit slope 0.1075 per deg at Re 6M M 0.15.
* Cylinder anchor: analytic oracle Cp equals 1 minus 4 sin squared theta is PASS (stagnation 1.0 within 0.05, shoulder minus 3.0 within 0.05). Free Re 100 literature band St 0.164 to 0.167, mean Cd 1.32 to 1.38, Cl peak amplitude 0.32 to 0.35 are INFO rows (no unsteady solver in scope). DFG channel benchmark excluded (confined channel, blockage, parabolic inflow, different physics).
* Alpha0: NACA 0012 expects 0. NACA 2412 has two rows: theory minus 2.07 (PASS target within 0.25 deg) plus experimental fit from 500k polar minus 2.29 (INFO reference, zero crossing between minus 2.5 and minus 2.25). Intercept from linear fit on minus 2 to 6 deg. Re 100k 2412 intercept near minus 1.30 is distorted, WARN only.
* Tier logic: PASS means within tolerance and demo ready. WARN means outside PASS but within review band, still demoable with a note. INFO means display only, never fails.
* PASS thresholds: Cl absolute within 0.05 versus XFOIL Re 500k at 4, 6, 8 deg for both 0012 and 2412. Cl slope within 5 percent of 2 pi (0.1097 per deg) below 8 deg on 0012 high Re bridge only. McCroskey slope 0.1075 per deg within 5 percent. Cp stagnation 1.0 within 0.05. Cylinder shoulder minus 3.0 within 0.05. Alpha0 within 0.25 deg (0012 at 0, 2412 theory at minus 2.07).
* WARN items: XFOIL Re 100k rows for 0012 and 2412 (bubble kink near 1 to 2 deg, never PASS). Review band at about twice PASS tolerance, still demoable with a note.
* INFO items: viscous suction peaks (Gregory minus 5.2 at 10 deg, minus 10.2 at 15 deg, inviscid overshoots so lower bound only), Cd values for all airfoils (never PASS), transition locations Top_Xtr and Bot_Xtr, cylinder St band plus Cd mean plus Cl amplitude, 2412 experimental alpha0 minus 2.29 reference.
* Ingest parsers (final): AirfoilTools CSV is primary (10 line metadata, header Alpha,Cl,Cd,Cdp,Cm,Top_Xtr,Bot_Xtr on line 11, comma rows). TXT is fallback (12 line header, whitespace rows of 7 floats). TMR DAT files are Tecplot style with comment lines, variables line, zone headers, then float rows, Fortran D exponents converted to E before parse. Selig coordinate DAT files are plain text (optional header plus x y pairs, TE to TE loop).
* Exit criteria: AK Vortex removed from exit criteria. Di Ilio hybrid LBM values stay as background reference only. Panel display shows expected, got, tolerance, source file, tier for the 9 listed rows.

## Technology Decisions
* Client: Vite plus TypeScript plus Canvas. Reason: solo scope, zero backend, fast demo.
* Flow core: TS Hess Smith plus analytic cylinder. Reason: deterministic, testable, under 100 ms.
* Surrogate: compact U Net behind frame interface. Reason: same UI path, A/B ready, offline weights.
* Validation: vendored JSON, no runtime fetch. Reason: offline judging, leakage control.
* Meta AI: Standard mode, cache then fallback. Reason: privacy default, survives network loss.

## API Strategy
* Base URL: https://api.meta.ai/v1
* Standard mode by default. Contributor mode only with explicit consent and labeling.
* Caching: hash inputs, set TTL, serve stale on failure. Preload cached responses for live demo.
* Offline fallback: cached demo pack runs full script with zero network. One click toggle.
* Fallback chain: SAM to box heuristic, Spark to template, Image to cached asset, surrogate to analytic.
* Keys in env only, sample env file, no secrets in repo.

## Geography and Offline Fallback
* Handle ET plus UTC times, locale aware copy.
* Cached demo pack for judging network issues. Required for solo live demo.
* Low bandwidth mode: text first, images lazy, clear status copy.
* Solo maintainability: single owner stack, minimal ops, pinned versions, one command setup.
