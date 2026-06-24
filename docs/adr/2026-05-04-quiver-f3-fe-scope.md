# ADR — Quiver F3: Canvas Mode Renderer (FE-scope)

- **Status:** Accepted
- **Date:** 2026-05-04
- **Phase:** 2 (Compute Core)
- **Task:** T-09 (F3)
- **Upstream deps:** T-05 (F2), T-08 (F5)

## Context

F3 is the spatial canvas: pan, zoom, drag, resize, snap-to-grid, multi-select,
viewport virtualization, visibility-driven evaluation. The performance
targets (60 fps with 100 cards, 30 fps with 200 cards) and the spec's
explicit "DOM-based, NOT `<canvas>` element" decision rule out any
shortcut path. Per **D-23**, this is FE-only; the SPA implementation lives
in `tellus-fe`.

## Decision

**F3 ships in `tellus-fe`** behind the same Phase 2 release gate as B5.
This ADR records the binding contracts (F3 C-01..C-12) and the
implementation sketch the FE will follow.

### Implementation sketch (tellus-fe)

```
frontend/canvas/
  CanvasRoot.tsx          — pan/zoom container; CSS transform on root only (F3 C-01)
  CanvasViewport.tsx      — IntersectionObserver-based virtualization (F3 C-08)
  CanvasCard.tsx          — absolutely-positioned <div> with translate3d (F3 C-01)
  controls/
    Pan.ts                — middle-mouse, space-bar, two-finger (F3 C-02)
    Zoom.ts               — Cmd/Ctrl-scroll + pinch, clamped 0.25..2.0 (F3 C-03)
    Resize.ts             — 8 handles, Shift = aspect-ratio (F3 C-05)
    Marquee.ts            — rubberband multi-select (F3 C-06)
    AutoArrange.ts        — collision-free layout (F3 C-04)
  state/
    selectionSlice.ts     — Redux slice for selection state
    visibilityHook.ts     — visibility-driven `computeCard` dispatch (F3 C-09)
  __tests__/
    perf.test.tsx         — 200-card render budget (F3 C-10)
    drag.spec.ts          — Playwright drag (F3 C-12)
    pan-zoom.spec.ts      — Playwright pan/zoom (F3 C-12)
    marquee.spec.ts       — Playwright marquee (F3 C-12)
  stories/
    Canvas.50.stories.tsx
    Canvas.100.stories.tsx
    Canvas.200.stories.tsx
    Canvas.500.stories.tsx        — perf-budget Storybook stories (F3 C-11)
```

### Key contracts

- **F3 C-01** — CSS `transform` on canvas root only; per-card transforms
  use `translate3d` for GPU compositing. No `<canvas>` element.
- **F3 C-02 / C-03** — input bindings explicit; pan/zoom range clamped at
  extrema (no overshoot).
- **F3 C-04** — snap-to-grid 32 px (matches Foundry Quiver convention);
  auto-arrange uses Mehlhorn-style force-directed layout, then snaps.
- **F3 C-05** — resize uses ghost preview during drag; **single store write
  on mouseup**, not per-tick (matches F2's optimistic store discipline).
- **F3 C-06** — group move applies a **single batched instruction**, not
  N individual `moveCard` calls (per OT semantics).
- **F3 C-07** — remove from canvas vs delete card: `removeCardFromCanvas`
  is reversible; `deleteCard` is gated by a confirmation dialog when the
  card has no other canvas references. **Card IDs do NOT free up after
  delete (B2 contract; immutable for life of analysis).**
- **F3 C-08** — virtualization with 200 px overscan; placeholders are
  width/height-preserving stubs to keep DOM stable for screen-readers.
- **F3 C-09** — visibility-driven evaluation respects analysis-level
  `loadSetting`. When `Visible`, IntersectionObserver dispatches
  `computeCard`. When card exits, evaluation is paused — but cache result
  is preserved (the user might scroll back).

### BE-side requirements (none new in this iteration)

F3 consumes:
- `GET /quiver/api/v1/registry/cards` (F5 — done)
- `POST /quiver/api/v1/compute/cards` (B5 — done)
- `PATCH /quiver/api/v1/analyses/:rid` (B1 — done) for instruction
  application; full OT instruction support arrives with B3.

## Consequences

- F3's perf targets are non-negotiable. The FE team will need to profile
  in Chrome Performance tab and assert 60 fps in Storybook with
  `--frame-rate=60`.
- All store mutations are owned by F2's Redux slices; F3 dispatches but
  does not own state shape.
- Group-move requires F2's batched-instruction support (already covered).

## Verification

- F3 contracts surfaced in this ADR (D-24 ADR-as-coverage).
- Once tellus-fe lands the implementation, the Playwright tests in
  `__tests__/` will be wired into the cross-cutting Gate 3 lifecycle
  test (canvas drive across the canvas + add-card + edit + revert path).

## Decisions

- **D-39 No `<canvas>` element** — DOM-based renderer is mandatory for
  accessibility (screen-reader landmarks per card; keyboard navigation;
  AIP-Configure button focus; etc.). Recorded for traceability —
  consistent with the spec's explicit wording.
