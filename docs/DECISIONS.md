# Decisions Log
Append only. Add new entries at bottom with date. Never rewrite history.

## Format
* Date:
* Context:
* Options considered:
* Decision:
* Impact (judging link):

## Entries

### 2026-10-26 Track selection pending
* Date: 2026-10-26
* Context: Need to choose Indie versus Startup lens and theme (Build for Your World or Push the Frontier).
* Options considered: Indie craft demo, Startup production path.
* Decision: Pending. Await brainstorm and feasibility check.
* Impact (judging link): Shapes Impact story and Technical Depth scope.

### 2026-10-26 Chose Solo Indie Push the Frontier
* Date: 2026-10-26
* Context: Participant profile locked as solo entrant in Indie track with Push the Frontier theme. Virtual worldwide, build Oct 26 to Nov 4 2026.
* Options considered: Solo Indie frontier craft versus team Startup production path versus Build for Your World local utility.
* Decision: Enter solo in Indie track on Push the Frontier theme. Single submitter lists self only.
* Rationale: Solo avoids teammate acceptance risk and keeps scope controllable in 10 days. Frontier fits technical ambition and multi model orchestration (Spark plus SAM plus Image).
* Impact (judging link): Shapes Impact story around frontier leap plus Indie creativity lens, and Technical Depth around working proof with cached fallback.

### 2026-10-26 Phase 1 geometry and flow review FAILs fixed (backend-dev)
* Date: 2026-10-26
* Context: code-reviewer FAIL on Phase 1 geometry/flow: regenerated polygon per cell, TS/script seed divergence, untested alpha sign, missing validation, unhandled duct kind, hardcoded wake centreline, duplicated fixture logic.
* Options considered: shared TS import for fixture script versus mirror plus parity test.
* Decision: Mirror plus parity test (script stays plain node, TS is canonical, src/flow/fixtures.parity.test.ts guards drift). Hoisted polygon, unified seed phase (seed % 7), aerodynamic alpha sign (positive nose up, negated math angle, TE down in y-up), duct wall mask plus block parity, 5 fixtures per RESEARCH.md, removed misleading 128x64 alias, extended validators (geometry ranges, DemoPack version/meta/files, pack/flow consistency, airfoil points).
* Rationale: Keeps fixture baking dependency free while making drift fail loudly in CI. Duct as channel constriction matches RESEARCH.md promise without Phase 2 solver scope.
* Impact (judging link): Technical Depth (deterministic, tested fixtures) and Demo (correct AoA visual, 5 cases).
