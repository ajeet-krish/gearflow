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
* Fixtures (5): 1) NACA0012 0deg, 2) NACA2412 6deg, 3) cylinder R=0.25 at (0.5,0), 4) duct/channel constriction, 5) generic wing/rectangular block. All on same 128x128 SDF + uniform inflow baseline.
* Sources: Wikipedia NACA airfoil + Potential flow around circular cylinder; Moran 2003; Abbott/von Doenhoff 1959; LADSON TM-4741 1996; Batchelor 2000 p424; Wu et al 2022 SDF airfoil; AK-Vortex src/geometry.hpp, simulation_parameters.md (tau=0.5+3*nu).

## 2026-10-26 - GearFlow Phase 2 (analytic potential flow, Hess-Smith simplified, cylinder, duct)
* Choice: Hess-Smith constant-source plus constant-vortex (N=100 to 160 panels, cosine spaced, reuse naca4Airfoil points) for NACA airfoils; analytic uniform plus doublet plus vortex for cylinder; Poiseuille parabola for duct baseline. All run in TypeScript on 128x128 grid, no CFD solver. Key trick: influence matrix A depends only on geometry, factor once then backsolve per alpha for fast sliders.
* Cylinder oracle (U=1, R=0.25): Vr=U*(1-R^2/r^2)*cos(theta), Vt=-U*(1+R^2/r^2)*sin(theta)-Gamma/(2*pi*r); surface Cp=1-4*sin^2(theta) (Cp=1 at 0,pi; Cp=-3 at pi/2,3pi/2; Vmax=2U). Lifting: Cp=1-(2*sin(theta)+Gamma/(2*pi*R*U))^2, Cl_cyl=Gamma/(U*R), Cd=0 (dAlembert).
* Airfoil: Kutta-Joukowski L=rho*U*Gamma, Cl=2*Gamma/(U*c). Thin-airfoil Cl=2*pi*(alpha-alpha0), alpha rad; slope 2*pi/rad = 0.1097/deg (measured viscous 0.10 to 0.11/deg). NACA0012 alpha0=0; NACA2412 alpha0=-2.07 deg theory, -2.10 deg measured. Cl(2412, 6deg) approx 0.88 inviscid, approx 0.75 to 0.85 measured. Validate: Cl slope within 5 percent of 2*pi below 8deg; Cp stagnation 1.0 plus/minus 0.05; cylinder shoulder -3.0 plus/minus 0.05; zero drag for symmetric 0deg.
* Hess-Smith TS steps: 1) nodes clockwise from lower TE, 2) panel angles/lengths/midpoints, 3) local influence u*=-1/2pi*ln(r2/r1), v*=beta/2pi (source) then rotate to global, 4) build (N+1)x(N+1) system (N tangency + 1 Kutta Vt1=-VtN), Gaussian elimination with partial pivot, 5) Vt_i then Cp_i=1-(Vt_i/U)^2, Gamma=gamma*sum(S_i), Cl=2*Gamma/(U*c), 6) grid eval u,v via superposition + freestream, mask inside via pointInPolygon/SDF, 7) cache A factorization for alpha sweep.
* Duct: plane Poiseuille u(y)=-1/(2*mu)*dp/dx*y*(H-y); umax=-H^2/(8*mu)*dp/dx; uavg=2/3*umax; u/uavg=6*(y/H)*(1-y/H). Use as duct baseline plus continuity speedup U2=U1*(H1/H2) in constriction. Entrance length Le approx 0.05*Re*Dh (flag if grid shorter).
* Slider implications (AoA -4 to 12, t 0.06 to 0.18): linear range holds, stall 12 to 15deg so clamp at 12deg; LE radius 1.1019*t^2 (0.004 at t=0.06, 0.036 at t=0.18) controls suction peak sharpness; thicker needs slightly more panels near LE (cosine spacing already does this); per-alpha solve is O(N^2) backsolve only, grid eval approx 2M ops (16k cells x 120 panels) under 100 ms in Float64Array, cacheable.
* Limits: inviscid so Cd=0, no separation or stall, fore-aft symmetric Cp on cylinder; keep Phase 1 wake visual as separate cosmetic deficit scaled by Cl, do not feed back into Cp/Cl.
* Sources: Hess/Smith 1967; Stanford AA200b lect 3-4 (Moran derivation); Anderson Fundamentals of Aerodynamics; Abbott/von Doenhoff 1959; Ladson et al TM-4741 1996; McCroskey AGARD NACA0012 assessment 1987; MIT 16.Unified f16 cylinder with circulation; Caltech Brennen potential flow; MFiX FLD01 Poiseuille; AeroSim Nassu Poiseuille LBM validation.
