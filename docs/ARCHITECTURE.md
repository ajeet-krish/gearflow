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
