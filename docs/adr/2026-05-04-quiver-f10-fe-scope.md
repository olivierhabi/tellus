# ADR — F10 (Dashboards Publisher / Embed UX) FE Scope (per D-23)

Date: 2026-05-05
Status: Accepted

## Context

F10 ships the user-visible publishing flows: "Publish as Dashboard"
dialog, dashboard preview mode, embed wizards (Workshop / Object
View), share UI, version pinning, "Publish as Visual Function".

All BE surfaces already shipped in T-17 (B10):
- `POST /publishing/dashboards` (+ embeds)
- `POST /publishing/visual-functions`
- `GET /publishing/dashboards/:rid` / `/visual-functions/:rid` /
  `/templates/:rid`

Per D-23 the SPA work lives in `tellus-fe`.

## Decisions

### D-77 — Dashboard publish dialog generates JSON-Schema from selected Parameter cards

For each Parameter card in the analysis (PARAMETER_OBJECT,
PARAMETER_STRING, PARAMETER_NUMBER, PARAMETER_BOOLEAN), generate a
JSON-Schema property keyed by `card.id`. The schema is recorded on
the published row at `parameter_schema` (B10 column). (F10 C-01)

### D-78 — Dashboard preview is the same canvas component, frozen

Reuses `<CanvasViewport>` with `mode="dashboard"`; OT instructions
disabled; only Parameter card config writes are accepted, and those
go to a local `parametersSlice`, not the OT log. The canvas reads
those overrides via the same selector chain. (F10 C-02)

### D-79 — Embed-in-Workshop / -in-Object-View open existing Compass dialogs

Workshop's existing module-picker and Object View's tab-picker are
reused; on confirm, the FE calls
`POST /publishing/dashboards/:rid/embed` with the embed surface +
parent RID + variable mapping. (F10 C-03, C-04)

### D-80 — Share URL encodes parameters in the query string

Format: `?p[<paramId>]=<value>` URL-encoded; deserialised by the
preview-mode reader. Compass authorisation is checked at every page
load (read on the dashboard RID); revoked → 403 banner instead of
content. (F10 C-05, C-09)

### D-81 — Version pinning via `?version=<n>`; default = latest

If `version` absent, the FE follows the latest published version of
the dashboard. If present, the published row at that version is
fetched and used. (F10 C-06)

### D-82 — Visual Function publisher reuses the same dialog with a different mode flag

Same component; "input parameters" become "VF input slots", "output"
becomes "VF output card", "exposed canvases" hidden. (F10 C-07)

### D-83 — E2E publish→consume happy path lives in `cypress/quiver/e2e/F10.cy.ts`

Already drafted in B10's commit; expanded as part of GATE-03 (E2E
Analysis Lifecycle Gate, post-T-20). (F10 C-08)

## Implementation sketch (parallel deliverable)

```
tellus-fe/frontend/publishing/
  PublishDashboardDialog.tsx    # F10 C-01
  DashboardPreview.tsx          # F10 C-02
  EmbedWorkshopWizard.tsx       # F10 C-03
  EmbedObjectViewWizard.tsx     # F10 C-04
  ShareUrlDialog.tsx            # F10 C-05
  VersionSelector.tsx           # F10 C-06
  PublishVisualFunctionDialog.tsx # F10 C-07
  state/parametersSlice.ts
  __tests__/
    publishHappyPath.cy.ts      # F10 C-08
    permissionRevoke.cy.ts      # F10 C-09
```

## Coverage

F10 C-01..C-09 covered by this ADR (D-24 ADR fallback); BE
dependencies verified by T-17 (B10).

## Touches

D-23, D-24, B10 (publishing surfaces), F2 (state), F3 (canvas), F5
(parameter card plugins), F9 (Generate entry on canvas).
