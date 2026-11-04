# Video Script: GearFlow 3 Minute Demo (280 words spoken)

## Full Spoken Script (read verbatim, 280 words)
#### Intro

Traditional computational fluid dynamics tools are extremely powerful but setting up simulations can take hours. What if you could set up CFD in seconds, without being stuck navigating menus.

My name is Ajeet and I built GearFlow, an interactive fluid dynamics toolkit controlled through natural language. Explain the simulation you want to build and an agent builds it.

Students can ask questions and receive instant visual feedback with physics explanations. Engineers can test simple ideas without wasting compute resources on repeated simulations.

#### Demo

1. Let's build a simple airfoil simulation: "Set up an airfoil naca 2415 at angle of attack 6". The agent builds it and explains the lift coefficient and coefficient of pressure. Let's make some adjustments: "increase camber and decrease thickness". Then: "increase the angle to 10".

2. Let's try some different shapes and bodies: "Show me a flow around a cylinder". Then: "increase radius".

3. "Show me flow around a square", "increase the length and rotate a bit"

4. Let's ask the agent to teach us about a flow scenario: "what happens when flow is constricted". The agent explains the physics and builds a simulation that helps us visualize a constricted flow. Let's see the pressure at the gap: "what happens to pressure". Here we can see the drop of pressure at the gap, causing flow to speed up. "widen the gap a lot".

Under the hood, every turn runs one harness. Words go to a Meta text model through Modal: one completion, capped length, zero temperature. The model answers in a fenced envelope of actions. A validator checks each action against the contract and the app executor applies them. Then the agent explains what changed, why, and what to try next.

At its current stage, this is a 2D inviscid flow estimation and not a full viscous CFD simulation. Planned next steps are a built-in solver that the agent can drive end-to-end for real simulations, turning into a comprehensive CFD harness. Implementing image and audio models could add even more ways of interacting with the agent, such as drawing a specific geometry or explaining turbulence models. The purpose of this project is to try and push the bounds of traditional CFD with Agentic AI workflows.

## Beat Sheet (time, visual, spoken, action)
* 0:00 to 0:07 cold open. Visual: full screen flow canvas morphing to the airfoil, no face, no slide. Spoken: Watch this. I told my flow solver to set up an airfoil, in English. Action: typed Set up an airfoil naca 2415 at angle of attack 6 sent just before rolling, canvas morphing, burned in caption on. Cold open clip may be lifted from the demo A take.
* 0:07 to 0:38 intro. Visual: slides plus face cam bottom corner, name and solo Indie entry. Spoken: Traditional CFD tools are powerful, but setup takes hours. What if you could set one up in seconds, without navigating menus? My name is Ajeet and I built GearFlow, an interactive aerodynamics toolkit controlled through natural language. Explain the simulation you want to build and an agent builds it. Students see physics instantly. Engineers test ideas without burning cluster time. Action: click through 2 slides (problem, product), hold each 12 sec, face cam on, lower third with name.
* 0:38 to 1:08 demo A airfoil. Visual: full screen app, left rail chat. Spoken: Case one, an airfoil. The agent builds it and explains lift and pressure. Now reshape it: more camber, thinner section. Then alpha 10. Watch the suction peak grow. Action: paste and send Set up an airfoil naca 2415 at angle of attack 6, then increase camber and decrease thickness, then increase the angle to 10. Prompts shown on screen, not spoken. Zoom 125 percent on chat enter. Read RUN card actuals live, never invent numbers. Backups if a turn misfires: set NACA 3408 at alpha 6, set alpha to 10.
* 1:08 to 1:23 demo B cylinder. Visual: full screen app, cylinder wake. Spoken: Case two, a cylinder at Re 1000. Now a bigger radius. Watch the wake widen. Action: paste and send Show me a flow around a cylinder at Re 1000, then increase radius. Never add shedding or karman words on this turn, the preset collision drops Re to 100. Backups: set body to cylinder at Reynolds number 1000, set cylinder radius 0.5.
* 1:23 to 1:36 demo C square. Visual: full screen app, block field. Spoken: Case three, a square. Now stretch it and rotate a bit. Action: paste and send Show me flow around a square, then increase the length and rotate a bit. Backup: set block width 1.2 height 0.5 alpha 10.
* 1:36 to 2:01 demo D constriction. Visual: full screen app, orifice field then Cp. Spoken: Case four, constricted flow. The agent explains the physics and builds the orifice. Show pressure at the gap: the pressure drop speeds the flow up. Now widen the gap. Action: paste and send what happens when flow is constricted, then what happens to pressure and confirm the field switches to Cp, then widen the gap a lot. Backups: set up the orifice constriction (constriction, never constricted), how does this affect pressure, set orifice gap 0.8. Never say high pressure on camera.
* 2:01 to 2:29 architecture. Visual: slide plus code B roll. Spoken: Under the hood, every turn runs one harness. Words go to a Meta text model through a proxy: one completion, capped length, zero temperature. The model answers in a fenced envelope of actions. A validator checks each action against the contract, caps at five, and the app executor applies them. Then the Physics Agent explains what changed, why, and what to try next. Action: scroll code slowly, highlight file names in this order: src/agent/modalGate.ts (single completion, capped tokens, zero temperature, low reasoning, fail closed proxy), src/agent/agentActions.ts (contract validator, five action cap), src/ui/AgentConsole.tsx (executor plus Physics Agent), src/agent/sessionSpend.ts (5 dollar soft cap). Lower third: Chat powered by Meta text model.
* 2:29 to 2:40 honesty. Visual: close on provenance label. Spoken: Every run carries its label: analytic preview, potential flow estimate, not validated. Cache 24 hours, spend capped at 5 dollars. Failures land honest with Retry. Action: hold on case note served by analytic preview (potential flow estimate, agent first mode) plus engine token ANALYTIC.
* 2:40 to 3:00 close. Visual: 2 slides constraints then next steps plus end card. Spoken: Today this is 2D inviscid, not full viscous CFD. Next, the agent drives a built-in solver end to end, with image and audio inputs later. I am Ajeet, this is GearFlow: pushing CFD with agentic AI. Action: show end card name project hackathon repo, hold 4 sec.

## Rehearsal Checklist
* Rehearse twice with timer. Ten live turns need about 40 seconds of model latency; speech fills the rest. If the endpoint averages slower than 5 seconds per turn, plan to drop a follow-up in the edit.
* Pre-type all 10 prompts in a scratch pad, paste and send live. Never retype on camera.
* Go or no go 30 min before recording: send each verbatim prompt live and confirm the canvas changes as expected. Any misfire swaps to its backup prompt for the recording.
* Absolute-number backups exist for every follow-up (3408, alpha 10, radius 0.5, block 1.2 by 0.5, gap 0.8). Relative words have no parser rescue, so verbatim turns ride the model alone.
* Forbidden on camera: shedding, karman, constricted (say constriction), high pressure, Validation panel, SAM overlay, poster, Export JSON, misconception card.
* Speak at calm demo pace, pause 1 beat on numbers, smile when the reshape lands.
* Re-run npm test on recording morning and quote the fresh numbers for Q and A.

## Fallback Plan
* If endpoint fails mid recording, cut camera, keep rolling screen capture. Restart narration from the current case setup prompt once the endpoint is back.
* Never show an error turn on camera. Pause voice, re-paste the prompt, retry once, then move on.
* If a follow-up fence misfires (canvas unchanged), narrate the intent live and keep rolling; fix in the next take.
* Never cut to Validation panel, SAM overlay, poster, or Export JSON. Those are unmounted or blocked.
* If running long, drop the 2a radius turn or the 4a pressure turn in the edit; cases 1 and 3 carry the story.
