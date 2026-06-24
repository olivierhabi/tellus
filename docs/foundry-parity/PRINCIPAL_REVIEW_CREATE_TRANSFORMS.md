<!--
  PROVENANCE / HOW THIS REVIEW WAS PRODUCED
  Author: Principal-engineer review, live-test-backed (2026-06-14).
  Method: (1) live manual test against a freshly booted backend via
          scripts/foundry-parity/verify-foundry-parity.sh on :3055 (CODE_REPOS_TEST_AUTH=1)
          -> 29 PASS / 0 FAIL / 4 GAP, of which ZERO checks exercise transforms;
          (2) live Postgres snapshot of every transform-relevant table (job_spec 0,
          dataset 0, dataset_lineage 0, dataset_transaction 0, dataset_versions 0,
          dataset_acl 0; orchestration_builds 1374 all kind=foundryWorker; foundry_datasets
          140; funnel_dataset 86; code_repository 150 all template_id='typescript-functions');
          (3) a 60-agent file:line subsystem read of tellus + tellus-fe across 9 transform
          dimensions, each load-bearing finding adversarially re-verified in source;
          (4) a real end-to-end loop on real project data (create transforms-python repo ->
          commit @transform -> tag/release) whose actual outcome is reported below;
          (5) a git-stash negative test on the load-bearing discovery invariant (FN_RE).
  Reference contract: Palantir Foundry "Code Repositories -> Create transforms"
          (transforms-python: @transform/@transform_df/@transform_pandas, Input/Output,
          @incremental; Builds/Checks; dataset lineage; job_spec).
  Companion review (shared plumbing): PRINCIPAL_REVIEW_FUNCTIONS_V2_AND_CODE_REPOS.md.
-->

# Formal Engineering Review — "Create transforms" (Python `@transform` → datasets) (1:1 Foundry Clone)

## 1. How I tested it (real data, real server)

**Harness (real server, freshly booted).** `scripts/foundry-parity/verify-foundry-parity.sh` boots its own backend on `:3055` with `CODE_REPOS_TEST_AUTH=1` and the `X-Tellus-Test-Principal` bypass, then exercises the real mounted `src/server.ts` surface. Result: **29 PASS / 0 FAIL / 4 GAP**. That number is real, and it is **irrelevant to transforms**: every check is either Code-Repositories chrome (CR-1…CR-18: create, tree, commit-CAS, If-Match, tags) or **TypeScript Functions** v2 (FN-1…FN-8: invoke, registry, SemVer). The four GAPs are pagination (CR-14), Pull Requests (CR-15), branch protection (CR-16), and CI checks (CR-17). **Not one check authors, discovers, builds, materializes, or lineages a `@transform`.** The harness does not exercise the transform loop at all, so the green bar says nothing about this feature.

**Live Postgres (the tables this feature would write).** Quoted from `docker exec tellus-postgres-1 psql -U tellus -d tellus_db` against the running dev database, *before* my own probe repos were created:

| Table | Rows | What it is |
|---|---:|---|
| `job_spec` (migration 057, "B7 JobSpec Publisher") | **0** | Transform job-spec artifact (`output_dataset_rid, repository_rid, commit_sha, source_path, entry_point, inputs, parameters, compute_profile`). The right shape — never written. |
| `dataset` (migration 024) | **0** | Transform-output dataset (`schema_definition, storage_path, total_rows, file_format`). |
| `dataset_lineage` (migration 024) | **0** | DAG edges (`upstream/downstream_dataset_id, edge_type`). |
| `dataset_transaction` | **0** | Snapshot/append transactions. |
| `dataset_versions`, `dataset_acl` | **0**, **0** | — |
| `dataset_columns` | 67 | FK to **`foundry_datasets`**, not to `dataset`. |
| `foundry_datasets` | **140** | File-browser **uploaded files** (`original_filename, mime_type, content_hash, search_vector`). |
| `funnel_dataset` | **86** | Data-connection **Iceberg catalog** (`namespace, table_name, snapshot_id, write_mode`). |
| `orchestration_builds` | **1374** | **ALL `kind=foundryWorker`** (1306 succeeded / 63 failed / 5 cancelled), `import_rid=ri.magritte.main.extract.*`, `connection_rid=ri.magritte.main.source.*`. Data-connection ingestion — **zero** reference a repo or transform. |
| `orchestration_build_events` | 5808 | Events for the above ingestion builds. |
| `code_repository` | **150** | **100% `template_id='typescript-functions'`.** Zero transforms repos had ever been created. |

The four transform-output tables (`job_spec`, `dataset`, `dataset_lineage`, `dataset_transaction`) are **empty**. The only build engine with activity serves data-connection ingestion, not transforms.

**End-to-end loop, attempted on the real server.** I ran the full documented loop against `:3055`:
1. `POST /api/v1/code-repositories {templateId:"transforms-python", templateVersion:"1.0.0"}` → **201**. Repo `ri.stemma.main.repository.c2b428b8-…` created, `state=ACTIVE`, persisted with `template_id='transforms-python'`. Its tree materialized `transforms/example.py` (275 bytes, a real `@transform(output=Output(...), source=Input(...))`) + `repoSettings.json`. **Authoring shape is real.**
2. `POST /…/tags {semver:"1.0.0", branch:"master"}` → **400 `CodeRepos:NoFunctionsToPublish`**.
3. Re-checked the tables: `job_spec=0, dataset=0, dataset_lineage=0, dataset_transaction=0`. **Nothing materialized. No output dataset, no lineage edge, no job_spec.**

The loop dead-ends at the discovery step. The repo persists forever as a `transforms-python` repo that can never build or publish anything.

**Negative test (git-stash discipline) — §2 of the EXIT CRITERIA.** I proved the discovery gate is load-bearing. Baseline (original `routes.ts:1602`): tag a transforms repo → `NoFunctionsToPublish`. I then changed exactly one line — broadened `FN_RE` from `…src/functions/…\.ts$` to also match `transforms/…\.(ts|py)$` — booted a fresh server on `:3066`, and tagged an identical transforms-python repo:

```
ORIG  (:3055, FN_RE = src/functions/*.ts)        -> 400 CodeRepos:NoFunctionsToPublish
PATCH (:3066, FN_RE also matches transforms/*.py)-> 201 {"version":{"rid":"ri.functions.main.function-version.96c0957e…",
                                                          "runtime":"NODE_20","state":"AVAILABLE",...},"functions":["example"]}
```

The one-line change flips the result — confirming `FN_RE` (`routes.ts:1602`) **is** the gate. But the "success" is more damning than the failure: the Python `@transform` was published as a **`ri.functions.main.function-version` with `runtime:"NODE_20"`** — misclassified as a Node *function* — and **even then `job_spec/dataset/dataset_lineage/dataset_transaction` all stayed at 0**. Fixing discovery alone produces a mislabeled function version, never a transform artifact. I restored `routes.ts` (`git checkout --`; working tree clean) and killed the test servers; the dev backend on `:3000` was untouched.

**Source verification.** Every load-bearing finding below was read first-hand in `tellus`/`tellus-fe` and independently re-verified by a second agent that re-opened the file. The two findings whose automated re-verifier hit a transient socket error (discovery `FN_RE`; orchestration = data-connection) are the two I additionally proved myself live (the e2e `NoFunctionsToPublish` and the negative test for the first; the `orchestration_builds` `kind`/`import_rid` query and the `dispatchBuild` single-caller grep for the second).

---

## 2. Verdict

**Create transforms — ~25% of shape, ~2% of substance — DIVERGENT (effectively MISSING).** The clone renders a syntactically-faithful Python `@transform` *template* and serves it from a real template catalog, and the repo around it (create/commit/tree/IDE) is solid — but **there is no transform loop**: no decorator discovery, no transform registry, no executor, no `job_spec` emission, no output-dataset materialization, and no input→output lineage. The end-to-end loop dies at discovery with `NoFunctionsToPublish`, and the only build engine that exists is a data-connection ingestion worker that cannot run a transform. The capping sentence: **everything downstream of "the template renders" is either absent, dead code, or wired to a different product.**

What makes this **DIVERGENT** rather than a clean **MISSING** is that the team built — to a genuinely high standard — three subsystems that *look* like the transform machinery but serve other features: a data-connection **build engine** (`orchestration/` + `workers/foundry-worker/`, 1374 live builds), a transform-shaped **`job_spec` publisher** (`services/jobSpec/`, well-engineered, **never mounted**), and a **CI scheduler** (`services/jemma/`, well-engineered, **never mounted**, executes nothing). The plumbing exists; it was never connected to `@transform`.

---

## 3. The findings that cap the score

### F1 — The transform loop has no first link, and the negative test proves no second link either. **Caps: Discovery, Authoring, Incremental, CI, Dataset, Lineage.**
The sole discovery path on the publish route is `FN_RE = /(^|\/)src\/functions\/([A-Za-z_][A-Za-z0-9_]*)\.ts$/` (`src/services/codeRepository/admin/routes.ts:1602`). It matches `.ts` files under `src/functions/` only. The transforms scaffold lives at `transforms/example.py` — wrong directory **and** wrong extension — so the discovery loop (`:1604-1609`) yields zero entries and the handler returns `CodeRepos:NoFunctionsToPublish` (`:1610-1612`). **Nothing anywhere parses `@transform`/`@transform_df`/`@transform_pandas`/`@incremental`** (a repo-wide grep returns only the scaffold's own literal string). The commit handler (`:1083-1183`) has exactly two side-effects — a `branch_cache.head_sha` UPSERT and an audit-event INSERT — so there is no discovery on commit either. My git-stash negative test (§1) shows that even *bypassing* `FN_RE` does not help: the discovered Python file is fed to the TypeScript publish path (`ts.transpileModule`, `:1625-1631`), published as a `function_version` with `runtime:NODE_20`, and **still produces no `job_spec`, no `dataset`, no lineage**. Blast radius: no transform can be discovered → none can be registered → none can emit a job_spec → none can build → none can materialize a dataset → lineage is structurally impossible. The entire feature is gated out at line 1602.

### F2 — The one real build engine is a data-connection ingestion worker, not a transform executor. **Caps: Build/Job execution, Dataset materialization, Incremental.**
`orchestration_builds` has 1374 rows and the machinery behind it is production-grade — but it is **Magritte data-connection ingestion**. The worker entrypoint dispatches only `snapshot`/`append`/`cdc` strategies (`src/workers/foundry-worker/entrypoint.ts:63-100`); what a "build" actually does is open a `pg.Client` to a *source database*, run `SELECT * FROM schema.table`, stream to Parquet, and commit an Iceberg snapshot (`src/workers/foundry-worker/strategies/snapshot.ts:55-117`). The **only** caller of `dispatchBuild` in the entire backend is the data-connection imports handler (`src/services/connectivity/imports/handlers.ts:663-677`) — no code-repository or transform path ever dispatches a build. The `JobSpec` the executor consumes carries `importRid`/`connectionRid`/`egress`/`workloadJwt` and a connector payload — **there is no `repoRid`, no transform alias, no `Output` dataset target** (`src/services/orchestration/runners/runtime-adapter.ts:14-38`). Orchestration isn't even a router (which is why `server.ts` has no mount for it); it is an in-process lazily-initialised singleton queue (`src/services/orchestration/queue/build-dispatcher.ts:247-269`), and its success path registers a *synced ingestion* dataset, not a transform output (`build-dispatcher.ts:181-214`). All 1374 builds confirm this: every `import_rid=ri.magritte.main.extract.*`. Blast radius: even if discovery and job_spec emission were fixed, there is no executor that would clone a repo, run Python, read input datasets, and write an output — the impressive engine is the wrong engine.

### F3 — The transform-shaped subsystems that *do* exist are dead code or belong to other products. **Caps: job_spec emission, Lineage/DAG, CI/Checks.**
- **`job_spec` (B7)**: the schema is correctly transform-shaped (`src/migrations/057_b7_jobspec.sql:7-26`, PK `(output_dataset_rid, branch)` → `JobSpec:OutputAlreadyOwned`), and `publishJobSpecsTx` is a genuinely well-built SERIALIZABLE conditional-ownership upsert (`src/services/jobSpec/store.ts:87-166`). But `createJobSpecApp` (`src/services/jobSpec/admin/app.ts:12`) is **referenced nowhere outside its own directory** — never `app.use()`'d in `server.ts` — and its only non-library caller is an integration test. `job_spec` has 0 rows because no production path can write one.
- **`dataset_lineage`**: written by exactly two paths, **neither a transform**. The Pipeline-Builder (Quiver) deploy reads `pipeline_nodes` and inserts `edge_type='pipeline_output'` (`src/services/deploymentService.ts:1497-1534`); the funnel/data-connection trigger inserts `edge_type='funnel_input'` (`src/migrations/029_funnel_input_lineage_trigger.sql:57-79`). The `edge_type` CHECK enum is `('pipeline_output','funnel_input','virtual_table')` and **both endpoints FK to `foundry_datasets(id)`** (`src/migrations/024_dataset_lineage.sql:16-35`) — there is **no `transform_output` edge type, and the transform-output `dataset` table isn't even in the lineage graph's identifier space**. Worse, `job_spec` uses `ri.foundry.*` RIDs while `dataset_lineage` keys on `foundry_datasets(id)` UUIDs — a disjoint identifier space, so transform job-specs could not become lineage edges even if they were published.
- **CI/Checks (Jemma)**: a real run lifecycle API (`src/services/jemma/admin/routes.ts:72-260`) and scheduler skeleton (`scheduler.ts`) exist, but the router is **never mounted** (`server.ts` has no `/api/v1/jemma`), the only `WorkerAdapter` is `InMemoryWorker` whose `startPod()` executes nothing (`src/services/jemma/scheduler/inMemoryWorker.ts:22-37`), and the stage list is a hardcoded constant `STAGE_NAMES` that **never reads `ci.yml`** (`src/services/jemma/state/types.ts:37-44`). The transforms templates ship **no `ci.yml` at all**. So no gate validates any transform before any (non-existent) build.

---

## 4. What's genuinely well-engineered

Credit is due, precisely so the omissions are not mistaken for incompetence — the team clearly *can* build this; they built the neighbours instead.

- **The data-connection build engine is principal-grade.** Idempotent, race-safe terminal-state guards (`src/services/orchestration/queue/build-dispatcher.ts:143-176`); weighted-fair per-tenant FIFO admission with slot accounting keyed on `buildRid` and a self-healing `finalize()` (`src/services/orchestration/queue/single-active-build.ts`); defense-in-depth egress isolation that monkeypatches `net.Socket.connect` to DNS-resolve + CIDR-match before any user network call (`src/services/orchestration/runners/egress-allowlist.ts:44+`); a pluggable runtime with a real gVisor (`runsc`) K8s Job adapter plus a hardened `child_process` sandbox fallback — env whitelist, per-job tmpdir, `--max-old-space-size`, soft-deadline SIGKILL (`src/services/orchestration/runners/{k8s-runtime,child-process-sandbox}.ts`). This is the *right* engineering — for ingestion.
- **The `job_spec` publisher is real, not a stub.** SERIALIZABLE upsert with conditional ownership (`WHERE job_spec.repository_rid = EXCLUDED.repository_rid`), orphan-replacement DELETE, monotonic `resource_version` (`store.ts:87-166`); a frozen, status-mapped error catalog (`errors.ts:21-33`); correct white/gray/black DFS circular-dependency detection that reports the cycle path (`validation.ts:96-158`); and thorough integration tests covering publish, cross-repo collision, orphan replacement, and validation errors (`tests/integration/code-repos/job-spec/admin-routes-integration.test.ts:45-211`). Every line of it is unreachable in production.
- **The Jemma CI scheduler is a real state machine.** `insertRun` creates the QUEUED run + 5 PENDING stage rows in one tx with `23505`→constraint mapping (`runStore.ts:88-122`); single-active-run-per-`(repo,ref)` via a migration-054 partial unique index (`scheduler.ts:1-60`); a complete typed run lifecycle API with IDOR-as-404 and ETag concurrency (`admin/routes.ts:72-260`). Unmounted, worker-less.
- **The lineage service is correct.** Recursive-CTE ancestor walk to reject cycles before insert (`LINEAGE_CYCLE_DETECTED`), idempotent `ON CONFLICT DO NOTHING`, depth-bounded up/downstream traversal returning a proper `{nodes,edges}` subgraph (`src/services/pipelines/datasetLineage.ts:86-211`); sound schema (`024:16-35`). It just never sees a transform.
- **The transforms-python template is shaped right.** `transforms/example.py` is a correct Foundry `@transform`: `from transforms.api import transform, Output, Input` + `output.write_dataframe(source.dataframe())` (`src/services/templates/manifest.ts:458-466`); the `datasetRid` parameter ships a real RID-validation regex (`:447`). The ts-functions template it sits beside is genuinely Foundry-faithful (staged `ci.yml`, Gradle multi-project, `functions.json`/`resources.json`, `:56-369`).
- **The FE commit client is solid** — 40-hex `parentSha` validation, UUIDv4 Idempotency-Key, `If-Match: "<parentSha>"` (`lib/codeRepositoriesApi.ts:419-458`); the run-polling UX (2s while non-terminal, 5s only with in-flight runs) is clean (`app/code-repositories/repo/[rid]/runs/...`); `lib/templatesApi.ts:85-90` would surface transforms correctly *if any create surface used it*.

---

## 5. Scorecard

| Dimension | Score | Shape / Subst | One-line justification (file:line) |
|---|---|---|---|
| **Authoring (`@transform` parsing/templates)** | **3/10** | 55 / 10 | Scaffold renders a real `@transform` (`manifest.ts:458-466`) and the catalog serves transforms-python/java/sql, but no decorator parsing exists and the FE create wizard never offers a transforms template (`app/code-repositories/new/page.tsx:75-88`). Java is an annotation-less placeholder (`manifest.ts:492-507`); SQL is `SELECT 1` (`:531-536`). |
| **Transform discovery / registry** | **1/10** | 15 / 0 | The only discovery is `FN_RE` (`routes.ts:1602`), `.ts`/`src/functions`-only; throws `NoFunctionsToPublish` for any transform (`:1610-1612`, reproduced live). No `@transform` parser, no transform registry. |
| **Build / Job execution** | **1/10** | 20 / 0 | The 1374-build engine is a Magritte ingestion worker (`workers/foundry-worker/strategies/snapshot.ts:55-117`); the sole `dispatchBuild` caller is data-connection imports (`connectivity/imports/handlers.ts:663-677`); the JobSpec is import-shaped, not transform-shaped (`runtime-adapter.ts:14-38`). No path from a commit to execution. |
| **Dataset materialization** | **1/10** | 30 / 0 | The transform-output `dataset` table is written only by manual multipart upload + a seed (`routes/datasets.ts:252-267`); no transform/build/orchestration/jobSpec path writes it. `dataset`/`dataset_transaction` = 0 rows. |
| **Lineage / DAG** | **1/10** | 22 / 2 | `dataset_lineage` written only by Pipeline-Builder deploy (`deploymentService.ts:1497-1534`, `pipeline_output`) and the funnel trigger (`029:57-79`, `funnel_input`); `edge_type` CHECK has no transform value and FKs to `foundry_datasets`, a disjoint ID space from job_spec RIDs (`024:16-35`). 0 edges. |
| **Incremental semantics** | **1/10** | 8 / 0 | No `@incremental` in the template or anywhere in `codeRepository`/`templates`; the `view:snapshot|incremental` enum lives only in the dead jobSpec validator (`jobSpec/validation.ts:13,74`). Real incremental/append delta logic is data-connection ingestion (`strategies/append.ts:84-145`), and `funnel_dataset.write_mode` is an Iceberg property — neither is transform write-semantics. |
| **CI / Checks gate** | **1.5/10** | 55 / 3 | A well-built Jemma scheduler exists but is unmounted (`server.ts` has no `/api/v1/jemma`), runs nothing (`inMemoryWorker.ts:22-37`), never reads `ci.yml` (hardcoded `STAGE_NAMES`, `state/types.ts:37-44`), and is never triggered by commit/tag. Transforms templates ship no `ci.yml`. (Harness GAP CR-17.) |
| **`job_spec` emission** | **2/10** | 85 / 0 | Transform-shaped schema (`057:7-26`) and a genuinely well-engineered SERIALIZABLE publisher (`jobSpec/store.ts:87-166`), but `createJobSpecApp` is never mounted (`admin/app.ts:12`, no caller outside tests); 0 rows; orchestration consumes a different JobSpec. Credit for shape/tests only. |
| **Frontend (author/preview/build/inspect)** | **2/10** | 35 / 5 | No transforms card in the create wizard (`new/page.tsx:75-88`); the only build/runs viewer calls the unmounted `/api/v1/jemma` (`lib/jemmaApi.ts:94-153`); dataset "Build" + "Explore data lineage" are decorative no-ops (`app/dataset/[datasetRid]/page.tsx:289,442`); the only lineage UI is ontology object-type lineage, not dataset lineage (`app/object-explorer/lineage/page.tsx:5-9`). The working IDE Run/Publish targets the **Functions** model. |

**Closing assessment.** This is not a half-built transforms feature; it is a **fully-built data-connection/ingestion product plus a faithful Functions product, with a transforms *template* dropped into the Functions repo flow and nothing behind it.** The honest label is: Authoring scaffold present; everything from discovery to lineage absent or disconnected. The good news — and it is real — is that the four hardest pieces (a hardened build engine, an immutable job_spec store, a CI state machine, a cycle-checked lineage service) already exist at high quality; they were simply built for ingestion and pipeline-builder and never wired to `@transform`. The path to parity is mostly *connection and one new executor strategy*, not greenfield.

---

## 6. Clone plan — "what it would take me"

Ordered, codebase-grounded. **Track 1 = make the loop exist and be correct** (without these, no transform can execute or materialize). **Track 2 = close-parity fidelity** (once the loop runs). Effort: S ≈ ≤1 day, M ≈ 2–4 days, L ≈ ≥1 week.

### Track 1 — Make a `@transform` discoverable, buildable, and materialized
1. **Transform discovery + decorator parser. (L)** Add a `TRANSFORM_RE` matching `transforms/**/*.py` (and `src/**/*.py`) and an AST/robust-regex parser that extracts `@transform`/`@transform_df`/`@transform_pandas`/`@incremental` plus the `Output(...)`/`Input(...)` RIDs. *Files:* `src/services/codeRepository/admin/routes.ts:1602-1612` (branch discovery on the repo's template **category** — `transforms` vs `functions` — instead of falling through to `NoFunctionsToPublish`). *Doc:* Create transforms → "transforms are discovered from committed code." *Dep:* none. **This is the line the negative test proves is the gate.**
2. **Emit a `job_spec` per discovered transform, and mount the publisher. (M)** Wire the tag/release (and/or commit) path to call `publishJobSpecs` with discovered `{outputDatasetRid, inputs[], sourcePath, entryPoint, parameters, view}`, and `app.use()` the existing dead router. *Files:* `src/services/codeRepository/admin/routes.ts:1565` (tags) → `src/services/jobSpec/store.ts:87-166`; `src/server.ts` (mount `createJobSpecApp` from `src/services/jobSpec/admin/app.ts:12` under `/api/v1/code-repositories`). *Doc:* job_spec artifact. *Dep:* #1. **The store, schema, validation, and tests already exist — this is a wiring task.**
3. **A transform-shaped JobSpec contract. (M)** Add a JobSpec variant carrying `repoRid`, `commitSha`/`branch`, transform alias, `inputs[]`, and output dataset RID, distinct from the import-shaped one. *Files:* `src/services/orchestration/runners/runtime-adapter.ts:14-38`. *Doc:* Builds execute a transform. *Dep:* #2.
4. **A transform runner strategy. (L)** Parallel to `snapshot.ts`: clone the repo at the committed ref, provision a Python (or TS) runtime, read INPUT datasets, execute the `@transform`, write the OUTPUT. Reuse the existing gVisor/child-process sandbox. *Files:* new `src/workers/foundry-worker/strategies/transform.ts`; dispatch in `src/workers/foundry-worker/entrypoint.ts:63-100`; reuse `src/services/orchestration/runners/{k8s-runtime,child-process-sandbox}.ts`. *Doc:* the build that executes a transform. *Dep:* #3.
5. **A dispatch path from commit/tag → `dispatchBuild`. (L)** Today the only caller is `connectivity/imports/handlers.ts:663-677`; add a code-repo path that, after #1–#2, enqueues a transform build. *Files:* `src/services/codeRepository/admin/routes.ts` → `src/services/orchestration/queue/build-dispatcher.ts`. *Doc:* commit → build. *Dep:* #1–#4.
6. **Materialize the OUTPUT dataset. (L)** On transform-build success, write the `dataset` table + a committed `dataset_transaction` (SNAPSHOT), instead of registering a *synced* ingestion dataset. *Files:* `src/services/orchestration/queue/build-dispatcher.ts:181-214`; `src/routes/datasets.ts:737-1009` (reuse the existing transaction machinery); `src/services/datasets/synced-dataset-registry.ts:97-137` (do **not** route transform output here). *Doc:* materialized output dataset. *Dep:* #4.
7. **Emit input→output lineage, and bridge the identifier space. (L)** On success, insert `(outputDataset → each input, edge_type='transform_output')` and add that value to the CHECK enum; resolve job_spec `ri.foundry.*` RIDs to real `foundry_datasets(id)` rows (create-or-get) so the lineage FK holds. *Files:* `src/migrations/024_dataset_lineage.sql:16-35` (new migration adding `transform_output`); `src/services/pipelines/datasetLineage.ts:86` (`insertEdge`); a RID↔UUID resolver near `src/services/jobSpec/store.ts`. *Doc:* dataset lineage. *Dep:* #6.
8. **FE: make a transforms repo creatable. (M)** Add a Transforms card group and `CARD_TO_TEMPLATE_ID` entries so the wizard POSTs `templateId=transforms-python|java|sql`; render the `datasetRid` param via the existing manifest-driven form. *Files:* `app/code-repositories/new/page.tsx:75-88`. *Doc:* template picker offers transforms. *Dep:* none (can land first). **Without this, the feature is unreachable from the product even after the backend works.**

### Track 2 — Close-parity fidelity
9. **`@incremental` semantics. (L)** Parse `@incremental`, set `InputSpec.view='incremental'` in the job_spec, and have the runner choose SNAPSHOT (full replace) vs APPEND/UPDATE (added+modified since last output snapshot), writing the correct `dataset_transaction.transaction_type`. *Files:* parser from #1; `src/services/jobSpec/{store,validation}.ts`; `transform.ts` runner from #4. *Doc:* incremental computation. *Dep:* Track 1.
10. **A real CI gate that reads `ci.yml`. (L)** Implement a `WorkerAdapter` that clones at `commitSha`, parses `ci.yml` stages (not the hardcoded `STAGE_NAMES`), executes them, and feeds events into `transition()`; mount the Jemma router; trigger a run from commit/tag and **block** build/publish until required checks pass. *Files:* `src/services/jemma/scheduler/inMemoryWorker.ts:22-37` (replace stub); `src/services/jemma/state/types.ts:37-44` (parse stages); `src/server.ts` (mount `/api/v1/jemma`); gate in `src/services/codeRepository/admin/routes.ts:1565`. *Doc:* CI checks gate. *Dep:* #1.
11. **Ship `ci.yml` + enrich the transforms templates. (M)** Add `ci.yml` (lint/test/build/register-transforms), `@transform_df`/`@incremental` examples, `pyproject.toml`, `transforms/__init__.py`, and a real `repoSettings.json` (branchProtection + semver `tagNameValidation`) to transforms-python; give transforms-java an actual `@Transform`-annotated class + dependency. *Files:* `src/services/templates/manifest.ts:453-536`. *Doc:* template fidelity. *Dep:* none.
12. **FE build/lineage surfaces. (L)** A `transformsApi` client + an IDE "Build/Run transform" panel calling the mounted build route; wire the decorative dataset "Build"/"Explore data lineage" + toolbar "Builds"/"Data lineage" controls to real data; a dataset-lineage graph viewer driven by `dataset_lineage`; repoint `lib/jemmaApi.ts:94-153` at a mounted route. *Files:* `app/code-repositories/repo/[rid]/page.tsx:2360,2632`; `app/dataset/[datasetRid]/page.tsx:289,442`; new `lib/transformsApi.ts`. *Doc:* author/preview/build/inspect. *Dep:* Track 1, #10.
13. **Transform parity-harness checks. (S)** Add TR-n checks to `scripts/foundry-parity/verify-foundry-parity.sh` (create transforms repo → commit @transform → build → assert `dataset`/`dataset_lineage`/`job_spec` rows) so the loop is regression-guarded — it is exercised by **zero** checks today. *Files:* the harness. *Dep:* Track 1.

---

## 7. Artifacts & framing corrections

**Written:** this file — `tellus/docs/foundry-parity/PRINCIPAL_REVIEW_CREATE_TRANSFORMS.md`.

**Framing corrections the original ask invites (important for not over-crediting parity):**

1. **"Create transforms" is conflated with three other products that *do* work in this codebase. None of them is the Python `@transform` model.**
   - **Data Connection / Magritte ingestion** is what actually builds and materializes datasets in the live system: `connectivity/imports` → the `orchestration/` engine → `foundry-worker` snapshot/append/cdc → `funnel_dataset` Iceberg tables, with `edge_type='funnel_input'` lineage. This is the 1374 builds and the only `dataset_transaction`/incremental activity. **Do not credit it to Create transforms.**
   - **Pipeline Builder (Quiver)** is a *visual DAG* product: `pipeline_nodes` → `deploymentService.materializeForDeploy` → `transformService.ts` → `edge_type='pipeline_output'` lineage. Note the name collision: `src/services/transformService.ts` is the **Pipeline-Builder's**, not the Code-Repos `@transform` service. This is the only place real topological build ordering exists — for a different product.
   - **File-browser datasets** (`foundry_datasets`, 140 uploaded files) and the manual-upload `dataset` table are the third. The transform-output `dataset` table is written *only* by multipart upload.
   The Code-Repositories **Python `@transform` → output dataset** feature — the actual review target — overlaps with all three only in vocabulary.

2. **The harness's 29 PASS / 0 FAIL / 4 GAP must not be read as transform coverage.** It exercises Code-Repos chrome and TS Functions. The transform loop has zero checks; its failure mode (`NoFunctionsToPublish`, no materialization) is invisible to the harness.

3. **The presence of a transform-shaped `job_spec` table + a B7 publisher is evidence of intent, not delivery.** The schema is correct and the publisher is well-built, but the router is unmounted and the table has 0 rows. A reader scanning migrations could mistake "the table exists" for "transforms emit job_specs"; the e2e loop and the negative test both show they do not.

4. **The transforms-java/sql templates are weaker than the ask implies.** transforms-java ships an annotation-less placeholder class + a one-line `build.gradle` (`manifest.ts:492-507`); transforms-sql ships `SELECT 1` (`:531-536`). Only transforms-python renders a real `@transform`.
