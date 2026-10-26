# Hackathon Rules Reference
> LOCKED PROFILE: Solo participant, Indie track, Push the Frontier theme. Virtual worldwide. Build Oct 26 to Nov 4 2026. Single submitter lists self only.

Source of truth for constraints. Flagged items await Official Rules confirmation. Profile above is locked for all planning, scoping, and judging alignment.

## Event Overview
| Item | Detail |
|------|--------|
| Event | Meta Global AI Developer Hackathon (Meta plus Cerebral Valley) |
| Format | Virtual, worldwide |
| Build window | Oct 26 to Nov 4, 2026 |
| Submissions due | Nov 4, 9PM ET (Nov 5, 02:00 UTC) |
| Judging | Nov 4 to Nov 8, 2026 |
| Finals | Nov 9, 2026 |
| Credits | 150 USD API credits per participant (anticipated) |
| Themes | 1) Build for Your World 2) Push the Frontier |

## Locked Track and Theme

### Indie track (locked)
* Solo entry is allowed. Limit is up to 4 per team, but solo has no teammate dependency and no acceptance risk.
* Single submitter flow: one person accepts terms, submits, and lists self only.
* Indie lens rewards creativity, technical ambition, craft, and whether it works and delights.
* What scores high for Indie: bold idea, clever multi model use, polished demo moment, clear technical craft in 10 days.

### Push the Frontier theme (locked)
Pushes machine capability and physical system understanding. Scope includes software, robotics, manufacturing, energy, materials, scientific acceleration, and machine control of physical systems.
What scores high through the Indie lens:
* Technical ambition: hard perception plus reasoning plus rendering problem, not a thin wrapper.
* Frontier fit: accelerates science, controls or explains a physical system, or extends what models can see and do.
* Working proof: live demo with measurable behavior (accuracy, latency, segmentation quality) plus graceful fallback.
* Clarity: judges can see the frontier leap in one demo moment.

### Startup track (not entered, short note)
Startup lens rewards execution and production readiness. Noted for reference only. No action needed for this solo Indie entry.

## Timeline (ET and UTC)
| Milestone | ET | UTC |
|-----------|----|-----|
| Build start | Oct 26, 2026, 12:00 AM ET | Oct 26, 2026, 04:00 UTC |
| Build end / submissions due | Nov 4, 2026, 9:00 PM ET | Nov 5, 2026, 02:00 UTC |
| Judging window | Nov 4 to Nov 8, 2026 | Nov 4 to Nov 8, 2026 (plus Nov 9 UTC overlap for late zones) |
| Finals / winners | Nov 9, 2026 | Nov 9, 2026 |

Note: Exact kickoff hour is pending Official Rules. Dates above are reference. Confirm in Official Rules.

## Eligibility and Team Rules (Solo Indie locked)
* Solo entry confirmed. Open to global virtual participants, subject to local law and platform terms.
* Original work only. Build must be created during the build window, except approved open source libraries and Meta APIs.
* Team limit is up to 4, but solo has no teammate dependency. Single submitter lists self only.
* One submission per entrant (to be confirmed in Official Rules).
* Exclusions apply (Meta employees, judges, and certain restricted regions, to be confirmed in Official Rules).
* Solo submitter accepts terms and submission license directly.

## Technical Requirements
Mandatory use of Meta AI products with multi model orchestration.

| Model / Tool | Role in stack | Notes |
|--------------|---------------|-------|
| Muse Spark / Wonder | Reasoning, chat, planning, orchestration | Primary reasoning layer |
| Glimmer | Lightweight interaction or on device style tasks | Use where latency matters |
| SAM 3.1 | Perception and segmentation | Vision and scene understanding |
| Muse Image | Rendering and visual generation | Demo visuals, assets |
| Muse Code | Developer velocity, codegen | Document usage in README and demo |

API base URL: https://api.meta.ai/v1

Rules:
* Combine at least two Meta models in a meaningful pipeline (for example perception plus reasoning, or reasoning plus rendering).
* Single model wrapper with no orchestration will score low on Use of Meta AI Tooling (25 percent).
* Document model usage, prompts, and fallback behavior in README and demo video.

## Submission Requirements
* Working demo (live URL, TestFlight, APK, or recorded fallback if live needs keys).
* Demo video, 2 to 3 minutes, showing real use and Meta model value.
* Public code repo with README (setup, API keys, run steps).
* Short writeup: problem, users, Meta tooling used, architecture, next steps.
* Declare third party assets, data sources, and licenses.

## Judging Rubric
| Criterion | Weight | What scores high |
|-----------|--------|------------------|
| Impact | 30 percent | Clear user pain, real world benefit, evidence of need, plausible adoption |
| Use of Meta AI Tooling | 25 percent | Deep multi model orchestration, clever use of Spark/Wonder, SAM, Image, Glimmer, visible Meta value |
| Demo | 25 percent | Polished 2 to 3 min story, live works, graceful fallback, memorable moment |
| Technical Depth | 20 percent | Sound architecture, hard problems solved, evaluation, performance, reliability |

Lens notes (Indie primary):
* Indie lens (locked): rewards creativity, ambition, and craft (it works and delights). Priority for this entry.
* Startup lens (reference only): rewards execution and production readiness. Not scored for this entry.

## Solo Strategy Note (10 day scope control)
* One owner, one submitter. No bus factor risk from teammates, but strict scope control is required.
* Pick one frontier problem, one core loop, one wow moment. Cut everything else.
* Single presenter demo: rehearse solo narration, one click cached fallback, offline pack ready.
* Daily checkpoint: working demo stays runnable. Docs first, code second.

## Prizes (Anticipated, Pending Official Rules)
| Track | Amount |
|-------|--------|
| Startup track | 550,000 USD |
| Indie track | 400,000 USD |
| Bonus prizes | 50,000 USD |
| Total anticipated | 1,000,000 USD |

Confirm split, taxes, and payment mechanics in Official Rules.

## Disqualification Triggers
* Plagiarism or non original submission.
* No meaningful use of Meta AI tooling.
* Missing demo or non reproducible build.
* Malicious code, data exfiltration, or policy violation.
* Licensing violation (unattributed assets, non commercial assets used commercially).
* Cheating the judging process or misrepresenting team eligibility.
* Training data or PII abuse, or unsafe content without safeguards.

## Critical Architecture Constraints (9 Points)
1. Multi model by design: route perception (SAM 3.1) to reasoning (Spark/Wonder) to rendering (Image) with explicit handoffs.
2. API strategy: support Standard mode by default. Use Contributor mode (trains models) only with explicit user consent and clear labeling.
3. Caching: cache model responses by input hash with TTL to save credits and reduce latency.
4. Fallback chain: define primary plus degraded behavior (for example SAM fails to bounding box fallback, Image fails to placeholder asset).
5. Offline and low bandwidth: provide cached demo mode so the 2 to 3 min video and live judging never depend on perfect network.
6. Key hygiene: API keys in env only, never in repo, with sample env file and key rotation notes.
7. Evaluation hooks: log latency, cost, and quality per model call for Technical Depth evidence.
8. Geography awareness: handle locale, timezone (ET plus UTC), and regional availability gracefully.
9. Reproducibility: pinned versions, one command setup, seedable demo data, deterministic fallback paths.

## Verification Checklist (Pending Official Rules)
* [ ] Confirm exact start hour and submission portal timezone handling
* [ ] Confirm team size limits and cross region teams
* [ ] Confirm prize split and eligibility exclusions
* [ ] Confirm single versus multiple submissions per team
* [ ] Confirm Standard versus Contributor API terms and data use
* [ ] Confirm allowed prebuilt code and assets cutoff date
* [ ] Confirm judging format (async video plus live finals)
* [ ] Confirm license grant scope for submissions
* [ ] Reverify API base URL and model names at build start
