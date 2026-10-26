# Architecture
Last updated: 2026-10-26. Solo owner, minimal ops, demo must survive network failure.

## System Overview
Placeholder: client app plus API service plus Meta AI orchestration layer. Single owner stack, minimal services, one deploy path.
Text diagram: Client > Orchestrator > (SAM 3.1, Spark/Wonder, Image, Glimmer) > Cache plus Eval Log > Client UI.

## Components
* Perception (SAM 3.1): segmentation, detection, scene parse. Output: masks, boxes, labels.
* Reasoning (Spark/Wonder): planning, chat, ranking, explanation. Output: structured plan.
* Rendering (Image): visuals, thumbnails, demo assets. Output: images with style prompt.
* Interaction (Glimmer): fast lightweight responses where latency matters.
* Orchestrator: routing, retries, timeouts, fallback chain.
* Store and Cache: input hash cache with TTL, eval logs, demo fixtures.

## Data Flow
1. Input arrives (image, text, location).
2. Orchestrator calls perception, then reasoning, then rendering as needed.
3. Each call checks cache first, then live API, then fallback.
4. Response returns with provenance (model, latency, cached flag).
5. Eval log records cost and quality for judging evidence.

## Technology Decisions
| Area | Choice | Reason |
|------|--------|--------|
| Client | TBD | To be filled after track selection |
| API service | TBD | To be filled |
| Orchestration | TBD | To be filled |
| Storage | TBD | To be filled |

## API Strategy
* Base URL: https://api.meta.ai/v1
* Standard mode by default for this solo entry. Use Standard for proprietary prompts and user data.
* Contributor mode only with explicit consent and clear labeling. Solo default is Standard unless user opts in.
* Caching: hash inputs, set TTL, serve stale on failure. Preload cached responses for live demo.
* Offline fallback: cached demo pack runs full script with zero network. One click toggle.
* Fallback: SAM to box heuristic, Spark to template, Image to cached asset.
* Keys in env, sample env file, no secrets in repo.

## Geography and Offline Fallback
* Handle ET plus UTC times, locale aware copy.
* Cached demo pack for judging network issues. Required for solo live demo.
* Low bandwidth mode: text first, images lazy, clear status copy.
* Solo maintainability: single owner stack, minimal ops, pinned versions, one command setup.
