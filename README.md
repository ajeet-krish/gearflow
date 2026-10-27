# GearFlow

GearFlow is a browser airfoil wind tunnel: shape a constrained body, watch the flow field update live, and read honest numbers. Solo Indie Push the Frontier entry for the Meta Global AI Developer Hackathon, Oct 26 to Nov 4 2026.

## Vision

CFD tooling is heavyweight, slow to set up, and gated behind desktop solvers, so students and makers never get instant visual intuition for lift and pressure. GearFlow puts a small honest wind tunnel in the browser: pick a body, set angle and Reynolds number, and see speed, pressure, and vorticity respond immediately with validated numbers beside the field. It stays constrained on purpose, so the physics it shows stays trustworthy.

## What It Does

The core loop is one screen and one presenter. Shape a body, watch the field, read the numbers, export the run.

* Constrained geometry: NACA 0012, 2412, 4412 presets plus cylinder, duct, block, and a guided custom sketch path. Bodies are validated polygons with SDF masks.
* Live potential flow field: speed, pressure (Cp), and vorticity views with particles, contours, and colormap control.
* Telemetry on every run: lift coefficient (Cl), minimum Cp, flow regime, solve time, grid, and provenance.
* Validation panel: 9 rows with PASS, WARN, and INFO tiers. Rows compare Cl at 4, 6, and 8 degrees against XFOIL polars at Re 100k and 500k for NACA 0012 and 2412, check 2412 alpha zero against thin airfoil theory, and show INFO-only cylinder bands for Strouhal, Cd, and Cl amplitude. McCroskey, Ladson, Gregory, and Selig datasets are also vendored under `fixtures/validation` and covered by parsing tests.
* Export: PNG snapshots plus PDF reports carrying the same numbers as the live UI.

## How It Uses Meta AI

Three Meta models work beside the core loop, never inside it. The solver never blocks on a network call, every Meta call has a cached or template fallback, and keys stay server side behind the `/api/meta` proxy.

* Muse Spark turns natural language into a geometry spec and gives a coach explanation of the current run, citing live Cl, Cp min, and alpha zero from the validation metrics.
* SAM 3.1 segments a sketch or photo into a polygon that is clamped against the SDF mask, so the physics wall stays authoritative and SAM acts as the visual label layer.
* Muse Image generates poster and hero visuals for export, prefetched at build time and regenerated live only on explicit user action.
* HashCache plus EvalLog sit under all calls: tiered TTLs (Spark text 24h, SAM masks 7d, Image assets 7d), serve stale on failure, visible status badges, and a per call ledger of latency, tokens, cost, and cache hits.

## The Solver, Honestly

The default backend is Hess Smith potential flow (constant source plus vortex panels, 100 to 160 panels, matrix factored once per geometry) with an analytic doublet plus vortex oracle for the cylinder. An optional Rust plus WASM backend behind `?wasm=1` matches the TypeScript solver within 1e-6, with automatic fallback to analytic on any fault and honest provenance labels. A compact learned surrogate (U Net behind the same frame interface) is available as an opt in comparison, with a sync budget gate that falls back to analytic for production shapes.

Limits are stated plainly because that is a feature. The core is inviscid potential flow with no turbulence model. The wake overlay is cosmetic and never feeds back into Cp or Cl. Only the Re shading of the wake deficit is modeled, so Re changes the wake look, not the inviscid core. Cd is displayed as not validated. No end to end latency promises are made; the telemetry bar shows the measured solve time of each run.

## UI: Zenith Instrument Room

The shell is a calm instrument room: a full bleed tunnel at center, dense data type, purple plus cyan accents on near black. Three bars stay pinned above the canvas: SOLVER (backend, body, alpha, Re, grid, live state), FIELD (quantity, layers, particles, colormap), and TELEMETRY (engine, grid, cells, solve time, Cl, CpMin, regime, provenance, validation counts). A left agent rail holds the conversational console with a pinned composer, and a right rail stacks five collapsible analysis windows (GEOMETRY, DISPLAY, VALIDATION, EVAL LEDGER, EXPORT). The tunnel carries a bottom left RUN summary card and a bottom right vertical colorbar. See `src/ui` for TopNav, SolverBar, FieldBar, TelemetryBar, and the analysis panels.

## Run It

Requires Node plus npm, and Rust with wasm-pack only for the optional WASM path. Copy the sample env file and add the Meta API key; the key is read server side by the proxy and never ships in the browser bundle.

```sh
cp .env.example .env
npm install
npm run dev
```

Other commands, all from `package.json`:

```sh
npm test
npm run build
npm run preview
```

The test suite runs via `npm test` (vitest). Optional Rust path:

```sh
npm run wasm:build
```

Then open the app with `?wasm=1`. For Rust unit tests:

```sh
npm run wasm:test
```

## Demo and Offline
The judged demo survives network loss. The app ships an offline pack with baked cases, cached Spark answers for presets, SAM rasters for fixtures, prefetched images, and vendored validation JSON. Toggle offline in the agent console to run the full script with zero network. To build with the offline default on:

```sh
VITE_DEMO_OFFLINE=true npm run build
```

Build then pack the judged demo booth copy:

```sh
npm run build
npm run pack:offline
```

Serve from the unzip directory root with `npx serve` or any static server. The `file` protocol will not load assets because of absolute URLs. For serving from a subpath, rebuild with a relative base before packing.

## Ranges and Defaults

* Bodies: NACA 0012, 2412, 4412, cylinder, duct, block, custom sketch polygon.
* Angle of attack: minus 4 to 12 deg, default 6 deg on NACA 2412.
* Reynolds number: 100 to 1,000,000, default 50,000. Re shades the wake deficit only.
* Grids: 128 or 256 with AUTO fallback to 128 after repeated slow solves. Surrogate and fixture paths stay at 128.
* Fields: speed, pressure (Cp), vorticity, with particle advection, contour overlay, and colormap choice.

## Project Layout

* `src/geometry`: parametric bodies, polygon plus SDF masks, presets.
* `src/flow`: Hess Smith potential solver, frame source, surrogate provider, WASM loader.
* `src/render`: canvas field texture, particles, colormaps.
* `src/ui`: TopNav, SolverBar, FieldBar, TelemetryBar, analysis panels, validation, export.
* `src/meta`: MetaClient, cache, eval log, Spark, SAM, poster, offline pack.
* `rust/gearflow-wasm`: Rust solver built with wasm-pack, checked in under `src/wasm/pkg`.
* `fixtures/validation`: vendored validation JSON, read locally at runtime.
* `docs`: rules, design, architecture, decisions, research, reviews, tests.

## Judging Alignment

* Impact 30: a real pain (CFD is gated and slow) with a real outcome (instant visual intuition plus validated numbers for students and makers).
* Meta Tooling 25: three models with explicit handoffs, Spark reasoning to SAM perception to Image rendering, all visible in the UI with status, cost, and cache state.
* Demo 25: single presenter, one core loop, under three minutes, one click cached fallback plus a full offline pack, ending on an exported visual.
* Technical Depth 20: Hess Smith plus Rust WASM parity, frame interface with surrogate comparison, vendored validation with tiers, measured provenance on every run.

See `docs/HACKATHON_RULES.md` for the rubric source and `docs/DESIGN.md` for the design alignment.

## Team, Status, License

Solo participant (Indie, Push the Frontier). Name and contact: [add your name, email, and profile link here].

Status: phases 0 through 8 complete, including the Rust plus WASM solver and the Zenith instrument shell.

Demo video and live URL go here before submission: [add video link and live link].

License: TBD, add before publishing. No LICENSE file is present in the repo yet.
