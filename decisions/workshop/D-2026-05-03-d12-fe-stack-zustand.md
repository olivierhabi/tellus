# D-12 — Frontend stack: zustand + react-query (in lieu of Redux Toolkit + RTK Query)

**Date:** 2026-05-03
**Status:** Accepted
**Touches contracts:** F01, F03, F04, F05..F10 (every F-task)

## Ambiguity
The Workshop spec calls for "React 18 + TypeScript 5 + Blueprint v6 + Redux
Toolkit + RTK Query + Vega-Lite via react-vega + MapLibre GL JS." The
existing `tellus-fe` codebase uses **zustand + @tanstack/react-query**
across every existing surface (`stores/*.ts`, `lib/*Api.ts`).

Mixing Redux Toolkit alongside zustand would split state-management idiom
inside a single app, which fails the "Consistency with existing Tellus
conventions" priority of the Decision Protocol.

The brief's Forbidden Behaviors include: **"Variable values live in a
dedicated reactive store (NOT Redux)."** zustand satisfies this rule
naturally; RTK is explicitly *not* required by the runtime.

## Options
1. **Add Redux Toolkit + RTK Query alongside existing zustand**: two
   competing idioms, larger bundle, no functional gain. Inconsistent.
2. **Migrate the entire FE off zustand to RTK**: out of scope; would
   touch every existing store and surface.
3. **Use zustand for editor + variable runtime, react-query for server
   state**: matches existing `tellus-fe` conventions; satisfies the
   "NOT Redux" rule for variable values trivially; mirrors RTK Query's
   server-state separation pattern via react-query's cache + invalidation.

## Decision
**Option 3.** zustand for client-only state (editor draft, variable graph
runtime, view-mode runtime). react-query for server-state (module GET
cache, module list cache, action-type picker cache). The Workshop API
client is a thin axios wrapper at `lib/workshopApi.ts` that mirrors the
RTK Query "endpoints" pattern at the function level.

## Rationale
- §F04 explicitly requires variable values to live OUTSIDE Redux. zustand
  is the natural fit; using RTK here would *violate* the spec.
- "Consistency with existing Tellus conventions" — every existing
  `tellus-fe` surface is zustand + react-query.
- Bundle size: avoids adding RTK + RTK Query when the equivalent
  patterns exist already.
- ETag/If-Match wiring is identical: the axios interceptor pattern that
  `lib/api.ts` already uses preserves response headers, which the
  Workshop client reads via `res.headers["etag"]`.

## What evidence would change this
- A pre-existing Tellus convention requiring RTK Query (not found at
  audit time).
- A spec section that explicitly forbids zustand or requires RTK
  Query-specific features (cache tags, prefetch, etc.) that
  react-query cannot model. A grep of the spec finds no such requirement.

## Tests tagged with this decision
- `tellus-fe/tests/unit/workshopApi.test.ts` — header injection +
  blind-PUT rejection mirror RTK Query's "prepareHeaders" contract.
- `tellus-fe/tests/unit/workshopDraftStore.test.ts` — zustand draft
  store + ETag retention through stale conflict.
- `tellus-fe/tests/unit/workshopVariableStore.test.ts` — F04 reactive
  variable graph kernel.
