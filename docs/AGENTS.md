# Agent Guide
Read docs/HACKATHON_RULES.md before any planning.

## Project Context
Solo Indie Push the Frontier entry. Solo participant, virtual worldwide, build Oct 26 to Nov 4 2026. Judging: Impact 30, Meta Tooling 25, Demo 25, Technical Depth 20. Indie lens rewards creativity, ambition, craft.

## Quick Commands
* Node: npm install, npm run dev, npm test (vitest run), npm run build (tsc plus vite build)
* Python (training/): uv sync, see training/modal_train.py and training/modal_sweep.py for run commands
* Rust (rust/gearflow-wasm): cargo test, cargo build
* Copy env: cp .env.example .env (add Modal proxy values, never commit secrets)

## Conventions
* No em dashes in prose or docs. Use commas, colons, parentheses.
* Conventional commits (feat, fix, docs, chore).
* Docs first: update docs/DECISIONS.md and docs/RESEARCH.md as you go.
* Env only for keys. Never commit secrets.
* Solo scope: one owner, one core loop, one wow moment. Cut extras, keep demo runnable daily.

## Project Map
* src/App.tsx (IDE shell: TopNav, left agent rail, center tunnel, right ANALYSIS rail, SettingsModal, TheoryPage)
* src/ui/ (AgentConsole, EditorTabs, FieldBar, SceneBars, SimulationSection, GeometrySection, TheoryPage, ValidationPanel)
* src/agent/ (Modal chat client plus gate, tutor prompt plus table, case presets, alpha sweep, misconceptions, curriculum)
* src/flow/ (analytic frame source, agent-first flags in config, gated legacy LBM plus neural plus WASM paths)
* src/geometry/, src/render/, src/validation/, src/meta/ (legacy orchestration plus EvalLog), src/contracts/, src/export/, src/config/
* training/modal_train.py, training/modal_sweep.py, training/merge_sweep.py (surrogate v2 training plus LBM sweep, user run, secrets stay in local Modal profile)
* rust/gearflow-wasm (legacy viscous core plus dataset_pilot, gated off under agent-first)
* docs/HACKATHON_RULES.md (constraints), docs/DESIGN.md, docs/ARCHITECTURE.md (product and tech)
* docs/DECISIONS.md (append only), docs/RESEARCH.md, docs/REVIEWS.md, docs/TESTS.md (logs and quality)
* fixtures/validation/ (vendored anchors), public/demo-pack/, public/offline-pack/ (cached demo data)

## Agent Workflow
1. Read HACKATHON_RULES.md and relevant Deep Doc.
2. Check DECISIONS.md to avoid repeat choices.
3. Implement small step, add tests if present.
4. Log decision and update docs.
5. Report files changed plus verification.

## Status
Submission slice complete: analytic default with agent-first gate (Phases 21 to 24), Modal-only chat on endpoint gearflow-chat, Zenith inherited shell reworked to agent rail plus tunnel plus ANALYSIS rail with TheoryPage. LBM, neural, WASM, and Phase 4 multi model paths are gated legacy slices, off by default. Dataset pilot in progress; see root AGENTS.md Status table for the phase ledger.
