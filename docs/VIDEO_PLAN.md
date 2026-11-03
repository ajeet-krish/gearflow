# Video Plan: GearFlow 3 Minute Demo

## Purpose And Audience
* Purpose: win Demo 25 plus support Meta Tooling 25, Impact 30, Technical Depth 20 in one memorable story.
* Primary audience: hackathon judges scanning 20,000 entries for a working frontier leap.
* Secondary audience: LinkedIn engineering audience watching sound off, judging craft and honesty.
* Success: viewer can repeat the idea in one line (chat sets up and runs flow sims) and remembers the live sweep.

## Ranked Format Concepts
* Option 1, chosen: deck plus face cam plus full screen demo. Slides for intro, problem, solution, close. Face cam in bottom corner throughout. Full screen screen recording for 1:10 to 2:30 demo.
  * Pros: matches requested structure, keeps human trust, lets flow field fill the frame at the wow moment, easy to edit in CapCut or DaVinci.
  * Cons: needs clean slide export plus OBS sync.
* Option 2: pure voiceover screen recording. Voice over app only, no face.
  * Pros: fastest to record, no camera lighting needed.
  * Cons: loses human connection, weaker for Indie creativity lens, forgettable in a large field.
* Option 3: one take talking head with live typing behind.
  * Pros: authentic, single shot energy.
  * Cons: no pacing control, typo risk live, hard to fit 3 minutes exactly, zoom clarity suffers.
* Option 4: documentary style with multiple scenes and music cuts.
  * Pros: cinematic.
  * Cons: over scope for 1 day production, risks missing working demo clarity.
* Why Option 1 wins: it opens cold, shows the builder, proves the product full screen, and closes with honest next steps. It serves judges plus LinkedIn with one edit.

## Style Guide
* Palette: Dracula dark matching the app. Ink near #0a0a0f, panel near #0d0d12, borders near #21222c, muted near #6272a4, purple #bd93f9, cyan #8be9fd, ok green #50fa7b, warn amber #ffb86c.
* Type: tracked uppercase labels, monospace for all data captions (Cl, CpMin, ms, grid, cache TTL).
* Captions: burned in captions for muted viewing on LinkedIn and judging scans.
* Lower thirds: name models honestly. Example: Chat powered by Meta text model. Image and audio inputs are future work.
* Music: low bed, minus 24 dB under voice, duck fully under sweep moment, no lyrics.
* Pacing: cold open fast, problem crisp, demo slow enough to read numbers, close calm. No slide longer than 15 seconds except demo.

## Stand Out Strategy For A 20,000 Entry Field
* First 5 seconds: cold open on live sweep footage already stepping. No title slide at 0:00. Typed prompt visible plus burned in caption.
* Thumbnail concept: CHAT RUNS CFD in bold mono over flow field still plus small face. Purple suction, cyan wake, RUN card visible.
* Gifable wow loop: 9 point alpha sweep morphing plus progress text Sweep X of 9. Silent loopable, readable at small size.
* Honesty as differentiator: show provenance labels on camera. Served by analytic preview, potential flow estimate, not validated. Judges remember candor.
* End on artifact: final flow still with Before versus After tutor table plus end card (name, project, hackathon, repo).

## Production Checklist
* OBS: 1440p canvas, 60 fps, screen plus webcam bottom corner, separate mic track, record to MKV then remux.
* Environment: do not disturb on, notifications off, browser zoom 100 percent, only GearFlow tab plus slides.
* Warm up: hit the live endpoint once, pretype camera safe prompts in chat drafts, keep Tutorials dropdown ready.
* Sweep trigger: Tutorials dropdown chip Stall demo is primary. Typed Run the alpha sweep from minus 4 to 12 deg is backup only, never mix both in one take. Setup via Example prompts dropdown chip Set up NACA 2412 at angle of attack (alpha) 6, which sends Set up NACA 2412 alpha 6. Typed setup backups: show me vortex shedding behind the cylinder, karman street please, set up the airfoil at alpha 8, airfoil naca 4412 alpha 2.
* Directing: speed ramps on waits, zoom keyframes at 125 percent on chat enter and RUN card, hold 1 sec on Cl 0.9750 and CpMin minus 2.4880.
* Audio: voice to minus 16 LUFS, test on phone speaker, test full video sound off.
* Never show: Validation panel, WASM badge, SAM overlay, poster generation, offline toggle, Export JSON button, misconception card.
* Offline needs no toggle: the sweep staircase runs with or without the endpoint, stepping the same canvas. If the endpoint is down, the same chip gives an honest offline summary. Never show error turns on camera.

## Upload And Submission Logistics
* Edit to exactly 180 seconds. Export 1440p, H264, 20 Mbps target.
* Upload to YouTube as Unlisted, audience set to Not for Kids, add chapters matching structure.
* Test link in incognito window. Confirm captions render.
* Upload morning of Nov 4, at least 3 plus hours before 9PM ET Nov 4 deadline (02:00 UTC Nov 5).
* Submission form needs: live demo URL, repo URL, YouTube link, short writeup (problem, users, Meta tooling, architecture, next steps), third party asset notes.
* Writeup mitigation for Tooling 25: the video shows the Meta text model path honestly. The README plus submission writeup document the full orchestration (Meta client, per call cache with 24h Spark TTL, eval ledger with cost, fallback chain with honest error plus Retry) to support the multi model Tooling criterion.
* YouTube chapters to paste: 0:00 Cold open, chat steps the flow live. 0:07 Intro. 0:20 The problem with CFD setup. 0:42 GearFlow, chat runs the solver. 1:10 Live demo. 2:14 Honest labels and limits. 2:32 Next steps and close.
* Captions: export SRT from the editor and upload it, in addition to burned in captions, for judging accessibility.
* Slide files in order: slides/01-intro.png, slides/02-problem-friction.png, slides/03-problem-intuition.png, slides/04-solution-harness.png, slides/05-constraints.png, slides/06-next-steps.png, slides/07-end-card.png.
* Go or no go 30 min before recording: hit the live endpoint once, confirm a tutor summary lands, confirm warm cache.
* Keep a local MP4 backup plus slide images in case of upload retry.
