# ADR — F9 (AIP UI) FE Scope (per D-23)

Date: 2026-05-05
Status: Accepted

## Context

F9 ships the user-visible AIP surfaces (Generate, Configure, Assist
chat, reasoning-trace viewer). The BE surface — `POST /aip/generate`,
`POST /aip/configure`, `POST /aip/assist`, `GET /aip/traces/:rid` —
already shipped in T-16 (B9). All F9 contracts are user-visible UX:
overlays, drawers, diff viewers, streaming token feedback, abort
buttons. None require new BE behaviour.

Per D-23 (FE-task scope) the SPA work lives in the parallel
`tellus-fe` repo; this ADR records the contract surface and the
implementation sketch so the FE deliverable is grounded in the
binding spec.

## Decisions

### D-68 — Generate preview overlay rendered as a Redux-driven dimmed layer

Non-modal: canvas pan/zoom (F3) remains live (F9 C-08). Implemented as
a sibling `<div>` inside `<CanvasViewport>` with `pointer-events:
auto` only on the overlay's own toolbar. Z-index above cards, below
modal dialogs.

### D-69 — Stream interruption surfaces the SSE `AbortController`

The "Stop" button (F9 C-07) calls `controller.abort()` on the SSE
`fetch`. Server-side, `req.on("close")` already terminates the stream
on the SSE writer's end (B9 implementation).

### D-70 — Reasoning trace drawer is a Blueprint `<Drawer>` reading `GET /aip/traces/:rid`

Backend already persists the row at the end of every Generate /
Configure / Assist invocation. Drawer renders `tools_called[]`
verbatim with timing + token + cost columns. (F9 C-04)

### D-71 — Property-value-hint preview reads the same payload the BE uses

Avoid drift between "what was sent" and "what is shown". The FE calls
`POST /aip/property-hints/preview` (B9-side; identical sampler). For
now, the preview is sourced from the same `propertyHints.ts` module
exported as a thin BE endpoint; a single source of truth. (F9 C-05)

## Implementation sketch (parallel deliverable)

```
tellus-fe/frontend/aip/
  GeneratePanel.tsx       # F9 C-01 — free text + SSE + overlay accept/reject
  ConfigureDialog.tsx     # F9 C-02 — diff viewer + apply / reject
  AssistChat.tsx          # F9 C-03 — chat panel, persisted on BE
  ReasoningTraceDrawer.tsx# F9 C-04
  HintPreview.tsx         # F9 C-05 — what was sent
  ToolUnauthorizedBanner  # F9 C-06 — inline explainer
  state/aipSseSlice.ts    # SSE controller + tokens + abort
  __tests__/
    snapshots/            # F9 C-09 — canned streams + golden diffs
```

## Coverage

F9 C-01..C-09 covered by this ADR (D-24 ADR fallback); BE surface
already verified by T-16 (B9) integration tests.

## Touches

D-23, D-24, B9 surfaces, F2 store conventions.
