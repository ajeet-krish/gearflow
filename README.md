# GearFlow

GearFlow, an interactive aerodynamics toolkit controlled through natural language.

Traditional CFD setup takes hours of mesh and menu work before any insight appears. GearFlow sets up a case in seconds from plain English, so the flow field is on screen while the question is still fresh.

Live Demo URL: TODO | Video URL: https://youtu.be/DIGMct427Ak | Offline ready | Solo Indie Push the Frontier

## Who it is for

Students see physics instantly, with each change explained beside the canvas. Engineers test simple ideas without burning cluster time on repeated simulations.

## Live demo walkthrough

The demo runs four cases, ten turns total. Each prompt below is typed verbatim and sent live. After each turn the canvas morphs to the new case and the chat explains what changed.

Case 1, airfoil. The agent builds the case and explains lift and pressure, then reshapes the section, then raises the angle so the suction peak grows.

```text
Set up an airfoil naca 2415 at angle of attack 6
```

The canvas builds the airfoil field, the chat explains the lift coefficient and the pressure coefficient.

```text
increase camber and decrease thickness
```

The canvas reshapes the section, the chat explains the new camber and thickness.

```text
increase the angle to 10
```

The canvas updates the field at the higher angle, the chat calls out the growing suction peak.

Case 2, cylinder. The agent builds the default wake case, then widens the body.

```text
Show me a flow around a cylinder
```

The canvas builds the cylinder wake, the chat explains the new case.

```text
increase radius
```

The canvas widens the body, the chat explains the wider wake.

Case 3, square. The agent builds the block field, then stretches and rotates it.

```text
Show me flow around a square
```

The canvas builds the block field, the chat explains the new case.

```text
increase the length and rotate a bit
```

The canvas stretches and rotates the block, the chat explains the new orientation.

Case 4, constriction. The agent explains the physics and builds the orifice, then switches the field to pressure, then widens the gap.

```text
what happens when flow is constricted
```

The canvas builds the orifice constriction, the chat teaches the constriction physics.

```text
what happens to pressure
```

The field switches to Cp, the canvas shows the gap pressure drop speeding the flow, the chat explains why.

```text
widen the gap a lot
```

The canvas opens the gap, the chat explains the softer constriction.

Backup prompts for reproducibility, all absolute forms. Use one when a relative turn misfires on camera: `set NACA 3408 at alpha 6`, `set alpha to 10`, `set cylinder radius 0.5`, `set block width 1.2 height 0.5 alpha 10`, `set up the orifice constriction`, `how does this affect pressure`, `set orifice gap 0.8`.

## Under the hood, one harness per turn

Every chat turn runs the same harness. Words go to a Meta text model through the Modal proxy with one completion, capped length at 400 tokens (`MODAL_MAX_TOKENS` in `src/agent/modalGate.ts`), temperature forced to 0 and `n` fixed to 1 (`forceModel` in `src/agent/modalGate.ts`), low reasoning effort (`MODAL_REASONING_EFFORT` in `src/agent/modalGate.ts`). The model answers in a fenced envelope of actions. A validator checks each action against the contract with a five action cap (`MAX_ENVELOPE_ACTIONS` in `src/agent/agentActions.ts`), and the app executor applies the valid ones (`src/ui/AgentConsole.tsx`). Then the tutor explains what changed, why, and what to try next, with a before versus after table (`src/ui/AgentConsole.tsx`). Session spend carries a 5 dollar soft cap (`SESSION_SPEND_CAP_USD` in `src/agent/sessionSpend.ts`). Failures land honest, with Retry and zero canvas writes (`src/ui/AgentConsole.tsx`).

## Honest limits and provenance

This is 2D inviscid flow estimation, not full viscous CFD. The judged path serves an analytic preview labeled potential flow estimate, not validated. Neural output is predicted, never validated. Every run carries its label on the canvas and in chat, so provenance is visible at a glance. The repo contains additional engine paths in code, but the demo and every claim here cover the analytic preview path only.

On validation, this README quotes the docs instead of claiming live results. The validation panel is debug gated: it mounts only with `?debug=1` (`src/App.tsx`). The panel definition in `src/ui/ValidationPanel.tsx` declares nine offline anchors against vendored XFOIL and literature bands (three PASS tier rows, two WARN rows, four INFO rows, with only a PASS tier failure blocking the demo). The test ledger in `docs/TESTS.md` records suite verdicts for the validator and metric helpers (for example the tiers and metrics suites report PASS), which is not the same as a live panel PASS row. Read a number off the run card only, never invent one.

## Next steps

Next, the agent drives a built in solver end to end for real simulations, growing this harness into a full CFD harness. Image plus audio inputs come later, so an owner can sketch a geometry or ask about turbulence by voice. The goal stays the same: pushing the boundaries of traditional CFD with agentic AI.

## Run it in 5 minutes

```sh
cp .env.example .env
```

Set the Modal chat env in `.env` (server only): `MODAL_CHAT_URL` to the full https Modal Shared Endpoint URL, `MODAL_PROXY_TOKEN` to the Bearer token, optional `MODAL_MODEL_ID` when the endpoint is renamed (default `gearflow-chat`). Keep `VITE_MODAL_URL` as the same origin client base (`/api/modal`). `VITE_DEMO_OFFLINE=true` marks the booth copy as offline aware, it never replaces the Modal failure path which stays an honest error turn with Retry.

```sh
npm install
npm run dev
```

```sh
npm test
npm run build
```

Script names verified in `package.json`: `dev`, `build`, `test`, plus optional `pack:offline`, `wasm:build`, `wasm:test`. Then open the dev URL. For Vercel, set the same server only env (`MODAL_CHAT_URL`, `MODAL_PROXY_TOKEN`, optional `MODAL_MODEL_ID`) in the project env and keep `VITE_MODAL_URL` pointed at `/api/modal`. A static export has no server proxy, so live chat needs the serverless proxy path. We stay on Vercel because GitHub Pages rejected the proxy requirement.

For the judged booth copy with no network:

```sh
VITE_DEMO_OFFLINE=true npm run build
npm run build
npm run pack:offline
npx serve
```

## Live endpoint runbook (Modal gearflow-chat)

1) Start (scale from zero):

```sh
set -a
source .env
set +a
curl -s "$MODAL_CHAT_URL" -H "Authorization: Bearer $MODAL_PROXY_TOKEN" -H "Content-Type: application/json" -d '{"model":"gearflow-chat","messages":[{"role":"user","content":"hello"}],"max_tokens":1}'
```

First hit often returns no upstreams available. That is normal. It triggers the cold boot, about 14 min. Send once, then move to logs.

2) Watch logs with the Modal CLI using the logs command with follow enabled for endpoint `gearflow-chat`. Wait for fired up and ready, then a POST 200 OK. After that, chat in the app streams normally.

3) Keepalive loop (only while debugging or recording): re-run the curl above about once per minute to prevent idle scale to zero during the session. Stop the loop when done.

Config notes: `MODAL_CHAT_URL` must end in `/v1/chat/completions`. Token is the combined `wk` plus `ws` value in `MODAL_PROXY_TOKEN`. Keep `VITE_MODAL_URL=/api/modal`. Restart `npm run dev` after any `.env` change.

Cost note: min 0 (scale to zero) is cheapest for daily use. Use min 1 only for the demo window, then stop it after Nov 9.

## Meta model usage status

| Status | Model or path | How it ships |
|--------|---------------|--------------|
| Live | Muse Spark via Modal (`gearflow-chat`) | Single live Meta text model in the judged loop, chat plus tutor, fail closed with Retry |
| Built but cut, code present, unmounted | Muse Image poster path | Explicit action only, not part of the judged loop, labeled cached when shown |
| Built but cut, code present, unmounted | SAM overlay | Cached and offline only, visual layer only, physics mask stays authoritative |
| Deferred | Glimmer local | No live path in this submission |
| Deferred | Wonder second voice | No live voice path in this submission |

Video and README label every Meta moment as live versus cached versus fallback.

## Media and third party assets

Docs media placeholders, all still TODO for the owner to land before submission: `docs/media/demo-2min.mp4`, `docs/media/shot-tunnel.png`, `docs/media/shot-agent.png`, `docs/media/shot-validation.png`, `docs/media/shot-export.png`, `docs/media/agent-setup-loop.gif`. No files exist under `docs/media` at the time of writing.

Slide images, all present, source and license TODO for the owner to fill before submission:

* `slides/images/cfd-car.webp` (exists, source TODO, license TODO)
* `slides/images/ansys-ui.jpg` (exists, source TODO, license TODO)
* `slides/images/cfd-car.jpg` (exists, source TODO, license TODO)

Never invent a source or license. The owner must confirm each asset is owned, licensed, or replaced before publishing.

## Docs map

* `docs/HACKATHON_RULES.md`: constraints, rubric source, submission requirements.
* `docs/DESIGN.md`: product story, demo script, wow moment.
* `docs/ARCHITECTURE.md`: solver, agent, and surrogate tech plan.
* `docs/DECISIONS.md`: decision log, what was chosen and why.
* `docs/RESEARCH.md`: background notes and measured findings.
* `docs/REVIEWS.md`: review history and quality gates.
* `docs/TESTS.md`: validation detail and test inventory.
* `docs/VIDEO_SCRIPT.md`: frozen spoken script and beat sheet, do not modify.

## Submission checklist

* [ ] Live demo URL (TODO, add before Nov 4).
* [x] Demo video 2 to 3 min: https://youtu.be/DIGMct427Ak (unlisted).
* [ ] Public repo with this README (setup, keys, run steps).
* [ ] Short writeup (problem, users, Meta tooling, architecture, next steps).
* [ ] Licenses declared for third party assets and data.
* [ ] Submitted before Nov 4 9PM ET.

## Team status license

Solo Indie entry. Name and contact: [TODO, add name, email, profile link]. Status: shipped behavior described above with file anchors, no phase counts. License: [TODO, add license and LICENSE file before publishing].
