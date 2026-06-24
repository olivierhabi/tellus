# JobSpec Publisher API (B7)

**Mount prefix:** *(not mounted on the live server — available as a module)*
**Status:** **Module-ready** — `createJobSpecAdminApp({ pool })` from `src/services/jobSpec/admin/app.ts`. Wire by adding `app.use("/api/v1/job-spec", createJobSpecAdminApp({ pool }))` to `src/server.ts`.
**Source:** `src/services/jobSpec/`
**Migrations applied:** `057_b7_jobspec`.

The JobSpec Publisher is the dataset-build orchestration plane. Each
`(repository_rid, branch)` declares a graph of inputs → outputs; the publisher
enforces that every `output_dataset_rid` is owned by exactly one
`(repository_rid, branch)` pair across the whole tenant. Cycle detection runs
DFS white/gray/black; orphan replacement deletes outputs that disappeared
between batches.

## Endpoints

### `POST /job-specs:publish`

Publish or replace the JobSpec for a `(repositoryRid, branch)`.
Idempotency-required.

```http
POST /api/v1/job-spec/job-specs:publish
Idempotency-Key: <uuid>
Content-Type: application/json

{
  "repositoryRid": "ri.stemma.main.repository.<uuid>",
  "branch":        "main",
  "outputs": [
    {
      "outputDatasetRid": "ri.foundry.main.dataset.<uuid>",
      "inputs":           [ "ri.foundry.main.dataset.<uuid2>" ],
      "transformPath":    "src/pipelines/transform.py",
      "language":         "python"
    }
  ]
}
```

**200 OK**

```json
{
  "publishedAt":   "2026-05-03T12:35:00.000Z",
  "outputs":       [ /* echoed */ ],
  "replacedOrphans": [ "ri.foundry.main.dataset.<uuid-of-removed>" ]
}
```

**Per-output uniqueness invariant** — if an `outputDatasetRid` is already owned
by a different `(repositoryRid, branch)` pair, the response is
`409 JobSpec:OutputAlreadyOwned` with
`parameters.outputDatasetRid` and `parameters.owner = { repositoryRid, branch }`.

The conditional upsert is `INSERT … ON CONFLICT (output_dataset_rid) DO UPDATE
SET … WHERE jobspec_output.repository_rid = $repositoryRid AND
jobspec_output.branch = $branch`. The 0-row UPDATE outcome is translated
into the `OutputAlreadyOwned` error without ever leaking the row.

**Cycle detection** — DFS over `(input → output)` edges; cycles return
`400 JobSpec:CycleDetected` with `parameters.cycle = ["A","B","A"]`.

**Orphan replacement** — outputs that existed in the previous batch for the
same `(repositoryRid, branch)` but are absent from the new batch are deleted
in the same SERIALIZABLE transaction; their RIDs are listed in
`response.replacedOrphans`.

### `GET /job-specs?repositoryRid=…&branch=…`

Returns the current JobSpec for a `(repository_rid, branch)`.

```json
{
  "repositoryRid": "ri.stemma.main.repository.<uuid>",
  "branch":        "main",
  "publishedAt":   "2026-05-03T12:35:00.000Z",
  "outputs":       [ /* same shape as publish */ ]
}
```

Unknown pair → 404 `JobSpec:NotPublished`.

### `GET /datasets/:rid/owner`

Reverse-lookup. Returns the `(repositoryRid, branch)` pair that currently owns
a given output dataset.

```json
{
  "outputDatasetRid": "ri.foundry.main.dataset.<uuid>",
  "owner":            { "repositoryRid": "ri.stemma.main.repository.<uuid>", "branch": "main" },
  "publishedAt":      "2026-05-03T12:35:00.000Z"
}
```

Unowned → 404 `JobSpec:Unowned`.

## Concurrency invariants

- Two concurrent publishes for the same `(repositoryRid, branch)` are
  serialised; the loser sees the winner's outputs reflected in its read.
- Two concurrent publishes from *different* `(repositoryRid, branch)` pairs
  trying to claim the same `output_dataset_rid` → exactly one succeeds; the
  other receives `409 JobSpec:OutputAlreadyOwned`. Verified by integration test.

## Error names

| `errorName` | HTTP | When |
|---|---|---|
| `JobSpec:OutputAlreadyOwned` | 409 | Output already claimed by a different `(repo, branch)`. |
| `JobSpec:CycleDetected` | 400 | Cycle in input → output graph. |
| `JobSpec:NotPublished` | 404 | No JobSpec for the requested `(repo, branch)`. |
| `JobSpec:Unowned` | 404 | Reverse-lookup found no owner. |
| `JobSpec:InvalidArgument` | 400 | Validation failure. |
| `JobSpec:Unauthenticated` | 401 | Missing principal. |
| `JobSpec:MissingIdempotencyKey` | 400 | Mutating POST without key. |
| `JobSpec:InvalidIdempotencyKey` | 400 | Non-UUID-v4 key. |
| `JobSpec:Internal` | 500 | Unexpected. |

## Schema highlights (migration 057)

- `jobspec (repository_rid, branch, published_at, PRIMARY KEY (repository_rid, branch))`
- `jobspec_output (output_dataset_rid PK, repository_rid, branch, transform_path, language, FOREIGN KEY (repository_rid, branch) REFERENCES jobspec ON DELETE CASCADE)`
- Index on `(repository_rid, branch)` for fast batch reads.

## Test coverage

- `tests/unit/code-repos/job-spec/validation-unit.test.ts` — 27 cases (incl. cycle detection & permutation invariance)
- `tests/integration/code-repos/job-spec/admin-routes-integration.test.ts` — 17 cases (incl. cross-repo collision, orphan replacement)
