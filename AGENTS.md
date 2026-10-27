# Meta Global Hackathon
Solo Indie Push the Frontier entry. Build Oct 26 to Nov 4 2026. Read docs/HACKATHON_RULES.md first.

## Quick Commands
* Node: npm install, npm run dev, npm test (TBD)
* Python: uv sync, uv run pytest (TBD)
* Rust: cargo run, cargo test (TBD)
* Copy env: cp .env.example .env (add Meta API key)

## Conventions
* No em dashes in docs or copy. Use commas, colons, parentheses.
* Conventional commits. Docs first, code second.
* Multi model orchestration is mandatory (Spark plus SAM plus Image).
* Keys in env only. Never commit secrets.
* Solo scope: one owner, one core loop, one wow moment. Keep demo runnable daily.

## Project Map
* docs/HACKATHON_RULES.md (rules and judging)
* docs/AGENTS.md (agent guide)
* docs/DESIGN.md (product and demo)
* docs/ARCHITECTURE.md (tech plan)
* docs/DECISIONS.md, docs/RESEARCH.md (logs)
* src/ (to be created after idea pick)

## Status
| Phase | Description | Status |
|-------|-------------|--------|
| Phase 0 | Infra scaffolding | Complete |
| Phase 1 | Contracts and skeleton (Vite shell, schemas, fixtures) | Complete |
| Phase 2 | Geometry plus analytic flow | Complete |
| Phase 3 | Surrogate and validation | Complete |
| Phase 4 | Meta orchestration (Spark, SAM, Image) | Complete |
| Phase 5 | Polish, export, submission | Complete |
| Phase 6 | UI/backend overhaul (C-1, C-3, C-4) | Complete |
| Phase 7 | Rust + WASM solver (parity, production bundle) | Complete |
| Phase 8 | Zenith instrument shell (navbar, rails, bars, vertical colorbar) | Complete |

## Deep Docs
* Rules: docs/HACKATHON_RULES.md
* Design: docs/DESIGN.md
* Architecture: docs/ARCHITECTURE.md
* Decisions: docs/DECISIONS.md
* Research: docs/RESEARCH.md
* Reviews: docs/REVIEWS.md
* Tests: docs/TESTS.md
