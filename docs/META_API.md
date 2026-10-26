# Meta API Reference
Last updated: 2026-10-26. Sources: dev.meta.ai docs fetched 2026-10-26. Scope is Phase 4 orchestration only. Validation numbers stay vendored per docs/DATA_SOURCES.md.

## Overview
* Base URL: https://api.meta.ai/v1. All browser traffic goes through proxy POST /api/meta. The proxy injects MODEL_API_KEY server side.
* Key format: LLM id secret. Store in env, per app keys, never commit. Sample env documents the variable.
* SDK: OpenAI compatible. Set base URL to the proxy path plus Bearer token on the server side. Browser code holds no secret.
* Standard mode for all judging runs. Contributor models train on content and need explicit consent plus labeling, so they are excluded by default.
* Models pinned in MetaClient: muse-spark-1.3 for text, sam-3.1 for masks, muse-image-1.0 for visuals.

## Authentication plus Proxy
* Env var: MODEL_API_KEY on the server only.
* Proxy route: POST /api/meta/chat/completions, /api/meta/responses, /api/meta/images/generations, /api/meta/images/edits, /api/meta/files.
* Proxy duties: attach Bearer token, enforce per session rate limit, strip key from responses, pass through usage (input plus output plus cached tokens).
* Client MetaClient: timeout 20s, one retry on 429 or 5xx with backoff, typed errors Auth, RateLimit, SafetyBlock, Network.
* On any error the client returns a fallback tag with reason, never throws into render. EvalLog records the outcome.

## Muse Spark (text plus structured spec)
* Endpoints: POST /v1/chat/completions for chat style, POST /v1/responses for Responses style with reasoning and prompt cache controls.
* Models: muse-spark-1.3 plus 1.2 plus 1.1 Standard; contributor variants end with contributor. GearFlow uses muse-spark-1.3 Standard.
* Context: 1M tokens.
* Key params: temperature 0 for spec work (default is 1.0, do not use default), reasoning effort low for NL to spec, text format json schema on Responses or response format json schema on Chat Completions, strict false default, additionalProperties false, every key listed in required.
* Prompt cache: stable system prompt first, volatile frame numbers last. Use prompt cache key gearflow-coach with 24h retention on Responses for bursty demo traffic. Watch cached tokens in usage to confirm hits.
* Limits: Standard RPM 3000 TPM 4M; Contributor RPM 150 TPM 3M.
* Pricing Standard: input 1.25 per M, cached input 0.15 per M, output 4.25 per M.
* Pricing Contributor: input 0.10 per M, cached input 0.002 per M, output 0.20 per M. Excluded from judging path.
* GearFlow use: SparkSpec converts natural language to Geometry JSON then validates against the Geometry schema before applying. SparkEngineer writes coach copy citing live Cl, Cp min, alpha0. Template copy is the fallback.

## SAM 3.1 (segmentation)
* Endpoint: POST /v1/responses with model sam-3.1.
* Inputs: image via input image plus noun phrase via input text (examples: naca airfoil, wind tunnel model). Video via input video in MP4, MOV, H.264, H.265, MPEG 4. Upload once via POST /v1/files then reuse file id.
* Streaming: recommended. Set stream true, accumulate output text deltas until response completed.
* Output grammar: text with Nf id box mask pairs. Box in source pixels as x1 y1 x2 y2 plus w h. Mask data gives H, W, enc payload with tilde for lossless or bang for one bit. Confidence c appears only with include confidence true.
* Parse: use parser parseImageStream then decodeMaskToRaster to Uint8Array of H times W in row major, height first. Note the encoding is base85, not base64.
* Pricing: 2.50 per 1000 images, 0.20 per 1000 video frames with 50 frame minimum billed per video request. No TPM, RPM 3000.
* GearFlow use: noun phrase plus airfoil polygon prior from the parametric generator. Clamp SAM box to the polygon then intersect with SDF for the display overlay. Physics mask stays authoritative. Fallback chain is SAM mask to polygon heuristic to full frame box.

## Muse Image (poster assets)
* Models: muse-image-1.0.
* One shot: POST /v1/images/generations for text to image, POST /v1/images/edits for edits. Params: model, prompt, n from 1 to 10, size as WxH aspect hint, response format b64 json or url, output format webp, png, or jpeg.
* Conversational: POST /v1/responses with model muse-image-1.0. Input is text or interleaved text plus image. Chain with previous response id. Store true default, or store false with replay of image generation call id.
* Tool rule: only image generation tool is allowed on this path. Do not send web search or function tools, the API returns 400. Optional flags are image search enable, web search enable on the image tool, shell enable, reasoning strength high or low, size, output format.
* Pricing: flat 0.01 per image. Count is n times price. Failures and safety blocks are free. Reasoning strength and tools do not change price.
* Limits: RPM 150. GearFlow disables the generate button while a request is in flight.
* GearFlow use: prefetch 2 to 3 heroes at build time into /public with one fixed style prompt. Live generation only on explicit button press, never on slider move. Serve cached asset instantly, generate in background.

## Caching plus Offline Pack
* Server prefix caching is automatic when the stable prompt leads. Client HashCache is a separate layer keyed by sha256 of canonical JSON (model plus endpoint plus prompt plus params).
* Layers: in memory Map plus localStorage. Namespaces are gearflow spark, gearflow sam, gearflow image.
* TTL: Spark text 24h, SAM masks 7d, Image assets 7d. Serve stale on failure with a cached badge and age note.
* OfflinePack: manifest plus cached Spark answers for all presets plus SAM rasters for the 5 fixtures plus prefetched images plus validation JSON. One click toggle runs the full script with zero network.
* EvalLog: ring buffer cap 200 in memory plus localStorage. Per call fields are timestamp, model, endpoint, latency ms, input plus output tokens, cost USD, cached flag, fallback reason. Panel footer shows session cost and hit rate.

## Cost Estimate (150 USD credit)
* Spark NL to spec near 800 in plus 300 out tokens is near 0.0023 Standard, near 0.00014 Contributor.
* Spark coach text near 1500 in plus 250 out tokens is near 0.0029 Standard.
* SAM image is 0.0025 each. Image is 0.01 each.
* Full demo script with 20 Spark calls plus 10 SAM plus 5 images from warm cache is under 0.15 live, near 0 after prefetch. Credits cover the whole build many times over.

## TypeScript Usage (via proxy)
* Spark chat call posts JSON with model muse-spark-1.3, messages array, temperature 0, response format json schema. Validate the returned JSON against the Geometry schema before use.
* SAM call posts JSON with model sam-3.1, input array of input image plus input text, stream true. Accumulate deltas, parse pairs, decode raster, clamp to polygon.
* Image one shot posts JSON with model muse-image-1.0, prompt, n 1, size hint, response format b64 json. Save blob to cache with 7d TTL.
* All calls wrap in getOrFetch helpers that check HashCache first, then proxy live, then stale or template fallback, then EvalLog write.

## Errors plus Fallbacks
* 401 or 403: Auth error. Show key missing notice in MetaPanel, use cached or template path.
* 429: RateLimit. Backoff once, then cached or template path with a queued note.
* Safety block: Image only. Free of charge. Show cached hero with a blocked notice.
* Network or timeout: serve stale cache with age, else template copy for Spark, polygon heuristic for SAM, cached hero for Image.
* Never block the frame loop. Render and validation run locally with zero Meta dependency.

## Sources
* dev.meta.ai overview, authentication, pricing and rate limits, structured output, reasoning, prompt caching, protocols responses, image generation, SAM overview, SAM reading segmentation. All fetched 2026-10-26.
* Proxy and cache design follows docs/ARCHITECTURE.md Phase 4 section. Decisions logged in docs/DECISIONS.md Phase 4 entries.
