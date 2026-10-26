# Data Sources and Provenance
Last updated: 2026-10-26. Retrieval date for all entries below: 2026-10-26. Phase 3 final with 2412 pair and 9 row tiers.

## Purpose
Phase 3 validation anchors for GearFlow. All numbers are vendored as committed JSON under fixtures/validation. No runtime fetch. This file records where each number came from, its license, corrected Reynolds numbers, parser specs, and how leakage is controlled.

## Sources
### 1. XFOIL NACA 0012 polars via AirfoilTools (clean anchor is Re 500k, Re 100k is WARN)
* What: Low Re viscous polars, XFOIL 6.96, Ncrit 9. Columns: alpha, CL, CD, CDp, CM, Top_Xtr, Bot_Xtr.
* Re available: 50k, 100k, 200k, 500k, 1M. Clean PASS anchor is Re 500k. Re 100k stays WARN only because the laminar separation bubble corrupts low alpha (kink near 1 to 2 deg, Cl jumps from 0.2578 at 1.0 to 0.3737 at 2.0). Do not fit slope through that kink and never mark Re 100k as PASS.
* Clean numbers (even alpha rows): Re 500k Cl is 0.0000 at 0, 0.2089 at 2, 0.4798 at 4, 0.7215 at 6, 0.8851 at 8. Re 100k Cl is 0.0000 at 0, 0.3737 at 2, 0.5365 at 4, 0.6862 at 6, 0.8471 at 8 (bubble affected below 4 deg). Transition Top_Xtr at Re 500k runs 0.7923 at 0 down to 0.0492 at 8.
* URLs: detail http://airfoiltools.com/polar/details?polar=xf-n0012-il-50000 (variants 100000, 200000, 500000, 1000000), text http://airfoiltools.com/polar/text?polar=xf-n0012-il-100000, csv http://airfoiltools.com/polar/csv?polar=xf-n0012-il-100000, coordinates http://airfoiltools.com/airfoil/details?airfoil=n0012-il
* Attribution: Mark Drela XFOIL solver, hosted by AirfoilTools. Cite Drela plus AirfoilTools in demo credits.
* License: Solver free for use, site data provided for personal and educational use. Vendored excerpt used under fair use for validation with attribution. No redistribution of bulk database.
* Used for: PASS on Re 500k absolute Cl within 0.05 at 4, 6, 8 deg. Re 100k shown as WARN with bubble note. Cd is NOT validated for any airfoil (inviscid gives 0).
* Alpha0 note: NACA 0012 alpha0 is 0. NACA 2412 details moved to section 1b with dual rows (theory minus 2.07 plus experimental minus 2.29).

* Ingest note: CSV is primary, TXT is fallback. Both vendored for 100k and 500k.

### 1b. XFOIL NACA 2412 polars via AirfoilTools (final Phase 3 pair)
* What: Cambered airfoil anchor, XFOIL 6.96, Ncrit 9, Mach 0. Columns match 0012 (alpha, CL, CD, CDp, CM, Top_Xtr, Bot_Xtr). Detail page http://airfoiltools.com/airfoil/details?airfoil=naca2412-il lists 10 polars (Re 50k, 100k, 200k, 500k, 1M at Ncrit 9 and Ncrit 5). Vendored: xf-naca2412-il-100000.txt plus csv (Re 0.100e6 Ncrit 9.000) and xf-naca2412-il-500000.txt plus csv (Re 0.500e6 Ncrit 9.000). Re 200k, 1M, and all Ncrit 5 variants NOT vendored by scope choice. Coordinate file fixtures/validation/naca2412.dat is Selig format (header NACA 2412 then x y rows from TE upper to TE lower, UIUC source).
* Even alpha Cl: Re 500k gives 0.2360 at 0, 0.5062 at 2, 0.7085 at 4, 0.8963 at 6, 1.0679 at 8. Re 100k gives 0.2623 at 0, 0.5150 at 2, 0.7087 at 4, 0.8941 at 6, 1.0201 at 8. Inviscid 2 pi law gives 0.226 at 0, 0.445 at 2, 0.666 at 4, 0.885 at 6, 1.104 at 8. Deltas versus Re 500k stay within 0.05 except at 2 deg (+0.061), so all three of 4, 6, 8 deg pass absolute.
* Alpha0 dual rows: theory minus 2.07 deg from thin airfoil integral (PASS target within 0.25 deg, not experimental). Experimental fit from vendored 500k polar minus 2.29 deg by zero crossing interpolation (between minus 2.5 Cl minus 0.0223 and minus 2.25 Cl 0.0042), kept as INFO reference. Re 100k intercept near minus 1.30 is bubble distorted, WARN only.
* Attribution: Mark Drela XFOIL solver, hosted by AirfoilTools. Cite Drela plus AirfoilTools plus Abbott and von Doenhoff for theory.
* License: Solver free for use, site data provided for personal and educational use. Vendored excerpt used under fair use for validation with attribution.
* Used for: PASS on absolute Cl within 0.05 at 4, 6, 8 deg versus Re 500k. Slope percent check NOT used for 2412 (viscous 4 to 8 deg slope 0.0899 per deg at 500k sits about 18 percent below inviscid, so percent check fails honestly). Cd NOT validated. Re 100k is WARN only.

### 2. NASA Turbulence Modeling Resource 2DN00 (corrected Reynolds numbers)
* What: NACA 0012 validation case. Ladson force data at Re 6M M 0.15. Gregory Cp at Re 2.88M (upper surface only, digitized from photocopy so approximate). McCroskey best fit slope 0.1075 per deg at Re 6M M 0.15.
* Correction: Gregory Cp is Re 2.88M, not 6M. Ladson forces are Re 6M. Do not label Gregory as 6M in code, fixtures, or demo copy.
* Page: https://tmbwg.github.io/turbmodels/naca0012_val.html, CFD: https://tmbwg.github.io/turbmodels/naca0012_val_sa.html
* Files: 0012.abbottdata.cl.dat, 0012.abbottdata.cd.dat, CL_Gregory_expdata.dat, CLCD_Ladson_expdata.dat, 0012.mccroskeydata.cl.dat, CP_Ladson.dat, CP_Gregory_expdata.dat, n0012clcd_cfl3d_sa.dat, n0012cp_cfl3d_sa.dat
* Key values: Ladson file has two zones (80 grit and 120 grit trip), columns alpha in deg plus cl plus cd, alphas minus 4.04 to 18.02, linear to about 14 deg, stall drop at 18.02. Use 80 grit or zone average below 14 deg. Gregory file has three zones (alpha 0, 10, 15), columns x over c plus cp. Alpha 0 peak about minus 0.42 near x over c 0.10 with stagnation 1.0 at x over c 0. Alpha 10 suction peak about minus 5.24 near x over c 0.0087. Alpha 15 peak about minus 10.18 near x over c 0.0024. McCroskey file is a 2 point fit line with slope 0.10749 per deg (6.16 per rad).
* Attribution: Ladson TM-4074 1988, Ladson et al TM-100526 1987, Gregory and OReilly R and M 3726 1970, Abbott and von Doenhoff 1959, McCroskey TM-100019 1987. Prefer Ladson tripped force data and Gregory Cp per TMR guidance.
* License: US public domain (NASA published data). Free to vendor with citation.
* Used for: PASS on Cl slope within 5 percent of 2 pi below 8 deg, McCroskey slope within 5 percent, Cp stagnation 1.0 within 0.05. Viscous suction peaks are INFO lower bounds only (inviscid overshoots, more negative, so never fail on peak).

### 3. Free cylinder Re 100 literature band (unsteady anchor, refined band)
* What: Free circular cylinder at Re 100: St 0.164 to 0.167, mean Cd 1.32 to 1.38, Cl peak amplitude 0.32 to 0.35 (Cl rms 0.22 to 0.24), Cd fluctuation amplitude about 0.009 to 0.011. St fit St equals 0.2665 minus 1.026 over sqrt(Re). Fey variant gives 0.165.
* Sources: Williamson Annu Rev Fluid Mech 1996, Williamson and Brown J Fluids Struct 1998, Henderson Phys Fluids 1997, Wolf Dynamics pimpleFoam laminar tutorial https://www.wolfdynamics.com/wiki/tut_2D_cylinder.pdf
* Attribution: Cite Williamson, Henderson, Wolf Dynamics tutorial.
* License: Published values cited as facts with attribution. Tutorial content referenced by link, not vendored.
* Used for: PASS on St within band only if an unsteady solver is added later. For Phase 3 exit, St plus mean Cd plus Cl amplitude are INFO rows. DFG channel benchmark excluded (confined channel with blockage and parabolic inflow gives Cd mean about 3.22 to 3.24 and St about 0.295 to 0.305, different physics).

### 4. Hybrid LBM airfoil data (background reference, AK Vortex removed from exit)
* What: NACA 0012 hybrid LBM, alpha 0 Cd 0.119 (Re 1000), 0.084 (Re 2000), 0.052 (Re 5000), 0.037 (Re 10000). Alpha sweep Re 1000 from 0 to 29 deg, steady below about 8 deg, stall near 26 deg.
* Sources: Di Ilio et al Computers and Fluids 166 (2018), arXiv:2006.10487. Local AK Vortex repo geometry and tau relation (tau equals 0.5 plus 3 nu).
* Attribution: Cite Di Ilio et al plus arXiv identifier.
* License: arXiv preprint values cited with attribution. Local repo cross check run by owner.
* Used for: background reference only. AK Vortex checks removed from Phase 3 exit criteria per scope decision. No LBM run blocks validation PASS.

## Ingest Parser Specs (final lock)
* AirfoilTools TXT (fallback): 12 line header (XFOIL 6.96 banner, airfoil name, fixed Re and Mach flags, xtrf 1.000 over 1.000 free transition, Mach plus Re plus Ncrit line, column header plus dash line), then whitespace delimited rows with 7 floats. Skip lines starting with non numeric plus dash lines. Split on whitespace. Example Re 100k line: 0.000 0.0000 0.01693 0.01017 0.0000 1.0000 1.0000.
* AirfoilTools CSV (primary): 10 line metadata (Polar key, Airfoil, Reynolds number, Ncrit, Mach, Max Cl over Cd, Url) then header Alpha,Cl,Cd,Cdp,Cm,Top_Xtr,Bot_Xtr on line 11, then comma rows. Split on comma after line 11. Covers xf-n0012-il-100000.csv, xf-n0012-il-500000.csv, xf-naca2412-il-100000.csv, xf-naca2412-il-500000.csv.
* TMR DAT: Tecplot style. Ignore lines starting with comment mark, variables line, zone headers. Parse remaining float rows, split by zone. Ladson zones are 80 grit and 120 grit. Gregory zones are alpha 0, 10, 15. Some numbers use Fortran D exponents, so convert D to E before float parse.
* Cylinder and LBM JSON: hand transcribed bands with source strings, no parser needed. Store min, max, provenance, retrieval date.
* Selig coordinates: plain text, optional header line (NACA 2412 or similar) plus x y pairs, TE to TE loop. Used for n0012.dat and naca2412.dat.
* Output: parsers emit fixtures/validation JSON arrays of alpha plus cl plus cd records and x plus cp plus alpha records. Validation panel reads JSON only. CSV preferred when both exist.

## Validation Tier Summary (9 rows, final)
* PASS: Re 500k absolute Cl for 0012 and 2412 at 4, 6, 8 deg, Ladson and McCroskey slopes, stagnation 1.0, cylinder shoulder minus 3.0, alpha0 (0012 at 0, 2412 theory at minus 2.07). Tolerances listed in docs/ARCHITECTURE.md.
* WARN: Re 100k rows for 0012 and 2412 (bubble kink). Review band at about twice PASS tolerance. Still demoable with a note. Never marked PASS.
* INFO: suction peaks, airfoil Cd (never validated), transition locations, cylinder St plus Cd mean plus Cl amplitude, 2412 experimental alpha0 minus 2.29 reference. Display only, never fails the suite.

## Leakage Statement
Validation fixtures are held out from surrogate training targets. The surrogate trains on analytic sweeps only. Validation numbers are used solely for tier reporting in the validation panel. No test polar point is used as a training label for a reported metric. Any future fine tuning on viscous data must add a new holdout set and record it here first.

## Manual Download Checklist
1. Download XFOIL text polars (0012 Re 100k WARN plus Re 500k PASS, 2412 Re 100k WARN plus Re 500k PASS) plus CSV primary variants and save parsed excerpts to fixtures/validation/xfoil_0012.json and xfoil_2412.json with URL and date.
2. Download NASA TMR Ladson force file (Re 6M) plus Gregory Cp file (Re 2.88M) plus McCroskey slope file to fixtures/validation/nasa_tmr_2dn00.json with URL and date. Verify Reynolds labels before commit.
3. Record cylinder band values (St 0.164 to 0.167, Cd 1.32 to 1.38, Cl amplitude 0.32 to 0.35, all INFO rows) plus citations in fixtures/validation/cylinder_re100.json.
4. Record Di Ilio Cd values as background reference in fixtures/validation/lbm_anchor.json. AK Vortex runs are NOT exit criteria.
5. Confirm no fetch calls remain in src/flow or validation panel code paths. Confirm no Gregory file is labeled 6M.
