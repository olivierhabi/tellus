# ADR — F6 (Add-Card UX) FE Scope (per D-23)

Date: 2026-05-05
Status: Accepted

## Context

F6 ships the user-visible "+" affordance on every card, the top-level
"Add data" search, the right-sidebar Library panel, and the AIP
Generate entry from the canvas chrome. All BE surfaces it depends on
already exist:

- `GET /quiver/api/v1/registry/cards` (T-08 / F5) — type-directed
  suggestion source.
- OMS / Compass / Functions registry — search backends (existing
  Tellus services, not Quiver-specific).
- `POST /aip/generate` (T-16 / B9) — AIP Generate streaming.

Per D-23 the SPA work lives in `tellus-fe`; this ADR records the
binding scope and implementation sketch.

## Decisions

### D-72 — "+" popover sources its candidates from the F5 registry, ranked by `CardPlugin.suggest`

Pure client-side filter: given `sourceOutputType`, the popover lists
every card type whose `declaredInputs[*].acceptedTypes` ⊇
`{sourceOutputType}`. Ranking is `CardPlugin.suggest(sourceCard,
candidate)` returning `0..1`. Ties broken alphabetically by display
name. (F6 C-01)

### D-73 — Top-level "Add data" search is a fan-out to OMS / Compass / Functions registry

Three concurrent queries; results merged client-side in order of
arrival; debounced 200 ms. No new BE endpoint. (F6 C-02)

### D-74 — Library panel is a filtered Compass listing scoped to Functions + Visual Functions

Reads existing Compass `GET /folders/:rid/children` filtered to
`{type ∈ {function, visual-function}}`; type filter is a client-side
`<HTMLSelect>` against the F5 registry's input-type list. (F6 C-03)

### D-75 — Keyboard shortcut `/` opens add-card search

Global hotkey installed on `<AppShell>`; suppressed when input
elements are focused. (F6 C-05)

### D-76 — Type-compatibility golden test runs the F5 registry against itself

A pure unit test in the FE: for every (sourceType, targetType) pair,
assert that `acceptedTypes ⊇ {sourceType}` matches the popover's
inclusion result. Catches FE/BE registry drift at build time. (F6
C-06)

## Implementation sketch (parallel deliverable)

```
tellus-fe/frontend/addCard/
  PlusPopover.tsx               # F6 C-01
  AddDataSearch.tsx             # F6 C-02
  LibraryPanel.tsx              # F6 C-03
  AipGenerateEntry.tsx          # F6 C-04 (delegates to F9 GeneratePanel)
  hooks/useSlashHotkey.ts       # F6 C-05
  __tests__/
    typeCompatibilityGolden.test.ts # F6 C-06
    aipPreview.test.ts          # F6 C-07
```

## Coverage

F6 C-01..C-07 covered by this ADR (D-24 ADR fallback); BE
dependencies (registry, OMS, Compass, Functions, AIP) already
verified upstream.

## Touches

D-23, D-24, F5 (registry source), B9 (AIP Generate), B10 (Visual
Function pinning on bind).
