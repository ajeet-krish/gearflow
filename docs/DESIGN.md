# Product Design Principles
Solo Indie Push the Frontier entry. One owner, 10 days, one core loop, one wow moment.

## Problem Statement
Students meeting aerodynamics for the first time can recite the lift formula but cannot see what the flow is doing. Changing angle of attack on paper moves a number; nothing shows the suction peak growing, the stagnation point sliding, or the reason a symmetric section lifts nothing at zero. Existing tools that do show this (XFOIL, CFD suites, wind tunnel rigs) demand installs, input file craft, or lab access, so the intuition never forms in the first study session. GearFlow closes that gap in the browser: pick a NACA section, drag alpha, watch the Cp field plus Cl respond in under 100 ms, then ask a tutor agent that answers only from the numbers on screen and says plainly what the potential flow estimate cannot prove.

## Users
* Primary user: undergraduate or early self taught learner studying lift and airfoils, working in a browser with no installs, asking what changing shape, alpha, and Re does to the flow field and Cl.
* Secondary user: instructor or club mentor running a live demo, who needs one URL, honest labels (estimate versus solved versus predicted), and a validation ledger to point at when asked what to trust.
* Non user stakeholder: hackathon judges scoring a solo Indie entry on Impact, single model Meta Tooling use, Demo clarity, and Technical Depth with reproducible validation.

## User Journeys
1. Discover: user finds product in demo or store context.
2. First win: user completes core task in under 60 seconds.
3. Habit: user returns because result is saved, shared, or improved.
4. Fallback: offline or API failure still shows useful cached result.

## UX Principles
* Demo first: every flow must be showable in 30 seconds by a single presenter.
* Simple start: one input, one clear output, progressive detail. Solo scope, no extra screens.
* Trust and clarity: show what the solver computed (analytic potential flow estimate) separately from what the tutor said, with honesty labels on every number and a validation ledger beside the field.
* Robust live: full live path plus one click cached fallback for stage demos. A model failure lands an honest error with Retry, never silent prose.
* Accessible and fast: readable type, keyboard path, low bandwidth mode, field solves in under 100 ms.
* Frontier visible: make the hard part obvious (tutor reasoning trace with the before versus after table, live alpha sweep, misconception callouts, captioned export).

## Visual Direction
Tone is a calm instrument room: deep near black surfaces, purple plus cyan accents, dense data type. Dracula tokens carry the theme (ink near #0a0a0f, panel near #0d0d12, borders near #21222c and #44475a, muted text near #6272a4, accent purple #bd93f9, accent cyan #8be9fd, ok green #50fa7b, warn amber #ffb86c). Data reads in monospace (readouts, telemetry, ticks), labels in tracked uppercase. Demo visuals are the live field itself plus the captioned export sheet; no live generated imagery in the submission path.

## Shell Layout (submission snapshot, agent-first)
The shell borrows the Zenith control room idea: a full bleed tunnel at center, data dense bars pinned above it, collapsible rails on both sides, one vertical colorbar in the tunnel. Why: the flow field is the hero, so the canvas runs edge to edge with no card inset. The agent console rail on the left keeps the tutor beside the field. The ANALYSIS rail on the right stacks SIMULATION (Re, velocity, run controls) above GEOMETRY (body, alpha, shape dims) so every run control sits beside the field. EditorTabs plus FieldBar pin case and quantity switching above the canvas. The RUN card bottom left plus the vertical colorbar bottom right keep the demo readout inside the tunnel. TheoryPage replaces the center column in theory mode as the companion textbook the agent points at.

## Demo Script Outline (single presenter, single live model)
1. Hook (0 to 15 sec): students can quote lift but cannot see it; installs and lab rigs keep the intuition out of reach.
2. Live task (15 to 90 sec): pick NACA 2412 at 6 deg, drag alpha and watch Cl plus the suction peak move; ask the agent why lift rose and get a one idea answer pinned to the before versus after table, with a live alpha sweep and a misconception callout. Solo narration, no handoffs.
3. Why this model setup (90 to 120 sec): one live model (Muse Spark via Modal, endpoint gearflow-chat) for tutoring and case setup, forced analytic solver underneath, deterministic helpers local and credit free, every number labeled estimate versus solved and every failure an honest error with Retry.
4. Impact close (120 to 180 sec): who benefits (learners and mentors with only a browser) and what is next (dataset pilot toward a validated surrogate). End on the captioned export sheet.

## Judging Alignment
* Impact 30 percent plus Indie creativity lens: tie each screen to a real outcome and a metric (intuition formed in under 60 seconds, zero install access gained), plus one bold frontier leap (an agent that teaches only from the numbers on screen and admits what they cannot prove).
* Demo 25 percent: script for single presenter clarity, rehearse fallback, end with memorable visual.
* Tooling 25 and Depth 20 by making the single live integration visible (one Modal endpoint, forced analytic solver, local deterministic helpers, honest Retry), with legacy multi model paths labeled cached or offline rather than hidden.
