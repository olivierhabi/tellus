# ADR — Quiver F2: Analysis Document State Management & OT Client

- **Status**: Accepted (BE contract surface ready; SPA work tracked in tellus-fe)
- **Date**: 2026-05-04
- **Task**: T-05 (F2)
- **Spec**: `tasks/quiver/quiver-tasks.md` §F2; contracts `tasks/quiver/contracts.md` §F2 C-01..C-10
- **Decision binding**: D-23, D-24, D-25

## Context

F2 is the FE state model (Redux Toolkit + OT client). The BE-side
contract surface F2 consumes is:
1. The B1 PATCH/GET endpoints (already wired).
2. The B3 OT submitInstructions endpoint + 412 OT_BASE_VERSION_TOO_OLD
   (NOT YET IMPLEMENTED — Phase 3 / T-08).
3. Branch header propagation on every mutating call (G-05; existing).
4. The B4 working-state PUT for autosave (already wired).

## Decision

Per **D-23**, F2 lands BE-side as the contract surface; the actual SPA
implementation is a parallel deliverable in tellus-fe.

### BE-side (verified here)

- **F2 C-10 (branch indicator on dispatch)** — every BE endpoint that
  the FE dispatch path calls forwards `X-Tellus-Branch`. Already
  exercised by `b4-versions-integration.test.ts` (working-state branch
  isolation) and `b1-routes-integration.test.ts` (POST/PATCH branch
  header). Surfaced for F2 in `f2-state-contract-integration.test.ts`.
- **F2 C-09 (no localStorage of variable values)** — documented; the
  BE has no enforcement surface for this. Marked FE-ONLY; the FE repo
  must enforce via lint rule.

### FE-only (documented here, implemented in tellus-fe)

- **F2 C-01** — Redux Toolkit store with normalized slices `cards`,
  `canvases`, `parameters`, `meta`, `pendingInstructions`, `presence`.
  Implementation: `app/quiver/state/store.ts`. **(FE-ONLY)**
- **F2 C-02** — OT client engine. Maintains `localPending: Instruction[]`;
  on server confirm of remote instructions, transforms `localPending`
  against them and re-applies. Real semantics depend on B3's
  server-side OT (T-08). Implementation: `lib/quiver/ot/client.ts`.
  **(FE-ONLY, requires B3)**
- **F2 C-03** — On 412 `OT_BASE_VERSION_TOO_OLD`: full document
  re-fetch + rebase; do NOT auto-retry submit. Implementation:
  `lib/quiver/api/submitInstructions.ts`. **(FE-ONLY, requires B3)**
- **F2 C-04** — Optimistic update UX; "saving" indicator on affected
  cards. **(FE-ONLY)**
- **F2 C-05** — Per-user undo/redo; size cap 100; only own instructions
  are undoable; conflict → no-op + toast. **(FE-ONLY)**
- **F2 C-06** — Memoized selectors `selectCardById`, `selectDownstream
  Cards`, `selectVisibleCardsOnCanvas`. **(FE-ONLY)**
- **F2 C-07** — Public `QuiverStore` API surface. **(FE-ONLY)**
- **F2 C-08 (PROPERTY TEST)** — 1000 random instruction sequences, two
  simulated clients, identical convergence. **(FE-ONLY, requires B3)** —
  Per D-25 below: the test lives in tellus-fe alongside the OT client
  implementation. The B3 task in this repo will independently exercise
  the server-side OT engine with its own property test (B3 C-15).

### F2 C-09 enforcement strategy (D-25)

The "no variable values in localStorage" rule is enforceable two ways:
1. **FE-side ESLint rule** — bans `localStorage.setItem` calls outside
   the theme-key allowlist. To be added to `tellus-fe` ESLint config.
2. **Cypress assertion** — after every dispatch, snapshot
   `localStorage` and assert no key matches `tellus.quiver.*` except
   `tellus.quiver.theme`.

## Decisions Logged

- D-23 — F-tasks land BE-side as contract surface.
- D-24 — Coverage gate scans ADRs for FE-only C-IDs.
- D-25 — F2 C-08 property test deferred to tellus-fe; the B3 server-side
  property test (B3 C-15) provides the in-this-repo OT correctness gate.

## Verification

- BE-side test: `tests/quiver/integration/f2-state-contract-integration.test.ts`
  — branch propagation contract that F2 C-10 depends on.
- ADR coverage: F2 C-01..C-09 marked FE-ONLY; coverage gate accepts
  this per D-24.

## Implementation Sketch (for the FE repo)

```
app/quiver/state/
  store.ts                     -- Redux Toolkit configureStore
  slices/
    cardsSlice.ts
    canvasesSlice.ts
    parametersSlice.ts
    metaSlice.ts
    pendingInstructionsSlice.ts
    presenceSlice.ts
lib/quiver/ot/
  client.ts                    -- OT client engine (transform + reapply)
  types.ts                     -- Instruction discriminated union
  __tests__/
    convergence.property.test.ts  -- F2 C-08 (1000 sequences)
hooks/quiver/
  useQuiverStore.ts
  useDispatchInstruction.ts
  useUndoRedo.ts
selectors/quiver/
  selectCardById.ts
  selectDownstreamCards.ts
  selectVisibleCardsOnCanvas.ts
```
