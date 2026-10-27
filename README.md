# [Your Project Title Here]
Solo Indie Push the Frontier entry for the Meta Global AI Developer Hackathon, Oct 26 to Nov 4 2026.

## Vision
We are building a friendly helper that turns everyday moments into action. Tell it what you see or need, and it responds with clear next steps plus visuals you can share.

## Who It Helps
* Busy people who want quick answers in their own context
* Communities that need accessible tools in low bandwidth settings
* Anyone curious about what Meta AI can do in real life

## 30 Second Demo
Watch a photo become a plan. Snap a scene, see key parts highlighted, get a simple plan in plain language, plus a visual you can save. All in under a minute, with an offline friendly fallback.

## How It Uses Meta AI
* Muse Spark: understands your ask and plans clear steps
* SAM 3.1: sees and segments what matters in your image
* Muse Image: creates shareable visuals and demo assets
* Glimmer: keeps quick chats fast and light

## Theme Fit
Push the Frontier (locked): solo Indie entry pushing machine capability with multi model orchestration (perception plus reasoning plus rendering). Idea placeholder to be filled after selection.

## Hackathon Context
Built for the Meta Global AI Developer Hackathon (Meta plus Cerebral Valley), virtual worldwide. Judged on Impact (30), Meta Tooling (25), Demo (25), Technical Depth (20). Details in docs/HACKATHON_RULES.md.

## Docs
Start here: AGENTS.md plus docs/AGENTS.md, then docs/DESIGN.md and docs/ARCHITECTURE.md.

## Team
* Solo participant. Single submitter lists self only.
* Placeholder: Add name, role, contact.
* We welcome feedback during judging week (Nov 4 to 8) and finals (Nov 9).

## Status
Phase 0 Complete. Idea selection in progress for solo indie frontier entry. Come back for live demo and video.

## Offline pack
Build then pack the judged demo booth copy:

```sh
npm run build
npm run pack:offline
```

Serve from unzip directory root via `npx serve` or any static server. `file://` will not load assets due to absolute URLs.

For a relative base (for example serving from a subpath), either pack with a rewrite:

```sh
node scripts/make-offline-pack.mjs --base=./
```

or rebuild permanently with `vite build --base=./` before packing.
