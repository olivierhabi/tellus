# Sandbox isolation migration plan (Phase 5 follow-up)

**Status:** scoped plan — NOT implemented. Phase 5 determined that
`isolated-vm` is **not** a safe drop-in replacement for the current
`vm` + worker_threads architecture; this document is the migration
design for when the work is scheduled.

## Why isolated-vm is not a drop-in

1. **Host-closure SDK bridge.** `runSandboxedWithSdk`
   (`src/services/functionRuntime.ts:310+`) injects *host functions*
   (`Objects.search/get/types`, `Edits.*`, `createEditBatch`) as plain
   closures into the vm context, and sandbox code calls them
   synchronously. Under isolated-vm these become `ivm.Reference`
   handles; every call must be re-entrant through
   `ref.applySync/apply` with explicit argument copying
   (`ivm.ExternalCopy`). The whole SDK surface
   (`src/services/functions/ontologyRuntime.ts:390-450`) needs a
   marshalling layer that does not exist.
2. **Snapshot passing.** The ontology snapshot (Maps of objects) is
   shared by reference today; isolates share nothing — the snapshot
   must be copied into the isolate (ExternalCopy) or re-materialized
   inside it. Large snapshots change the performance profile of every
   invocation.
3. **Async contract.** `pendingPromise`/`awaitSandboxPromise`
   (`functionRuntime.ts:373-402`) hands a sandbox-created Promise to
   the host. Cross-isolate Promises require
   `ivm.Reference` + callback bridging; the current 5s `Promise.race`
   timeout must be re-implemented against isolate wall-clock
   termination (`isolate.dispose()`), not a race.
4. **Toolchain/runtime risk.** isolated-vm is a native module
   (node-gyp, C++ toolchain, Python). The repo runs Node 24
   (`package.json: engines.node = "24.x"`); prebuilt-binary coverage
   for Node 24 must be verified per release before adoption, and the
   production image gains a build toolchain or a pinned prebuilt.
5. **Worker model overlap.** The current pool already gives
   per-invocation wall-budget termination + respawn. isolated-vm's
   added value is *memory isolation and realm separation*, not
   scheduling — so the migration is a like-for-like rewrite of the
   innermost execution cell, not an incremental upgrade.

## Target design (when scheduled)

1. **Execution cell**: one `ivm.Isolate` per worker (memory-capped via
   `memoryLimit`), one disposable `ivm.Context` per invocation.
2. **Broker bridge (host side, auditable)**: the SDK stops being host
   closures and becomes a *protocol*: sandbox code emits operation
   requests (`objects.search`, `edits.update`, …) through a single
   bridged dispatch function; the host broker validates each
   operation against the invocation's authorization context
   (publisher provenance, program/function-version authorization,
   declared-import allowlist) before executing it and returning a
   plain-data result. Every privileged operation is logged to the
   action audit chain with the pinned function identity.
   This is the full form of the Phase 5 broker checkpoint
   (`src/actions/functionActionExecutor.ts` kind + scope guards).
3. **Capability-less isolate**: no `require`, no host references
   except the single dispatch bridge; `process`, fs, net,
   child_process unreachable by construction (not by omission).
4. **Limits**: `memoryLimit` per isolate, wall-clock dispose per
   invocation, snapshot size cap, edit-count cap (already:
   `maxAffectedObjects`).
5. **Rollout**: shadow mode (run both engines, compare outputs) →
   per-tenant flag → default. Rollback = the current vm pool, kept
   intact behind a config switch until isolation has one full
   release of soak.

## Prerequisites

- Verify isolated-vm release support for the deployed Node major.
- Production image: prebuilt binary availability or toolchain
  addition.
- Operation protocol schema + broker authorization model (extends
  the Phase 5 checkpoint to per-operation granularity, including
  READ operations, which today are scoped only by declared imports).
- Snapshot copy strategy for large ontologies (paged reads through
  the broker instead of whole-ontology snapshots — this also fixes
  the current 50k-200k row materialization ceiling).

## What Phase 5 already shipped toward this

- Worker env whitelist + `resourceLimits` memory cap.
- Broker checkpoint: program authorization (edit-kind fail-closed)
  and operation authorization (declared-import edit scope) at the
  persistence boundary.
- The audit path for privileged persistence is unchanged and reused
  by the target design.
