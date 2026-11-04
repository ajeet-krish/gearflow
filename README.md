<p align="center"><img src="media/projectthumbnail.png" width="800" alt="GearFlow, an agentic interface for computational fluid dynamics" /></p>

# GearFlow: An Agentic Interface for Computational Fluid Dynamics

What if you could set up an aerodynamics simulation in seconds, without being lost in a sea of menus. Traditional CFD tools are extremely powerful but setting up simulations can take hours.

With GearFlow, describe the simulation you want, and an agent sets it up, runs it, and explains the results.

Live App: https://gearflow-five.vercel.app
Demo Video: https://youtu.be/DIGMct427Ak

## Who it is for

Students can ask questions and receive instant visual feedback with physics explanations. Engineers can test simple ideas without wasting compute resources on expensive simulations.

## How it works

Type plain English in the left-side chat and the physics agent sets up the simulation and runs it, and provides physics explanations.

![GearFlow Studio scene with NACA 2425 airfoil Cp pressure field, RUN card showing CL 1.609](media/airfoil.png)


In this example where an airfoil simulation is setup, the user describes adding thickness. The agent makes the changes and also explains that the thicker section strengthens the suction peak while camber and alpha stay fixed, so the change is purely a thickness effect. It names Try next as nudging alpha by 1 deg to test whether the suction peak grows faster on the fatter section, and it carries the honest physics note that potential flow omits separation and stall, so real thick sections at high alpha may differ.

![GearFlow Studio scene with orifice plate velocity field, RUN card showing CPMIN minus 50.234](media/orifice.png)
Screenshot alt: Agent Console on the left, Scene canvas with orifice velocity field and streamlines on the right.

The user asks to learn about a specific flow scenario: "show me what happens when flow is constricted". The canvas builds the orifice plate with 0.4 gap opening and 0.08 plate thickness at Re 1000 in the velocity field, with streamlines squeezing through the gap.

The Physics Agent explains the venturi effect, where continuity forces speedup through the gap and Bernoulli means lower pressure, so Cp dips hardest inside the gap and recovers downstream. Try next suggests shrinking the gap further to reason through even higher speed and a larger pressure drop.

## Under the hood, one harness per turn

Every chat turn runs the same harness. Words go to a Meta text model through the Modal proxy with one completion, capped length at 400 tokens (`MODAL_MAX_TOKENS` in `src/agent/modalGate.ts`), temperature forced to 0 and `n` fixed to 1 (`forceModel` in `src/agent/modalGate.ts`), low reasoning effort (`MODAL_REASONING_EFFORT` in `src/agent/modalGate.ts`). The model answers in a fenced envelope of actions. A validator checks each action against the contract with a five action cap (`MAX_ENVELOPE_ACTIONS` in `src/agent/agentActions.ts`), and the app executor applies the valid ones (`src/ui/AgentConsole.tsx`). Then the tutor explains what changed, why, and what to try next, with a before versus after table (`src/ui/AgentConsole.tsx`). Session spend carries a 5 dollar soft cap (`SESSION_SPEND_CAP_USD` in `src/agent/sessionSpend.ts`). Failures land honest, with Retry and zero canvas writes (`src/ui/AgentConsole.tsx`).

## Current Limitations

At its current stage, the physics is idealized. Inviscid estimation leaves out friction and turbulence, and can never show real separation and stall.

Live chat depends on a paid Modal GPU endpoint. Keeping it online through the week of judging would drain the project funds, so the endpoint runs only for recorded demos. The live Vercel app serves the full interface, but chat turns land honest with Retry while the endpoint is down. The demo video shows the complete live loop.

## Next steps

Planned next steps are a built-in solver that the agent can drive end-to-end for real simulations, turning into a comprehensive CFD harness. Research is currently being done on implementing image plus audio inputs, so an owner can sketch a geometry or ask about turbulence by voice. The goal stays the same: pushing the boundaries of traditional CFD with agentic AI.

## Meta model usage status

| Status | Model or path | How it ships |
|--------|---------------|--------------|
| Live | Muse Spark via Modal (`gearflow-chat`) | Single live Meta text model in the judged loop, chat plus tutor, fail closed with Retry |
| Built but cut, code present, unmounted | Muse Image poster path | Explicit action only, not part of the judged loop, labeled cached when shown |
| Built but cut, code present, unmounted | SAM overlay | Cached and offline only, visual layer only, physics mask stays authoritative |
| Deferred | Glimmer local | No live path in this submission |
| Deferred | Wonder second voice | No live voice path in this submission |

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

* [x] Live demo URL: https://gearflow-five.vercel.app/.
* [x] Demo video 2 to 3 min: https://youtu.be/DIGMct427Ak (unlisted).
* [ ] Public repo with this README (setup, keys, run steps).
* [ ] Short writeup (problem, users, Meta tooling, architecture, next steps).
* [ ] Licenses declared for third party assets and data.
* [ ] Submitted before Nov 4 9PM ET.
