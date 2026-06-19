# D-84 — GATE-03 (E2E Analysis Lifecycle Gate) deferred to FE-shell deliverable

Date: 2026-05-05
Status: Accepted (blocker)

## Ambiguity

GATE-03 specifies a single Playwright test driving the full 14-step
analysis lifecycle: create → add cards → validate DAG → bind parameters
→ time-series with rolling aggregate → transform table → save/revert
→ 2-browser collaboration → AIP generate/configure → publish dashboard
+ visual function → embed → metric/audit verification.

This gate requires a fully-running FE shell rendering the analysis
canvas — the deliverable that lives in `/Users/olivierhabimana/Desktop/projects/tellus-fe`
per D-23 (FE-task scope). The current verification harness (`scripts/quiver-verify.sh`)
runs Postgres + Redis + the BE compute path; it does not (yet) build
or boot the FE shell.

## Options considered

1. **Build + boot the FE shell from this harness.**
   - Reach into `tellus-fe/`, run `pnpm install && pnpm build`, serve
     the build, drive Playwright against it.
   - Bringing a parallel repo into this harness contradicts D-23 and
     bloats the scope of the BE drive.
2. **Stub the FE with a synthetic HTML harness.**
   - Cheap, but defeats the gate's purpose: the gate is about the
     *real* user-visible flow, not a synthetic.
3. **Defer to FE-shell deliverable.** *(chosen)*
   - File this D-blocker, document what the FE-side work needs to do
     to close GATE-03, and have GATE-03 added to `DEFERRED_IDS` in the
     coverage gate with this D-entry as the citation.

## Choice: option 3 — defer

**Decision-Protocol defaults:** consistency with existing Tellus
conventions (D-23 already binds F-tasks to `tellus-fe`); production
safety (don't ship a fake-passing gate; document the real gap).

## What unblocks resumption

The FE-side deliverable in `tellus-fe` ships a Playwright suite at
`tellus-fe/cypress/e2e/quiver/lifecycle-gate.cy.ts` (or equivalent
Playwright tree) that drives the 14 steps against a live BE+FE
deployment. When that suite exists and runs green three times in a
row, GATE-03 is closed.

The BE side is already prepared:
- B1 GET/PATCH/PUT analyses + cards (T-01).
- B2 _validate route (T-02).
- B3 instructions stream + WS gateway (T-10/T-11).
- B4 versions + working state (T-03).
- B5 compute coordinator (T-06).
- B6/B7/B8/B9 backends (T-07/T-13/T-14/T-16).
- B10 publishing (T-17).
- F1/F2/F3/F4/F5/F6/F7/F8/F9/F10 surfaces shaped by ADR per D-23.

GATE-01, GATE-02, GATE-04 are exercised in-process by:
- `tests/quiver/integration/gate-01-ot-convergence-integration.test.ts`
- `tests/quiver/integration/gate-02-compute-cache-deadline-integration.test.ts`
- `tests/quiver/integration/gate-04-auth-branch-propagation-integration.test.ts`

GATE-03 is the only gate that fundamentally requires the FE shell.

## Touches

GATE-03; D-23 (FE-scope binding); D-24 (ADR fallback for FE-only contracts).
