# Agent Guide
Read docs/HACKATHON_RULES.md before any planning.

## Project Context
Meta Global Hackathon build, Oct 26 to Nov 4 2026. Judging: Impact 30, Meta Tooling 25, Demo 25, Technical Depth 20.

## Quick Commands
* Node: npm install, npm run dev, npm test (to be filled)
* Python: uv sync, uv run pytest (to be filled)
* Rust: cargo run, cargo test (to be filled)

## Conventions
* No em dashes in prose or docs. Use commas, colons, parentheses.
* Conventional commits (feat, fix, docs, chore).
* Docs first: update docs/DECISIONS.md and docs/RESEARCH.md as you go.
* Env only for keys. Never commit secrets.

## Project Map
* docs/HACKATHON_RULES.md (constraints)
* docs/DESIGN.md, docs/ARCHITECTURE.md (product and tech)
* docs/DECISIONS.md, docs/RESEARCH.md (logs)
* docs/REVIEWS.md, docs/TESTS.md (quality)

## Agent Workflow
1. Read HACKATHON_RULES.md and relevant Deep Doc.
2. Check DECISIONS.md to avoid repeat choices.
3. Implement small step, add tests if present.
4. Log decision and update docs.
5. Report files changed plus verification.
