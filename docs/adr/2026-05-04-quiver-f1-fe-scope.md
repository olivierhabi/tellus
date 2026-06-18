# ADR — Quiver F1: App Shell, Routing, Auth, Layout Skeleton

- **Status**: Accepted (BE contract surface ready; SPA work tracked in tellus-fe)
- **Date**: 2026-05-04
- **Task**: T-04 (F1)
- **Spec**: `tasks/quiver/quiver-tasks.md` §F1; contracts `tasks/quiver/contracts.md` §F1 C-01..C-08
- **Decision binding**: `decisions/quiver/D-2026-05-04-fe-scope.md` (D-23, D-24)

## Context

F1 covers the React/Next SPA shell — pages, routing, auth bootstrap,
layout, theme, error boundary, single-tab guarantee, mobile breakpoint.
Per D-23, the BE repo verifies the **contract surface** the FE consumes;
the actual SPA implementation lives in `tellus-fe` as a parallel
deliverable.

## Decision

For F1, the partition is:

### BE-side (verified here)

- **F1 C-02 (auth gateway 401 → redirect)** — the BE returns
  `401 Tellus:Quiver:Unauthenticated` on missing/invalid token; the FE
  observes this status code and routes the user to
  `/multipass/api/oauth2/authorize?...`. The BE side is verified by
  `tests/quiver/integration/f1-auth-contract-integration.test.ts` and
  by `cypress/quiver/e2e/F1.cy.ts` (HTTP-only smoke).
- **F1 C-08 (Cypress E2E)** — landing-page → API smoke is exercised by
  `cypress/quiver/e2e/F1.cy.ts` against the live API. Full
  login → editor → logout requires the FE preview to be running and is
  scoped out of the BE harness.

### FE-only (documented here, implemented in tellus-fe)

- **F1 C-01** — register Next.js routes
  `/quiver/analyses/[rid]`, `/quiver/analyses/[rid]?state=…`,
  `/quiver/dashboards/[rid]`, `/quiver/folders/[folderRid]/new`.
  Implementation: `app/quiver/analyses/[rid]/page.tsx`, etc. **(FE-ONLY)**
- **F1 C-03** — Layout skeleton with top bar (analysis title, save,
  branch indicator, presence avatars, share, AIP-Assist), left sidebar
  (canvases + add-card panel), main viewport, right inspector, bottom
  toolbar. Implementation in `components/quiver/AppShell.tsx`.
  **(FE-ONLY)**
- **F1 C-04** — Blueprint.js v6 theme; system-preference default; user
  override persisted to `localStorage["tellus.quiver.theme"]`.
  **(FE-ONLY)**
- **F1 C-05** — Route-level error boundary; integrate with the
  observability layer the FE repo already uses. **(FE-ONLY)**
- **F1 C-06** — `BroadcastChannel("tellus.quiver.<rid>.<userId>")`
  detects sibling tab; second tab opens read-only mirror with banner.
  **(FE-ONLY)**
- **F1 C-07** — `< 768 px` viewport disables canvas-mode editor;
  dashboard view-only allowed. **(FE-ONLY)**

## Implementation Sketch (for the FE repo)

```
app/quiver/
  layout.tsx                  -- AppShell wrapper + theme provider
  analyses/[rid]/page.tsx     -- Editor entry; reads ?state= for working state
  dashboards/[rid]/page.tsx   -- Dashboard read-only viewer
  folders/[folderRid]/new/page.tsx  -- Create-analysis flow
components/quiver/
  AppShell.tsx
  TopBar.tsx
  LeftSidebar.tsx
  RightInspector.tsx
  BottomToolbar.tsx
  ErrorBoundary.tsx
  SingleTabGuard.tsx          -- BroadcastChannel mirror
  ThemeProvider.tsx
hooks/quiver/
  useQuiverApiClient.ts       -- handles 401 → /multipass/.../authorize
```

## Verification

- BE-side test: `tests/quiver/integration/f1-auth-contract-integration.test.ts` —
  asserts every Quiver endpoint returns 401 with the canonical envelope
  on missing auth (F1 C-02 contract surface).
- Cypress: `cypress/quiver/e2e/F1.cy.ts` — exercises 401 redirect
  semantics against the live API (F1 C-08 partial).
- FE-side: when `tellus-fe` work lands, the SPA cypress suite there
  picks up C-01/C-03..C-07.

## Decisions Logged

- D-23 — F-tasks land BE-side as contract surface.
- D-24 — Coverage gate scans ADRs for FE-only C-IDs.
