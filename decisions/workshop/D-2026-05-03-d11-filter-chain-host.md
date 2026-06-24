# D-11 — `filterByVariable` constraint host may be objectSet OR objectSetFilter

**Date:** 2026-05-03
**Touches contract IDs:** B02 C-05, B02 C-08, B02 C-13.

## Ambiguity

`tasks/workshop/workshop-tasks.md` §B02 specifies the nine semantic rules but does not explicitly enumerate which variable types may host a `filterByVariable` constraint. The architecture spec (referenced but not present in this repo as a self-contained doc) lists `variableTransformation` as a `definitionType` for derived filters, which strongly implies that filters can chain (filter B = filter A composed with extra predicate). Whether the constraint host can itself be an `objectSetFilter` was not stated.

## Options considered

1. **Host = objectSet only.** Strictly bipartite; `filterByVariable` only travels objectSet → objectSetFilter. Cycles are graph-theoretically impossible, which makes the §B02-acceptance "VariableGraphCycle with cyclePath" rule unreachable as written.
2. **Host = {objectSet, objectSetFilter}.** Filter chains are representable. Real cycles (e.g., the Phase-5 acceptance test "Filter using a variable pointing at itself transitively") become testable. Target check `target.type === "objectSetFilter"` remains strict, so blatant type errors are still rejected (proven by `B02 C-08`).
3. Loosen target check too. Rejected — would weaken type safety beyond the spec's intent.

## Choice

**Option 2.** Implementation in `src/services/workshop/validator.ts` checks `v.type !== "objectSet" && v.type !== "objectSetFilter"`.

## Rationale

- Production safety: rule still rejects type-incompatible bindings (target must be `objectSetFilter`).
- Foundry-faithful: variableTransformation pattern requires filter→filter chains.
- Auditable: the cycle-detection rule (B02 C-05) becomes meaningfully reachable; tests can drive it. Without this decision, C-05 is dead code and the spec acceptance "filter pointing at itself" cannot be exercised.
- More restrictive than naïve "any host"; less restrictive than impossible-bipartite.

## Evidence that would change this

- Architecture spec section explicitly stating `filterByVariable` host must be objectSet only — would force inventing a separate constraint kind (e.g., `composedFilter`) for filter chains.
- F03/F04/F07 surfaces require a different constraint shape — would re-evaluate against those tasks' contract IDs.

## Tests tagged with this decision

- `tests/unit/workshop/validator-unit.test.ts`
  - "B02 C-05: 2-node filter chain cycle → VariableGraphCycle with cyclePath"
  - "B02 C-05: injected filter cycles of varying length are always detected"
- `tests/integration/workshop/B02-validate-on-write-integration.test.ts`
  - "B02 C-05: variable graph cycle → 400 VariableGraphCycle with cyclePath"
