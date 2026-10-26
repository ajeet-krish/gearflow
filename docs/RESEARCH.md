# Research Log
Append only. Brief notes with sources and dates.

## Hackathon Research (2026-10-26)
* Event: Meta Global AI Developer Hackathon, virtual worldwide, build Oct 26 to Nov 4 2026, due Nov 4 9PM ET (Nov 5 02:00 UTC), judging Nov 4 to 8, finals Nov 9.
* Judging: Impact 30, Meta Tooling 25, Demo 25, Technical Depth 20. Indie rewards creativity and craft. Startup rewards execution.
* Must use Meta AI with multi model orchestration: Spark/Wonder, Glimmer, SAM 3.1, Muse Image, Muse Code.
* Prizes anticipated 1M total (Startup 550k, Indie 400k, Bonus 50k). Credits 150 USD per participant. Pending Official Rules.
* Themes: Build for Your World, Push the Frontier.
* Sources: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details and https://dev.meta.ai
* Open: confirm Official Rules for team size, exclusions, submission portal, license grant.

## Domain Research
* Track locked 2026-10-26: Solo Indie Push the Frontier. Future research should prioritize frontier domains (software, robotics, manufacturing, energy, materials, scientific acceleration, physical system control) with solo demoable scope.
* To be filled after idea selection. Add user interviews, competing tools, data sources.

## 2026-10-26 - GearFlow Phase 1 (SDF, NACA4, potential flow fixtures)
* SDF: negative inside, positive outside, zero on wall, normalized by chord (sdf/c). Grid 128x128, x in [-0.5, 2.0], y in [-1.0, 1.0], chord=1, LE at (0,0). Reuse AK-Vortex naca_coords (cosine spacing, perp-to-camber) + point_in_polygon then min-distance to polygon for SDF sign.
* NACA4: yt=5*t*(0.2969*sqrt(x)-0.1260*x-0.3516*x^2+0.2843*x^3-0.1015*x^4) (use -0.1036 for closed TE); yc=m/p^2*(2*p*x-x^2) for x<p, m/(1-p)^2*((1-2p)+2*p*x-x^2) for x>=p; theta=atan(dyc/dx); xu=x-yt*sin(theta), yu=yc+yt*cos(theta), xl=x+yt*sin(theta), yl=yc-yt*cos(theta). Checks: 0012 max yt=0.06 at x=0.3, LE radius 1.1019*t^2=0.0159c.
* Potential-flow cylinder (fixture oracle): phi=U*r*(1+R^2/r^2)*cos(theta); Vr=U*(1-R^2/r^2)*cos(theta); Vt=-U*(1+R^2/r^2)*sin(theta); Cp=1-4*sin^2(theta) on r=R (Cp=1 at 0,pi; Cp=-3 at pi/2,3pi/2; Vmax=2U). Zero drag expected (dAlembert).
* Fixtures (5): 1) NACA0012 0deg, 2) NACA2412 6deg, 3) cylinder R=0.25 at (0.5,0), 4) duct/channel constriction, 5) generic wing/rectangular block. All on same 128x128 SDF + uniform inflow baseline.
* Sources: Wikipedia NACA airfoil + Potential flow around circular cylinder; Moran 2003; Abbott/von Doenhoff 1959; LADSON TM-4741 1996; Batchelor 2000 p424; Wu et al 2022 SDF airfoil; AK-Vortex src/geometry.hpp, simulation_parameters.md (tau=0.5+3*nu).
