# LinkedIn Launch Post: GearFlow

## Recommended Post (copy and paste, about 210 words)
I stopped clicking CFD sliders.

I built GearFlow, a browser airfoil lab where chat sets up and runs flow simulations. Type a case like Set up NACA 2412 alpha 6 and the agent builds it live. You see pressure, velocity, lift, and stall behavior right in the canvas. NACA 2412 at alpha 6 gives lift 0.9750 with minimum pressure minus 2.4880, readable with sound off.

Under the hood is an analytic preview solver (2 ms, 118 panels, 512 grid) with honest provenance labels on every run. The chat harness runs on a Meta text model, with a 24 hour cache and an eval ledger for cost and latency. 130 files and 1750 tests keep the build green.

The wow moment is the stall sweep. One phrase runs 9 alphas from minus 4 to 12 degrees, stepping the canvas live with progress and Stop control, then a tutor summary explains what changed, why, and what to try next.

This is day one. Next, the same agent will drive a full viscous solver end to end for real CFD simulations, not just an analytic estimate. Image and audio inputs come after that.

Full 3 minute demo attached. What would you ask chat to simulate first?

#CFD #AIagents #BuildInPublic

## Alternate Lines
* Alternate hook: Chat now sets up my flow sims.
* Alternate closing: If intuition came from conversation, what would you probe first?

## Posting Checklist
* Post from personal profile on Wed Nov 4 midday or late afternoon.
* Attach full 3 minute video natively, add captions, confirm sound off autoplay is readable.
* Put repo and live demo links in first comment, not in body, plus repeat the closing question there.
* Post first comment immediately after publishing, then reply to early comments within 15 minutes.
* Frame as engineering build story, never as vote request. Post goes out regardless of result.
* Pin for 48 hours, reshare key replies as follow up content.
