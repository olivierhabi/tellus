# D-2026-05-01-004 — `BranchProtection:TagImmutable` error name (B10-C-09)

## Status

Accepted. Implemented. Live in `src/services/stemmaEvents/errors.ts`
and `src/services/stemmaEvents/policy/preReceive.ts`.

## Context

Spec §B10-C-09 requires the pre-receive policy to reject tag mutations
(delete or update) unless the principal carries an OWNER role. Tags
are append-only by default. The spec mandates the *behaviour* but
does not pre-name the error envelope's `errorName` field, unlike the
five branch-protection failure modes that are explicitly named in
B10-C-16..20:

- `BranchProtection:DeleteProtected` (B10-C-16, 403)
- `BranchProtection:ForcePushProtected` (B10-C-17, 403)
- `BranchProtection:RequiresPullRequest` (B10-C-18, 403)
- `BranchProtection:InsufficientApprovals` (B10-C-19, 403)
- `BranchProtection:RegexViolation` (B10-C-20, 400)

A name was therefore needed so the §1.3 envelope could be assembled,
and so the contract test in
`tests/unit/code-repos/stemma-events/branch-protection-errors-unit.test.ts`
could pin a stable string the route layer must return.

## Decision

Mint **`BranchProtection:TagImmutable`** as the errorName for B10-C-09.
Map to HTTP **403** with `errorCode = PERMISSION_DENIED`. Carry
`parameters = { ref, reason: "delete" | "update" }`.

## Rationale

1. **Naming consistency.** Every other B10 policy rejection uses the
   `BranchProtection:` namespace prefix. Reusing it for tag-immutability
   keeps a single namespace for "policy denied this ref-update", so
   subscribers building dashboards can group them under one selector.
   The alternative `Tag:Immutable` would split the dashboard logic.
2. **Status code 403, not 400.** Spec §1.3 reserves 400 for
   `INVALID_ARGUMENT`. Tag mutability is not a malformed input — the
   request is well-formed and would be allowed for an OWNER. The
   correct semantic is "you are not permitted to do this", which is
   `PERMISSION_DENIED → 403`. Mirrors all other branch-protection
   denials in this family.
3. **Parameter shape.** The `reason` discriminator (`"delete" | "update"`)
   lets clients distinguish the two failure modes without round-tripping
   to inspect the underlying ref-update record. Symmetrical with the
   spec's pattern for `Stemma:RefUpdateRejected` carrying a structured
   `parameters` payload.
4. **OWNER override is policy-level, not RBAC-level.** B10-C-09 says
   tags are immutable *unless* the principal is an OWNER. We check
   the role in the policy module rather than delegate to Compass
   because (a) Compass action keys are about resource access, not
   meta-mutation policy, and (b) the override needs to be visible to
   the audit log entry naming this exact decision (the audit row
   carries the rejected ref + reason).

## Alternatives considered

1. **`Tag:Immutable` (new namespace).** Cleaner separation but bloats
   the dashboard surface and forces every subscriber to know about
   two namespaces for what is conceptually one decision flow.
2. **Reuse `BranchProtection:DeleteProtected` for tag deletion.**
   Misleading — tags aren't branches, and the protection isn't
   "this ref is in the protected-branches list", it's "tags are
   append-only by default". Two different invariants reusing one
   error name would lose audit-log clarity.
3. **Defer the rejection to Compass.** Possible but conflates two
   concerns: Compass owns "can this principal write to this resource
   at all", and B10's tag-immutability rule is "this kind of write
   is forbidden by the resource's own policy regardless of who you
   are". Easier to test in isolation when the policy lives with the
   other branch-protection rules.

## What evidence would change this

- The spec is amended to specify a different errorName for B10-C-09.
  In that case, swap the union member in `BranchProtectionErrorName`
  and update the four call sites + the unit test.
- A second tag-related policy is added (e.g. signed-tag requirement).
  Then we'd promote the `Tag:` namespace and split the names.

## Contracts touched

- B10-C-09 — tag immutability rejection (HTTP behaviour)
- §1.3 — error envelope shape (errorCode + errorName + parameters)
- B10-C-16..20 — companion branch-protection error names

## Tests pinning this decision

- `tests/unit/code-repos/stemma-events/branch-protection-errors-unit.test.ts:30`
  asserts `BranchProtection:TagImmutable` is in the exhaustive name list.
- `tests/unit/code-repos/stemma-events/branch-protection-errors-unit.test.ts:48`
  asserts `BRANCH_PROTECTION_STATUS["BranchProtection:TagImmutable"].httpStatus === 403`.
- `tests/unit/code-repos/stemma-events/pre-receive-policy-unit.test.ts`
  asserts the policy returns this exact errorName for the "owner-less
  tag delete" and "owner-less tag update" scenarios.
