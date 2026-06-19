# ADR — Quiver F5: Card Type Registry & Card Components (FE-scope + BE contract)

- **Status:** Accepted
- **Date:** 2026-05-04
- **Phase:** 2 (Compute Core)
- **Task:** T-08 (F5)
- **Upstream deps:** T-02 (B2), T-05 (F2)

## Context

F5 is the FE plugin system: each of the 26 card types from B2's registry
gets a `CardPlugin` with editor, renderer, declared inputs, output type, and
optional suggester. The plugin set is consumed by F3 (canvas), F4 (inspector),
F6 (add-card UX). Per **D-23**, the SPA implementation lives in the parallel
`tellus-fe` repo; this ADR is the contract surface and FE-scope record.

## Decision

**The 26-card registry is the contract.** Both BE (via
`assertRegistryIntegrity()` at boot, B2 C-02) and FE (via build-time check
against the new endpoint) enforce it.

### BE-side contract (this repo)

- **`GET /quiver/api/v1/registry/cards`** — public, cacheable, no auth.
  Returns `{ version, count, cards: [{ type, inputs: { slot: { accepts[],
  optional, list } }, output }] }`.
  - `count` MUST equal 26.
  - `cards[].type` MUST be drawn from the 26 enum values in
    `tasks/quiver/registry-fixture.md`.
  - Cache-Control + weak ETag emitted.
  - Phase ≥ 1 (mounted alongside `analysesRouter` and `versionsRouter`).
- Server-side boot invariant `assertRegistryIntegrity()` already locks the
  registry shape against `registry-fixture.md` (B2 C-02).

### FE-scope (tellus-fe — D-23, D-24)

- **F5 C-01** — `interface CardPlugin<TConfig, TOutput>` exported from
  `frontend/cards/types.ts`. Generic, no `any`. Fields per spec:
  `type`, `icon`, `displayName`, `declaredInputs`, `outputType`, `Editor`,
  `Renderer`, optional `suggest`.
- **F5 C-02** — Plugin implementations for all 26 card types in
  `frontend/cards/<type>/<plugin>.tsx`. Build-time check validates the FE
  registry matches the BE registry endpoint at `pnpm build` time
  (`scripts/check-card-plugins.ts`). Missing plugin → build fails (F5 C-08).
- **F5 C-03** — Common card chrome: `<CardHeader>` (icon, displayName,
  hidden-toggle, options menu), `<CardBody>` (Renderer), `<CardFooter>`
  (input-bindings drawer, error indicator). Provided by
  `frontend/cards/_chrome/`.
- **F5 C-04** — Browser-side Transform Table engine: DuckDB-WASM
  recommended; hand-rolled JS fallback. Row limit 50 000. Intermediate
  results memoized in IndexedDB (`quiver-transform-cache` v1).
- **F5 C-05** — AIP Configure entry point: button in every card header
  (`<AipConfigureButton cardId={...} />`). Wires to F9.
- **F5 C-06** — Each plugin has a Storybook story + Vitest snapshot test
  in `frontend/cards/<type>/__tests__/`.
- **F5 C-07** — Plugins lazy-loaded via `import()` per card type.
- **F5 C-08** — Build-time plugin coverage check via the BE registry
  endpoint (above). FE script:
  ```ts
  const expected = (await fetch("/quiver/api/v1/registry/cards")).cards;
  for (const c of expected) {
    if (!cardPluginRegistry[c.type]) throw new Error(`missing plugin: ${c.type}`);
  }
  ```

## Consequences

- BE remains the single source of truth for card types; FE cannot drift
  without failing CI.
- The new endpoint is small, cacheable, and adds zero authentication
  surface — registry is non-confidential metadata.
- The FE plugin list is testable in isolation in `tellus-fe` and against
  this contract endpoint in CI integration.

## Verification

- `tests/quiver/integration/f5-registry-route-integration.test.ts` — 5 cases
  asserting the endpoint shape, count, ETag, stability across calls, and
  per-entry slot field types. All green.
- `assertRegistryIntegrity()` boot check covers B2 C-02 and (transitively)
  F5 C-02.
- Coverage gate (D-24): F5 contracts surfaced as ADR coverage when not
  testable BE-side.

## Decisions

- **D-37 Registry endpoint mounted at phase ≥ 1** — even though F5 is
  Phase 2 in the spec, the registry endpoint must be available the
  moment FE is deployed (Phase 1 onwards). Decision-Protocol: more
  permissive read of public metadata.
- **D-38 Endpoint is unauthenticated** — registry is not user-specific;
  caching upstream of CDNs is desirable. No PII; no marking gate.
  Decision-Protocol: more auditable (no auth-coupling in build pipelines).
