# D-2026-04-30-004 — Explorer-specific page-size caps

## Ambiguity

T-09 brief specifies `MAX_PAGE_SIZE = 1000` (was `10_000`) and adds
`MAX_PAGE_SIZE_OPT_IN = 2000`. The current `MAX_PAGE_SIZE = 10_000` is
imported by non-explorer routes too (`src/routes/datasets.ts:412`,
`src/routes/edits.ts` defines its own local 500 cap, `src/routes/reindexStatus.ts`
local 100 cap). Tightening the global constant tightens those caps too,
which exceeds T-09's stated scope (the explorer surface).

## Options

1. Lower `MAX_PAGE_SIZE` globally to 1000. Tightens datasets.ts cap as a
   side-effect. Strictest interpretation of the brief.
2. Introduce explorer-specific caps `MAX_EXPLORER_PAGE_SIZE = 1000` and
   `MAX_EXPLORER_PAGE_SIZE_OPT_IN = 2000`; rewire `validatePageSize` to
   use them; leave `MAX_PAGE_SIZE = 10_000` for legacy non-explorer
   callers.
3. Add a comment-driven follow-up to update other consumers.

## Chosen

Option 2. Surgical — closes the explorer contract C-156/C-157 exactly,
does not touch unrelated routes (which have their own scope-bound caps
already). The Decision Protocol's "consistency with surrounding code"
priority points here: the codebase already has per-route local caps
(`MAX_PAGE_SIZE = 500` in edits.ts, 100 in reindexStatus.ts), so a
per-surface constant is idiomatic.

## Rationale

- The explorer is the only surface that user-supplied query parameters
  flow through `queryValidator.validatePageSize`.
- Datasets and other administrative routes have human operators in the
  loop and their pre-existing caps are appropriate.
- An audit-friendly migration path: if a future audit demands the
  global cap drop to 1000, that's one constant change away.
