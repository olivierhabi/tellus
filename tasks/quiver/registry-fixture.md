# Quiver Card Type Registry — Golden Fixture

> Locked at the Starting Protocol of the Quiver Drive (date: 2026-05-04).
> Source: `tasks/quiver/quiver-tasks.md` §B2 "Card Type Registry (initial set)".
> Every B-task that adds backend execution updates the **status** column; every F-task that adds a plugin updates the **plugin** column. The set of card types is **frozen** at 26.
> A boot-time sanity check (B2) reads this fixture and fails the process if the in-code registry diverges.

## Type vocabulary

```
OBJECT_SET, FILTER_OBJECT_SET, SEARCH_AROUND, AGGREGATION,
TRANSFORM_TABLE, MATERIALIZATION, JOIN_MATERIALIZATION,
EXPRESSION, NUMERIC_FORMULA, BOOLEAN_FORMULA,
TIME_SERIES_PLOT, TIME_SERIES_CHART, ROLLING_AGGREGATE, EVENT_SET, TIME_SERIES_FORMULA,
CATEGORICAL_CHART, PIVOT_TABLE, VEGA_PLOT,
PARAMETER_STRING, PARAMETER_NUMBER, PARAMETER_DATETIME, PARAMETER_BOOLEAN,
PROPERTY_VALUE_SELECT,
ACTION_BUTTON,
FUNCTION_CALL, VISUAL_FUNCTION_CALL,
AIP_GENERATE_RESULT
```

Note: the spec lists `PARAMETER_*` as a single line collapsing four type-specialized parameter cards. We expand to four (`PARAMETER_STRING`, `PARAMETER_NUMBER`, `PARAMETER_DATETIME`, `PARAMETER_BOOLEAN`) to keep the registry total at exactly 26 (recorded in `decisions/quiver/D-2026-05-04-starting-protocol.md` D-02). Output type for each parameter card matches its name.

## Output type vocabulary

```
OBJECT_SET, TRANSFORM_TABLE, MATERIALIZATION,
NUMBER, STRING, BOOLEAN, DATETIME,
TIME_SERIES_PLOT, TIME_SERIES_CHART, EVENT_SET,
CATEGORICAL_CHART, VEGA_PLOT, NONE,
ANY,         -- only for FUNCTION_CALL / VISUAL_FUNCTION_CALL output (resolved at validation time)
ARRAY<Card>  -- only for AIP_GENERATE_RESULT
BOOLEAN_FORMULA, AGG_SPEC, JOIN_KIND, COMPARATOR, AGG_OP, DURATION, VEGA_SPEC, RID  -- referenced as input slot types
```

## Type compatibility (covariance)

- `OBJECT_SET` is acceptable wherever `TRANSFORM_TABLE` is, with implicit promotion (B2 C-04).
- `MATERIALIZATION` is acceptable wherever `TRANSFORM_TABLE` is.
- `NUMBER`, `STRING`, `BOOLEAN`, `DATETIME` are NOT mutually compatible (no implicit conversions).
- `ANY` matches any output (used only for function output resolution).

## The 26 card types

| # | type | input slots | output | B-backend (default) | F-plugin |
|---|------|-------------|--------|---------------------|----------|
| 1 | `OBJECT_SET` | (none) | `OBJECT_SET` | B6 (OSS) | F5 |
| 2 | `FILTER_OBJECT_SET` | `src: OBJECT_SET`, `predicate: BOOLEAN_FORMULA` | `OBJECT_SET` | B6 (OSS) | F5 |
| 3 | `SEARCH_AROUND` | `src: OBJECT_SET`, `linkApiName: STRING` | `OBJECT_SET` | B6 (OSS) | F5 |
| 4 | `AGGREGATION` | `src: OBJECT_SET`, `group: ARRAY<STRING>`, `agg: ARRAY<AGG_SPEC>` | `TRANSFORM_TABLE` | B6 (OSS aggregate) | F5 |
| 5 | `TRANSFORM_TABLE` | `src: OBJECT_SET\|TRANSFORM_TABLE\|MATERIALIZATION` | `TRANSFORM_TABLE` | B7 (Polars) | F5 (DuckDB-WASM) |
| 6 | `MATERIALIZATION` | `src: OBJECT_SET\|TRANSFORM_TABLE` | `MATERIALIZATION` | B7 (tier-selected) | F5 |
| 7 | `JOIN_MATERIALIZATION` | `left: MATERIALIZATION`, `right: MATERIALIZATION`, `on: ARRAY<STRING>`, `kind: JOIN_KIND` | `MATERIALIZATION` | B7 (Polars/Spark) | F5 |
| 8 | `EXPRESSION` | (formula refs to upstream cards) | `NUMBER\|STRING\|BOOLEAN\|DATETIME` (declared) | B7 (in-process) | F5 |
| 9 | `NUMERIC_FORMULA` | (formula refs) | `NUMBER` | B7 (in-process) | F5 |
| 10 | `BOOLEAN_FORMULA` | (formula refs) | `BOOLEAN` | B7 (in-process) | F5 |
| 11 | `TIME_SERIES_PLOT` | `src: OBJECT_SET\|OBJECT`, `propertyApiName: STRING` | `TIME_SERIES_PLOT` | B8 (Codex) | F5+F7 |
| 12 | `TIME_SERIES_CHART` | `plots: ARRAY<TIME_SERIES_PLOT>` | `TIME_SERIES_CHART` | B8 (Codex) | F5+F7 |
| 13 | `ROLLING_AGGREGATE` | `src: TIME_SERIES_PLOT`, `window: DURATION`, `op: AGG_OP` | `TIME_SERIES_PLOT` | B8 (Codex) | F5+F7 |
| 14 | `EVENT_SET` | `src: TIME_SERIES_PLOT`, `threshold: NUMBER`, `op: COMPARATOR` | `EVENT_SET` | B8 (Codex) | F5+F7 |
| 15 | `TIME_SERIES_FORMULA` | (refs to TS plots) | `TIME_SERIES_PLOT` | B8 (Codex) | F5+F7 |
| 16 | `CATEGORICAL_CHART` | `src: TRANSFORM_TABLE\|OBJECT_SET`, `x: STRING`, `y: STRING` | `CATEGORICAL_CHART` | B7 (in-process) | F5 |
| 17 | `PIVOT_TABLE` | `src: TRANSFORM_TABLE\|OBJECT_SET` | `TRANSFORM_TABLE` | B7 (Polars) | F5 |
| 18 | `VEGA_PLOT` | `spec: VEGA_SPEC`, `data: TRANSFORM_TABLE\|OBJECT_SET` | `VEGA_PLOT` | (validated only — frontend renders) | F5 |
| 19 | `PARAMETER_STRING` | (none) | `STRING` | (no backend; literal value) | F5 |
| 20 | `PARAMETER_NUMBER` | (none) | `NUMBER` | (no backend) | F5 |
| 21 | `PARAMETER_DATETIME` | (none) | `DATETIME` | (no backend) | F5 |
| 22 | `PARAMETER_BOOLEAN` | (none) | `BOOLEAN` | (no backend) | F5 |
| 23 | `PROPERTY_VALUE_SELECT` | `src: OBJECT_SET`, `propertyApiName: STRING` | `STRING\|NUMBER` | B6 (OSS) | F5 |
| 24 | `ACTION_BUTTON` | `actionApiName: STRING`, `paramBindings: map<STRING,ANY>` | `NONE` | B6 (Actions via OMS) | F5 |
| 25 | `FUNCTION_CALL` | `functionRid: RID`, `paramBindings: map<STRING,ANY>` | `<function-declared>` | B5 (Functions backend) | F5 |
| 26 | `VISUAL_FUNCTION_CALL` | `visualFunctionRid: RID`, `paramBindings: map<STRING,ANY>` | `<visual-fn-declared>` | B5 (inlined per B10) | F5 |

`AIP_GENERATE_RESULT` is intentionally **not** in the 26: per spec, it is a transient client-side concept produced by AIP Generate (B9), materialized as a list of standard cards on accept. The B2 registry must accept its presence as a parse target but does not register it as a regular card type. (Recorded in D-2026-05-04-starting-protocol.md D-03.)

## Validation invariants

- Every entry above maps 1:1 with a TS const exported from `src/services/quiver/dag/cardTypeRegistry.ts`.
- Boot-time check: hash of `[type, sorted(slot,acceptedTypes), output]` for all 26 entries must equal a constant pinned in `cardTypeRegistry.fixture.json`.
- F5 plugin presence is verified at frontend build time against the same fixture.

## Status (advances as B-/F-tasks complete)

| type | backend status | frontend status |
|------|----------------|------------------|
| every entry above | TODO | TODO |
