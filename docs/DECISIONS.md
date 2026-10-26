# Decisions Log
Append only. Add new entries at bottom with date. Never rewrite history.

## Format
* Date:
* Context:
* Options considered:
* Decision:
* Impact (judging link):

## Entries

### 2026-10-26 Track selection pending
* Date: 2026-10-26
* Context: Need to choose Indie versus Startup lens and theme (Build for Your World or Push the Frontier).
* Options considered: Indie craft demo, Startup production path.
* Decision: Pending. Await brainstorm and feasibility check.
* Impact (judging link): Shapes Impact story and Technical Depth scope.

### 2026-10-26 Chose Solo Indie Push the Frontier
* Date: 2026-10-26
* Context: Participant profile locked as solo entrant in Indie track with Push the Frontier theme. Virtual worldwide, build Oct 26 to Nov 4 2026.
* Options considered: Solo Indie frontier craft versus team Startup production path versus Build for Your World local utility.
* Decision: Enter solo in Indie track on Push the Frontier theme. Single submitter lists self only.
* Rationale: Solo avoids teammate acceptance risk and keeps scope controllable in 10 days. Frontier fits technical ambition and multi model orchestration (Spark plus SAM plus Image).
* Impact (judging link): Shapes Impact story around frontier leap plus Indie creativity lens, and Technical Depth around working proof with cached fallback.

### 2026-10-26 Phase 3 surrogate provider behind frame interface
* Date: 2026-10-26
* Context: Need a learned U Net path that the UI can A/B against analytic flow without forking render code, and that degrades cleanly when weights fail to load.
* Options considered: Separate surrogate render path versus single frame interface with analytic and surrogate backends.
* Decision: Single frame interface (`predictSDF(input): Frame`) with analytic default and surrogate opt in. Surrogate maps SDF plus mask plus inflow plus alpha encoding to u, v, Cp on 128x128. Fallback to analytic on load failure with provenance flag.
* Impact (judging link): Technical Depth (clean abstraction, offline fallback) and Demo (one toggle A/B moment).

### 2026-10-26 Vendored validation fixtures, no runtime fetch
* Date: 2026-10-26
* Context: Demo must survive network loss and validation numbers must not drift with upstream site changes.
* Options considered: Live fetch from AirfoilTools or NASA at runtime versus committed JSON fixtures under fixtures/validation.
* Decision: Commit all validation numbers as JSON fixtures with a manual download checklist. Validation panel reads local files only.
* Impact (judging link): Demo robustness plus Technical Depth (reproducible checks).

### 2026-10-26 XFOIL Re 100k as primary airfoil anchor
* Date: 2026-10-26
* Context: Need a low Re anchor closest to inviscid comparison plus a high Re bridge for slope checks.
* Options considered: XFOIL NACA 0012 Re 100k Ncrit 9 primary with Re 500k bridge versus NASA TMR 6M as primary.
* Decision: XFOIL Re 100k primary (tolerance plus/minus 0.05 absolute on Cl below 8 deg), NASA TMR Ladson tripped plus Gregory Cp as high Re asymptotic anchor (5 percent slope band, Cp stagnation 1.0 plus/minus 0.05).
* Impact (judging link): Technical Depth (honest regime matched validation).

### 2026-10-26 Free cylinder Re 100 anchor, DFG excluded
* Date: 2026-10-26
* Context: Cylinder check needs an unsteady free cylinder reference, not a blocked channel benchmark.
* Options considered: Free cylinder literature band (St 0.164 to 0.167, mean Cd 1.32 to 1.37) versus DFG 2D-2 channel values.
* Decision: Use free cylinder band (Williamson, Henderson) for St and Cd. Exclude DFG channel Cd near 3.18 as a different config with blockage and parabolic inflow.
* Impact (judging link): Technical Depth (correct comparator, avoids false fail).

### 2026-10-26 Cd excluded from inviscid validation, AK Vortex as LBM cross check
* Date: 2026-10-26
* Context: Inviscid core gives Cd 0 by construction, so matching viscous drag would be tuning theater. Still need a viscous regime sanity path.
* Options considered: Validate Cd against XFOIL versus mark Cd not validated and cross check LBM regime separately.
* Decision: Mark Cd not validated on the inviscid path. Add AK Vortex cross checks (NACA 0012 Re 1000 and 2000 alpha 0 Cd, alpha 4 and 8 deg onset) referencing Di Ilio hybrid LBM data.
* Impact (judging link): Technical Depth (no overclaim, explicit scope guard).

### 2026-10-26 Phase 1 geometry and flow review FAILs fixed (backend-dev)
* Date: 2026-10-26
* Context: code-reviewer FAIL on Phase 1 geometry/flow: regenerated polygon per cell, TS/script seed divergence, untested alpha sign, missing validation, unhandled duct kind, hardcoded wake centreline, duplicated fixture logic.
* Options considered: shared TS import for fixture script versus mirror plus parity test.
* Decision: Mirror plus parity test (script stays plain node, TS is canonical, src/flow/fixtures.parity.test.ts guards drift). Hoisted polygon, unified seed phase (seed % 7), aerodynamic alpha sign (positive nose up, negated math angle, TE down in y-up), duct wall mask plus block parity, 5 fixtures per RESEARCH.md, removed misleading 128x64 alias, extended validators (geometry ranges, DemoPack version/meta/files, pack/flow consistency, airfoil points).
* Rationale: Keeps fixture baking dependency free while making drift fail loudly in CI. Duct as channel constriction matches RESEARCH.md promise without Phase 2 solver scope.
* Impact (judging link): Technical Depth (deterministic, tested fixtures) and Demo (correct AoA visual, 5 cases).

### 2026-10-26 XFOIL Re 500k promoted to clean PASS anchor, Re 100k to INFO
* Date: 2026-10-26
* Context: Researcher ingest showed XFOIL Re 100k has a laminar separation bubble kink near 1 to 2 deg (Cl jumps from 0.2578 at 1.0 to 0.3737 at 2.0), so a pointwise PASS on Re 100k would fail honestly computed inviscid results.
* Options considered: Keep Re 100k as primary PASS anchor versus demote Re 100k to INFO and promote Re 500k to clean PASS anchor on the 4 to 8 deg segment.
* Decision: Promote Re 500k to clean PASS anchor (slope within 0.05 absolute on 4 to 8 deg segment). Keep Re 100k as INFO display with bubble note. Slope fit must skip the kink.
* Rationale: Re 500k transition moves forward cleanly (Top_Xtr 0.79 down to 0.05) and avoids bubble theater. Keeps validation honest about low Re viscous effects.
* Impact (judging link): Technical Depth (regime matched validation, no false fail).

### 2026-10-26 Correct TMR Reynolds labels plus McCroskey slope anchor
* Date: 2026-10-26
* Context: Ingest verification showed Gregory Cp is Re 2.88M upper surface only, not 6M. Ladson force data is Re 6M M 0.15. McCroskey file is a 2 point fit with slope 0.1075 per deg at Re 6M M 0.15.
* Options considered: Leave combined 6M label versus split labels with separate provenance per file.
* Decision: Split labels. Ladson stays Re 6M tripped force PASS anchor. Gregory labeled Re 2.88M with suction peaks as INFO lower bounds only. McCroskey slope 0.1075 per deg added as PASS anchor within 5 percent.
* Rationale: Wrong Reynolds label would mislead judges and break trust in the validation panel. Split labels match TMR guidance (prefer Ladson tripped plus Gregory Cp).
* Impact (judging link): Technical Depth (correct provenance) and Demo (accurate validation copy).

### 2026-10-26 Refine cylinder Re 100 band, reaffirm DFG exclusion
* Date: 2026-10-26
* Context: Refined literature band is St 0.164 to 0.167, mean Cd 1.32 to 1.38, Cl peak amplitude 0.32 to 0.35. DFG channel values (Cd near 3.22, St near 0.30) remain a different config.
* Options considered: Keep prior narrower Cd top 1.37 and Cl top 0.34 versus widen to 1.38 and 0.35 per full literature spread.
* Decision: Adopt widened band (Cd top 1.38, Cl amplitude top 0.35) with uncertainty note (about 3 percent on St, 5 percent on Cd). Keep DFG excluded with blockage note.
* Rationale: Wider band reflects domain and span effects across Williamson, Henderson, and tutorial sources. Avoids brittle failures on honest results.
* Impact (judging link): Technical Depth (correct comparator).

### 2026-10-26 Adopt PASS WARN INFO tiers plus parser specs and theory alpha0
* Date: 2026-10-26
* Context: Binary pass or fail would punish display only items (suction peaks, Cd, Re 100k bubble) that inviscid theory cannot match. Parsers also need exact specs (TXT 12 line header, CSV 10 line metadata, TMR Tecplot zones with Fortran D exponents). NACA 2412 alpha0 must cite theory minus 2.07, not experiment.
* Options considered: Binary pass or fail on all metrics versus tiered PASS WARN INFO with explicit thresholds and display only INFO.
* Decision: Adopt tiers. PASS is demo ready tolerances (slope 5 percent or 0.05 absolute, stagnation within 0.05, shoulder within 0.05, alpha0 within 0.25 deg, St in band). WARN is about twice PASS tolerance for review. INFO covers Re 100k bubble, suction peaks, Cd, transition locations and never fails. Document parsers (whitespace split, comma split after line 11, zone split with D to E conversion). Set 2412 alpha0 to theory minus 2.07.
* Rationale: Tiers let the panel stay green on honest physics while still flagging drift. Parser specs make ingest reproducible for a solo owner. Theory alpha0 matches the inviscid comparator.
* Impact (judging link): Technical Depth (honest validation UX) and Demo (panel never red screens on known physics).

### 2026-10-26 Final Phase 3 with 2412 pair, 9 row list, absolute Cl PASS
* Date: 2026-10-26
* Context: Researcher vendored NACA 2412 Re 100k and 500k polars plus Selig coordinates and extracted even alpha Cl plus dual alpha0 values. Panel needs an explicit 9 row list (prior 7 plus 2412 pair) with honest tiers.
* Options considered: Slope percent check for 2412 versus absolute Cl check versus no 2412 validation.
* Decision: Add 2412 pair as Row 3 (Re 500k absolute Cl PASS within 0.05 at 4, 6, 8 deg) and Row 4 (Re 100k WARN only). Use absolute Cl PASS for 2412 because viscous 4 to 8 deg slope 0.0899 per deg sits about 18 percent below inviscid 0.1097, so slope percent fails honestly. Keep 0012 slope percent only on high Re bridge plus McCroskey. Full 9 rows: 0012 500k PASS, 0012 100k WARN, 2412 500k PASS, 2412 100k WARN, 2412 theory alpha0 PASS, 2412 experimental alpha0 INFO, cylinder St INFO, cylinder Cd INFO, cylinder Cl amplitude INFO. Cd NOT validated for any airfoil. AK Vortex removed from exit criteria.
* Rationale: Absolute check passes real 2412 data (deltas +0.043, +0.011, minus 0.036 at 4, 6, 8 deg) while slope percent would force a false red. WARN on Re 100k respects the bubble kink. INFO on cylinder unsteady band respects no unsteady solver scope.
* Impact (judging link): Technical Depth (regime matched validation, no overclaim) and Demo (panel stays green with honest notes).

### 2026-10-26 Lock parsers with CSV primary plus dual 2412 alpha0 rows
* Date: 2026-10-26
* Context: Ingest must be reproducible across 13 vendored files with Fortran quirks and Selig headers. 2412 alpha0 needs both theory and measurement without conflating them.
* Options considered: TXT primary versus CSV primary, single alpha0 value versus dual rows.
* Decision: Lock CSV as primary ingest and TXT as fallback (TXT 12 line header with whitespace rows, CSV 10 line metadata with header on line 11, TMR DAT with Tecplot zones and D to E conversion, Selig DAT with optional header plus x y pairs). Keep two separate 2412 alpha0 rows: theory minus 2.07 as PASS target within 0.25 deg plus experimental minus 2.29 from 500k zero crossing as INFO reference. Re 100k intercept near minus 1.30 stays WARN only.
* Rationale: CSV primary avoids whitespace fragility and matches AirfoilTools export. Dual alpha0 rows keep theory target for the inviscid comparator while preserving the measured intercept for trust.
* Impact (judging link): Technical Depth (reproducible ingest, correct provenance) and Demo (accurate validation copy).

### 2026-10-26 Phase 3 review remediation (Majors plus High/Medium)
* Date: 2026-10-26
* Context: Code review flagged insecure checkpoint loading, quote-split TMR variables, unverified weights SHA, dead leakage guard, base-ignored UNet layers, sync UI freeze risk, uncapped manifests and parsers, trusted committed JSON, INFO tier throw on infinite tolerances, unvalidated provider inputs, unpinned training versions, duplicated flatteners.
* Options considered: Minimal targeted patches per item versus broader refactors (worker thread now, full async provider now).
* Decision: Targeted patches: torch.load weights_only=True, quote-aware TMR tokenize with row width checks plus fixture rebake, sha256 verification with basename allowlist and byte cap, reserved anchor exclusion in gen_dataset plus real dataset assertion, base-built UNet layers, latency gate test at 8x8 with documented production risk (async ONNX stays Phase 4), manifest base/grid/norm/sha hardening with constructor validation, parser and dataset size caps mirrored in ingest script, metrics and tiers edge guards (INFO returns before tolerance checks), exact-circle SDF via resolveBody, single Gregory flattener, pinned Modal versions with arg ranges.
* Rationale: Keeps Phase 3 demo runnable offline while closing the security and correctness holes the review requires. Worker plus full async provider are larger Phase 4 work with the pinned onnxruntime-web dependency.
* Impact (judging link): Technical Depth (verified weights, honest validation, reproducible ingest) and Demo (no UI freeze surprise, fallback stays clean).

### 2026-10-26 Production sync inference gated to analytic fallback (async ONNX is the real fix)
* Date: 2026-10-26
* Context: Review Major on sync conv freeze: the exact TS U-Net forward pass is O(cells times base squared), so production weights (128x128, base 32, about 1.8M params and 2.5G MACs) would block the UI thread for seconds on every frame. A full Web Worker plus async provider is Phase 4 scope.
* Options considered: Full Web Worker plus async ONNX provider now versus a sync cost gate with honest fallback versus leaving the freeze undocumented.
* Decision: Added a sync budget gate (MAX_SYNC_CELLS_TIMES_BASE 65536, helper syncInferenceAllowed): SurrogateFlowProvider.getFrame runs the sync forward pass only when nx times ny times base fits the budget, else it serves the analytic fallback with meta.backend analytic-fallback. Test shapes (8x8 any base, 128x128 base 2) still run the surrogate path; production 128x128 base 32 falls back in under 500ms (pinned by a latency gate test). The async ONNX path via the pinned onnxruntime-web dependency is the real fix and stays Phase 4 work.
* Rationale: Keeps the demo interactive and the provenance badge honest without pretending the sync path can carry production weights. The gate is a documented stopgap, not the architecture.
* Impact (judging link): Technical Depth (honest perf envelope, tested fallback) and Demo (no UI freeze on the surrogate toggle).

### 2026-10-26 Phase 3 re-review Low items closed
* Date: 2026-10-26
* Context: Phase 3 re-review left 4 residual Low items (weight download byte cap, weightsOverride norm positivity, null zone/point guards in datasets, reserved-anchor check scope plus install pinning).
* Options considered: Defer Lows to Phase 4 versus close them now with targeted guards.
* Decision: Closed all 4 now. Surrogate weights fetch pre-checks Content-Length against MAX_WEIGHTS_BYTES before arrayBuffer (post-download cap kept as fallback, FetchFn type exposes optional headers). WeightsOverride norm gets the same std positivity check as validateManifest. asTmr and asCoords throw datasets errors on null or non-object zone and point elements. assert_no_leakage keeps the disjoint-ID check for both splits but scopes the reserved-anchor check to train only (val holds reserved anchors by construction). pyproject.toml documents lock-only installs via uv sync --locked with Modal exact pins noted.
* Rationale: All closable without architecture change, keeps the review record clean heading into Phase 4 Meta orchestration.
* Impact (judging link): Technical Depth (no open review items, honest provenance).

### 2026-10-26 Proxy key handling for Meta calls
* Date: 2026-10-26
* Context: Browser calls to Meta API must not ship MODEL_API_KEY in the bundle. Key format is LLM id secret, per app keys, env only.
* Options considered: Direct browser calls with env injected at build time versus thin server proxy that injects the key per request.
* Decision: Thin server proxy at POST /api/meta with key from env, per session rate limit, key stripped from client. Browser MetaClient sends model plus payload only. Sample env documents the variable, repo holds no real key.
* Impact (judging link): Technical Depth (key safety) and Demo (live calls work without leaking secrets).

### 2026-10-26 SAM custom polygon path with physics mask authoritative
* Date: 2026-10-26
* Context: SAM masks are visual quality, but the flow mask must stay exact for Cp and Cl. Need a blend that keeps physics exact while showing SAM value.
* Options considered: SAM mask as flow mask versus SAM box plus parametric polygon clamp intersected with SDF mask.
* Decision: Keep SDF plus polygon mask authoritative for physics. SAM output becomes a visual overlay plus label layer. Custom path clamps SAM box to the parametric polygon then intersects with SDF. Fallback chain is SAM mask to polygon heuristic to full frame box, never blocking render.
* Impact (judging link): Technical Depth (no physics drift) and Demo (visible SAM wow with safe fallback).

### 2026-10-26 Cache TTLs plus serve stale plus EvalLog
* Date: 2026-10-26
* Context: Live demo must survive network loss and stay cheap on 150 USD credits. Need TTLs that match content volatility plus transparent cost logging.
* Options considered: No client cache with live only versus single TTL for all models versus tiered TTL with serve stale and per call eval log.
* Decision: Tiered HashCache keyed by sha256 of model plus prompt plus params. Spark text 24h, SAM masks 7d, Image assets 7d. Serve stale on failure with cached badge. EvalLog ring buffer cap 200 records model, latency, tokens, cost, cached flag, fallback reason. Panel footer shows session cost and hit rate.
* Impact (judging link): Demo (offline safe) and Technical Depth (measured cost and latency).

### 2026-10-26 Offline pack as one click judging fallback
* Date: 2026-10-26
* Context: Judging network can fail. The full Meta script must run with zero network on one toggle.
* Options considered: Live only with apologies versus prefetched heroes only versus full OfflinePack with manifest plus cached Spark answers for presets plus SAM rasters for 5 fixtures plus images plus validation JSON.
* Decision: Build full OfflinePack with manifest. MetaPanel offline toggle short circuits Spark, SAM, and Image to pack entries. EvalLog marks entries cached. Prefetch 2 to 3 Image heroes to /public at build time, live generation only on explicit action.
* Impact (judging link): Demo (stage safe) and Meta Tooling (orchestration still visible while offline).

### 2026-10-26 Phase 4 review fixes, proxy hardening plus cache and schema caps
* Date: 2026-10-26
* Context: Phase 4 code and security reviews returned FAIL with 5 Majors, 1 High, 4 Mediums, 5 Lows across the proxy, eval log, SAM path, solver Kutta, offline pack, cache, poster URL, and schema caps.
* Options considered: Defer to Phase 5 versus fix all High and Major items plus Mediums and Lows in one pass with regression tests.
* Decision: Fixed all 13 items. Proxy allowlists 3 POST paths with same origin check, per IP rate limit, 10 MiB body cap with 413, upstream timeout, response cap, generic errors. EvalLog stores payload hash verbatim and the cache layer reports cached hits. SAM hashes full bytes via SHA-256, never caches fallbacks, validates fallback polygons, caps sketches at 5 MiB PNG/JPEG, validates dims and bbox, finite checks iou and confidence, maps AbortError to timeout. Custom closed airfoils get Kutta. Offline pack ships public/offline-pack/index.json with 2 baked cases and wires into App offline state. HashCache is LRU capped at 100 with expiry purge and persist cap plus namespaced clear. Poster URLs allowlist https and sized png base64. Schema enforces chord 1, magnitude bounds, SAM y bounds, Spark nPoints 160, and provider string caps. Monaco preset corrected to m 0.06, FlowControls derives display code, extractContent threads feature, masthead reads Phase 4.
* Impact (judging link): Technical Depth (closed review gate, 308 tests green) and Demo (offline safe, honest ledger).
