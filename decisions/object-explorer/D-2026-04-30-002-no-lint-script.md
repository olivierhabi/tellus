# D-2026-04-30-002 — `npm run lint` does not exist

## Ambiguity

The DoD asserts "`npm run lint && npm run typecheck && npm test` all pass."
The repo has no `lint` or `typecheck` script in `package.json`.

## Options

1. Add an ESLint config + `lint` script. Rejected — out of scope for this
   work and adds churn unrelated to the explorer.
2. Treat `npx tsc --noEmit` as the type+lint baseline.
3. Skip and report.

## Chosen

Option 2. `npx tsc --noEmit` is the closest thing the repo has to a
linter; type-strictness is what the brief actually cares about ("No `any`
introduced"). Surfaced in PROGRESS.md.
