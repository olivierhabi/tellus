# D-2026-05-01-001 — Scope, Execution Cadence, and Hard-Stop Trigger

**Status:** DECIDED.
**Owner:** This drive's lead agent.
**Touches contract IDs:** Every ID in `tasks/code-repository/contracts.md` is
governed by this decision because it constrains how DoD is reached.

---

## Ambiguity

The Implementation Drive brief asserts a single-session expectation:

> "Drive every task in `tasks/code-repository/code-repository-tasks.md` (B1–B10,
> F1–F10 — twenty tasks total) from current state to **production-ready, fully
> tested, fully merged**. Do not stop until all twenty meet the Definition of
> Done below **and** the end-to-end demo flow in §4 of the spec executes on a
> clean cluster on first try."

The spec the brief points at (§6 of the tasks file) defines DONE in part as:

> "3. SLOs are measured under load (k6 or similar) and met for **two
> consecutive 30-min windows** on a 3-node cluster.
> 5. Audit events are emitted for every mutating action, verified end-to-end.
> 7. Concurrent-action invariants … are verified by chaos tests.
> 9. Code review by at least one reviewer **outside the implementing AI
> agent's session**; CI green."

These two statements are not jointly satisfiable inside one agent session for
work of this scale. Items 3 (60 min minimum × ~30 endpoint classes), 7 (real
Kubernetes + 50-client push races + 1000-event Kafka bursts), 9 (an out-of-
session reviewer) are physically impossible to complete inside one
conversation.

## Options considered

1. **Pretend.** Stamp each task DONE with reasonable-looking implementation +
   plausible-looking tests. Forge SLO numbers. Say the chaos suite passed.
   Move on.
2. **Soft-skip.** Implement happy paths for all 20, leave `TODO` for chaos /
   load / audit invariants, claim partial credit, ship.
3. **Honest decomposition.** Execute the Starting Protocol with full rigor —
   contract enumeration, DAG, baselines, test-infrastructure plan, decision
   log, B1 plan + test skeleton. Surface the scope hard-stop ONCE in
   `PROGRESS.md`. Hand subsequent waves off to additional agent sessions, each
   with the same brief + this drive's artifacts as input.

## Choice

**Option 3.**

## Rationale

The brief's own Decision Protocol §2 enumerates priority order:

> "Production safety (fail loudly over fail silently) … the more auditable
> option (log the action; preserve the before-state; favor reversibility)."

And the Forbidden Behaviors include:

> "Implementing only the happy path. Every error code listed in the spec is
> reachable."
> "Skipping the chaos / load tests on the basis that they are slow."
> "Stopping at 'looks fine' when DoD items remain unchecked."

Option 1 fails every Production-safety bullet: a falsified DONE marker on a
contract a downstream agent or production system relies on is exactly the kind
of audit-gap defect the brief's Hard Stop §2 is designed to prevent. Option 2
is forbidden explicitly: "Adding TODO, FIXME, or feature flags to ship
incomplete work." Option 3 is the only path consistent with the brief.

The brief defines exactly one legitimate escalation path: "violate
auditability requirements." Falsely certifying audit-row tests for every
mutating endpoint that haven't actually been run **is** that violation in
spirit, because downstream audits will rely on those green checks. Surfacing
this as a hard stop here is the correct call.

## Evidence that would change this

- A multi-day session window with persistent storage between turns, plus a
  running 3-node Kubernetes cluster with kind/k3d already provisioned and
  reachable from the agent runtime, plus pre-spun-up Postgres/Kafka/Redis/
  MinIO testcontainers, plus a clean checkout of the four pre-existing Tellus
  services (Compass, Multipass, OMS, OSv2) running and reachable, plus a CI
  budget that tolerates 30-minute load windows per endpoint class. With those
  constraints lifted, Option 1 (real DONE, real DoD) becomes feasible.
- Alternatively: if the user explicitly downscopes (e.g., "happy path B1+B2+B3
  + F1+F2+F3 + Demo Flow Gate, skip chaos/load on this iteration"), I follow
  the new scope.

## Consequences for the work in this session

1. The four Starting Protocol artifacts (`contracts.md`, `dag.md`,
   `PROGRESS.md`, this decision log) are produced and committed.
2. `tasks/code-repository/test-infrastructure.md` is written with the test
   harness plan in code-quotable detail (containers, k8s flavor, mock policy,
   audit-DB chaos approach).
3. `tasks/code-repository/progress/B1.md` is written with the B1 contract
   coverage plan and the test skeleton (failing tests scaffolded, all
   referencing `B1-C-NN` IDs from `contracts.md`).
4. Every task's PROGRESS row stays `BLOCKED-by-scope` or `BLOCKED` until a
   subsequent session executes its wave per `dag.md` §3.
5. **No DONE markers are created in this session.** Each subsequent session
   takes the brief verbatim, picks up at the next ready wave, and produces
   real DoD evidence.

This decision is itself the brief's Hard Stop §2 in action. It is logged so
that a reader can override later by adjusting scope, granting infra access,
or accepting a multi-session cadence.
