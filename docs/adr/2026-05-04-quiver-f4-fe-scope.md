# ADR — Quiver F4 (Graph Mode Renderer) — FE-only scope

**Status:** Accepted (2026-05-05)
**Decision tree:** D-23 (FE-tasks land BE-side as the contract surface; SPA implementation is a parallel deliverable in `/Users/olivierhabimana/Desktop/projects/tellus-fe`).

## Context
F4 ships the alternate "graph" view of an analysis — a Sugiyama hierarchical DAG (via `dagre`) showing every card as a node and every binding as an edge. There is **no new BE surface**: the graph view consumes the same `AnalysisDocument` the canvas view consumes (B1 GET) and the same registry (F5 GET `/registry/cards`).

## Decision
Land F4 entirely as an FE deliverable in `tellus-fe`. The BE coverage gate accepts F4 C-01..C-08 via this ADR per D-24 (ADR fallback for FE-only C-IDs).

## FE deliverables (parallel, in tellus-fe)

| C-ID | Deliverable |
|---|---|
| F4 C-01 | `frontend/graph/Layout.ts` — `dagre` Sugiyama default; `d3-force` fallback behind `featureFlags.graphFallbackForce=true`. Layout function memoised on `(cards.hashId, canvases.hashId)`; recomputes only on structural change. |
| F4 C-02 | `frontend/graph/Edge.tsx` — SVG bezier; `strokeDasharray` empty for native-type edges, `4 4` for type-promoted (e.g. OBJECT_SET → TRANSFORM_TABLE). Edge keys come from `validateDag().bindings[]` (B2 surface). |
| F4 C-03 | `frontend/graph/Node.tsx` — 16-token palette in `frontend/cards/palette.ts`; icon+color resolved from `cardTypeRegistry` (F5 GET). Token set frozen; new card types map to tokens at registration time. |
| F4 C-04 | `frontend/graph/onClickNode.ts` — dispatches `selectCard(cardId)` to shared store (F2 deliverable). Canvas+inspector follow via existing `selectionSlice` subscribers. |
| F4 C-05 | `frontend/graph/dragNode.ts` — overrides layout in local state; toolbar `Relayout` button calls back into `Layout.ts` to wipe overrides. Override survives session per F2 BroadcastChannel. |
| F4 C-06 | `frontend/graph/EdgeTooltip.tsx` — slot name resolved from `cardTypeRegistry[input.cardType].slots[input.slotName].label`. Hover delay 250 ms. |
| F4 C-07 | `frontend/graph/BranchBadge.tsx` — visible when `analysis.branchRid !== TRUNK_RID`. Badge text = branch display name (Multipass directory lookup). |
| F4 C-08 | `frontend/graph/__perf__/200card.bench.ts` — Storybook+vitest perf budget; CI fails on regression > 10 % vs baseline. |

## BE surface required (none new)
- `GET /quiver/api/v1/analyses/:rid` (B1) — provides cards + canvases.
- `GET /quiver/api/v1/registry/cards` (F5) — provides palette + slot labels + icons.
- `POST /quiver/api/v1/analyses/:rid/_validate` (B2) — provides edges via `bindings[]`.

## Verification
- BE harness: ADR fallback satisfies coverage gate (D-24).
- FE: Storybook stories per palette token + dagre/d3-force toggle; vitest perf bench at 200 cards.

## Related
- D-23 (FE-task scope split)
- D-24 (ADR fallback for FE-only C-IDs)
- D-39 (DOM-based renderer for canvas — graph view uses SVG, not `<canvas>`)
- ADR `docs/adr/2026-05-04-quiver-f5-fe-scope.md`
