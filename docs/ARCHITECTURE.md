# Architecture
Last updated: 2026-10-26

## System Overview
Placeholder: client app plus API service plus Meta AI orchestration layer.
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
* Standard mode by default. Contributor mode only with explicit consent (trains models).
* Caching: hash inputs, set TTL, serve stale on failure for demo continuity.
* Fallback: SAM to box heuristic, Spark to template, Image to cached asset.
* Keys in env, sample env file, no secrets in repo.

## Geography and Offline Fallback
* Handle ET plus UTC times, locale aware copy.
* Cached demo pack for judging network issues.
* Low bandwidth mode: text first, images lazy, clear status copy.
