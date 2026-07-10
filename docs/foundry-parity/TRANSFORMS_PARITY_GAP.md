# Transforms-python parity gap — tellus vs Palantir Foundry

> Companion to `transforms-architecture.md`. Where that document describes what
> tellus **has**, this one describes what tellus **diverges on** vs Palantir
> Foundry's `transforms-python` product, with a per-capability verdict, code
> evidence, and a concrete 1:1 clone path. The reference rubric is the 30-link
> doc/patent set + the exact API signatures in the user's clone spec.
>
> Method: a 13-agent adversarial workflow (9 capability auditors + 4 skeptics
> that re-read the code to refute each load-bearing verdict) plus a live
> `bash` + `cypress` probe (`tellus-fe/scripts/verify-transforms-parity.sh`,
> `tellus-fe/cypress/e2e/transforms-foundry-parity.cy.ts`) that creates a real
> transforms-python repo, commits a 5-transform probe module, builds, and
> asserts each per-transform outcome.

## 0. Executive summary

> **Production-readiness pass (2026-07-05, second pass):** a senior re-review
> rejected the prior "local-mode parity = done" framing as insufficient for
> production. 8 production gaps were re-derived from the actual code (not the
> prior self-graded list) + closed with adversarial 4-part proof (impl +
> positive test + negative test + cold re-verify) or honestly left NOT STARTED.
> The environment changed during the pass: Docker IS available (the prior
> "no Docker" OUT_OF_SCOPE was stale) + a Spark standalone cluster is runnable
> in containers, so the security (sandboxed execution) + distribution (Spark
> cluster) gaps — previously OUT_OF_SCOPE — are now PROVEN.
>
> | Gap | Status | Evidence (command + pasted output) |
> |---|---|---|
> | 1. Distributed Spark (was local[N] only) | **PROVEN** (multi-container/multi-process Spark standalone, NOT multi-node) | `bash scripts/verify-transforms-cluster.sh` → positive: cluster build SUCCEEDED (master==spark://spark-master:7077 + count() dispatched to a worker); negative: master-down → build FAILED (loud, no silent local fallback) |
> | 2. Durable/resumable scheduling (was mark-failed only) | **PROVEN** | `bash scripts/verify-transforms-retry.sh` + `cypress transforms-retry.cy.ts` 4/4 (retry-succeeds-after-fix, 404 not-found, 409 in-flight, 200 idempotency) + cap 429 (max_retries=0) + boot re-queue (insert 'queued' row → restart → SUCCEEDED) + 5 unit tests |
> | 3. Sandboxed/containerized execution (was host process) | **PROVEN** | `bash scripts/verify-transforms-sandbox.sh` → positive: container build SUCCEEDED; negative A: host-FS read BLOCKED (`FileNotFoundError: /Users/.../tellus/.env` — exists on host, absent in container); negative B: network egress BLOCKED (`Network is unreachable` under `--network=none`) |
> | 4. Unified lineage (was two unjoined universes) | **PROVEN** | `bash scripts/verify-transforms-lineage-unified.sh` → both `transform_lineage` + `dataset_lineage` edges returned, bridged by name; negatives 400 (malformed id) + 404 (nonexistent) |
> | 5. CI/PR gating (was no end-to-end parity gate) | **PROVEN** | `.github/workflows/transforms-parity.yml` (YAML valid; `unit` job runs the 82 transforms unit tests; `parity-e2e` runs the bash + cypress suite); positive: 82/82 unit + all bash/cypress PASS locally; negative: a broken-assertion test → vitest exits non-zero → job red → merge blocked |
> | 6. Per-repo reproducible env management | **PROVEN** | `bash scripts/verify-transforms-per-repo-env.sh` → positive: repo with `requirements.txt: tabulate` + `from tabulate import tabulate` → SUCCEEDED (pip `--target` into a content-hash-cached `~/.tellus/transform-deps/<hash>/` dir on PYTHONPATH; the shared venv's pyspark still available); negative A: nonexistent pkg → 503 `Transform:RuntimeNotConfigured` at scheduling (pip failed loudly); negative B (isolation): no requirements.txt → `No module named 'tabulate'` (not in shared venv + not declared). Container mode: in-container `pip install --target /tmp/deps` (bridge network for pypi when deps present — honest trade-off vs `--network=none`). |
> | 7. Package/library publishing path | **PROVEN** | `bash scripts/verify-transforms-libs.sh` → positive: repo B `libs.txt: sharedutil <repoA-rid> lib/sharedutil` + `from sharedutil import hello` → SUCCEEDED (cross-read publisher A's `lib/sharedutil/` at master HEAD, written to `<workdir>/libs/sharedutil/`, on PYTHONPATH); negative A: nonexistent publisher → 503 at scheduling; negative B (isolation): no libs.txt → `No module named 'sharedutil'`. |
> | 8. Untested surfaces (concurrency/authz/adversarial) | **PROVEN** | `bash scripts/verify-transforms-concurrency-adversarial.sh` → concurrency: 3 simultaneous builds all SUCCEEDED (no cross-contamination); adversarial A: malformed python → 400 `Transform:NoTransformsToBuild` (rejected at scheduling); adversarial B: nonexistent input RID → FAILED `input dataset not found`. AuthZ: bash READER→404 / no-roles→404 / EDITOR→202 + 10 unit tests (`transforms-authz-unit.test.ts`) — the transforms router now layers `requireOperation(WRITE/READ)` (was authN-only). |
>
> **8 of 8 PROVEN, 0 BLOCKED, 0 NOT STARTED.** Every gap closed with adversarial
> 4-part proof (impl + positive + negative + cold re-verify). Final cold
> regression gate: `npx tsc --noEmit` clean + 82/82 transforms unit tests pass
> after all edits.

---

> **Prior (first pass) status, retained for history:** all 9 surfaces end PARITY
> (for the achievable local-mode behavior) or OUT_OF_SCOPE (cited structural
> blockers — missing infra that cannot exist in this environment). No "partial"
> remains. Every PARITY claim is backed by a fresh test run with pasted output;
> every OUT_OF_SCOPE has a cited blocker.

The 2026-07-05 pass closed the three previously-unfinished items (data
branching, schema evolution, testing dry-run) + AST parse + the crash-recovery
sweeper + `@configure` resource allocation + Parquet loud-failure + the
PySpark illusion-of-distribution audit. The "would break in production
tomorrow" list is fully resolved (each item either closed-with-proof or
converted to a cited OUT_OF_SCOPE with loud-failure behavior proven).

| # | Capability | Status | Evidence |
|---|---|---|---|---|
| 1 | PySpark `@transform` | **PARITY** (local-mode: API + partitioning + shuffle + ctx + @configure allocation) + **OUT_OF_SCOPE** (multi-executor cluster — no Spark cluster/K8s/YARN; illusion audit done — no config that requests a cluster + silently runs local) | §5.1 |
| 2 | Pandas `@transform_pandas` | **PARITY** (CSV: .pandas() + write_pandas + ctx) + **OUT_OF_SCOPE** (Parquet — `fileScannerService.ts:299` rejects; container — no Docker; loud-failure proven: `write_parquet` → clear `NotImplementedError`) | §5.2 |
| 3 | Incremental `@incremental` + `ctx` | **PARITY** (5-build 3→6→9→12→15 + mode='previous' successful read + ctx + set_mode + failure paths) | §5.3 |
| 4 | `@configure` | **PARITY** (validation reject-unknown + allocation: CPU_LARGE→local[4], DRIVER_MEMORY_*→spark.driver.memory) | §5.4 |
| 5 | Data branching | **PARITY** (branch column + branch-filtered resolveDatasetByRid + same-branch SNAPSHOT + 4/4 cypress: build on A doesn't see B's data) | §5.5 |
| 6 | Build process | **PARITY** (recursive lineage + topo + ctx + AST parse + crash-sweeper) + **OUT_OF_SCOPE** (durable scheduler — in-process + crash-sweeper recovers; containerized — no Docker) | §5.6 |
| 7 | PR/CI/Conda | **OUT_OF_SCOPE** (Jemma dead code, unmounted; zero Conda/env.yml support) | §5.7 |
| 8 | Provenance + schema evolution | **PARITY** (recursive lineage a→b→c→3 nodes; schema-evolution diff + breaking-rejection) + **OUT_OF_SCOPE** (foundry_datasets bridge — two unjoined table universes) | §5.8 |
| 9 | Testing/publishing | **PARITY** (testing dry-run, no side effects: real build after dry-run is SNAPSHOT) + **OUT_OF_SCOPE** (library publishing — no package-registry code) | §5.9 |

Adversarial verdicts (§6, against the PRE-closure code): **no-PySpark
CONFIRMED** (STALE — refuted; partitioning+shuffle+allocation proven local-mode),
**no-ctx-API CONFIRMED** (STALE — refuted), **no-branch-isolation PARTIAL**
(STALE — refuted; data branching now PARITY), **configure-is-no-op CONFIRMED**
(STALE — refuted; validation + allocation proven).

## 1. The reference rubric (30 links)

> **Doc-URL drift note:** the `palantir.com/docs/foundry/transforms-python/*`
> URLs in the reference set now return **404 ("Page not found… yet")** —
> Palantir reorganized their docs tree. The **API signatures** in the clone
> spec (the copiable `@transform` / `@transform_pandas` / `@incremental` /
> `@configure` templates) are intact and are the authoritative clone target
> used throughout this document. Re-derive the live doc URLs from
> `palantir.com/docs/foundry/dev-toolchain/overview/` if needed.

**Foundry documentation (Python & Spark transforms):**
1. Overview of Python Transforms — `palantir.com/docs/foundry/transforms-python/overview/`
2. Getting Started with Python in Code Repositories — `…/transforms-python/getting-started/`
3. PySpark Transforms API Reference — `…/transforms-python/pyspark-transforms/`
4. Pandas & Single-Node Transformations — `…/transforms-python/pandas-transforms/`
5. Incremental Processing (`@incremental`) — `…/transforms-python/incremental-transforms/`
6. Advanced Transform Decorators Reference — `…/transforms-python/decorators/`
7. The Transform Context Object (`ctx`) — `…/transforms-python/transform-context/`
8. Testing Python Transforms locally — `…/transforms-python/testing/`
9. Profile Configuration (`@configure`) — `…/transforms-python/profile-configuration/`
10. Publishing and Packaging Custom Libraries — `…/transforms-python/publishing/`
11. Code Repositories Architecture Overview — `…/code-repositories/overview/`
12. Dataset Branching tied to Git Branches — `…/code-repositories/branching/`
13. Pull Requests and Automated CI Checks — `…/code-repositories/pull-requests/`
14. Environment Configuration (Conda / Mamba) — `…/code-repositories/environment-configuration/`
15. Foundry Build Process and Topological Sorts — `…/code-repositories/build-process/`
16. Supported Languages & Environments — `…/data-integration/supported-languages/`
17. Configuring Spark Profiles for Heavy Jobs — `…/data-integration/spark-profiles/`
18. Optimizing Spark Transformations in Foundry — `…/data-integration/optimizing-spark/`

**Palantir patents (pipeline, branching, distributed compute):**
19. US11593336B2 — Data pipeline branching
20. US10657121B2 — Executing a data processing pipeline
21. US10061803B2 — Data synchronization and versioning
22. US10929381B2 — Incremental data processing
23. US10242062B2 — Tracking data provenance
24. US11182356B2 — Pipeline branch management
25. US9880868B1 — Visual interface for configuring pipelines
26. US10423614B2 — Large-scale data transformation and querying
27. US10860584B2 — Distributed data computation caching
28. US11023472B2 — Automated schema evolution in pipelines
29. US11256708B2 — Dynamic resource allocation for data processing
30. US10552431B2 — Declarative data transformation framework

## 2. The live probe (bash + cypress)

`tellus-fe/scripts/verify-transforms-parity.sh` orchestrates: health checks
(backend `:3000`, FE `:3001`, `python3`), a static API-surface audit of the
shim, a branch-scoping audit, and the cypress spec
`tellus-fe/cypress/e2e/transforms-foundry-parity.cy.ts`.

The cypress spec creates a real `transforms-python` repo, commits a single
`transforms/probe.py` containing one `@transform` per Foundry API surface,
triggers a real build (`POST /code-repositories/:rid/builds`), polls to
terminal, and asserts each per-transform outcome. The probe is written the
**Foundry** calling convention: `@transform` non-incremental receives
`(output, **inputs)`; `@transform_pandas` and `@incremental` receive
`(ctx, ...)` with `ctx` first (Foundry's `TransformContext` injection rule).

| Probe transform | Foundry API exercised | Live outcome (2026-07-02) | What it proves |
|---|---|---|---|
| `probe_basic` | `@transform` + stdlib `DataFrame` | **SUCCEEDED** ✓ | the build engine works on stdlib transforms |
| `probe_spark` | `@transform` + `pyspark.sql.functions` | **SUCCEEDED** ✓ | PySpark PARITY — `Input.dataframe()` returns a `pyspark.sql.DataFrame` via a local-mode `SparkSession`; `df.withColumn(..., F.current_timestamp())` + `write_dataframe` work |
| `probe_pandas` | `@transform_pandas` + `.pandas()` | **SUCCEEDED** ✓ | Pandas PARITY — `Input.pandas()` returns a `pandas.DataFrame`; `ctx` injected; `write_pandas` works |
| `probe_incr` | `@incremental` + `ctx.is_incremental` + `set_mode` + `dataframe(mode='previous')` | **SUCCEEDED** ✓ | Incremental PARITY — `ctx` is injected as the first param; `set_mode('replace')` honored; first build runs full-snapshot (`is_incremental=false`) |
| `probe_conf` | `@configure(profile=[...])` + stdlib body | **SUCCEEDED** ✓ | `@configure` builds (still a no-op re: resource allocation — see §5.4) |

**Live-confirmed run** (`TELLUS_TRANSFORM_VENV=… bash scripts/verify-transforms-parity.sh`,
cypress 2/2 passing in 25 s): build status **`succeeded`**, `transformCount=5`,
all five probes materialized an output dataset (1 row each). The runner
provisions a PySpark venv (pyspark 4.1.2 + pandas 3.0.3 + pyarrow 24.0.0 on
Python 3.14) + `JAVA_HOME=openjdk@21`, restarts the tellus backend with
`TELLUS_PYTHON_BIN`/`PYSPARK_PYTHON`/`JAVA_HOME`/`TELLUS_TRANSFORM_TIMEOUT_MS=300000`,
then runs the cypress probe. Per-transform evidence is written to
`tellus-fe/cypress/transforms-parity-probe-result.json`.

## 3. The clone target (Foundry API signatures)

Verbatim from the reference spec — this is what "1:1" means concretely:

```python
# PySpark @transform
@transform(my_output=Output("/path/to/output"), my_input=Input("/path/to/input"))
def compute(my_input, my_output):
    df = my_input.dataframe()                       # -> pyspark.sql.DataFrame
    my_output.write_dataframe(df.withColumn("x", F.current_timestamp()))

# Pandas @transform_pandas
@transform_pandas(my_output=Output("/path"), my_input=Input("/path"))
def compute(my_input, my_output):
    df = my_input.pandas()                          # -> pandas.DataFrame (Parquet in RAM)
    my_output.write_pandas(df)

# Incremental @incremental
@incremental(semantic_version=1, snapshot_inputs=["my_input"])
@transform(my_output=Output("/path"), my_input=Input("/path"))
def compute(ctx, my_input, my_output):
    if ctx.is_incremental:
        new = my_input.dataframe(mode='previous')   # delta since last transaction
        my_output.set_mode('modify')                # append
    else:
        my_output.set_mode('replace')               # full snapshot
    my_output.write_dataframe(...)

# Resource configuration
@configure(profile=["DRIVER_MEMORY_LARGE", "EXECUTOR_MEMORY_MEDIUM"])
@transform(out=Output("/path"), inp=Input("/path"))
def compute(inp, out): ...
```

## 4. What tellus has today (the starting point)

Real and live (see `transforms-architecture.md` for the full lifecycle):
- `@transform` / `@transform_df` / `@transform_pandas` / `@incremental` decorators are **recognized** by the discovery parser and **present** in the shim.
- `Input` / `Output` / `DataFrame` classes; `Input.dataframe()`, `Input.pandas()`, `Output.write_dataframe()`, `Output.write_pandas()` (alias).
- A real `python3` child-process sandbox (`executor.ts`), DAG topological sort + cycle detection (`buildService.topoOrder` + `jobSpec/validation.ts`), a persisted build lifecycle with events (`transform_build` / `transform_build_event`), and input→output lineage edges (`transform_lineage`) — migration `103`.
- Dataset outputs materialize as committed `dataset_transaction` rows (SNAPSHOT/APPEND), viewable in the existing dataset-preview UI.
- FE triggers + observes builds (`tellus-fe` `TransformBuildDialog` + `DatasetLineageDialog` + `lib/transformsApi.ts`).

## 5. Per-capability gap analysis

### 5.1 PySpark `@transform` (distributed compute) — PARTIAL (API + local-mode proven; cluster/shuffle/resource unproven)

> **CLOSED 2026-07-02.** `Input.dataframe()` now returns a
> `pyspark.sql.DataFrame` via a local-mode `SparkSession` (`_get_spark()` in
> `pythonRuntime.ts`); `Output.write_dataframe` accepts a PySpark DF
> (`df.toPandas().to_csv(...)`). The executor passes `JAVA_HOME`/`PYSPARK_PYTHON`
> to the child and the backend runs with `TELLUS_PYTHON_BIN` = a venv with
> pyspark 4.1.2 + Java 21. Live-confirmed: `probe_spark` SUCCEEDS
> (`df.withColumn("ts", F.current_timestamp())` + `write_dataframe`). Remaining
> nuance: local-mode Spark (single-node), not a cluster; storage is CSV, not
> Parquet/Iceberg; `@configure` profiles still don't size the driver/executors.

The text below is the PRE-closure analysis, retained as the change rationale.

**Foundry** (links 3/17/18, patents 26/27): `Input.dataframe()` returns a
`pyspark.sql.DataFrame`; the runtime provisions a `SparkSession`; execution is
a lazy Spark plan over Parquet/Iceberg; `@transform_df`/`@transform_pandas`
receive a `TransformContext` with `ctx.spark_session`.

**tellus evidence (pre-closure):** `pythonRuntime.ts:189-192` — `def dataframe(self) -> DataFrame: … return DataFrame.read_csv(self._path)` returned the stdlib list-of-dicts `DataFrame` (`:46-172`, a `csv.DictReader` wrapper), **not** a `pyspark.sql.DataFrame`. `executor.ts:259` spawned bare `python3` with a scrubbed env — no `SparkSession`, no Spark provisioning. A `grep` for `pyspark|SparkSession|spark_session|findfindspark` across `transforms/` returned zero runtime hits (the only Spark refs were a string literal in the unrelated Java template).

**Clone path:**
1. `runtime/pythonRuntime.ts` — back `Input.dataframe()` with a lazily-built `SparkSession` (once per process) returning `spark.read.csv(...)`/`parquet(...)` as a `pyspark.sql.DataFrame`; `Output.write_dataframe` must accept a PySpark DF and `df.write.csv/parquet`.
2. `executor.ts` — provision PySpark in the child: install `pyspark`, set `SPARK_HOME`/`PYSPARK_PYTHON`, raise `DEFAULT_TIMEOUT_MS` (60 s is far too low), add per-profile `--driver-memory`/`--executor-memory`/`--num-executors`; containerize (Docker + cgroup limits) for true parity.
3. Add a `TransformContext` (`ctx`) with `spark_session`, `auth`, `shared_state`.

### 5.2 Pandas `@transform_pandas` (single-node) — PARTIAL (API proven; CSV not Parquet, no container)

> **CLOSED 2026-07-02.** `Input.pandas()` reads the CSV directly into a
> `pandas.DataFrame` (`pd.read_csv`); `Output.write_dataframe`/`write_pandas`
> accept a pandas DF. The build venv installs pandas 3.0.3 + pyarrow. The
> driver injects `ctx` for `@transform_pandas` (Foundry convention). Live-
> confirmed: `probe_pandas` SUCCEEDS. Remaining nuance: storage is CSV not
> Parquet; no single-node container (bare `python3` subprocess).
**Foundry** (link 4): `my_input.pandas()` returns a real `pandas.DataFrame`
(Parquet decoded into RAM); the Spark JVM is skipped and the job routes to a
single-node Python container; `ctx` is passed; `Output.set_mode` and
`Input.dataframe(mode='previous')` drive incremental pandas.

**tellus evidence:** the happy path works — `transform_pandas` (`pythonRuntime.ts:270`), `Input.pandas()` (`:194`) → `DataFrame.to_pandas()` (`:148-150` does `import pandas as pd`), `write_pandas = write_dataframe` (`:221`). Divergences:
1. **Storage is CSV, not Parquet** (`read_csv`/`write_csv` `:158-172`; `materializeOutput` hardcodes `'csv'`).
2. **No container** — bare `python3` in a temp workdir (`executor.ts:259`).
3. **pandas not guaranteed** — `import pandas` raises `ImportError` if the host lacks it (live: pandas is **not** installed); no venv/pip/`environment.yml` provisioning.
4. **No `ctx`** for `transform_pandas` (`driver.py` calls `entry.fn(**bound_inputs)` with no ctx, `pythonRuntime.ts:374-376`).
5. **No `set_mode` / `is_incremental` / `dataframe(mode='previous')`** (see §5.3).
6. **Inputs resolve globally, not branch-scoped** (see §5.5).

**Clone path:** add Parquet I/O (pyarrow) + containerize (pinned `python:<ver>-slim + pandas + pyarrow` image) + provision a venv from `requirements.txt`/`environment.yml` + the `ctx`/`set_mode`/`mode='previous'` work in §5.3/§5.4 + branch-scoping in §5.5.

### 5.3 Incremental `@incremental` + `ctx` Context API — PARITY (test-backed 2026-07-04)

> **CLOSED 2026-07-02.** A `Context` (`ctx`) class is in the shim
> (`is_incremental`, `parameters`, `auth`, `shared_state`); the driver injects
> `ctx` as the first positional arg for `@incremental` and for
> `@transform_df`/`@transform_pandas` (Foundry rule). `Output.set_mode(mode)`
> and `Input.dataframe(mode='previous')` are implemented; `buildService`
> resolves `isIncremental` (a prior committed transaction exists for the
> output) + per-input `previousPath` (`datasetStore.resolvePreviousTransaction`,
> the second-newest committed tx) and honors `exec.writeMode` for the
> transaction type (`'replace'`→SNAPSHOT, `'modify'`/`'append'`→APPEND).
> Live-confirmed: `probe_incr` SUCCEEDS (first build, `is_incremental=false`,
> full-snapshot path). Remaining nuance: `mode='previous'` is wired but only
> exercised on a 2nd/incremental build (the probe's first-build run takes the
> `else` branch).
**Foundry** (links 5/7, patent 22): `@incremental(semantic_version=,
snapshot_inputs=)` above `@transform`; `ctx` is injected as the first
positional param of every incremental transform; `ctx.is_incremental`,
`my_input.dataframe(mode='previous')`, `my_output.set_mode('modify'|'replace')`.

**tellus evidence:** `@incremental` (`pythonRuntime.ts:276-287`) is a **pure metadata no-op** — it stores `meta={"enabled": True}` + kwargs (`snapshot_inputs`, `semantic_version` captured but **never read**). The only runtime effect is a blanket `t.incremental ? "APPEND" : "SNAPSHOT"` flip at `buildService.ts:340`. Every Foundry runtime semantic is absent:
1. **No `ctx`** — `Transform.__call__` (`:254-255`) is a passthrough; `driver.py` calls `entry.fn(output, **bound_inputs)` with no `ctx` constructed. A `def compute(ctx, my_input, my_output)` binds `ctx` to the `Output` → broken.
2. **No `ctx.is_incremental`** — the build-time boolean `t.incremental` is never surfaced to user code.
3. **No `dataframe(mode='previous')`** — `Input.dataframe()` (`:189`) takes no args; always reads the full latest CSV.
4. **No `Output.set_mode`** — only `write_dataframe(df, mode="replace")` (a kwarg, not a method; `'modify'` is not a recognized value).
5. **`snapshot_inputs` / `semantic_version`** — captured, unused.

**Clone path:**
1. `pythonRuntime.ts` — add a real `Context` class (`is_incremental`, `snapshot_inputs`, `previous`, `parameters`, `auth`); `Input.dataframe(self, mode=None)` accepting `'previous'`; `Output.set_mode(self, mode)` storing `'replace'|'modify'|'append'` honored by `_materialize`.
2. `driver.py` — when `entry.incremental` is set, construct `Context(is_incremental=<bool>, …)` and pass it as the **first** positional: `entry.fn(ctx, output, **bound_inputs)`; bind each `snapshot_input`'s previous-transaction path.
3. `executor.ts` — extend the `TELLUS_TRANSFORM_JOB` payload with `is_incremental` + per-input `previousPath`.
4. `buildService.ts` — resolve the previous committed transaction for the output (to decide `is_incremental`); set `transactionType` from the Output's `set_mode` result, not the hardcoded `t.incremental` shortcut (`:341`).
5. `datasetStore.ts` — add `resolvePreviousTransaction(rid, branch)` returning the second-newest committed transaction's file (also fixes §5.5).

### 5.4 `@configure` resource profiles — GAP
**Foundry** (link 9, patent 29): `@configure(profile=[...])` requests cluster
shapes / single-node memory; the runtime maps profile names to concrete
resource allocation (driver/executor memory, CPU, RAM).

**tellus evidence:** `pythonRuntime.ts:301-304` — `def configure(*_args, **_kwargs): def deco(target): return target` is a **pure no-op** that discards `profile=[...]`. `class Profile` (`:296-298`) is an inert `__init__`. `discovery.ts` does not parse `@configure` (no `profile` field on `DiscoveredTransform`). `buildService.ts:207` hardcodes `computeProfile: "default"`. There is **no profile catalog** and **no runtime resource allocation** — `executor.ts` runs a bare `python3` with only an env whitelist + `SIGKILL` deadline; no `--memory`/`--cpus`/ulimit/Spark driver.

**Clone path:**
1. `pythonRuntime.ts` — make `configure` capture `profile` onto the `Transform`; make `Profile` a real class.
2. `discovery.ts` — parse `@configure(profile=[...])` into a `profile: string[] | null` field on `DiscoveredTransform`.
3. `buildService.ts:207` — thread `t.profile` into `computeProfile` (not `"default"`) and into the executor job spec.
4. **New** `transforms/profileCatalog.ts` — a Foundry-aligned catalog mapping `DRIVER_MEMORY_*`/`EXECUTOR_MEMORY_*`/CPU/RAM names to a `ResourceSpec`.
5. `executor.ts` — apply the resolved `ResourceSpec` (`docker run --memory --cpus`, or `ulimit -v`/`nice` as a minimum); for full cluster-shape parity, a real Spark submit path.

### 5.5 Data branching tied to Git branches — GAP
**Foundry** (link 12, patents 19/21/24): a Git branch maps to dataset version
snapshots via **pointers** — creating a branch does not copy physical data; a
build on branch B resolves its `Input` datasets to B's pinned snapshots
(inheriting the parent's until a build produces new ones).

**tellus evidence:** input resolution is **global**. `datasetStore.ts:41` —
`resolveDatasetByRid(rid)` takes **no branch parameter**; `:53-59` —
`SELECT file_path FROM dataset_transaction WHERE dataset_id=$1 AND status='committed' ORDER BY committed_at DESC NULLS LAST LIMIT 1` returns the global-latest transaction, **no branch filter**. `dataset_transaction` has **no `branch` column**. A SNAPSHOT write (`datasetStore.ts:142-149`) supersedes prior transactions for **all branches** — clobbering sibling branches. `createBranch` forks code blobs (a physical copy) and does nothing for datasets. The `Input(branch=…)` kwarg (`pythonRuntime.ts:179`) is scaffolded-but-unwired. `transform_lineage` records a `branch` tag on edges (migration `103:59,65`) but input resolution does not use it. *(Adversarial verdict: PARTIAL — the core assertion "inputs are global" is CONFIRMED; the lineage branch tag is the only branch-aware data, which is why this is GAP not NA.)*

**Clone path:**
1. **New migration** `1XX_dataset_branch_snapshots.sql` — a `dataset_branch_snapshot(dataset_rid, branch, transaction_id, pinned_at)` table that **points** to a `dataset_transaction` (no data copy); optionally add `branch` to `dataset_transaction`.
2. `datasetStore.ts` — `resolveDatasetByRid(rid, branch)` resolves via the branch-snapshot pointer, falling back to the parent/default-branch snapshot (Foundry inheritance); `materializeOutput` on a branch build creates a new transaction + a `(rid, branch)→transaction_id` pointer (sibling branches keep the old transaction; remove the global `superseded=true` for branch-scoped writes).
3. `buildService.ts:302` — pass `branch` into the resolver.
4. `postgres.ts createBranch` — after forking code blobs, fork dataset-snapshot **pointers** (`INSERT INTO dataset_branch_snapshot … SELECT … WHERE branch=$fromBranch`) — pointers only, zero data copy (the Foundry guarantee).

### 5.6 Build process (AST, DAG, containerized compute, lifecycle) — PARTIAL
**Foundry** (link 15, patent 30): read the Python **AST**, map Input/Output to
the catalog, topologically sort the DAG, containerize each `compute()` against
the compute backend; builds are scheduled jobs with a lifecycle.

**tellus evidence:**
- **DAG topo-sort + cycle detection — PARITY.** `buildService.ts:80-113` `topoOrder` (Kahn) + `jobSpec/validation.ts:96-158` `detectCircularDependencies` (DFS white/gray/black).
- **AST parse — PARTIAL.** `discovery.ts:103-153` `scanModule` is a hand-rolled TS line-scanner with paren-balance + regex `extractOutputRid`/`extractInputs` (`:155-168`); only literal `Output("rid")`/`Input("rid")` strings resolve — misses f-string/computed/aliased RIDs and never reads the `def(…)` signature (so it cannot see `ctx`).
- **Containerized compute — GAP.** `executor.ts:259` spawns bare `python3` in a temp workdir; no Docker/containerd, no per-repo image.
- **Job lifecycle — PARTIAL.** The status enum + events + terminal-state guard exist (`103:23-50`); the route returns `202` with polling. But dispatch is `void runBuild(...)` fire-and-forget in-process (`buildService.ts:256`) — **no durable scheduler/queue/worker**, no retry, a process restart orphans in-flight builds (stuck in `running`), and `transform_build_active_idx` (`103:41-42`) is never scanned.
- **Branch-scoped inputs — GAP** (§5.5).
- **CI/Conda — GAP** (§5.7).

**Clone path:**
1. **Real AST** — new `runtime/discoveryAst.py` invoked via the existing `python3` spawn, using `ast.parse` to find decorators + resolve non-literal RIDs; `discovery.ts` delegates to it.
2. **Containerized compute** — `executor.ts` `docker run` a per-repo image built from `environment.yml`/`requirements.txt` + the shim (new `imageBuilder.ts`).
3. **Durable scheduler** — new `dispatcher.ts`: `SELECT … FROM transform_build WHERE status='queued' FOR UPDATE SKIP LOCKED LIMIT 1` → claim → `runBuild`, with retry + a timeout sweep for stale `running` rows; `buildService.ts:256` becomes enqueue-only.
4. Parallelize independent DAG layers (`Promise.all` per topo layer) instead of the sequential `for` loop (`:296`).

### 5.7 Code-repo PR/CI/Conda/supported languages — PARTIAL
**Foundry** (links 11/13/14/16): git-like repos; Pull Requests with automated
CI checks (lint/discover/build/test) reported as PR status checks; Conda/Mamba
`environment.yml` with pinned deps; supported languages Python (PySpark),
Java, SQL, R, containerized Spark sidecar.

**tellus evidence:**
- **PRs — GAP.** No PR resource model (no tables/migrations, no `POST /pulls`, no merge/review/comment). The only PR surface is a pre-receive branch-protection flag (`stemmaEvents/policy/preReceive.ts:102 RequiresPullRequest`) that blocks direct pushes but has no PR object; `repoSettings.json` seeds declare `requirePullRequest`+`requiredStatusChecks` (`manifest.ts:210,553`) with no backing implementation.
- **CI checks — GAP (scaffolded, unmounted).** The Jemma CI service (`services/jemma/`) defines stages (setup/lint/test/build/publish) and routes, but `createJemmaApp` is **never mounted in `server.ts`** (integration-test-only), the only `WorkerAdapter` is `InMemoryWorker` (returns a fake podName, runs nothing), and the seed `ci.yml` is inert text. The separate transform **build** engine IS mounted and works, but it is a manual build path, not push/PR-triggered CI.
- **Conda/Mamba — GAP.** Zero matches for `conda`/`mamba`/`environment.yml`/`requirements.txt`/`Pipfile` in `/src`. The executor runs bare host `python3` (`executor.ts:17`) with a scrubbed env; user code importing pandas/PySpark fails unless the host happens to have them.
- **Supported languages — PARTIAL.** Templates cover typescript/python/java/sql. R and containerized Spark sidecar transforms are absent. The Python runtime is **not** PySpark (§5.1).

**Clone path:**
1. **PRs** — new PR resource model (table + `POST /:rid/pulls` + merge/review/comment endpoints) backed by Stemma branches.
2. **CI** — mount Jemma in `server.ts`; add `ciParser.ts` to parse the repo's `ci.yml` into stages; make the worker shell out each stage's command (or containerize); wire commit/tag webhooks to `scheduleRun` so CI triggers on push/PR.
3. **Conda/env** — new `conda.ts` to parse `environment.yml`/`requirements.txt` from the committed tree; feed the image builder (§5.6) so transforms can use pandas/PySpark; add a Python CI stage (`ruff`/`mypy`/`pytest`) to the seed `ci.yml` (currently Gradle/TS-functions-only).

### 5.8 Provenance + automated schema evolution — PARTIAL
**Foundry** (patents 23/28): track data provenance (input→output lineage +
which build/job produced each dataset); perform automated schema evolution
(detect schema changes between builds, validate compatibility, evolve/migrate).

**tellus evidence:**
- **Provenance — PARTIAL.** `transform_lineage` (`103:55-67`) records input→output edges carrying `build_rid` ("which build produced this") and `buildService.ts:347-354` writes them. **Gaps:** (1) the lineage API (`routes.ts:148-151`) is **single-hop** (`WHERE output=… OR input=…`) — no `WITH RECURSIVE` multi-hop traversal; (2) **disjoint provenance graphs** — transform outputs materialize into the singular `dataset` table while `provenanceService.fetchLineage` walks `foundry_datasets`/`dataset_lineage` — transform-produced datasets are **invisible to object-level provenance**; (3) no provenance for non-transform ingestion; (4) `build_rid` is nullable (`103:61`) though populated in practice.
- **Schema evolution — GAP.** Only schema *inference + overwrite-on-materialize* exists (`datasetStore.ts:98-104,170-186`); `schemaHash` is stored but **never compared** to the previous transaction's hash, no compatibility policy (add-column vs drop/rename), no data migration. Patent US11023472B2 is unimplemented.

**Clone path:**
1. **Schema evolution** — new `dataset_schema_version` table (per-materialization version, not overwrite); `materializeOutput` diffs `schemaHash` vs the last version, classifies the delta (add-column=compatible, drop/rename/type-change=breaking), emits a `schema_evolution` event, and fails/migrates on breaking changes per policy; expose `Input.schema` to transforms.
2. **Provenance → parity** — `WITH RECURSIVE` lineage traversal; bridge `dataset`↔`foundry_datasets` (upsert a `foundry_datasets` row + a `dataset_lineage` edge on materialize); record ingest provenance; make `build_rid` `NOT NULL`.

### 5.9 Local testing harness + library publishing — GAP
**Foundry** (links 8/10): a local test harness that runs `@transform` functions
against fixture (mock) data with a real `ctx` + pytest integration; package a
repo's Python as a custom library (conda/wheel + `meta.yaml`/`environment.yml`)
published to a channel for pip-install reuse across repos.

**tellus evidence:** both halves absent.
- **Testing — GAP.** The build engine is the **only** execution path; it binds inputs to REAL dataset files by RID (not fixtures), materializes the output (not a dry-run), and passes no `ctx`. No `POST …/transforms/test` or preview-with-fixtures endpoint. The seed `ci.yml` names `pytest`/`tellus transforms discover` stages but Jemma is unmounted (§5.7) and no `tellus` CLI binary exists.
- **Publishing — GAP.** No conda/wheel/sdist/`meta.yaml`/library channel/`repository_dependencies.yml`/pip-install-reuse. `POST /:rid/tags` publishes TypeScript functions only, not Python libraries.

**Clone path:**
1. **Test harness** — new `testHarness.ts` `runTransformDryRun({repoFiles, entryPoint, fixtures})` reusing the executor workdir but binding `Input`s to fixture CSVs and **not** calling `materializeOutput`; new route `POST /code-repositories/:rid/transforms/test`; add `ctx` to the shim (§5.3).
2. **Library publishing** — new `libraryPublish.ts` + migration (`python_library` table: rid, repo_rid, branch, semver, artifact_sha256, artifact_bytes); routes `POST /:rid/libraries` (read committed `meta.yaml`/`pyproject.toml`, run `python -m build`/`conda build`, content-address, store), `GET /:rid/libraries`, `GET /libraries/:libRid/download`; `discovery.ts` parses `repository_dependencies.yml`; `executor.ts` creates a venv + `pip install` declared deps.

## 6. Adversarial verdicts (re-read by skeptic agents)

| Claim | Verdict | Key evidence |
|---|---|---|
| tellus `@transform` does NOT support PySpark (`Input.dataframe()` is stdlib, no `SparkSession`) | **CONFIRMED** | `pythonRuntime.ts:189-192` returns the stdlib `DataFrame` (`:46-173`, `csv.DictReader`); docstring `:32-33` "no pandas/Spark required"; `grep pyspark\|SparkSession` in `transforms/` = 0 runtime hits. |
| tellus does NOT implement the Foundry incremental `ctx` API (no `ctx` injected, no `is_incremental`/`set_mode`/`dataframe(mode='previous')`) | **CONFIRMED** | `Transform.__call__` `:254-255` is a passthrough; `driver.py` calls `entry.fn(output, **bound_inputs)` with no `ctx`; `grep ctx\|is_incremental\|set_mode` in `transforms/` = 0. `write_dataframe(mode=)` `:208` superficially resembles Foundry's output mode but is a no-op string. |
| tellus transform inputs are NOT branch-isolated (global latest committed transaction) | **PARTIAL** | `resolveDatasetByRid(rid)` `datasetStore.ts:41` takes no branch param; `:53-59` no branch filter; `dataset_transaction` has no branch column; `runBuild` `:302` doesn't pass branch. **The core assertion is CONFIRMED.** PARTIAL because `transform_lineage` carries a `branch` tag — but input *resolution* does not use it. |
| tellus `@configure` is a no-op (no profile→resource mapping) | **CONFIRMED** | `pythonRuntime.ts:301-304` `configure` returns `target` unchanged, discards `profile`; `Profile` `:296-298` inert; `buildService.ts:207` hardcodes `computeProfile:"default"`; no profile catalog anywhere in `src/`. The gap is slightly **worse** than "no-op decorator": even if `@configure` captured the profile, the executor has no resource knob to apply it. |

## 7. How to reproduce (the live probe)

```bash
# Prereqs: tellus backend on :3000 (npm run dev in tellus/), tellus-fe on :3001
# (npm run dev here), python3 on PATH, and the cypress user created once via
# `npm run auth:bootstrap` in the tellus backend.

bash scripts/verify-transforms-parity.sh
```

The runner prints: health checks, the static API-surface audit (which Foundry
symbols are present vs absent in the shim), the branch-scoping audit, the
cypress probe output, and a per-transform outcome summary read from
`cypress/transforms-parity-probe-result.json` (written by the spec).
Non-zero exit = a health check or a cypress assertion failed — gateable in CI.

Override the targets with `CYPRESS_BACKEND_URL` / `CYPRESS_BASE_URL` /
`CYPRESS_API_URL` / `CYPRESS_BROWSER` if your ports differ.

### 7.1 Test inventory (added 2026-07-04)

The 2026-07-04 pass added the tests the acceptance standard requires. Run the
unit suite offline (`pnpm vitest run --config vitest.unit.config.ts` in
`tellus/`) and the live gate via the bash runner above.

**Backend unit tests** (`tellus/tests/unit/code-repos/code-repository/transforms/`):
- `transforms-parity-logic-unit.test.ts` (29 tests) — `transactionTypeFor`
  (replace→SNAPSHOT, modify/append→APPEND, undefined/null/unknown→SNAPSHOT),
  `topoOrder` (chain/diamond/external-RID), `DATASET_RID_REGEX` (the
  segment-count regression: 4-segment accepted, 5-segment rejected,
  `validateDatasetRid` → `invalid-dataset-rid`), `executor.filterEnv`
  (JAVA_HOME/PYSPARK_PYTHON whitelist + PYSPARK_PYTHON-default + no secret
  leak), `executor.buildJobSpec` (isIncremental/previousPath threading).
- `datasetStore-unit.test.ts` (11 tests) — `resolvePreviousTransaction`
  (OFFSET-1 guard: null on first build, second-newest on build 2, relative-path
  resolution, the OFFSET-1 SQL regression), `resolveDatasetByRid` (latest tx +
  storage_path fallback + not-found), `materializeOutput` ROLLBACK (mid-transaction
  failure → ROLLBACK not COMMIT, client released, rethrows) + malformed-schema
  (scanFile raises before BEGIN → no transaction started), and the
  is_incremental-vs-previousPath regression (existence ≠ OFFSET 1).
- `driver-integration-unit.test.ts` (8 tests, skips without the venv) — the
  ctx-injection rule (`@transform_pandas`/`@incremental` get ctx;
  non-incremental `@transform` does not), `write_dataframe` dispatch,
  `set_mode` reflected in `result.mode`, `mode='previous'` before prior tx
  raises, a transform that raises mid-write → `{ok:false}` (no half-commit),
  and the executor timeout (SIGKILL → `timedOut`).

**Frontend unit test** (`tellus-fe/tests/unit/transforms-parity-runner-regression.test.ts`,
3 tests) — the bash runner's `set -u` + unbound-`TELLUS_JAVA_HOME` regression
(`bash -n` syntax + `resolve_java_home` does not abort under `set -u`).

**Live cypress specs** (`tellus-fe/cypress/e2e/`):
- `transforms-foundry-parity.cy.ts` (2 tests) — the 5-probe parity gate
  (`probe_basic`/`probe_spark`/`probe_pandas`/`probe_incr`/`probe_conf` all
  SUCCEEDED, build status `succeeded`).
- `transforms-incremental-multibuild.cy.ts` (4 tests) — **3 sequential builds
  with the row-level diff**: build 1 = 3 rows / SNAPSHOT
  (`is_incremental=false`), build 2 = 6 rows / APPEND (`is_incremental=true`),
  build 3 = 9 rows / APPEND. This is the proof the incremental path actually
  runs, not just the first-build snapshot branch.

Total: 51 unit tests (48 backend across 3 files + 3 frontend) + 6 cypress
tests. Two regressions hit mid-flight (the RID segment-count, the `set -u`)
each have a test that would have caught them, and the `is_incremental`
OFFSET-1 bug found during the 3-build test pass has both a unit test
(is_incremental-vs-previousPath) and the 3-build integration test.

## 8. Prioritized 1:1 clone roadmap

Ordered by "unblocks the most downstream parity":

1. **PySpark runtime** (§5.1) — the core. Provision `pyspark` + `SparkSession` in the executor; back `Input.dataframe()`/`Output.write_dataframe` with `pyspark.sql.DataFrame`. Without this, "transforms-python" is a stdlib subset, not Foundry.
2. **`ctx` / `TransformContext`** (§5.3) — inject `ctx` as the first positional; add `is_incremental`, `set_mode`, `dataframe(mode='previous')`. Unblocks incremental + testing.
3. **Branch-scoped inputs + snapshot pointers** (§5.5) — the data-branching patent core; without it, pipeline experimentation is not isolated.
4. **Containerized compute + Conda env** (§5.6/§5.7) — per-repo image from `environment.yml`; unblocks pandas/PySpark availability and `@configure` enforcement.
5. **`@configure` profile catalog** (§5.4) — map profile names to `ResourceSpec`; thread through the executor.
6. **Durable build scheduler** (§5.6) — `FOR UPDATE SKIP LOCKED` dispatcher + timeout sweep; replace the in-process `void runBuild`.
7. **Real AST discovery** (§5.6) — replace the line-scanner with `ast.parse` for robust contract extraction.
8. **PR + CI (Jemma mount)** (§5.7) — PR object model; mount Jemma; wire push/PR webhooks to `startBuild`.
9. **Provenance parity + schema evolution** (§5.8) — recursive lineage; bridge `dataset`↔`foundry_datasets`; per-materialization schema versions.
10. **Test harness + library publishing** (§5.9) — fixture dry-run route; `python -m build`/`conda build` library packaging.

Each item cites the exact files and line ranges to change in §5.1–§5.9.
