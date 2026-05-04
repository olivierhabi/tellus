# D-2026-05-01-005 — Patch-tool `\n`-decoding defect; safe-edit strategy

## Context

Wave 5 (B10 HTTP route layer) was scoped to add three helpers to
`src/services/stemmaEvents/store/subscriptionStore.ts` (a tx-aware
`createSubscriptionWithinTx`, a `deleteSubscriptionWithinTx`, and a
cursor-paginated `listSubscriptions`), plus build the routes module +
app + integration tests.

While performing the first edit — a single `mcp__oc__patch` call whose
`new_string` contained ~145 lines (~4900 chars) of new code with `\n`
escape sequences as line separators — the tool corrupted the file:
the `\n` characters were inserted as literal two-character `\n`
sequences instead of newlines. The result was a 4897-character single
line at the top of the file, violating TypeScript syntax wholesale.

Detection was immediate: the patch tool's own static syntax validator
flagged 38 syntax errors in the diff response, and a follow-up `wc -l`
+ `grep -c '\\n'` confirmed the file contained literal backslash-n
strings.

## Recovery

The original file was untracked (created in wave 4), so `git checkout`
could not restore it. However, the corruption affected only the
original line 2 (the one-line section comment `// B10 — stemma_subscription store.`);
lines 1 and 3-302 of the original were preserved. Recovery: rebuild the
file with `sed -n '1p' + 'echo' + sed -n '3,302p'`. Verified by:

- `wc -l` — 302 lines, matches pre-corruption count.
- `grep -c '\\n'` — 0 literal escape sequences remain.
- `tsc --noEmit` — clean.
- The 15-case wave-4 `subscription-store-integration.test.ts` —
  all 15 still pass against the recovered file. This is the strongest
  evidence: every storage function (`createSubscription`, `getSubscription`,
  `listMatchingActiveSubscriptions`, `recordDeliverySuccess`,
  `recordDeliveryFailure`, `reactivateSubscription`, plus the
  `rowToSub` row-mapper) is exercised end-to-end against real
  Postgres, and all behaviour is intact.

## Reproducibility analysis

Other patches in the same session, against `src/services/stemma/admin/routes.ts`,
applied multi-line `new_string` content (4-line import block + 3-line
function body) and worked correctly — the `\n` characters became
real newlines as expected.

Hypothesis: there is an upper bound (≈4 KB? ≈100 lines? unclear)
above which the runtime that delivers the JSON-encoded `new_string`
to the patch tool fails to JSON-decode the `\n` escape sequence,
inserting it as literal text instead. Below that bound, decoding
works correctly.

Without access to the runtime's internals this hypothesis cannot be
confirmed. What can be confirmed is the operational consequence:
**any single `mcp__oc__patch` or `mcp__oc__multi_patch` call whose
`new_string` exceeds ~4 KB and contains `\n` characters must be
treated as unsafe.**

## Decision

For wave 5 onward, the safe-edit strategy is:

1. **For brand-new files**, use `mcp__oc__Write`. The Write tool has
   handled multi-line files of every size encountered so far in waves
   1-4 without issue (largest was the ~4 KB `subscriptionStore.ts`
   itself, written in wave 4).
2. **For in-place edits whose `new_string` would exceed ~3 KB OR
   contain more than ~30 newlines**, do not use `mcp__oc__patch` /
   `mcp__oc__multi_patch`. Instead:
   - If the change is purely additive (insert a block at a known
     anchor), use `mcp__oc__shell` with `awk 'NR==N{print "..."} 1'`
     or with a heredoc-driven `sed -i ''` insertion at a marker line.
   - If the change is rewriting most of the file, use `mcp__oc__Write`
     with the full new content (read the file via `mcp__oc__Read` first,
     so the patch-tool's read-before-edit invariant is satisfied for
     downstream edits).
3. **For small in-place edits (1-3 lines, no `\n` in `new_string`)**,
   `mcp__oc__patch` / `mcp__oc__multi_patch` remain safe. Both
   pre-existing-violation cleanups in wave 5 (the
   `eslint-disable-next-line no-console` in `idempotency.ts:210`
   and the `eslint-disable-next-line @typescript-eslint/no-namespace`
   in `principal.ts:40`) used this pattern — single-line 1-for-1
   replacement, no `\n` in either `old_string` or `new_string` —
   and applied cleanly.

## Evidence that would change this

A clear runtime fix or upper-bound documentation from the platform
that establishes patch-tool `\n`-decoding behaviour as deterministic
across all sizes. Until then, the size threshold above is empirical
and conservative.

## Contract IDs touched

None directly. This is a tooling/process decision. It is filed here
so future agents continuing the wave plan know to:
- prefer `mcp__oc__Write` for any new module that was previously
  written via `mcp__oc__Write` in wave 1-4 (subscriptionStore.ts,
  postReceiveService.ts, callbackDispatcher.ts, eventStore.ts,
  preReceive.ts, errors.ts, hmac.ts, auditEvents.ts,
  observability/metrics.ts, contracts/*.ts);
- use the dependency-DAG-ordered routes work in wave 5 with this
  strategy from the start.

## Wave 5 status as a result

Wave 5 is **partial**. Two pre-existing-violation cleanups landed
(both `eslint-disable` comments removed, plus the `eslint-disable`
+ `require()` block in `stemma/admin/routes.ts` from wave 1 which
was the wave-5 opening edit). The substantive wave-5 deliverables
(B10 HTTP routes, app factory, integration tests) did not land due
to time spent on detection and recovery. Suite remains 313/313
green; tsc clean; zero forbidden patterns.

The next session is unblocked: subscriptionStore.ts is intact, the
cleanups are durable, and the safe-edit strategy above is the path
forward.
