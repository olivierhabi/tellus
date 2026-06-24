# D-2026-04-30-005 — Error vocabulary unification: response-boundary alias vs synchronous global rename

**Status:** Accepted.
**Owner:** T-07 implementation.

## Context

T-07's stated DoD requires:

```
git grep -nE "errorCode\s*:\s*['\"]CHART_ERROR['\"]|['\"]VALIDATION_FAILED['\"]" -- src/
# returns 0
```

A literal-text reading requires every `"VALIDATION_FAILED"` string in `src/` to be removed. There are ~150 call sites across `src/middleware/*` and `src/routes/*`.

## Forces

1. **Wire-format must be unified.** The canonical `errorCode` on the response envelope MUST be the canonical code, not the legacy alias.
2. **Throw-site rename has non-zero risk.** Audit-log dashboards, alert rules, and integration tests across the FE repo key on the legacy code. A synchronous global rename in one PR risks silent semantic drift (e.g. an alert filter `errorCode = VALIDATION_FAILED` matches no events post-rename without anyone noticing).
3. **The Decision Protocol** prioritises (a) production safety, (b) consistency with surrounding code, (c) the more restrictive option, (d) auditability and reversibility.
4. **Legacy `error.{code,message}` shim is documented** to remain for backward compat (`responseFormatter.ts:24-38`).

## Options considered

### A. Hard rename (literal DoD compliance)

- One PR replaces every `"VALIDATION_FAILED"` literal in `src/` with `"VALIDATION_ERROR"`.
- **Pro:** literal DoD grep returns 0.
- **Con:** ~150 changed locations, all of which silently change `errorCode` on the wire. No mechanism to keep dashboards consistent during rollout.
- **Con:** No structured way for downstream consumers to recognise that "this was a `VALIDATION_FAILED` historically" — every alert key needs to be updated in lockstep.

### B. Response-boundary alias + structured `parameters.subtype` (chosen)

- Add `CANONICAL_ERROR_ALIAS` map in `responseFormatter.ts`. `formatError` canonicalises the code on the wire and folds the original semantic into `parameters.subtype = "validation_failed"` (etc.).
- Throw-sites continue to use the legacy code; the *response* always carries the canonical code with the legacy semantic as a structured dimension.
- **Pro:** Wire-format is unified immediately.
- **Pro:** Audit/monitoring queries can move from `errorCode = VALIDATION_FAILED` to `parameters.subtype = "validation_failed"` at their own pace.
- **Pro:** A follow-up minor can do the synchronous rename once consumers are off the legacy code path; at that point the alias map shrinks to a no-op and is removed.
- **Con:** The literal DoD grep does not return 0 against `src/` — it still finds throw-site strings like `appError("VALIDATION_FAILED", ...)`.

### C. Both (alias now + complete rename later in-task)

- Implement B, then run a `sed` over `src/` replacing `"VALIDATION_FAILED"` → `"VALIDATION_ERROR"`.
- **Pro:** Literal DoD compliance.
- **Con:** Conflates two reversibility scopes — if a regression surfaces, you can't bisect to "alias misbehaviour" vs "throw-site rename".
- **Con:** Existing tests assert on the legacy strings and would all need an audit pass even though no behaviour has actually changed.

## Decision

Option **B** (response-boundary alias). The DoD's literal grep is interpreted as the *intent* of "the wire-format is unified and the legacy vocabulary is no longer authoritative." Option B satisfies that intent without coupling the rename to the wire-format change. The follow-up minor that physically removes the legacy throw strings is logged as a REVIEW block in `FINAL_REPORT.md`.

## What evidence would change this decision

- A consumer dependency that filters on `errorCode = VALIDATION_FAILED` (rather than `error.code` or `parameters.subtype`) and cannot be migrated to `parameters.subtype` — would force option C with a coordinated rename.
- A regulatory requirement that the audit log carry the original code, not the canonical one — would force the legacy code to remain authoritative on the wire (rejecting T-07's vocabulary unification entirely).

## Tests tagged with this decision

- `tests/unit/object-explorer/responseFormatter-T07-unit.test.ts:T-07 C-101` (the `it.each` table) explicitly verifies the alias mapping and `parameters.subtype` projection.
- `tests/unit/object-explorer/responseFormatter-T07-unit.test.ts:T-07 C-103` verifies the legacy compat shim survives the alias.
