<!--
  PROVENANCE / HOW THIS REVIEW WAS PRODUCED
  Author: Principal-engineer review, manual-test-backed (2026-06-14).
  Method: (1) live manual test against the running backend via
          scripts/foundry-parity/verify-foundry-parity.sh on a freshly booted
          server -> 29 PASS / 0 FAIL / 4 GAP; (2) live Postgres data snapshot
          (147 repos, 36 function_versions [21 AVAILABLE/15 YANKED], job_spec 0 rows);
          (3) 7-agent file:line subsystem read of tellus + tellus-fe; (4) first-hand
          verification of the load-bearing findings (vm-not-a-sandbox, transpile-not-
          typecheck, content-blind commit SHA, monotonicity-in-caller, jobSpec unmounted).
  Reference contracts: Palantir Foundry Functions overview + Code Repositories overview.
-->

# Formal Engineering Review — TS Functions v2 & Code Repositories (1:1 Foundry Clone)

## 1. Verdict

This is a serious, technically literate clone that nails the **single-author publish loop** and badly under-builds the **collaboration and runtime-isolation loops**. The authoring → commit → tag/release → immutable-registry → invoke path is real, durable, and in several places genuinely well-engineered (content-derived ETags, two-parser If-Match concurrency, a SERIALIZABLE + UNIQUE-index immutability fence, a compensating create-saga, a hand-written SemVer engine). But two structural facts cap the score hard: (1) function execution runs in Node `vm`, which is **not** an isolation boundary and is trivially escapable to host RCE (`src/services/functionRuntime.ts:204-221`), and (2) the entire governance third of Code Repositories — Pull Requests, branch protection, CI checks — has **no working endpoint** on the running server. My grades:

- **(A) TS Functions v2:** ~**80%** of the authoring + versioning + registry + invoke-envelope surface, but ~**0%** of a safe execution boundary and ~**40%** of the real OSDK read model. Call it **PARTIAL-leaning-PARITY on shape, DIVERGENT on substance** because the one thing a server-side function runtime exists to provide — isolation — is absent.
- **(B) Code Repositories:** ~**85%** of the solo authoring/publish loop, ~**15%** of the collaboration loop (PRs/protection/CI), and a git object layer that is a path-keyed working-tree snapshot, not a content-addressed object DAG (`src/services/codeRepository/adapters/postgres.ts:146-148`). Net **PARTIAL**.

The harness number (29 PASS / 0 FAIL / 4 GAP) is accurate but flattering: it measures the happy-path HTTP contract surface, where this code is strong. It does not exercise sandbox escape, type-checking depth, multi-branch commit identity, or the collaboration endpoints that simply return nothing.

---

## 2. What Was Actually Built

The end-to-end architecture is real and traceable:

**Repo create (saga).** `POST /api/v1/code-repositories` (`routes.ts:123-226`) drives a 4-step compensating saga via `executeCreateRepositorySaga` (`saga/executor.ts:86`): reserve Compass → create Stemma → scaffold+push the TS-Functions template (`runStep3`, `executor.ts:266`) → `INSERT code_repository` + activate (`executor.ts:340`). It is governed by a **pure, total** state machine with terminal-state absorption and an exhaustiveness `never` check (`saga/stateMachine.ts:35,58-65`), reverse-order compensation (`executor.ts:405`), and a durable Postgres ledger keyed `UNIQUE(idempotency_key, principal_sub)` (`ledgerStore.ts:44`, `migration 053:108`). Live: 147 repos, 100% `typescript-functions`. The template itself (`templates/manifest.ts:56-369`) is an unusually faithful Foundry v2 scaffold (the `typescript-functions/` v2 discriminator dir, `functions.json`/`resources.json`, `@osdk/functions` deps, gradle multi-project wrapper, a real `ci.yml`).

**Git layer (Stemma).** The production adapter is `PostgresStemma` (`adapters/postgres.ts:58`), wired as the sole adapter at `server.ts:668`. It persists three flat tables — repo / branch / blob (`migration 086:17-47`). This is **durable** (replacing a prior in-memory adapter that lost content on reload) and the commit CAS is genuinely correct: `commitFiles` takes `SELECT head_sha ... FOR UPDATE` inside BEGIN/COMMIT and rejects on `parentSha ≠ HEAD` (`postgres.ts:96-153`). The tree ETag (`treeProjectionSha`, `postgres.ts:44-52`) is a real content-derived hash over each projected entry's per-blob content SHA, which makes the strong-ETag/304 path cache-correct.

**Monaco IDE.** A single 3466-line client page (`app/code-repositories/repo/[rid]/page.tsx:2832`) composes the file tree, Monaco tabs (dynamic `ssr:false`, `page:83-86`), a Functions live-preview panel, a SourceControl commit panel, a Tag&Release dialog, and a Resource Imports sidebar. The dirty buffer is a clean `bases`/`drafts` two-Map split giving O(1) diffs (`page:2902-2973`). Commits send `If-Match: "<40-hex parentSha>"` + a UUIDv4 Idempotency-Key via a textbook HTTP client (`lib/codeRepositoriesApi.ts:419-458`).

**Tag & Release → immutable registry.** `POST /:rid/tags` (`routes.ts:1565`) discovers `src/functions/*.ts` (`FN_RE`, `routes.ts:1602-1609`), transpile-validates each, sorts by apiName for **deterministic** hashing (`routes.ts:1619`), content-addresses a `{exports, sources}` manifest via sha256, and publishes through `publishVersion`. The registry store (`functionsRegistry/store.ts:85`) runs `BEGIN ISOLATION LEVEL SERIALIZABLE` + `FOR UPDATE` lock-then-check, with a DB-level `UNIQUE(repository_rid, branch, semver)` fence (`migration 055:46`): identical sha256 → dedup 200, different sha256 → 409 `VersionImmutable`. The SemVer engine (`semver.ts`) is hand-written and real: canonical strict regex (`30-31`), §11 precedence with correct numeric-vs-alphanumeric prerelease ordering (`75-99`), caret math with the 0.x.y/0.0.z special cases (`221-253`), and faithful npm §10 prerelease exclusion (`278-289`). Live: 36 versions (21 AVAILABLE / 15 YANKED) across 26 repos.

**Invoke with Ontology edits.** `POST /:rid/functions/invoke` (`routes.ts:1925`) transpiles TS → CJS, materializes an Ontology snapshot from Postgres `object_instances` (`ontologyRuntime.ts:72-122`), injects an `Objects`/`Edits`/`createEditBatch` SDK, runs it in `vm` (`functionRuntime.ts:169-267`), and returns a faithful envelope `{result, durationMs, stdout, stderr, status, edits[], editsApplied, ontology{...}}` (`routes.ts:2296-2311`). The **edit-collapsing** model is genuinely faithful to Foundry (create+update→create, create+delete cancels, update-after-delete no-op, link last-wins; `ontologyRuntime.ts:241-270`), and `applyEdits:true` persistence is properly transactional with per-property audit rows (`ontologyRuntime.ts:408-495`).

**Credit where due — what is genuinely well-engineered:**
- **Two purpose-built If-Match parsers** prevent type confusion: integer `resource_version` (`parseVersionEtagOrNull`, `routes.ts:2405`) vs 40-hex SHA (`parseShaIfMatch`, `routes.ts:2682`), both failing to 400 *before* any SQL bind (the CR-11d guard).
- **RFC-7232-correct 412-vs-400 disambiguation**: every concurrency route re-queries to separate not-found from version-mismatch (`routes.ts:355-369, 406-418, 1250-1264`).
- **Idempotency middleware closes the deferred-INSERT race** by persisting the 2xx body *before* flushing bytes, via an `res.json` override, with an explicit comment on why `res.on('finish')` was insufficient (`idempotency.ts:199-252`).
- **The FE auth client** is production-grade: single-flight `/auth/refresh` with cross-tab BroadcastChannel leader election + follower watchdog, retry-at-most-once, and an honest comment admitting the dual-leader rotation race (`lib/api.ts:208-280`).

These are not the marks of a demo. The concurrency and immutability primitives are the real thing.

---

## 3. Parity Matrix

| Foundry capability | Verdict | Evidence (file:line) | Notes |
|---|---|---|---|
| Repo create from TS-Functions template | **PARITY** | `routes.ts:123-226`, `executor.ts:86,266,340` | Real compensating saga + durable ledger. 147 live repos. |
| File tree + blob read for IDE | **PARITY** | `routes.ts:612,780`; strong ETag 304 `710-716` | 5MiB cap, binary→base64, IDOR-safe 404. |
| Branches + default branch | **PARTIAL** | `routes.ts:429-500,510,567,579` | Default is **"main"** not Foundry's **"master"** (`routes.ts:2936`). |
| Mandatory commit message | **PARITY (BE)** / **PARTIAL (FE)** | `routes.ts:2735-2742`; FE `page.tsx:462-468` | Backend 400s empty; UI auto-fills a placeholder so the gate is never hit. |
| Commit optimistic concurrency (parentSha→412) | **PARITY** | `routes.ts:1096-1106`; `postgres.ts:96-153` | FOR UPDATE serializing fence; correct. |
| Metadata ETag / If-Match concurrency | **PARITY** | `routes.ts:2405-2408,355-369` | Malformed→400, mismatch→412. |
| Idempotency-Key replay | **PARITY** | `idempotency.ts:77,164,199-252` | Same-key+diff-body→409; replay header set. |
| Tag&Release publishes all `src/functions/*` | **PARITY** | `routes.ts:1565,1602-1609,1689` | Deterministic apiName sort; content-addressed. |
| Release build **blocks** on failing build | **PARTIAL / DIVERGENT** | `routes.ts:1625-1631` | `ts.transpileModule` only — **no type-check, no import resolution**. Type-broken code publishes. |
| Immutable SemVer registry | **PARITY** | `store.ts:91,110-123`; `migration 055:46` | SERIALIZABLE + UNIQUE index. Immutability is **branch-scoped**, not global. |
| Monotonic SemVer (lower→409) | **PARITY (via wrapper)** / **PARTIAL (registry)** | `routes.ts:1647-1654`; **not** in `store.ts:105-145` | Direct `POST /api/v1/functions/:rid/versions` accepts a lower version → 201 (`admin/routes.ts:93-140`). |
| SemVer range resolution (^/~/x → max-sat) | **PARTIAL** | `semver.ts:128-219,278-365` | No `\|\|`, no hyphen ranges, bare `^1`/`~1.2` throw. FE never calls `resolveVersion`. |
| Deprecate / yank lifecycle | **PARTIAL** | yank `store.ts:211-226`; no DEPRECATED state `migration 055:31-32` | Only AVAILABLE\|YANKED; Foundry distinguishes deprecate (still resolvable) from yank. |
| Ontology imports backed by versioned resources.json | **DIVERGENT** | `routes.ts:1366-1540`, `computeImportsEtag:2443` | Stored in a **DB table**, not declarative-in-tree; decoupled from git history. |
| **Pull Requests / Proposals** | **MISSING** | no route; `open_pr_count` seeded 0 `routes.ts:550` | Harness GAP CR-15. No BE, no FE. |
| **Branch protection / PreReceiveHook** | **MISSING** | `is_protected` hardcoded FALSE `routes.ts:550`, never checked at commit | Harness GAP CR-16. FE simulator 404s (`stemmaEventsApi.ts:60`). |
| **CI checks (ci/foundry-publish)** | **MISSING** | no checks endpoint; `job_spec` 0 rows | Harness GAP CR-17. FE runs pages 404 (`jemmaApi.ts`). |
| List repos — pagination | **PARTIAL** | `routes.ts:256` returns `nextPageToken:null` | Harness GAP CR-14. FE prints "wired in F2" (`browse/page.tsx:237`). |
| IDOR-safe (unknown rid→404) | **PARITY** | `routes.ts:265-281,663-674` | Scoped to `state IN ('ACTIVE','ARCHIVED')`. |
| 401 unauth + §1.3 envelope | **PARITY** | `principal.ts:75,157-169`; `errors.ts:290` | Per-route auth (ADR-008) avoids 401-ing siblings. |
| Server-side **isolated** sandbox execution | **DIVERGENT** | `functionRuntime.ts:204-221`; `routes.ts:2199` | Node `vm`, **not** an isolation boundary. Full host RCE reachable. |
| Hard CPU timeout | **PARTIAL** | `functionRuntime.ts:226-229,251-254` | 5s/phase ⇒ ~10s wall; async un-timed; escape bypasses timer. |
| Memory limit | **MISSING** | no `resourceLimits`/Worker anywhere | OOM crashes the shared backend (DoS). |
| Ontology read SDK (search/aggregate/link traversal) | **PARTIAL** | `ontologyRuntime.ts:84-95,147-178` | In-JS over a Postgres snapshot, not OpenSearch/OSDK; no link-traversal read; sync, not async. |
| Ontology Edits API + collapsing | **PARITY** | `ontologyRuntime.ts:241-317` | Faithful collapse semantics; transactional apply. |
| Action execution inside a function | **MISSING** | SDK exposes only Objects/Edits/createEditBatch `ontologyRuntime.ts:322-338` | No `Actions.execute`. |
| Invoke envelope | **PARITY** | `routes.ts:2296-2311` | Rich, parity-shaped. |
| Git object DB (loose blob/tree/commit, DAG) | **DIVERGENT** | `migration 086:17-47`; `postgres.ts:146-148` | Path-keyed snapshot; HEAD = `sha(rid:branch:msg:paths)`, content-blind; no parents/history. |
| Create transforms (Python/Java/SQL @transform→datasets) | **MISSING** | `manifest.ts:437/481/521`; FN_RE `.ts`-only `routes.ts:1602` | Scaffold renders; **no discovery, no executor, no lineage**. `job_spec` 0 rows. |
| JobSpec build registration | **DIVERGENT (dead code)** | `jobSpec/store.ts:87`, `jobSpec/admin/routes.ts:91` never `app.use()`'d | Well-built, never mounted. 0 rows in prod. |

---

## 4. Critical Divergences & Risks (ranked)

### R1 — `vm` is not a sandbox: authenticated arbitrary-code → host RCE. **Severity: CRITICAL.**
`runSandboxedWithSdk` injects host functions (`require` shim, `console`, `Objects`, `Edits`, `createEditBatch`, `module`/`exports`) directly as context globals (`functionRuntime.ts:204-221`) and runs user TS via `vm.createContext` + `runInContext`. Node's `vm` keeps those injected functions in the **host realm**, so the prototype chain is an escape hatch: `Edits.create.constructor.constructor('return process')()` returns the real Node `process`, from which `process.mainModule.require('child_process')`, `fs`, network, env/secret exfiltration, and the **same Postgres pool** are reachable. The header comment at `functionRuntime.ts:6-9` claims "no require, no process, no fs, no network" — it documents the opposite of reality. *Why it matters at Palantir scale:* every authenticated user who can author or invoke a function gets code execution in the shared admin process serving all tenants. This cannot be patched by adding shims; it requires `isolated-vm`, a Worker, or an out-of-process sandbox. With `applyEdits:true` (`routes.ts:2223-2236`) the same code also writes the system-of-record `object_instances` with no Action-rule validation, so escape + mutation are one call.

### R2 — No memory limit: trivial whole-backend DoS. **Severity: CRITICAL.**
There is no `resourceLimits`/Worker/heap cap anywhere (`functionRuntime.ts`). `new Array(1e9)` OOM-kills the shared Node process for all tenants. The 5s CPU timer does not bound allocation rate before OOM.

### R3 — Transpile-not-typecheck defeats the "build blocks publish" contract. **Severity: MEDIUM (HIGH for trust).**
The release gate is `ts.transpileModule({isolatedModules:true})` (`routes.ts:1625-1631`), single-file emit that does **not** type-check, resolve imports, or cross-file check. A function with a type error or an import of a non-existent module transpiles clean and is published as an **immutable AVAILABLE artifact**, failing only at `vm` runtime. Foundry's `ci/foundry-publish` runs full `tsc`. The clone's strongest-looking guarantee — an immutable, content-addressed, SemVer-gated registry — is therefore publishing artifacts a real build would reject.

### R4 — "Immutable registry" stores source inline; there is no blob store. **Severity: MEDIUM.**
`artifactBlobId = inline:<sha16>` (`routes.ts:1689`) is a synthetic pointer; the real bytes live in `manifest_json.sources`, and `artifact_bytes` measures the canonical JSON, not a stored object. Content-addressing is real and correct, but the blob indirection is a fiction. At scale this couples the registry table to source size and forecloses the dedup/GC/CDN properties a real artifact store provides.

### R5 — Content-blind commit identity. **Severity: HIGH (data-integrity).**
`commitSha = deterministicSha(rid:branch:message:sortedPaths)` (`postgres.ts:146-148`) ignores file **content**. A content-only edit (same paths, same message) produces an **identical HEAD** — the ref does not advance and two distinct commits collide to one SHA. This breaks commit identity/history and **silently weakens the parentSha CAS**: a stale client whose content edit didn't move HEAD can pass If-Match. Only the tree ETag reflects content. There is also no commit object, no parent linkage, no author/timestamp, no DAG (`migration 086`), so "history" is not queryable. A far more git-faithful Stemma (`src/services/stemma/`: loose objects, symbolic refs, pkt-line smart-HTTP) exists but is **dormant** — `server.ts:668` wires only `PostgresStemma`.

### R6 — The four GAPs are load-bearing, not cosmetic (see §5). **Severity: HIGH (product completeness).**
- **PRs/Proposals (CR-15):** no route; `open_pr_count` is vestigial (`routes.ts:550`). FE toolbar tab flips `?section=pulls` but `page.tsx:3291` only branches on `branches`, so it renders the editor.
- **Branch protection (CR-16):** commit route never consults `is_protected` (hardcoded FALSE, `routes.ts:550`); the only "protection" is blocking default-branch deletion (`routes.ts:579`). The FE ships a polished simulator over `POST /v1/stemma-events/pre-receive` (`stemmaEventsApi.ts:60`) whose router lives in a never-booted standalone `app.ts` — **every Simulate click 404s**.
- **CI checks (CR-17):** no checks endpoint; `job_spec` 0 rows. FE runs pages poll `/v1/jemma/runs` (`jemmaApi.ts`), also unmounted (and the cancel path is mis-spelled `:cancel` vs `/cancel`, `jemmaApi.ts:121`).
- **Pagination (CR-14):** `nextPageToken:null` unconditionally (`routes.ts:256`); FE silently truncates at 100 and prints "pagination wired in F2" (`browse/page.tsx:237-241`).

### R7 — "Create transforms" is not real. **Severity: MEDIUM (honesty).**
Python/Java/SQL templates render (`manifest.ts:437/481/521`) but there is **no `@transform` discovery, no build executor, no dataset lineage**. The discovery regex is `.ts`-only (`routes.ts:1602`), so Tag&Release on a transforms repo returns `NoFunctionsToPublish` (`routes.ts:1610-1611`). The `JobSpec` subsystem that would register builds (`jobSpec/store.ts:87`, `jobSpec/admin/routes.ts:91`) is fully implemented but **never `app.use()`'d** in `server.ts` — `createJobSpecApp` is imported only by tests. `job_spec` has 0 rows in prod. A user can create a transforms repo that can never build or publish anything, and nothing surfaces the dead end until release time. This should be labeled scaffold-only, not a product.

### R8 — Saga is in-request, not durably resumable. **Severity: HIGH (recoverability).**
The saga runs synchronously inside the POST handler (`executor.ts:117-119`); there is no background driver. Replay short-circuits non-terminal ledger rows into a `failed` result (`executor.ts:110-112`, `resultFromLedgerRow:474-499`), so a crash mid-saga is **permanently wedged** while upstream Compass/Stemma reservations leak. Forward steps mint fresh RIDs each call (`randomUUID`, `executor.ts:156,223`) and are **not idempotent** — only compensations are. (Mitigated today only because live Compass/Template are in-memory stubs, `mount.ts:75-77`.)

### R9 — Non-atomic dual-write of branch HEAD. **Severity: MEDIUM.**
`commitFiles` writes the authoritative HEAD in one transaction, then a **separate** route tx upserts `branch_cache.head_sha` (`routes.ts:1083-1133`). A crash between them leaves the cache stale; `GET /branches` reads the cache while the tree endpoint reads Stemma — the exact drift class migration 086 claims to have fixed.

### R10 — FE cross-branch dirty-buffer bleed. **Severity: HIGH (silent wrong-content commit).**
`switchBranch` is a bare `router.push(?branch=)` with no remount (`page.tsx:2869-2875`); `drafts`/`bases` are keyed by **bare path** while tab keys are `${branch}:${path}`. Edit `src/x.ts` on master, switch to a feature branch, commit — the master-authored draft is written to the feature branch's `x.ts` against the feature branch's parentSha, with no warning and no unsaved-changes guard. The code even acknowledges it: "This will need to grow a branch dimension."

**Lower-severity, real:** registry monotonicity excludes YANKED rows (`routes.ts:1638`) so a version below a yanked-higher one isn't gated; create response ETag is hardcoded `W/"1"` (`routes.ts:200`); FE discards the 4-key error envelope everywhere, showing "Request failed with status code 409/412" (`lib/api.ts:356-422`, `browse/[rid]/page.tsx:229`); no file add/delete/rename in the IDE (`op:"modify"` only, `page.tsx:3024`); resource-imports 412 is swallowed into an unhandled rejection (`ResourceImportsPanel.tsx:1698-1711`) contradicting the page's own comment; hottest read paths do a durable audit INSERT before ack, doubling DB round-trips under IDE load (`routes.ts:722-754`).

---

## 5. The Collaboration Gap

Code Repositories is not an editor — it is a **governed change-control system**. The product's reason to exist over "Monaco + a database" is that a change to a protected branch must pass through review and CI before it can advance a ref, and that releases are produced by that gated pipeline. The clone implements the *artifact* end of that pipeline beautifully and omits the *governance* end entirely. Concretely:

- **Branch protection is the write-path authorization model.** Without a PreReceiveHook, commits are accepted on **any** branch including ones flagged protected (`is_protected` is never set or read, `routes.ts:550,1027`). There is no point at which the system can say "you may not advance this ref directly." That is not a missing feature; it is a missing security boundary on the write path. The `PreReceive` metric exists (`observability/metrics.ts:51`) but no hook is wired — the scaffolding implies an intent that was never connected.
- **Pull Requests are how changes become reviewable units.** With no PR/Proposal entity, there is no diff-to-review, no approval gate, no merge — so the only way content enters a branch is a direct authenticated commit. Every "feature branch" is therefore a dead end that can only be merged by a human re-typing or by an out-of-band copy. `open_pr_count` is permanently 0.
- **CI checks are what make a merge *mean* something.** `ci/foundry-publish` is the contract that "merged" implies "type-checked, linted, tested, publishable." Here the publish path is a **synchronous HTTP `/:rid/tags`** call (`routes.ts:1565`), not a CI run — and because the build is transpile-only (R3), even that gate is shallow. `job_spec` at 0 rows confirms no check ever executed.

These three are mutually reinforcing: protection without PRs is a wall with no gate; PRs without checks are review theater; checks without protection can't block anything. They are roughly the load-bearing third of the product. The FE makes this worse by shipping **fully-built UIs over non-existent endpoints** (branch-protection simulator, runs viewer with 2s/5s polling) that 404 at runtime — presenting capabilities that do not exist is more damaging than honestly showing "coming soon," because it reads as working in a demo and fails in production.

---

## 6. Recommendations / Roadmap to True 1:1

Split into two tracks. **Track 1 must precede any production exposure** — the current invoke path is unsafe to run with untrusted input.

### Track 1 — Make the existing path production-safe
1. **Replace `vm` with real isolation. (L)** Move execution to `isolated-vm` or a per-invoke Worker/child process with `resourceLimits` (heap + CPU), no host objects in the realm, and the Ontology SDK exposed over a serialized RPC boundary rather than injected functions. `functionRuntime.ts:204-221` is the file; this is non-negotiable and gates R1+R2. *Until done, the invoke endpoint should be feature-flagged off for any multi-tenant deployment.*
2. **Add a real type-check to the release gate. (M)** Run `tsc` (full program, import resolution, cross-file) in the publish path before content-addressing; keep `transpileModule` only for the fast working-tree preview. `routes.ts:1625-1631`. This makes "immutable AVAILABLE" mean "would build."
3. **Real content-addressed blob store. (M)** Persist artifact bytes in an actual blob backend keyed by sha256; make `artifact_blob_id` a real pointer, not `inline:<sha16>`. `routes.ts:1689`.
4. **Make commit identity content-derived. (M)** Fold the tree projection SHA (or per-blob content) into the commit/HEAD hash so content-only edits advance the ref and the parentSha CAS is sound. `postgres.ts:146-148`. Bonus: adopt the dormant `src/services/stemma/` loose-object store to get real history.
5. **Atomic HEAD write. (S)** Either write `branch_cache.head_sha` in the same tx as the Stemma commit or stop caching HEAD and read it from Stemma. `routes.ts:1083-1133`.
6. **Per-property/Action validation before `applyEdits`. (M)** Don't let a function write `object_instances` without schema + permission checks. `ontologyRuntime.ts:408-495`.
7. **Surface the error envelope on the FE. (S)** Render `errorName`/`parameters` from `error.response.data` so 409/412/422 are legible. `lib/api.ts:356-422` and every page catch.
8. **Fix the cross-branch dirty-buffer key. (S)** Key `drafts`/`bases` by `${branch}:${path}` (or remount on `?branch=`) and add a `beforeunload`/nav guard. `page.tsx:2900-2905`.

### Track 2 — Close the parity gaps
9. **Pull Requests / Proposals. (L)** A PR entity (source→target ref, status, reviewers, approvals), diff endpoint, and merge that advances the target ref. This is the keystone of the collaboration loop.
10. **Branch protection + PreReceiveHook. (M)** Set/read `is_protected`; enforce a pre-receive gate on commit/merge to protected branches (require PR, require passing checks). Actually mount `stemmaEventsAdminRouter` in `server.ts`. The FE simulator already exists — it just needs a live route.
11. **CI checks executor. (L)** A real runner that executes `ci.yml` (type-check/lint/test/publish), writes `job_spec`/run rows, and gates merges via a Checks API. Mount the already-built `jobSpec` router and the Jemma runs router; fix the `:cancel` path. This subsumes #2's enforcement.
12. **Cursor pagination. (S)** `nextPageToken` on list repos and list versions; consume it in `browse/page.tsx`. `routes.ts:256`, `store.ts:161-179`.
13. **Dataset-transforms executor or honest labeling. (L / or S).** Either build `@transform` discovery + a build executor + lineage feeding `job_spec`, or explicitly mark transforms templates "scaffold-only (no build)" in the UI so users aren't led into a dead end. `routes.ts:1602`, `manifest.ts:437/481/521`.
14. **Registry-level monotonicity + global version scoping. (M)** Move the lower-version→409 check into `publishVersionTx` so the registry — not the Tag&Release caller — is the source of truth for ordering, and reconcile branch-scoped vs Foundry's global immutability. `store.ts:105-145`, `admin/routes.ts:93-140`.
15. **Default branch `master`, file add/delete/rename, deprecate lifecycle. (S each)** Small fidelity items.

---

## 7. Scorecard

| Dimension | Score | One-line justification |
|---|---|---|
| **Authoring (template→scaffold→edit)** | **8/10** | Real saga + faithful v2 template + capable Monaco IDE; no file add/delete/rename, cross-branch buffer bleed. |
| **Versioning / Registry** | **8/10** | Real SemVer engine + SERIALIZABLE + UNIQUE-index immutability; but source-inlined (no blob store), monotonicity lives in the caller, branch-scoped. |
| **Concurrency model** | **9/10** | Two-parser If-Match, RFC-7232 412/400 disambiguation, race-correct idempotency, FOR UPDATE commit CAS — the best part of the codebase; docked for content-blind HEAD weakening the CAS and the non-atomic HEAD dual-write. |
| **Execution / Runtime security** | **1/10** | `vm` is not a boundary — host RCE + no memory cap; the header comment claims isolation that does not exist. |
| **Collaboration / Review** | **1/10** | No PRs, no protection enforcement, no merge; commits land on any branch. The load-bearing third is absent. |
| **CI / Checks** | **1/10** | No runner, `job_spec` 0 rows; publish is a synchronous HTTP call, and the build is transpile-only. JobSpec/Jemma routers built but never mounted. |
| **Dataset transforms** | **1/10** | Templates render; no discovery/executor/lineage. "Create transforms" is not real. |
| **Frontend IDE** | **6/10** | Pixel-faithful chrome, strong commit-concurrency plumbing and live-preview edit-and-rerun; undercut by 404-ing protection/runs UIs, swallowed errors, no pagination, and the dirty-buffer bleed. |

**Closing assessment.** The team clearly understands distributed-systems correctness — the concurrency, idempotency, and immutability primitives are principal-grade and would survive a hostile review. That makes the two structural omissions more conspicuous, not less: a server-side function runtime whose entire purpose is isolation runs in a non-sandbox, and a change-control product ships without change control. The path to a true 1:1 is not a rewrite — it is finishing the two halves that were scaffolded and left disconnected (the dormant loose-object Stemma; the unmounted JobSpec/Jemma/stemma-events routers; the simulator UIs) and replacing `vm` with a real boundary. Until R1/R2 are closed, the invoke endpoint should not be exposed to untrusted authors.