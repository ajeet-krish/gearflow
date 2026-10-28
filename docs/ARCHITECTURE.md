# Architecture
Last updated: 2026-10-26. Phase 8 Zenith shell plus Phase 7 Rust WASM path. Phases 1 to 6 complete, Phase 7 and Phase 8 complete. Solo owner, demo must run offline.

## System Overview
GearFlow is a browser airfoil flow lab. Vite plus TypeScript, no backend at demo time except a thin Meta proxy for key safety.
Phase 1 gives SDF geometry fixtures on a 128 by 128 grid. Phase 2 gives analytic potential flow (Hess Smith panels for airfoils, analytic doublet plus vortex for cylinder, Poiseuille baseline for duct). Phase 3 adds a learned surrogate provider behind the same frame interface plus a validation panel fed by vendored datasets.
Phase 4 adds Meta orchestration beside the loop for explanation, segmentation, and demo assets. Text path: UI Controls to Frame Source (Analytic or Surrogate) to Render (Canvas plus Particles) to Validation Panel. Meta path: MetaPanel to Proxy to MetaClient (Spark, SAM, Image) with HashCache plus EvalLog under all calls, OfflinePack as fallback.
Core loop never blocks on Meta. Every Meta call has a cached or template fallback and a visible status badge.

## Components (core loop, unchanged)
* Geometry (src/geometry/parametric.ts): NACA 4 digit generator, cosine spacing, polygon plus SDF sign. Canonical TS source, plain node bake script mirrors it with parity test.
* Potential flow (src/flow/potential.ts, analyticFlow.ts, sdf.ts, wake.ts): Hess Smith constant source plus vortex, N 100 to 160 panels. Matrix factored once per geometry, backsolve per alpha. Cylinder uses analytic oracle. Wake stays cosmetic, scaled by Cl, never fed back into Cp or Cl.
* Frame source (src/flow/frameSource.ts): single interface over analytic and surrogate backends. UI and render never call providers directly. Deterministic seed phase (seed mod 7) shared across backends.
* Surrogate provider (src/flow/surrogate.ts): compact U Net behind the same frame signature. Sync gate allows small shapes only, production 128 by 128 with base 32 serves analytic fallback with honest provenance. Async ONNX path is Phase 4 work.
* Validation panel (src/ui/ValidationPanel.tsx plus src/validation): compares Cl, Cp stagnation, Cp shoulder, alpha0, cylinder St against vendored JSON in fixtures/validation. Shows PASS, WARN, or INFO with tolerance and provenance per metric. No network calls.
* Render (src/render/FlowCanvas.tsx, fieldTexture.ts, particles.ts, colormap.ts): canvas field texture plus advected particles. Reads frames only, never physics.
* Contracts (src/contracts): DemoPack, FlowField, Grid, Geometry, Provenance schemas. DemoPack pins version, meta, files, and pack to flow consistency.

## Frontend Shell (Phase 8 Zenith instrument room)
* Top navbar (src/ui/TopNav.tsx): 56px tall instrument bar with GearFlow wordmark, STUDIO/VALIDATE/EXPORT nav links, offline chip, theme icon, plus WASM badge when the Rust backend is live.
* Left agent rail (src/ui/AgentConsole.tsx in src/App.tsx railLeft, default 320px resizable): full height transcript with a pinned composer, offline aware, backed by MetaClient plus HashCache plus EvalLog.
* Right analysis rail (src/ui/AnalysisPanel.tsx plus src/ui/AnalysisSection.tsx, default 320px resizable): five stacked collapsible windows that stay mounted when collapsed, GEOMETRY (src/ui/FlowControls.tsx), DISPLAY (src/ui/DisplayControls.tsx), VALIDATION (src/ui/ValidationPanel.tsx), EVAL LEDGER (src/ui/EvalLogPanel.tsx), EXPORT (src/ui/ExportBar.tsx). Navbar VALIDATE and EXPORT links open the matching window.
* Center tunnel column (src/App.tsx tunnelCol): three pinned bars above an edge to edge FlowCanvas (src/render/FlowCanvas.tsx). SOLVER bar (src/ui/SolverBar.tsx) for backend, body, alpha, Re, grid, live state. FIELD bar (src/ui/FieldBar.tsx) for quantity, layers, particles, colormap name. TELEMETRY bar (src/ui/TelemetryBar.tsx) for engine, grid, cells, solve time, Cl, CpMin, regime, provenance, validation counts.
* Tunnel overlays: bottom left RUN card (body, alpha, Re, grid, regime summary) and bottom right vertical colorbar (src/ui/VerticalColorbar.tsx, 8 stop gradient with ticks at max, 75, 50, 25, min). Both are overlays inside the tunnel element, so the field stays full bleed.

## Solver Backends (analytic plus Rust WASM, Phase 7)
* Analytic default (src/flow/frameSource.ts AnalyticFlowProvider): Hess Smith panels plus analytic cylinder, matrix factored once per geometry, wake rebuilt on Re change. Panel cache survives Re only updates via geometriesEqual early return.
* Rust WASM path (rust/gearflow-wasm plus src/flow/wasmFlowProvider.ts WasmFlowProvider, factory src/flow/createFlowProvider.ts, loader src/flow/wasmLoader.ts): wasm-pack web output checked in under src/wasm/pkg. Loader uses a static dynamic import of @/wasm/pkg/gearflow_wasm, so Vite bundles the glue chunk and emits a dist/assets/gearflow_wasm_bg hashed wasm asset plus the glue chunk in production. Loader is a singleton that never throws, missing pkg resolves false for TS fallback.
* Provider lifecycle: created once per grid via createFlowProvider when ?wasm=1 is set, kept alive across slider moves, driven by the App solved memo through setGeometry plus setRe. Re only changes reuse cached panels and rebuild the field. Any WASM fault latches wasmFailed to the TS analytic fallback with honest provenance (analytic fallback label, no WASM badge, fallback notice in the tunnel).

## Phase 4 Meta Orchestration (new)
Design goal: visible multi model value (Spark reasoning, SAM segmentation, Image visuals) with Standard mode default, cache first, offline pack fallback, and keys never in the browser bundle.

### MetaClient (src/meta/metaClient.ts, new)
* Single fetch wrapper for all Meta calls. Base URL https://api.meta.ai/v1. Timeout 20s, one retry on 429 or 5xx with backoff, typed errors (Auth, RateLimit, SafetyBlock, Network).
* Takes proxy path only (default /api/meta). Never reads MODEL_API_KEY directly in browser code. Sends model plus payload plus cache key hint, receives JSON plus usage (input, output, cached tokens).
* Records every call into EvalLog before returning. Returns tagged union (ok with data plus usage, fallback with reason) so UI never throws on Meta failure.
* Uses OpenAI compatible shape: base URL override plus Bearer token injected server side by the proxy.

### HashCache (src/meta/hashCache.ts, new)
* Key is sha256 of canonical JSON (model plus endpoint plus prompt plus params). Value holds response JSON plus saved at plus TTL plus cost plus model.
* Two layers: in memory Map for session speed plus localStorage for reload persistence. Namespaced keys (gearflow:spark, gearflow:sam, gearflow:image).
* TTL: Spark text 24h, SAM masks 7d, Image assets 7d. Serve stale on failure: if live call fails and any cached entry exists, return stale with cached flag true and a status note.
* Keyed helpers: getOrFetch for Spark, getImageOrFetch for Image with blob URL cache, getMaskOrFetch for SAM with raster cache.

### EvalLog (src/meta/evalLog.ts, new)
* Ring buffer (cap 200 entries) in memory plus localStorage persistence. Per call: timestamp, model, endpoint, latency ms, input plus output tokens, cost USD, cached flag, fallback reason or empty.
* Cost math: Spark Standard input 1.25 per M (cached 0.15 per M) plus output 4.25 per M. SAM image 0.0025 each, video frames 0.0002 each with 50 frame minimum. Image 0.01 each, failures and safety blocks free.
* Exported with OfflinePack manifest and shown in MetaPanel footer (total cost this session, cache hit rate). Used for judging transparency.

### SparkSpec plus SparkEngineer (src/meta/spark.ts, new)
* Model muse-spark-1.3 Standard. Temperature 0, reasoning effort low, structured output via json schema (Responses text format or Chat Completions response format, strict false, additionalProperties false, all keys in required list).
* SparkSpec: natural language to geometry spec. Input example (NACA 2412 at 6 deg, thicken a touch). Output validated against Geometry schema before it touches frame source. Invalid spec returns template default (0012 at 0) with a notice.
* SparkEngineer: coach explanation. Stable system prompt first, volatile frame numbers last, prompt cache key gearflow-coach with 24h retention. Cites live Cl, Cp min, alpha0 from validation metrics. Short copy for stage (2 sentences) plus expandable detail.
* Presets (src/meta/presets.ts): curated prompts (explain stall onset, compare 0012 versus 2412 at 6 deg, classroom one liner for lift). Presets are the prefetch list for OfflinePack.

### SamSegment (src/meta/sam.ts, new)
* Model sam-3.1 via POST /v1/responses. Image input plus noun phrase (naca airfoil, wind tunnel model). Video path reserved, not in demo scope.
* Parse with streaming accumulate then parser plus raster decode to Uint8Array (H times W, row major). Confidence kept only when include confidence is true.
* Custom polygon path: component takes airfoil polygon from parametric generator as prior, converts SAM box to polygon clamp, intersects with SDF mask for crisp wall. This keeps physics mask authoritative and SAM as the visual label layer.
* Fallback chain: SAM mask to bounding box heuristic from SDF polygon to full frame box. Never blocks render. Badge shows (SAM live, SAM cached, heuristic).

### Poster Image (src/meta/poster.ts, new)
* Model muse-image-1.0. One shot generate plus edit for hero and thumbnail, conversational responses chaining for iterations (previous response id, store true default). Only image generation tool allowed on that path.
* Prefetch 2 to 3 heroes at build time into /public with fixed style prompt. Live generation only on explicit user action (button), never on slider move. RPM 150 respected with button disable plus queue note.
* Cost flat 0.01 per image. Failures and safety blocks free. Poster shows cached asset instantly while live generates in background.

### OfflinePack plus Proxy (src/meta/offlinePack.ts, server/proxy.ts, new)
* OfflinePack: manifest plus cached Spark answers for all presets plus SAM rasters for 5 fixtures plus prefetched images plus fixtures/validation JSON. One click toggle in MetaPanel runs the full script with zero network.
* Proxy: minimal server route POST /api/meta/* that injects MODEL_API_KEY from env (format LLM id secret), enforces per app keys, rate limits per session, strips key from client. Browser bundle contains no secret. Sample env file documents the variable, repo contains no real key.
* Standard mode for all judging runs. Contributor models are excluded unless explicit consent plus labeling is added, because that mode trains on content.

### MetaPanel (src/ui/MetaPanel.tsx, Phase 4 origin, superseded by Phase 8 shell)
* Phase 4 single UI surface for all Meta state. Shows per call status (live, cached with age, fallback with reason), latency, cost, model name. Phase 8 splits this across the agent console rail and the analysis rail windows above.
* Controls: preset picker, Spark explain button, SAM overlay toggle, Poster regenerate button, offline toggle, low bandwidth toggle.
* Trust copy: labels what Meta did (spec from text, mask from SAM, art from Image) and what is analytic (Cl, Cp from Hess Smith or surrogate). Consent line for Standard mode.

## Data Flow (Phase 4)
1. User picks fixture plus alpha and thickness, or types a preset prompt in MetaPanel.
2. SparkSpec path (optional): text to spec JSON, schema validated, applied to frame source on accept. Template fallback on invalid output.
3. Frame source selects backend (analytic default, surrogate when enabled and allowed by sync gate). Evaluates u, v, Cp on 128 by 128, masks inside solid via SDF, attaches provenance.
4. Render draws field plus particles. Validation panel integrates Cl from panel Cp and checks named metrics locally.
5. Meta explain path: SparkEngineer reads frame metrics plus validation tiers, checks HashCache first, then live via Proxy, then template copy. EvalLog records each step.
6. SAM overlay path: SamSegment checks mask cache, then live, then polygon heuristic. Image path serves /public asset first, live generates only on demand.
7. Offline toggle short circuits steps 5 and 6 to OfflinePack with zero fetch. EvalLog marks all entries cached.

## Surrogate Design (Phase 3 carried forward)
* Input channels: normalized SDF over chord, solid mask, freestream u and v, alpha encoding tiled over grid. Grid fixed at x in [minus 0.5, 2.0], y in [minus 1.0, 1.0], chord 1, LE at (0,0).
* Output channels: u, v, Cp per cell. Cl derived by panel Cp integration for comparability with analytic path.
* Training data: analytic sweeps (alpha minus 4 to 12 deg, thickness 0.06 to 0.18) plus vendored anchors as held out checks only. Leakage statement lives in docs/DATA_SOURCES.md.
* Sync gate: surrogate runs sync forward only when cells times base fits budget 65536, else analytic fallback with meta backend flag. Latency gate test pins small shape timing. Async ONNX is the Phase 4 fix.
* Scope guard: inviscid training means Cd stays 0 by construction. Cd displayed as not validated.

## Validation Design (9 rows, unchanged)
* Vendored fixtures only: 13 files under fixtures/validation, committed to repo. CSV primary ingest, TXT fallback, TMR DAT with Fortran D exponents, Selig DAT coordinates. No fetch at runtime.
* Rows: 0012 Re 500k Cl PASS at 4, 6, 8 deg within 0.05. 0012 Re 100k WARN only. 2412 Re 500k Cl PASS at 4, 6, 8 deg within 0.05. 2412 Re 100k WARN only. 2412 theory alpha0 minus 2.07 PASS within 0.25 deg. 2412 experimental minus 2.29 INFO. Cylinder St 0.164 to 0.167 INFO. Cylinder mean Cd 1.32 to 1.38 INFO. Cylinder Cl amplitude 0.32 to 0.35 INFO.
* Anchors: XFOIL 0012 plus 2412 Re 500k Ncrit 9 clean PASS. Ladson Re 6M tripped force plus McCroskey slope 0.1075 per deg within 5 percent. Gregory Re 2.88M upper surface only, suction peaks INFO lower bounds. Cylinder analytic oracle Cp equals 1 minus 4 sin squared theta PASS at stagnation 1.0 and shoulder minus 3.0.
* Tiers: PASS demo ready, WARN review band near twice PASS, INFO display only never fails. Cd never validated. AK Vortex removed from exit criteria.
* Parsers locked: TXT 12 line header whitespace rows, CSV 10 line metadata with header on line 11 comma rows, TMR Tecplot zones with D to E conversion, Selig x y pairs. Panel reads JSON only.

## Technology Decisions
* Client: Vite plus TypeScript plus Canvas. Reason: solo scope, zero backend, fast demo.
* Flow core: TS Hess Smith plus analytic cylinder. Reason: deterministic, testable, under 100 ms.
* Surrogate: compact U Net behind frame interface with sync gate. Reason: same UI path, A/B ready, honest fallback.
* Validation: vendored JSON, no runtime fetch. Reason: offline judging, leakage control.
* Meta AI: Standard mode via proxy, cache then fallback. Reason: privacy default, survives network loss, key safety.
* Meta UI: agent console rail plus stacked analysis rail (AgentConsole, AnalysisPanel, EvalLogPanel) for status plus controls. Reason: judging transparency, single presenter clarity.

## API Strategy
* Base URL: https://api.meta.ai/v1 via proxy path /api/meta. Keys in env only, sample env file, no secrets in repo.
* Standard mode by default. Contributor mode excluded without explicit consent and labeling.
* Models: muse-spark-1.3 for text, sam-3.1 for masks, muse-image-1.0 for visuals. Pinned names in MetaClient.
* Caching: hash inputs with sha256, TTL 24h Spark text and 7d SAM plus Image, serve stale on failure. Preload cached responses for live demo.
* Offline fallback: OfflinePack runs full script with zero network. One click toggle in MetaPanel.
* Fallback chain: SAM to polygon heuristic to full frame, Spark to template copy, Image to cached asset, surrogate to analytic.

## Geography and Offline Fallback
* Handle ET plus UTC times, locale aware copy.
* Cached demo pack for judging network issues. Required for solo live demo.
* Low bandwidth mode: text first, images lazy, clear status copy.
* Solo maintainability: single owner stack, minimal ops, pinned versions, one command setup.

## Phase 10 pointer
The viscous Lattice Boltzmann core design (modules, kernel, boundaries, forces, statistics, batch API, tests, provenance) lives in docs/ARCHITECTURE-LBM-PHASE10.md. The potential path in this document is unchanged and remains the instant preview and fallback.

## Modal training and sweep (C-1/C-2)

GearFlow gains two separate user run Modal apps: `gearflow-surrogate-v2` trains the base 8 surrogate in two stages (analytic pretrain, then LBM fine tune), and `gearflow-lbm-sweep` runs the Rust `dataset_pilot` binary across CPU workers. Both keep auth, data, checkpoints, and sweep output outside git, and both hand the later C-5 export phase a versioned contract of checkpoint, normalization sidecar, run log, sweep manifest, and parity goldens. Base 8 is locked for v2 production (122934 parameters). Base 16 runs only as a conditional ablation per docs/DECISIONS.md.

### C-1 training app (training/modal_train.py, rewritten)

Header states the app is run by the user only, Modal auth lives in the user local Modal profile, no secret is read from the repo, single run command `modal run training/modal_train.py` from the repo root. Image: debian_slim python 3.12, pinned torch 2.5.1 plus numpy 1.26.4, local code copied per file (model.py, dataset.py, dataset_v2.py, losses.py), `PYTHONUNBUFFERED=1` only, fail closed without CUDA.

Volumes: `gearflow-data` mounted at `/data` (inputs: `/data/analytic/` train shards plus manifest, `/data/lbm/<sweep_id>/` cases), `gearflow-checkpoints` at `/checkpoints` (outputs per run: `best.pt`, `last.pt`, `norm.json`, `run_log.json`, `history.jsonl`). GPU: A10G first with L4 fallback, batch sizes fit both at base 8 on 128 by 128, run log records actual device. Resources 4 CPU, 16384 MiB, timeout 7200 per stage, scaledown 300. Retries 2 for infrastructure loss only. Validation before GPU work: base must equal 8, epochs 1 to 200, batch 1 to 64, lr 1e-6 to 1e-2, first sample probe for (4,128,128) input and (6,128,128) target finiteness.

Stages: pretrain 60 epochs batch 32 lr 3e-4 cosine on analytic train split, best by composite val loss, norm fitted on analytic train only. Fine tune 30 epochs batch 16 lr 5e-5 cosine from pretrain best, LBM cases split by case id 80/20, input norm frozen byte for byte, output norm refitted on LBM train only, selection on LBM val composite, analytic val logged as forgetting guardrail. AdamW weight decay 1e-4 both stages. `last.pt` every epoch, `best.pt` on improvement only.

Download path (default): `training/checkpoints/v2/<run_id>/` gets exactly `best.pt`, `norm.json`, `run_log.json` (gitignored, never committable). Checkpoint dict carries `arch` (`unet-v2`), `base` 8, `inCh` 4, `outCh` 6, loads with `weights_only=True`. Sidecar `norm.json` schema `gearflow-surrogate-norm/v2` is authoritative; export asserts hash agreement. Run log schema `gearflow-run-log/v1` records run id, stage, status, UTC times, git sha, GPU requested and actual, versions, base, params, schedule, sample counts, manifest hashes, norm hash, best epoch and composite, per head physical errors, wall seconds, remote path. No host, user, path, or credential material.

### Model v2 contract

Identifier `unet-v2`; v1 checkpoints rejected, never adapted. Inputs (batch,4,128,128): sdf clipped (-3,3) standardized; mask identity 0/1; alpha degrees tiled over alphaScale 12; logRe base 10 standardized, missing or non positive Re is a hard dataset error. Outputs (batch,6,128,128): meanU, meanV standardized; cp standardized with clip (-10,10), LBM source pmean/(0.5*u_lattice^2); vorticity dimensionless standardized clip (-20,20), LBM source omegamean bin; tke log1p transformed then standardized (analytic target exactly 0, degenerate flag when fitted std below 1e-3); recirc raw logit, fluid cells with mean u below 0 positive, solid excluded from loss and read 0 at inference. Ref quantities: U_ref is manifest u_lattice, ref_length required per case (chord, diameter, height, gap).

Network: encoder 8/16/32, bottleneck 64, symmetric decoder, head 8 to 6 via 1x1 conv. Conv except head followed by GroupNorm (4 groups, eps 1e-5, affine) then ReLU. Nearest upsample, max pool, as v1. Loss over fluid cells only: meanU 1.0, meanV 1.0, cp 0.5, vorticity 0.25, tke log1p 0.5, recirc BCE with logits 0.5 and pos_weight clamped 1 to 20 recorded in run log. Optional divergence regularizer default 0.0 pretrain, 0.01 fine tune, never in selection. Composite val loss without divergence selects best; per head physical RMSE logged every epoch.

Canonical grid 128 by 128 over x -0.5 to 2.0, y -1.0 to 1.0, node rule matching Rust k = j*nx+i, no row flips. Continuous channels bilinear resample align corners; mask and recirc nearest with mask threshold 0.5. Outside native domain filled with freestream. Solid cells zeroed after resample. C-2 cases use sdf.f32 bin; pilot cases without it derive SDF by distance transform marked `sdf_source: derived_mask`.

ONNX opset 18: Conv, GroupNormalization, Relu, MaxPool, Resize nearest, Concat only. Sigmoid and expm1 stay in the TypeScript consumer. Fixed batch 1, fixed 128 by 128, no dynamic axes. V2 inference is ONNX only; v1 flat weight forward pass stays v1 only.

### C-2 sweep (training/modal_sweep.py, new)

Image debian_slim python 3.12 plus build-essential, pinned Rust 1.85.0 minimal profile, crate copied with committed Cargo.lock, release build of dataset_pilot to /root/gearflow-wasm/target/release/dataset_pilot, binary path asserted at start. No GPU, no secrets, no torch. Volume gearflow-sweep at /sweep. Runner gains `cases` spec file arg, `manifest_out` fragment arg, eighth bin sdf.f32. CaseSpecV1: case_id, body, re, u_lattice, alpha_deg, les, nx, ny, domain_width, radius/width/height/naca_code or null, ref_length, transient, window, substitutes_for or null, note. Manifest sha v2 covers eight bins in order umean, vmean, pmean, omegamean, tke, recirc, obstacle, sdf; merge keeps v1 mode for pilot output. Rows gain sha_version, ref_length, substitutes_for.

Fan out: local entry reads data/sweep/<sweep_id>/cases.jsonl, Modal map over run_case_remote capped 16 containers, 4 vCPU 4096 MiB timeout 1800 retries 2. Per worker layout /sweep/runs/<sweep_id>/workers/<case_id>/ with one row fragment plus case dir. Completed outputs verified before return count as cached unless force. Diverged is a successful outcome, no retry, no auto substitute. Local merge (training/merge_sweep.py): recompute every sha, check sizes nx*ny*4, finite values, id agreement; abort exit 2 with merge_report.json only on any mismatch, missing id, or conflict; identical duplicates keep first; diverged and setup error rows preserved verbatim; substitutes copied with substitute true plus substitutes_for marker, originals untouched. Output data/lbm/<sweep_id>/ cases plus manifest.jsonl sorted by spec order plus merge_report.json.

Planning figure 45 s per 4 vCPU case: 60 cases about 3 min compute 6 to 11 min end to end; 200 cases about 10 min compute 13 to 18 min end to end. Output about 105 MiB at 60, 350 MiB at 200 (256 by 256 eight channel). Dollar figures as vCPU hours; multiply by current Modal rate before the 200 case run.

### C-5 interfaces (fixed now, built later)

Checkpoint dir training/checkpoints/v2/<run_id>/ with best.pt, norm.json, run_log.json. Export writes public/surrogate/v2/model.onnx (gitignored), norm.json byte copy, model.json browser manifest (version 2, arch unet-v2, base 8, channels, opset 18, files plus sha256, runId, provenance). Golden generator builds three fixed inputs, runs torch and ONNX Runtime CPU, writes fixtures/surrogate-v2/ input.f32 plus expected_onnx.f32 plus expected_torch.f32 plus golden.json with 1e-4 tolerance, under 2 MiB committed.

### Risks

Image first build cost (torch download, cold cargo build): pinned versions, layer caches, build once early, record separately. Rust compile in image: pinned toolchain, committed lockfile, zero new crates, local binary fallback. Volume egress: download three checkpoint files plus sweep once into gitignored data, verify by sha locally, never store in git or bundle. GPU availability: A10G then L4 preference, actual device logged, batches fit both, local reduced epoch smoke path. Auth: user local Modal profile only, nothing reads repo env, no secrets in code or logs. Small fine tune set: case splits, frozen input norm, guardrail reporting, fail closed merge, ablation gated on evidence. Resampling drift: one canonical grid, one bin order, sha versions, byte level C-5 golden. Diverged shrinkage: preserved rows, explicit substitutes, merge fails closed on missing ids, run log reconciles with merge report.
