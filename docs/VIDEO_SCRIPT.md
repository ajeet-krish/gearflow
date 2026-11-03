# Video Script: GearFlow 3 Minute Demo (319 words spoken)

## Full Spoken Script (read verbatim, 319 words)



Watch this. I told my flow solver to set up an airfoil, in English.
I am Ajeet, a solo builder working on scientific tools. I build GearFlow, a browser lab where chat sets up aerodynamics. Solo Indie entry, pushing what chat can do for physics.
CFD tools are powerful but setup is friction. Meshing, solvers, and plots take hours. Students guess instead of seeing. Intuition never builds because trying one angle takes too long. Engineers wait for clusters to test simple ideas.
GearFlow fixes that. Type a case in chat and the agent builds it. It runs on a Meta text model for reasoning, with cached responses and an eval ledger for every call. You see metaClient, modalGate, cache, and evalLog here. Today chat is text only, and every result carries an honest label.
Case one, airfoil. Set up airfoil NACA 2415 at angle of attack 6. The agent builds it: milliseconds, 512 grid. Now reshape it. Set NACA 3412, more camber, thinner section. Then set alpha to 10. Watch the suction peak grow.
Case two, cylinder. Set body to cylinder at Reynolds number 1000. Now set cylinder radius to 0.5. The wake widens with the body.
Case three, square. Show me flow around a square. Now stretch it: set block width to 1.2, height to 0.5, alpha to 10.
Case four, constriction. Set up the orifice constriction. How does this affect pressure? The field switches to Cp. Now widen it: set orifice gap to 0.8.
Every run carries its label: analytic preview, potential flow estimate, not validated. Spark cache lives 24 hours, spend capped at 5 dollars. If the network drops, calls fail honest with Retry.
Today is a 2D inviscid preview, not viscous CFD. Next, the same agent will drive a full solver end to end for real simulations. Image plus audio inputs come after that. I am Ajeet, this is GearFlow for the Meta Global Hackathon.

## Beat Sheet (time, visual, spoken, action)
* 0:00 to 0:07 cold open. Visual: full screen flow canvas morphing to the airfoil, no face, no slide. Spoken: Watch this. I told my flow solver to set up an airfoil, in English. Action: typed set up airfoil naca 2415 at angle of attack 6 sent just before rolling, canvas morphing, burned in caption on. Cold open clip may be lifted from the demo A take.
* 0:07 to 0:20 intro. Visual: slide plus face cam bottom corner, name and solo Indie entry. Spoken: I am Ajeet, a solo builder working on scientific tools. I build GearFlow, a browser lab where chat sets up aerodynamics. Solo Indie entry, pushing what chat can do for physics. Action: face cam on, lower third with name.
* 0:20 to 0:40 problem. Visual: 2 slides, CFD setup friction then intuition gap. Spoken: CFD tools are powerful but setup is friction. Meshing, solvers, and plots take hours. Students guess instead of seeing. Intuition never builds because trying one angle takes too long. Engineers wait for clusters to test simple ideas. Action: click through 2 slides, hold each 10 sec.
* 0:40 to 1:06 solution. Visual: slide plus code B roll of src/meta/metaClient.ts, src/agent/modalGate.ts, src/meta/cache.ts, src/meta/evalLog.ts. Spoken: GearFlow fixes that. Type a case in chat and the agent builds it. It runs on a Meta text model for reasoning, with cached responses and an eval ledger for every call. You see metaClient, modalGate, cache, and evalLog here. Today chat is text only, and every result carries an honest label. Action: scroll code slowly, highlight file names, lower third Chat powered by Meta text model.
* 1:06 to 1:36 demo A airfoil. Visual: full screen app, left rail chat. Spoken: Case one, airfoil. Set up airfoil NACA 2415 at angle of attack 6. The agent builds it: milliseconds, 512 grid. Now reshape it. Set NACA 3412, more camber, thinner section. Then set alpha to 10. Watch the suction peak grow. Action: type set up airfoil naca 2415 at angle of attack 6, then type set NACA 3412 at alpha 6, then type set alpha to 10. Zoom 125 percent on chat enter. Read RUN card actuals live, never invent numbers.
* 1:36 to 1:52 demo B cylinder. Visual: full screen app, cylinder wake. Spoken: Case two, cylinder. Set body to cylinder at Reynolds number 1000. Now set cylinder radius to 0.5. The wake widens with the body. Action: type set body to cylinder at Reynolds number 1000 (never say shedding or karman on this turn, the preset collision would drop Re to 100), then type set cylinder radius to 0.5.
* 1:52 to 2:08 demo C square. Visual: full screen app, block field. Spoken: Case three, square. Show me flow around a square. Now stretch it: set block width to 1.2, height to 0.5, alpha to 10. Action: type show me flow around a square, then type set block width to 1.2, height to 0.5, alpha to 10.
* 2:08 to 2:28 demo D constriction. Visual: full screen app, orifice field then Cp. Spoken: Case four, constriction. Set up the orifice constriction. How does this affect pressure? The field switches to Cp. Now widen it: set orifice gap to 0.8. Action: type set up the orifice constriction (constriction, never constricted, never say high pressure), then type how does this affect pressure and confirm the field switches to Cp, then type set orifice gap to 0.8.
* 2:28 to 2:40 honesty. Visual: close on provenance label. Spoken: Every run carries its label: analytic preview, potential flow estimate, not validated. Spark cache lives 24 hours, spend capped at 5 dollars. If the network drops, calls fail honest with Retry. Action: hold on case note served by analytic preview (potential flow estimate, agent first mode) plus engine token ANALYTIC.
* 2:40 to 3:00 close. Visual: 2 slides constraints then next steps plus end card. Spoken: Today is a 2D inviscid preview, not viscous CFD. Next, the same agent will drive a full solver end to end for real simulations. Image plus audio inputs come after that. I am Ajeet, this is GearFlow for the Meta Global Hackathon. Action: show end card name project hackathon repo, hold 4 sec.

## Rehearsal Checklist
* Rehearse twice with timer, time each beat, keep turns brisk to protect all four cases.
* Prewarm endpoint. Pre-type every follow-up in a scratch pad, paste and send live to save seconds.
* Absolute numbers only for follow-ups (3412, alpha 10, radius 0.5, width 1.2, gap 0.8). Relative words like increase, widen, or a bit have no parser rescue.
* Never say shedding or karman on the cylinder turn, never say constricted, never say high pressure. Use constriction, orifice, gap.
* Go or no go 30 min before recording: hit the live endpoint once with each of the 4 setup prompts, confirm the canvas changes, confirm warm cache.
* Speak at calm demo pace, pause 1 beat on numbers, smile when the reshape lands.
* Test suite note for Q and A only: re-run npm test on recording morning and quote the fresh numbers.

## Fallback Plan
* If endpoint fails mid recording, cut camera, keep rolling screen capture. Restart narration from the current case setup prompt.
* Never show an error turn on camera. Pause voice, re-paste the prompt, retry once, then move on.
* If a follow-up fence misfires (canvas unchanged), narrate the intent live and keep rolling; fix in the next take.
* Never cut to Validation panel, SAM overlay, poster, or Export JSON. Those are unmounted or blocked.
* If running long, drop the 2a radius turn or the 4a pressure turn in the edit; cases 1 and 3 carry the story.
