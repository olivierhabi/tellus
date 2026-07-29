# Privileged-operations matrix — Functions sandbox (Phase 5 closeout)

**Status:** evidence-backed inventory of every operation reachable by
function code, as of the Phase 5 closeout. The broker checkpoint is
complete for *persistence*; it is NOT yet a complete mediated broker
for all privileged operations — the remaining gaps are named at the
bottom. Line refs: `src/services/functionRuntime.ts` (FR),
`src/services/functionWorkerPool.ts` (FWP),
`src/services/functions/ontologyRuntime.ts` (OR),
`src/actions/functionActionExecutor.ts` (FAE).

| Operation | Directly available in sandbox | SDK/broker mediated | Authorization basis | Audit record | Remaining risk |
|---|---|---|---|---|---|
| **Object reads** (`Objects.search/get/types`) | No — host closures over an in-memory snapshot (OR:390-435); no DB handle in the vm | Partially — reads are scoped *at snapshot load*: `loadOntologySnapshot(db, { objectTypes: importedTypes })` (FAE:201-205) only loads DECLARED imports; per-call authz is not re-checked inside the sandbox | Declared repo imports (per repository+ontology), at snapshot build | `requestedTypes` recorded post-run (OR:392-400) and returned to the invoke route for the import-diff warning; **not persisted as an audit row** | No per-user row-level security (authorization is per-declared-import, not per-executing-user); whole-type materialization (50k-200k rows) is a DoS surface |
| **Object writes** (create/update/delete) | No — `Edits.*`/`createEditBatch` host closures only BUFFER edits in memory (OR:410-425) | **Yes** — broker checkpoint validates every edit's `objectType` against declared imports BEFORE `applyEdits` (FAE:232-263); program authorization `function_kind='edit'` fail-closed (FAE:164-171); batch rejected whole | Published contract (edit kind) + declared object-type imports | `object_edits` audit rows + action audit appended in the same transaction via `preCommitHook` (OR applyEdits; FAE passes the hook); rejections surface as structured submission failures (durable failure audit, Phase 1 path) | None known for the declared-import dimension |
| **Link/unlink** | No — buffered like other edits (`Edits.link/unlink`, OR:337-346) | **Yes (closed in this pass)** — link type must be a declared `link_type` import; BOTH endpoint object types resolved from `link_types` metadata must be declared `object_type` imports; unresolved/ambiguous metadata fails closed (`FUNCTION_LINK_TYPE_UNRESOLVED`); any violation rejects the whole batch (FAE:266-352) | Declared link-type import + declared endpoint object-type imports | Same transaction + audit path as object writes (`link_edit` rows carry actorUserId; OR:549-560) | None known for the declared-import dimension |
| **Network** | **No** — the vm context contains only `{module, exports, require-shim, console, __input, SDK globals}` (FR:361-369); no `fetch`, `http`, `net`, `dns`; `require()` of any non-SDK specifier throws (FR:352-358) | n/a (disabled, not brokered) | Disabled by construction (by omission — see risk) | n/a | **By omission, not by construction**: a vm context escape (`this.constructor.constructor`) reaches the host realm where network exists. Mitigated today only by worker env whitelist + memory cap. **Named blocker** → isolated-vm migration (`docs/sandbox-isolation-migration-plan.md`) |
| **Filesystem** | **No** — no `fs`, no `require('fs')` (shim throws) | n/a (disabled) | Disabled by omission | n/a | Same escape caveat as network. **Named blocker** |
| **Child process** | **No** — no `child_process` in context | n/a (disabled) | Disabled by omission | n/a | Same escape caveat. **Named blocker** |
| **Module loading** | Restricted — `require` shim resolves only 6 SDK specifiers (`@foundry/functions`, `@foundry/functions-api`, `@foundry/ontology-api`, `@ontology/sdk`, `@osdk/functions`, `@osdk/client`, FR:168-175); all others throw (FR:355-357) | n/a (allowlist) | Static specifier allowlist | Thrown import attempts appear as sandbox errors → structured execution failure | Host-realm escape bypasses the shim entirely (same root cause) |
| **Environment access** | **No** — no `process` in the sandbox context | n/a (disabled) | Disabled by omission | n/a | Escape caveat; **defense-in-depth shipped**: workers run with a 4-key env whitelist `{NODE_ENV, TZ, PATH, HOME}` (FWP:118-135) — an escaped function finds no DB credentials / LLM tokens in `process.env` |
| **Host callbacks** | The ONLY host contact surface: SDK closures (`Objects.*`, `Edits.*`, `createEditBatch`), the console shim (log capture), and the numeric-alias/decorator no-ops (FR:334-346) | Yes — closures over snapshot/edit buffer only; they touch no DB, fs, or network | Snapshot scoping + broker checks downstream | Console output captured to `logs[]` and returned | Prototype-pollution/escape through injected closures is the classic `vm` weakness — same root blocker |
| **Time limits** | CPU per phase: vm `timeout: FUNCTION_TIMEOUT_MS` on eval + invoke (FR:374-376, 426); async completions raced (FR:463+) | Worker wall-budget: `FUNCTION_TIMEOUT_MS*2 + 2s` then terminate+respawn (FWP:70, submitToPool) | Global constants | Timeout → structured `FUNCTION_EXECUTION_TIMEOUT` (FAE:206-213) | Microtask-loop hangs are bounded only by the worker wall budget (worker killed), not preempted in-v8 |
| **Memory limits** | None in-vm | Worker V8 old-space cap `resourceLimits.maxOldGenerationSizeMb` (default 256MB, `FUNCTION_WORKER_MAX_OLD_SPACE_MB` override, 64MB floor; FWP:74-79, 125-127) | Global constant | OOM → worker exit → single-task error + respawn | Per-invocation cap is per-worker (shared across queued tasks); snapshot materialization happens on the MAIN process (unbounded there) |

## Privileged operations NOT yet behind the broker (named blockers)

1. **Host-realm escape** (network/fs/child-process/env via vm context
   escape): mitigated by worker env whitelist + memory cap, NOT
   eliminated. Fix = isolated-vm migration
   (`docs/sandbox-isolation-migration-plan.md`). **This is the root
   blocker for any multi-tenant security claim.**
2. **Per-user row-level read security**: reads are authorized per
   declared import (repository-level), not per executing user.
   Follow-up: per-user RLS on snapshot load.
3. **Publish-time test runner**: the publish pipeline's test stage
   executes repository code in a child process with normal fs/network
   (it is a build system). Reachable by function *source* at publish
   time, gated by repo-edit permissions, not by the runtime broker.
   Follow-up: sandboxed publish runner or explicit acceptance.
4. **Main-process snapshot materialization**: unbounded memory on the
   API process for large ontologies. Follow-up: paged reads through
   the broker (also in the isolation plan).
