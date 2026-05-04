# Code Repositories — Contract Enumeration

> Source of truth for tests. Every test added under §Testing Requirements of the
> implementation brief MUST cite at least one contract ID from this file in its
> name (`T-XX C-YY: <observable behavior>`). Contracts that cannot be tested as
> written are tagged `(decision-bound: D-…)` and the test is written against the
> strictest plausible interpretation per the Decision Protocol.
>
> Numbering: `<TASK>-C-<NN>` where TASK ∈ `{G, B1..B10, F1..F10}`. `G` is the
> §1 Global Contracts surface that applies to every endpoint introduced by any
> task. Total count printed at the end of each section.
>
> Spec citations point at line ranges in `tasks/code-repository/code-repository-tasks.md`
> using the `path:start-end` form mandated by repo conventions.

---

## G — Global Contracts (apply to every endpoint of every task)

Source: `tasks/code-repository/code-repository-tasks.md:57-118`.

### G.1 RID format
- **G-C-01** RID matches `^ri\.[a-z][a-z0-9-]*\.[a-z0-9-]+\.[a-z0-9-]+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` (UUIDv4, lowercase, hyphenated). `tasks/code-repository/code-repository-tasks.md:60`.
- **G-C-02** Reserved namespaces are exactly `stemma`, `code-repos`, `jemma`, `functions`, `osdk`. Any other service namespace in this surface is a regression.
- **G-C-03** Repository RID is `ri.stemma.main.repository.<uuidv4>`.
- **G-C-04** JobSpec RID is `ri.code-repos.main.job-spec.<uuidv4>`.
- **G-C-05** Function-version RID is `ri.functions.main.function-version.<uuidv4>`.
- **G-C-06** CI run RID is `ri.jemma.main.run.<uuidv4>`.

### G.2 Authentication & authorization
- **G-C-07** Every RPC requires `Authorization: Bearer <jwt>`; missing or malformed token returns `401` (server SHOULD NOT distinguish; surface as `errorCode=PERMISSION_DENIED`).
- **G-C-08** JWT verifier requires claims `sub`, `jti`, `org`, `markings[]`, `scopes[]`, `exp`; any missing claim returns 401. `exp` must be ≤ `iat + 16h`; longer-lived tokens are rejected.
- **G-C-09** Service-to-service callers obtain tokens via `client_credentials`; user-driven flows via `authorization_code+PKCE`. Mismatched grant on a service-only or user-only endpoint returns 403.
- **G-C-10** Every read and every write goes through `Compass.canAct(principal, rid, role)` with `role ∈ {VIEWER, EDITOR, OWNER, DISCOVERER}`. The check is logged with the result.
- **G-C-11** **IDOR returns 404, never 403.** Any code path that distinguishes "exists but you cannot access" from "does not exist" by returning 403 in production is a regression. The 403 is reserved for `BranchProtection:*`, `LivePreview:WriteAttemptDenied`, and explicit grant-policy rejections where existence is already public.

### G.3 Error envelope
- **G-C-12** Every error response body is exactly `{errorCode, errorName, errorInstanceId, parameters}`; any extra top-level field is a regression. `tasks/code-repository/code-repository-tasks.md:65-75`.
- **G-C-13** `errorCode` ∈ `{INVALID_ARGUMENT, PERMISSION_DENIED, NOT_FOUND, CONFLICT, FAILED_PRECONDITION, RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE, DEADLINE_EXCEEDED, QOS_THROTTLE}` only.
- **G-C-14** `errorName` is namespaced as `<Service>:<Symbol>` and is part of the contract. Renaming an `errorName` is a breaking change.
- **G-C-15** HTTP status mapping: `INVALID_ARGUMENT→400`, `PERMISSION_DENIED→403`, `NOT_FOUND→404`, `CONFLICT→409`, `FAILED_PRECONDITION→412`, `RESOURCE_EXHAUSTED→429`/`QOS_THROTTLE→429`, `INTERNAL→500`, `UNAVAILABLE→503`, `DEADLINE_EXCEEDED→504`.
- **G-C-16** `parameters` carries only safe diagnostic args (RIDs, names, shas, timestamps). It MUST NOT carry secrets, raw tokens, internal SQL, or stack frames.

### G.4 Optimistic concurrency
- **G-C-17** Every mutable resource exposes `etag = W/"<resource_version>"` on read.
- **G-C-18** PUT/PATCH/DELETE require `If-Match`. Missing or stale `If-Match` returns `412 FAILED_PRECONDITION` with `errorName=<Service>:StaleEtag`.
- **G-C-19** `resource_version` is a monotonically increasing integer per row, bumped on every successful write.

### G.5 Idempotency
- **G-C-20** Every mutating POST that creates or appends to a collection requires `Idempotency-Key: <uuidv4>`.
- **G-C-21** The server stores `(idempotency_key, request_hash)` for ≥ 24h.
- **G-C-22** Replay with the same key + same request hash returns the **byte-identical** original response with `Replay: true` set in `parameters` of the response envelope (success or error). `tasks/code-repository/code-repository-tasks.md:79`.
- **G-C-23** Replay with the same key + different request hash returns `409 CONFLICT` with `errorName=<Service>:IdempotencyConflict`.

### G.6 Pagination
- **G-C-24** All list endpoints use cursor pagination with `?pageSize=<1..1000, default=100>&pageToken=<opaque>` and respond `{data, nextPageToken}`.
- **G-C-25** `pageToken` is opaque base64; it encodes the sort key + last-seen RID and survives backend restart for ≥ 30 days.
- **G-C-26** No endpoint returns offset-based pagination. `?offset=` is rejected as `INVALID_ARGUMENT`.

### G.7 Field validation regex (verbatim from spec §1.6)
- **G-C-27** `apiName` regex: `^[a-z][a-zA-Z0-9]{0,63}$`.
- **G-C-28** Reserved `apiName` words are rejected (case-insensitive): `ontology, object, property, link, relation, rid, primaryKey, typeId, ontologyObject, branch, repository, function, action`.
- **G-C-29** `branchName` regex: `^[a-zA-Z0-9._/-]{1,255}$` AND must not contain `..`, `@{`, `\`, must not start with `-` or `/`, must not end with `.lock`.
- **G-C-30** `tagName` regex: `branchName` rules AND must match `^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$`. Leading `v` is normalized away on storage.
- **G-C-31** `repositoryName` (display) regex: `^[\w][\w \-.()]{0,127}$`. NOT globally unique; uniqueness is per parent folder (B2-C-15).
- **G-C-32** `filePath` constraints: < 4096 bytes; no NUL bytes; must not start with `/`; no `..` segments; not equal to `.git` and not under `.git/`.

### G.8 Standard SLOs (per endpoint class — each endpoint annotated with its class)
- **G-C-33** Class **Metadata read (single resource)**: P50 ≤ 30 ms, P95 ≤ 150 ms, P99 ≤ 400 ms, hard timeout 5 s.
- **G-C-34** Class **Metadata write**: P50 ≤ 80 ms, P95 ≤ 400 ms, P99 ≤ 1 s, hard timeout 10 s (excludes Funnel/CI side-effects).
- **G-C-35** Class **Git ref/object read**: P50 ≤ 50 ms, P95 ≤ 300 ms, P99 ≤ 800 ms, hard timeout 30 s.
- **G-C-36** Class **Git push (≤10 MB delta)**: P50 ≤ 400 ms, P95 ≤ 2 s, P99 ≤ 8 s, hard timeout 60 s.
- **G-C-37** Class **CI run start**: P50 ≤ 1 s, P95 ≤ 5 s, P99 ≤ 15 s, hard timeout 60 s (warm pool; cold start +30 s).
- **G-C-38** Class **Live preview execution**: P50 ≤ 200 ms, P95 ≤ 2 s, P99 ≤ 8 s, hard 30 s cap (Function CPU budget, not wall clock).
- **G-C-39** Class **OSDK generation (≤200 types)**: P50 ≤ 500 ms, P95 ≤ 3 s, P99 ≤ 10 s, hard timeout 60 s.
- **G-C-40** Any endpoint exceeding its P99 by > 2× over a 5-minute window pages on-call.
- **G-C-41** Every service exposes `GET /health` (liveness) and `GET /readiness` (db connectivity + downstream availability).

### G.9 Prometheus baseline metrics (each service emits all five)
- **G-C-42** `tellus_rpc_requests_total{service, endpoint, code}` (counter).
- **G-C-43** `tellus_rpc_request_duration_seconds{service, endpoint, code}` histogram with buckets `5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000` ms.
- **G-C-44** `tellus_rpc_inflight{service, endpoint}` gauge.
- **G-C-45** `tellus_circuit_breaker_state{service, downstream}` gauge `0=closed, 1=open, 2=half-open`.
- **G-C-46** `tellus_idempotency_replays_total{service, endpoint}` counter incremented exactly once per replay (G-C-22).

### G.10 Circuit breakers / retries
- **G-C-47** Cross-service clients use Dialogue-style AIMD limiter: initial concurrency 20, min 1, max 200, FIFO queue per upstream node.
- **G-C-48** Retriable errors: 429, 503, 504, network. Max 4 attempts. Exponential backoff with jitter.
- **G-C-49** Reads always retriable. Writes retriable **only when the request carries an `Idempotency-Key`**.
- **G-C-50** Circuit opens at ≥ 50 % error rate over rolling 30 s window; transitions to half-open after 30 s.

### G.11 Audit
- **G-C-51** Every mutating endpoint emits exactly one row to `audit.events` Kafka topic AND its Postgres mirror with fields `(timestamp, principal_sub, principal_jti, service, endpoint, target_rid, action, before_hash, after_hash, request_id, source_ip, user_agent)`.
- **G-C-52** The HTTP response is held until the audit row is durable in the local Postgres replica (sync write); Kafka publish is async fan-out.
- **G-C-53** Audit retention: ≥ 7 years (for v1, the storage policy is configured to 7 years; expiry is enforced by retention worker, NOT by deletion at write time).
- **G-C-54** `before_hash` and `after_hash` are SHA-256 of the canonical JSON of the resource state pre/post write. They differ iff the write changed observable state (no-op writes still emit a row but with `before_hash == after_hash`).

**Section count: G-C-01 .. G-C-54 (54 IDs)**

---

## B1 — Stemma Git Server

Source: `tasks/code-repository/code-repository-tasks.md:122-230`.

### B1.1 Smart-HTTP surface
- **B1-C-01** Smart HTTP available at `https://<host>/git/<repository_rid>{.git}`.
- **B1-C-02** `GET /git/<rid>/info/refs?service=git-upload-pack` returns capability advertisement; `Content-Type: application/x-git-upload-pack-advertisement`.
- **B1-C-03** `GET /git/<rid>/info/refs?service=git-receive-pack` ditto for push.
- **B1-C-04** `POST /git/<rid>/git-upload-pack` honours `Content-Type: application/x-git-upload-pack-request`.
- **B1-C-05** `POST /git/<rid>/git-receive-pack` honours `Content-Type: application/x-git-receive-pack-request`.
- **B1-C-06** Auth accepted as `Authorization: Basic <base64(token:x-oauth-basic)>` OR `Authorization: Bearer <jwt>` — both resolve via Multipass.
- **B1-C-07** Clone/fetch requires `Compass.canAct(principal, rid, VIEWER)`.
- **B1-C-08** Push requires `Compass.canAct(principal, rid, EDITOR)` AND a successful B10 pre-receive (B10-C-01..10).

### B1.2 Conjure admin API
- **B1-C-09** `POST /stemma/api/v1/repositories` body `{rid, defaultBranchName}` → `Repository`.
- **B1-C-10** `DELETE /stemma/api/v1/repositories/{rid}` performs soft-delete (state=TOMBSTONED).
- **B1-C-11** Hard purge runs ≥ 30 days after tombstone; purged rows return `RepositoryNotFound`.
- **B1-C-12** `GET /repositories/{rid}/refs` returns `Ref[]` with cursor pagination (G-C-24).
- **B1-C-13** `GET /repositories/{rid}/refs/{name}` returns single Ref or `Stemma:RefNotFound`.
- **B1-C-14** `GET /repositories/{rid}/blobs/{sha}` streams `application/octet-stream`.
- **B1-C-15** `GET /repositories/{rid}/trees/{sha}` returns `TreeEntry[]`.
- **B1-C-16** `GET /repositories/{rid}/commits/{sha}` returns `Commit`.
- **B1-C-17** `GET /repositories/{rid}/refs/{ref}/files?path=…` returns `FileContent`.
- **B1-C-18** `POST /repositories/{rid}/diff` body `{fromRef, toRef, paths?}` returns `DiffResult`.
- **B1-C-19** `POST /repositories/{rid}/gc` admin-only (`OWNER` + service scope `stemma:admin`); response is `202` and a queued task; concurrent gc on same rid is coalesced.

### B1.3 Persistence (DDL invariants)
- **B1-C-20** `stemma_repository.state` ∈ `{ACTIVE, TOMBSTONED, PURGED}`. CHECK constraint enforced; transitions only ACTIVE→TOMBSTONED→PURGED.
- **B1-C-21** Ref CAS: every ref update is `UPDATE stemma_ref SET target_sha=$new WHERE repository_rid=$r AND name=$n AND target_sha=$expected_old` and asserts `affected_rows == 1`; otherwise `Stemma:RefUpdateRejected` (409) is returned with the current `target_sha` in `parameters.newTip`.
- **B1-C-22** A `git-receive-pack` that updates N refs commits all N atomically (Postgres `serializable` isolation; AtlasDB single tx if available).
- **B1-C-23** Packfile bytes stream into `stemma_blob` first; `stemma_packfile` row inserts only after `git index-pack --strict` AND content-addressable verification (`sha256(packfile) == declared`); failure deletes the orphan blob and returns `Stemma:InvalidPackfile`.
- **B1-C-24** Quarantine: every push gets an isolated quarantine directory; B10 pre-receive runs against quarantined refs; promotion is a single atomic ref-update tx; failed pre-receive deletes the quarantine in the same transaction.
- **B1-C-25** All Stemma nodes are stateless: any node can serve any request; no node-local state survives across requests.

### B1.4 Error codes
- **B1-C-26** `Stemma:RepositoryNotFound` (404) — also returned for tombstoned and purged repos to non-admins.
- **B1-C-27** `Stemma:RefNotFound` (404).
- **B1-C-28** `Stemma:RefUpdateRejected` (409) — CAS mismatch OR non-ff without `force=true` OR B10 protection denial; `parameters` MUST include the current `newTip` SHA.
- **B1-C-29** `Stemma:ProtectedBranchViolation` (403) — surfaced via B10 callback (delegated, but the error name is owned here).
- **B1-C-30** `Stemma:RepositorySizeExceeded` (413) > 10 GB total without admin override.
- **B1-C-31** `Stemma:PushBodyTooLarge` (413) > 1 GB per push body.
- **B1-C-32** `Stemma:InvalidPackfile` (400) — failed `git index-pack --strict`.
- **B1-C-33** `Stemma:GcInProgress` (503) — temporary; response sets `Retry-After: 60`.
- **B1-C-34** `Stemma:HookTimeout` — surfaced when B10 `/hooks/pre-receive` does not respond within 5 s (B10-C-01); push rejected.

### B1.5 SLOs
- **B1-C-35** `info/refs` P95 < 200 ms (G-C-35 class).
- **B1-C-36** `git-upload-pack` clone throughput ≥ 50 MB/s sustained per connection.
- **B1-C-37** `git-receive-pack` commit-latency P95 < 2 s for ≤ 10 MB delta (G-C-36).
- **B1-C-38** Background gc keeps packs ≤ 64 MB and ≤ 10 packs per repo before merge.

### B1.6 Metrics
- **B1-C-39** `stemma_pushes_total{result}` counter; result ∈ `{accepted, rejected, error}`.
- **B1-C-40** `stemma_clones_bytes_total` counter.
- **B1-C-41** `stemma_packfiles{repo}` gauge — cardinality bounded by repo count (alert if > 10⁶).
- **B1-C-42** `stemma_ref_update_conflicts_total` counter.
- **B1-C-43** `stemma_repo_size_bytes{repo}` gauge — sampled async to keep cardinality bounded.

### B1.7 Edge cases / invariants
- **B1-C-44** Force-push: requires EDITOR + branch unprotected (B10) + `force=true` capability negotiated; otherwise `RefUpdateRejected`.
- **B1-C-45** Tag refs are immutable: any update to `refs/tags/*` returns `RefUpdateRejected` unless `force=true` AND principal is OWNER.
- **B1-C-46** Soft-deleted repos return 404 to all callers except admin queries (`scopes` includes `stemma:admin`).
- **B1-C-47** Empty repository creation produces a single symbolic ref `HEAD → refs/heads/main` and zero commits; first push initializes the branch.
- **B1-C-48** Quarantine lifecycle: created per push, deleted after promotion or rejection — there is no path that leaves a quarantine on disk past the request.

### B1.8 Acceptance (binding §)
- **B1-C-49** `git clone https://tellus/git/<rid>.git` works against a fresh repo; a 1 GB packfile fetch completes (throughput ≥ 50 MB/s).
- **B1-C-50** Concurrent pushes to the same branch from N=2 (and N=50 for chaos) clients: exactly one succeeds; losers receive `RefUpdateRejected` with `parameters.newTip = <winner sha>`.
- **B1-C-51** Killing the Stemma node mid-push results in zero partial state — the next clone observes the pre-push tip.

**Section count: B1-C-01 .. B1-C-51 (51 IDs)**

---

## B2 — Code Repository Service

Source: `tasks/code-repository/code-repository-tasks.md:233-331`.

### B2.1 RPC surface
- **B2-C-01** `POST /code-repos/api/v1/repositories` body `{displayName, parentFolderRid, templateId, templateVersion, defaultBranch?: "main"}`; requires `Idempotency-Key`; returns `Repository {rid, displayName, parentFolderRid, templateId, templateVersion, defaultBranch, gitHttpUrl, createdAt, etag}`.
- **B2-C-02** `GET /repositories/{rid}` returns `Repository` or `Stemma:RepositoryNotFound`.
- **B2-C-03** `PATCH /repositories/{rid}` requires `If-Match`; only `displayName, defaultBranch, settings` may change.
- **B2-C-04** `DELETE /repositories/{rid}` requires `If-Match`; performs trash (state=TRASHED), not hard delete.
- **B2-C-05** `GET /repositories/{rid}/branches?protected=true|false` returns cursor-paginated branch list.
- **B2-C-06** `GET /repositories/{rid}/branches/{name}` returns `Branch`.
- **B2-C-07** `GET /repositories/{rid}/tags?pageSize=&pageToken=` cursor-paginated.
- **B2-C-08** `GET /repositories/{rid}/settings` returns the materialised `repoSettings.json`.
- **B2-C-09** `PUT /repositories/{rid}/settings` requires `If-Match`; on success the server commits `repoSettings.json` to the default branch as a system commit.
- **B2-C-10** `GET /repositories/{rid}/branches/{branch}/tree?path=&depth=` returns tree listing.
- **B2-C-11** `GET /repositories/{rid}/branches/{branch}/files?path=` returns file content (5 MB max; F2-C-08 truncation banner upstream).
- **B2-C-12** `GET /repositories?parent=&template=&q=&pageSize=&pageToken=` cursor-paginated search.
- **B2-C-13** `POST /repositories/{rid}/branches/{branch}/commits` (added per F4 dependency) body `{parentSha, message, fileChanges:[…]}` requires `Idempotency-Key` + `If-Match` (ETag asserts `parentSha == HEAD`); returns `Commit {sha, branch, headerEtag}`.

### B2.2 Persistence
- **B2-C-14** `code_repository.state` ∈ `{ACTIVE, ARCHIVED, TRASHED}` (CHECK enforced).
- **B2-C-15** Unique index `code_repository_parent_name ON (parent_folder_rid, lower(display_name)) WHERE state='ACTIVE'` — enforces case-insensitive uniqueness per folder.
- **B2-C-16** `code_repository_branch_cache` is read-only from this service's API; only the B10 event consumer updates it.
- **B2-C-17** ETag = `W/"<resource_version>"` (G-C-17).

### B2.3 Settings schema (validation invariants)
- **B2-C-18** `settings.tagNameValidation.regex` is compiled and rejected on update if it does not parse (`Invalid regex` → `CodeRepos:InvalidSettings`).
- **B2-C-19** `settings.branchNameValidation.regex` ditto.
- **B2-C-20** `settings.protectedBranches` is a glob array; invalid glob → `CodeRepos:InvalidSettings`.
- **B2-C-21** `settings.requirePullRequest` (bool), `settings.requiredApprovals` (int ≥ 0).
- **B2-C-22** `settings.computeProfile` ∈ `{default, warm-pool, high-memory}` (other values rejected).
- **B2-C-23** `settings.checks` is `{lint, unitTests, antipattern}` booleans; unknown keys rejected.

### B2.4 Concurrency
- **B2-C-24** Branch-cache lag: `head_sha` reflects the post-receive event ≤ 5 s P99 after the push; emit `code_repos_branch_cache_lag_seconds` (B2-C-30).
- **B2-C-25** Rename (PATCH displayName): row lock on the repo + uniqueness re-check inside the same tx; collision returns `CodeRepos:NameConflict` (409).

### B2.5 Error codes
- **B2-C-26** `CodeRepos:NameConflict` (409).
- **B2-C-27** `CodeRepos:TemplateNotFound` (404).
- **B2-C-28** `CodeRepos:TemplateInitFailed` (500) — repo flagged `INIT_FAILED`; the same idempotency key may be retried.
- **B2-C-29** `CodeRepos:ParentFolderNotFound` (404).
- **B2-C-30** `CodeRepos:InvalidSettings` (400).
- **B2-C-31** `CodeRepos:RepositoryArchived` (412) on writes to archived repos.
- **B2-C-32** `CodeRepos:StaleEtag` (412) — global G-C-18 alias for this service.
- **B2-C-33** `CodeRepos:IdempotencyConflict` (409) — alias for G-C-23.

### B2.6 SLOs
- **B2-C-34** `createRepository` end-to-end (saga incl. initial template push) P95 < 5 s.
- **B2-C-35** `listBranches` P95 < 200 ms (cache).
- **B2-C-36** `readFile` P95 < 300 ms.

### B2.7 Metrics
- **B2-C-37** `code_repos_repositories_total{template, state}` gauge.
- **B2-C-38** `code_repos_branch_cache_lag_seconds` histogram.
- **B2-C-39** `code_repos_create_failures_total{reason}` counter.

### B2.8 Saga invariants
- **B2-C-40** Repo creation is a 4-step saga: (1) `Compass.createResource` → (2) `Stemma.createRepository` → (3) `B3.scaffold` + push initial commit → (4) `state = ACTIVE`.
- **B2-C-41** Steps 1–3 are individually compensable. On any step failure, the saga rolls back via tombstoning the partial Stemma repo + Compass `markTrashed`.
- **B2-C-42** The same idempotency key replays the saga and produces the same RID; partial saga state is recovered by checkpoint table not exposed in the API.
- **B2-C-43** RID and `gitHttpUrl` are permanent across renames.
- **B2-C-44** Trash flips state to TRASHED and Stemma starts returning 404 to all non-admin callers (cross-task: B1-C-46). Untrash flips back.
- **B2-C-45** Hard delete is 2-phase: TRASHED → 30 days grace → PURGED.

### B2.9 Acceptance
- **B2-C-46** `POST /repositories` with `templateId=typescript-functions` returns 201 + clonable repo containing template files on `main`.
- **B2-C-47** Two concurrent same-name creates in same folder: exactly one returns 201, the other 409 `NameConflict`.
- **B2-C-48** A successful push triggers cache update within 5 s P99 (B2-C-24 measured).

**Section count: B2-C-01 .. B2-C-48 (48 IDs)**

---

## B3 — Repository Templates Engine

Source: `tasks/code-repository/code-repository-tasks.md:334-383`.

### B3.1 RPC surface
- **B3-C-01** `GET /templates/api/v1/templates` returns `Template[]` cursor-paginated.
- **B3-C-02** `GET /templates/api/v1/templates/{templateId}/versions/{version}` returns `TemplateManifest`.
- **B3-C-03** `POST /templates/api/v1/scaffold` body `{templateId, version, repositoryRid, parameters, principalSub}` is **internal-only** (callable only by `code-repos` service principal); returns `ScaffoldResult {commitSha, fileCount, totalBytes}`.

### B3.2 Manifest invariants
- **B3-C-04** Manifest fields exactly: `{templateId, version, displayName, language, category, parameters[], files[]}`.
- **B3-C-05** Each `parameters[i]` has `{name, regex, default}`; `default` may reference repo display name slug (`<derived from repo name>`).

### B3.3 Storage
- **B3-C-06** Templates are immutable git tree objects in a system-owned Stemma repo `ri.stemma.main.repository.<system-templates>`; addressed by `templateId@version`.
- **B3-C-07** A `templates_index` Postgres table caches manifest metadata for listing; never authoritative for content.

### B3.4 Determinism
- **B3-C-08** Scaffold is idempotent: identical `(templateId, version, repositoryRid, parameters)` MUST produce a byte-identical commit SHA on two runs.

### B3.5 Error codes
- **B3-C-09** `Templates:NotFound` (404).
- **B3-C-10** `Templates:VersionDeprecated` (410) — admin-marked; existing repos unaffected, new scaffolds blocked.
- **B3-C-11** `Templates:ParameterValidationFailed` (400).

### B3.6 v1 templates content
- **B3-C-12** `typescript-functions` MUST include: `package.json`, `tsconfig.json`, `src/index.ts` (with `@Function` example), `.gitignore`, `README.md`, `osdk.config.json` placeholder (for B5), `repoSettings.json`.
- **B3-C-13** `typescript-functions` `package.json#name` is the repo display name lowercased + hyphenated.
- **B3-C-14** `python-functions` MUST include: `pyproject.toml` (Poetry), `src/<package>/__init__.py`, `tests/`, `osdk.config.json`.
- **B3-C-15** `transforms-python` MUST include: `transforms/` with `@transform` example referencing a placeholder dataset RID.
- **B3-C-16** Template upgrades NEVER auto-apply to existing repos.

### B3.7 Acceptance
- **B3-C-17** Scaffolding `typescript-functions@2.4.0` for repo `<rid>` produces deterministic commit SHA across two runs (B3-C-08).
- **B3-C-18** Scaffolded repo runs `npm ci && npm test` cleanly on a fresh `node:20` container.

**Section count: B3-C-01 .. B3-C-18 (18 IDs)**

---

## B4 — Resource Imports Service

Source: `tasks/code-repository/code-repository-tasks.md:386-442`.

### B4.1 RPC surface
- **B4-C-01** `GET /code-repos/api/v1/repositories/{rid}/imports` returns `ImportSet {imports:[{kind, rid, apiName, importedAt}], etag}`.
- **B4-C-02** `POST /repositories/{rid}/imports` body `{adds:[{kind, rid}], removes:[{rid}]}` requires `If-Match`; atomic; returns `ImportSet`.
- **B4-C-03** `POST /repositories/{rid}/imports:preview` body `{adds, removes}` returns `ImpactReport {generatedFilesPreview, breakingReferences[]}`.

### B4.2 Persistence
- **B4-C-04** `code_repository_imports.entity_kind` ∈ `{OBJECT_TYPE, LINK_TYPE, ACTION_TYPE, INTERFACE, VALUE_TYPE}` (CHECK).
- **B4-C-05** `api_name_at_import` is snapshotted at import time and used by B5 codegen for stability.
- **B4-C-06** ETag = `W/"<resource_version>"` from `code_repository_imports_version` per repo.

### B4.3 Concurrency
- **B4-C-07** `addImports` is one transaction: all adds + removes commit together or none.
- **B4-C-08** On successful change, emit Kafka event `code-repos.imports.changed` (consumed by B5).

### B4.4 Error codes
- **B4-C-09** `Imports:EntityNotFound` (404).
- **B4-C-10** `Imports:NotImportedInProject` (412) — `parameters.projectRid` MUST be populated.
- **B4-C-11** `Imports:KindMismatch` (400).
- **B4-C-12** `Imports:DuplicateApiName` (409) — two entities sharing `api_name_at_import` would break codegen.

### B4.5 Edge cases
- **B4-C-13** Renamed-in-OMS entity: snapshot updated on next import touch; preview returns `breakingReferences` warning.
- **B4-C-14** Removing an entity referenced in code: preview lists impacted files; remove still proceeds (CI fails subsequently).
- **B4-C-15** Repo deletion cascades — imports rows deleted.

### B4.6 Acceptance
- **B4-C-16** Importing `[Gena] Clinic` and `[Gena] Financial` succeeds; `osdk.config.json` reflects two object types.
- **B4-C-17** Out-of-project entity returns 412 `NotImportedInProject` with `parameters.projectRid`.

**Section count: B4-C-01 .. B4-C-17 (17 IDs)**

---

## B5 — OSDK Code Generator Service

Source: `tasks/code-repository/code-repository-tasks.md:445-486`.

- **B5-C-01** `POST /osdk-gen/api/v1/generate` body `{repositoryRid, branch, importsEtag}` requires `Idempotency-Key`; returns `GenerateResult {commitSha, generatedFiles[], durationMs}`.
- **B5-C-02** `GET /osdk-gen/api/v1/generate/{runId}` returns `{state ∈ {PENDING, RUNNING, SUCCEEDED, FAILED}, error?, commitSha?}`.
- **B5-C-03** Generation is triggered by Kafka event `code-repos.imports.changed` (B4-C-08) AND on demand from the IDE.
- **B5-C-04** TypeScript output layout: `.osdk-generated/index.ts`, `.osdk-generated/objects/<ApiName>.ts`, `.osdk-generated/actions/<ApiName>.ts`, `.osdk-generated/package.json` declaring local module `@osdk/local`.
- **B5-C-05** TS template's `src/osdk.ts` re-exports the generated module.
- **B5-C-06** Python output layout: `.osdk-generated/__init__.py`, `.osdk-generated/objects.py`.
- **B5-C-07** Per-repo serialization via Postgres advisory lock keyed on `hashtext(repository_rid)`.
- **B5-C-08** Concurrent triggers coalesce: a second trigger with the same `importsEtag` blocks until the first finishes and returns the same result.
- **B5-C-09** `Osdk:OmsUnavailable` (503).
- **B5-C-10** `Osdk:UnsupportedPropertyType` (501) — fail loudly, do NOT silently drop. (`parameters.propertyType` populated.)
- **B5-C-11** `Osdk:GenerationFailed` (500).
- **B5-C-12** `Osdk:CommitFailed` (500) — Stemma push failed; service retries up to 3× with re-fetch of HEAD; after 3 failures surfaces error to UI.
- **B5-C-13** SLO: P95 < 3 s for ≤ 200 entities; P99 < 10 s.
- **B5-C-14** Concurrency with user push: if Stemma CAS fails, generator re-fetches HEAD, replays generation against the new tree, retries push.
- **B5-C-15** Unsupported property types (vector, media-reference, struct, geo) emit `// @ts-expect-error TELLUS-OSDK-UNSUPPORTED:<type>` placeholder + log; the file still compiles.
- **B5-C-16** Acceptance: after importing `[Gena] Clinic`, `.osdk-generated/objects/GenaClinic.ts` exists with typed properties matching OMS.
- **B5-C-17** Acceptance: renaming the apiName in OMS, then re-importing, regenerates with the new apiName; the old name's file is gone.

**Section count: B5-C-01 .. B5-C-17 (17 IDs)**

---

## B6 — Jemma CI Worker Pool

Source: `tasks/code-repository/code-repository-tasks.md:489-569`.

- **B6-C-01** `POST /jemma/api/v1/runs` body `{repositoryRid, ref, commitSha, trigger, triggeringUserSub}` requires `Idempotency-Key`; returns `Run {rid, state:QUEUED, queuedAt}`.
- **B6-C-02** `GET /runs/{rid}` returns the run.
- **B6-C-03** `POST /runs/{rid}:cancel` cancels.
- **B6-C-04** `GET /runs?repositoryRid=&ref=&pageSize=&pageToken=` cursor-paginated.
- **B6-C-05** `GET /runs/{rid}/logs` is SSE (`text/event-stream`) emitting events `{stage, line, ts}`.
- **B6-C-06** `GET /runs/{rid}/logs/chunks?stage=&offset=` returns chunked log content.
- **B6-C-07** `state` ∈ `{QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELLED, TIMED_OUT}` and transitions form the DAG `QUEUED→RUNNING→{SUCCEEDED|FAILED|CANCELLED|TIMED_OUT}` only.
- **B6-C-08** `trigger_kind` ∈ `{PUSH, PR, TAG, MANUAL}`.
- **B6-C-09** **At most one running run per `(repository_rid, ref)`**. A new push while running cancels the in-flight (graceful 30 s SIGTERM) and starts the new one.
- **B6-C-10** Per-repo concurrency cap: 4 concurrent runs across all branches (configurable via `repoSettings.compute`).
- **B6-C-11** Global pool: min 8 max 200 worker nodes (autoscaled).
- **B6-C-12** Pod from warm pool when available; else cold-start path.
- **B6-C-13** Stage order: `setup → lint → test → build → publish`. Failure of a non-`publish` stage skips subsequent and marks run `FAILED`.
- **B6-C-14** `typescript-functions` toolchain: `npm ci → npm run lint (eslint) → npm test (jest) → npm run build (tsc) → publish to B8`.
- **B6-C-15** `python-functions` toolchain: `poetry install → pylint/ruff → pytest → publish to B8`.
- **B6-C-16** `transforms-python` toolchain: lint + pytest + JobSpec discovery → B7 publish.
- **B6-C-17** `transforms-java` toolchain: `./gradlew check publish` + JobSpec discovery → B7 publish.
- **B6-C-18** Hard timeouts: 30 min total per run; 10 min per stage. Exceeding → state `TIMED_OUT` with `failure_reason` set.
- **B6-C-19** `Jemma:RunNotFound` (404).
- **B6-C-20** `Jemma:RunAlreadyTerminal` (409) — cancel/start on a finished run.
- **B6-C-21** `Jemma:CapacityExceeded` (429) — auto-retried by client (G-C-48).
- **B6-C-22** `Jemma:WorkerImageUnavailable` (503).
- **B6-C-23** `Jemma:StageFailed` is a synthetic name surfaced via `state=FAILED, failure_reason=<stage>:<reason>`.
- **B6-C-24** SLO: queue-to-start P95 < 5 s warm, < 30 s cold (G-C-37).
- **B6-C-25** SLO: log streaming latency P95 < 1 s.
- **B6-C-26** `jemma_runs_total{trigger, result}` counter.
- **B6-C-27** `jemma_queue_depth` gauge.
- **B6-C-28** `jemma_run_duration_seconds{template, result}` histogram.
- **B6-C-29** `jemma_pod_cold_starts_total` counter.
- **B6-C-30** Pod OOM-kill → state `FAILED`, `failure_reason='OOM'`; UI surfaces compute-profile suggestion.
- **B6-C-31** Stemma fetch failure inside the pod: 3× retry with backoff; then `FAILED` with `failure_reason='stemma-unreachable'`.
- **B6-C-32** Run cancelled while uploading to B8: B8 abort-upload signal sent; partial artifacts deleted.
- **B6-C-33** Acceptance: TS push → QUEUED in < 1 s, RUNNING in < 5 s, SUCCEEDED in < 60 s for the empty template.
- **B6-C-34** Acceptance: two pushes within 1 s on the same branch → first cancelled, second runs to completion.

**Section count: B6-C-01 .. B6-C-34 (34 IDs)**

---

## B7 — JobSpec Publisher

Source: `tasks/code-repository/code-repository-tasks.md:572-640`.

- **B7-C-01** `POST /code-repos/api/v1/repositories/{rid}/branches/{branch}/job-specs` body `{commitSha, jobSpecs:[…]}` requires `Idempotency-Key`; **internal — Jemma only**; returns `PublishResult {published[], rejected:[{outputDatasetRid, reason}]}`.
- **B7-C-02** `GET /job-specs?outputDatasetRid=&branch=` returns the JobSpec or 404.
- **B7-C-03** `GET /repositories/{rid}/branches/{branch}/job-specs` cursor-paginated.
- **B7-C-04** `JobSpec` fields exactly: `{outputDatasetRid, branch, repositoryRid, commitSha, sourcePath, entryPoint, inputs[], parameters, computeProfile}`.
- **B7-C-05** PRIMARY KEY `(output_dataset_rid, branch)` enforces global uniqueness per output × branch.
- **B7-C-06** Different repo trying to publish the same key → `JobSpec:OutputAlreadyOwned` (409); current owner's `repositoryRid` populated in `parameters.ownerRid`.
- **B7-C-07** Same repo re-publishing: atomic upsert; `published_at` and `commit_sha` advance.
- **B7-C-08** A repo's prior publishes that no longer appear in the new payload are deleted (full replacement of `(repository_rid, branch)` set).
- **B7-C-09** `JobSpec:OutputAlreadyOwned` (409).
- **B7-C-10** `JobSpec:CircularDependency` (400) — discovered output appears in inputs (transitive closure check).
- **B7-C-11** `JobSpec:InvalidEntryPoint` (400).
- **B7-C-12** `JobSpec:DatasetNotFound` (404).
- **B7-C-13** Postgres isolation: SERIALIZABLE for the publish transaction (decision-bound: D-2026-05-01-003).
- **B7-C-14** Acceptance: `transforms-python` repo with two `@transform` decorators publishes exactly two rows.
- **B7-C-15** Acceptance: two repos racing the same output → exactly one wins.

**Section count: B7-C-01 .. B7-C-15 (15 IDs)**

---

## B8 — Functions Registry

Source: `tasks/code-repository/code-repository-tasks.md:643-728`.

- **B8-C-01** `POST /functions/api/v1/functions/{repositoryRid}/versions` multipart body `{tagName, semver, branch, commitSha, runtime, entryPoints, artifactBlob}` requires `Idempotency-Key`; **internal — Jemma only**.
- **B8-C-02** `GET /functions/{repositoryRid}/versions?branch=&pageSize=` cursor-paginated.
- **B8-C-03** `GET /functions/{repositoryRid}/versions/{semver}` returns `FunctionVersion`.
- **B8-C-04** `GET /functions/{repositoryRid}/resolve?versionTarget=&branch=` resolves a semver range; returns `FunctionVersion` or 404.
- **B8-C-05** `GET /functions?ontologyRid=&q=` discovery for Workshop/OMS UIs (cross-repo).
- **B8-C-06** `GET /functions/{repositoryRid}/versions/{semver}/artifact` streams the artifact blob.
- **B8-C-07** `entryPoint.signature` schema: `{apiName, displayName, inputs[{name, type}], output, isQuery, isAction, memoryMb, cpuTimeoutSec}`.
- **B8-C-08** `runtime` ∈ `{NODE_20, PY_311}`; `state` ∈ `{AVAILABLE, YANKED}`.
- **B8-C-09** UNIQUE `(repository_rid, branch, semver)`.
- **B8-C-10** `is_preview = (branch != repo's default_branch)` at publish time.
- **B8-C-11** Republish same key + matching `artifact_sha256` returns the existing record (idempotent).
- **B8-C-12** Republish same key + different `artifact_sha256` → `Functions:VersionImmutable` (409).
- **B8-C-13** Yank is metadata-only; `functions.version.yanked` Kafka event published.
- **B8-C-14** `resolveTarget` parses npm-semver: `^1.2.0`, `~1.2.0`, `1.2.x`, `=1.2.3`, `>=1.2.3 <2.0.0`.
- **B8-C-15** `resolveTarget` filter: `branch=requested OR (branch=default AND is_preview=false)`.
- **B8-C-16** `resolveTarget` selection: highest matching semver among AVAILABLE versions.
- **B8-C-17** `resolveTarget` returns 404 (`Functions:VersionTargetUnsatisfied`) if no match.
- **B8-C-18** `Functions:VersionImmutable` (409).
- **B8-C-19** `Functions:VersionNotFound` (404).
- **B8-C-20** `Functions:VersionTargetUnsatisfied` (404).
- **B8-C-21** `Functions:RepositoryNotPublishable` (412) — repo template is not a function template.
- **B8-C-22** `Functions:ArtifactCorrupt` (400) — sha256 mismatch on upload.
- **B8-C-23** Branch-aware preview: tag `1.0.0-beta.1` on a feature branch → `is_preview=true`; OMS Action Type bound to `^1.0.0` resolves stable on default branch, NOT preview, unless consumer passes `branch=feature/foo`.
- **B8-C-24** Yanking a version still in use: yank succeeds, warning event published; OMS UI shows "yanked function".
- **B8-C-25** Artifact storage: S3-compatible blob store, retention forever (until repo deletion).
- **B8-C-26** SLO: `resolveTarget` P95 < 50 ms (in-memory cache by repositoryRid + invalidate on publish).
- **B8-C-27** SLO: `publishVersion` P95 < 2 s for ≤ 50 MB artifact.
- **B8-C-28** Acceptance: tag `v1.0.0` on `main` → CI publishes → `resolveTarget(^1.0.0, main)` returns it.
- **B8-C-29** Acceptance: same tag on a feature branch → `is_preview=true`, doesn't pollute main resolution.
- **B8-C-30** Acceptance: two CI pods race the same tag → idempotency dedups; second sees first's result.

**Section count: B8-C-01 .. B8-C-30 (30 IDs)**

---

## B9 — Live Preview Execution Service

Source: `tasks/code-repository/code-repository-tasks.md:731-774`.

- **B9-C-01** `POST /live-preview/api/v1/sessions` body `{repositoryRid, branch, commitSha}` returns `Session {rid, expiresAt}`.
- **B9-C-02** `POST /sessions/{rid}/invoke` body `{functionApiName, inputs, allowMutations:false}` returns `InvokeResult {output, durationMs, logs[]}`.
- **B9-C-03** `DELETE /sessions/{rid}`.
- **B9-C-04** Runtime container: Node 20 OR Python 3.11 with the user's repo at the requested commit, OSDK pre-installed, OAuth token scoped to user perms on the requested branch.
- **B9-C-05** Containers come from per-`(runtime, repository_template)` warm pool; eviction after 10 min idle.
- **B9-C-06** Per-invocation limits: 30 s CPU, 512 MiB memory (configurable up to 2 GiB), 100 MB egress, 1000 OSDK calls.
- **B9-C-07** Limits enforced via cgroups + interceptor in OSDK runtime.
- **B9-C-08** Limit exceeded → `LivePreview:LimitExceeded` (429) and abort.
- **B9-C-09** One in-flight invocation per session; subsequent invocations queue in-process.
- **B9-C-10** Sessions auto-expire after 30 minutes; closed/expired sessions return 404.
- **B9-C-11** `LivePreview:SessionNotFound` (404).
- **B9-C-12** `LivePreview:InvocationFailed` (500) — user code threw.
- **B9-C-13** `LivePreview:Timeout` (504).
- **B9-C-14** `LivePreview:LimitExceeded` (429).
- **B9-C-15** `LivePreview:WriteAttemptDenied` (403) — function attempted mutation while `allowMutations=false`.
- **B9-C-16** Working tree edits: F7 PATCHes dirty files to the session before invocation; the service snapshots the patched tree.
- **B9-C-17** OSDK stale (imports removed since last codegen) → `LivePreview:OsdkStale` (412) with regen hint in `parameters.regenUrl`.
- **B9-C-18** SLO: cold-session P95 < 5 s.
- **B9-C-19** SLO: warm-session invocation P95 < 2 s, P99 hard cap 8 s (G-C-38).
- **B9-C-20** `live_preview_invocations_total{result}` counter.
- **B9-C-21** `live_preview_session_warmup_seconds` histogram.
- **B9-C-22** `live_preview_active_sessions` gauge.
- **B9-C-23** Acceptance: invoke `calculateDaysSalesOutstanding` returns `40.51` within 2 s warm.
- **B9-C-24** Acceptance: a function with `while(true){}` is killed at 30 s and returns `LivePreview:Timeout`.

**Section count: B9-C-01 .. B9-C-24 (24 IDs)**

---

## B10 — Stemma Event Bus & Branch Protection

Source: `tasks/code-repository/code-repository-tasks.md:777-848`.

- **B10-C-01** Pre-receive: synchronous HTTP `POST /hooks/pre-receive` from Stemma; B10 must respond within **5 s** else Stemma rejects with `Stemma:HookTimeout` (B1-C-34).
- **B10-C-02** Pre-receive payload exactly: `{repositoryRid, principalSub, refUpdates:[{ref, oldSha, newSha, isCreate, isDelete, isForce}]}`.
- **B10-C-03** Post-receive: async event published to Kafka topic `stemma.refs.updated`.
- **B10-C-04** Pre-receive checks run **in order, fail-fast**: regex → protected-branch policy → tag immutability → Compass permission.
- **B10-C-05** Step 1: each ref name validated against `branchNameValidation` / `tagNameValidation` regex from `repoSettings`; failure → `BranchProtection:RegexViolation` (400).
- **B10-C-06** Step 2 (protected branch): `isDelete` → `BranchProtection:DeleteProtected` (403).
- **B10-C-07** Step 2: `isForce` → `BranchProtection:ForcePushProtected` (403).
- **B10-C-08** Step 2: direct push when `requirePullRequest=true` → `BranchProtection:RequiresPullRequest` (403).
- **B10-C-09** Step 3 (tag): `refs/tags/*` update or delete → reject (immutable per B1-C-45) unless principal is OWNER.
- **B10-C-10** Step 4: `Compass.canAct(principal, repository_rid, EDITOR)` — failure → `Compass:PermissionDenied` (403).
- **B10-C-11** `POST /stemma-events/api/v1/subscriptions` body `{eventTypes, targetUri, secret}` returns `Subscription {rid}`.
- **B10-C-12** `GET /events?repositoryRid=&since=&pageSize=&pageToken=` cursor-paginated event listing.
- **B10-C-13** Subscriber callbacks include `X-Tellus-Signature: sha256=<hex>` HMAC over the body using subscription secret.
- **B10-C-14** Pre-receive must respond P99 < 2 s under load (per G-C-37 derived).
- **B10-C-15** Post-receive Kafka delivery is at-least-once; subscriber idempotency is the subscriber's responsibility.
- **B10-C-16** `BranchProtection:DeleteProtected` (403).
- **B10-C-17** `BranchProtection:ForcePushProtected` (403).
- **B10-C-18** `BranchProtection:RequiresPullRequest` (403).
- **B10-C-19** `BranchProtection:InsufficientApprovals` (403) — surfaced by F9 merge gate, owned by B10.
- **B10-C-20** `BranchProtection:RegexViolation` (400).
- **B10-C-21** `repoSettings.json` modified in the same push: validation uses **OLD** settings; new settings effective from the next push (avoids self-reject bootstrap).
- **B10-C-22** Subscriber endpoint flapping: 5 consecutive failures → `state=SUSPENDED`, requires manual reactivation.
- **B10-C-23** Acceptance: push to a protected branch without PR is rejected with `RequiresPullRequest`.
- **B10-C-24** Acceptance: force-push to protected `main` is rejected.
- **B10-C-25** Acceptance: push to a feature branch produces a post-receive event observable at B6 within 1 s P95.

**Section count: B10-C-01 .. B10-C-25 (25 IDs)**

---

## F1 — Web IDE Shell

Source: `tasks/code-repository/code-repository-tasks.md:856-880`.

- **F1-C-01** Route `/code/:repositoryRid` opens the repo on default branch.
- **F1-C-02** Route `/code/:repositoryRid/branches/:branch?path=src/index.ts` is a deep link to a file on a branch.
- **F1-C-03** Route `/code/:repositoryRid/branches/:branch/pr/:prRid` opens review mode.
- **F1-C-04** Keybinding `Cmd/Ctrl+S` saves the active editor.
- **F1-C-05** Keybinding `Cmd/Ctrl+P` opens quick file picker.
- **F1-C-06** Keybinding `Cmd/Ctrl+Shift+P` opens command palette.
- **F1-C-07** Keybinding `Cmd/Ctrl+Enter` triggers build/run.
- **F1-C-08** Keybinding `Cmd/Ctrl+B` toggles file tree.
- **F1-C-09** Keybinding `Cmd/Ctrl+J` toggles bottom drawer.
- **F1-C-10** A single `useRepoStore` Zustand slice owns `{repositoryRid, currentBranch, openFiles, dirtyFiles, activeTabPath, terminalLines}`.
- **F1-C-11** Network calls go through a typed `apiClient` generated from the Conjure IR (B2 contract); raw `fetch` to backend endpoints from components is a regression.
- **F1-C-12** Two browser tabs on the same repo share editor state via BroadcastChannel; saves synchronise across tabs.
- **F1-C-13** On network loss the editor enters Offline mode; saves queue locally and replay on reconnect with conflict detection (delegated to F4).
- **F1-C-14** Panel sizes persist across reload (IndexedDB scoped per repo RID).
- **F1-C-15** Acceptance: opening `/code/<rid>` shows the file tree and opens README.md by default if present.
- **F1-C-16** Acceptance: Monaco TS LSP autocompletes against OSDK-generated types.

**Section count: F1-C-01 .. F1-C-16 (16 IDs)**

---

## F2 — File Tree & VFS Adapter

Source: `tasks/code-repository/code-repository-tasks.md:884-911`.

- **F2-C-01** Default branch tree fetched on mount via `B2.listFiles`.
- **F2-C-02** Folder click triggers single-level lazy fetch.
- **F2-C-03** File click triggers `B2.readFile`, opens Monaco tab.
- **F2-C-04** Rename / delete in tree marks `dirtyFiles`; persisted on commit (F4).
- **F2-C-05** New-file action shows pending icon until first save.
- **F2-C-06** Editor file size limit 5 MB; larger renders binary/large placeholder with download.
- **F2-C-07** Markdown (`.md`) files render in split preview pane.
- **F2-C-08** `.osdk-generated/` is shown but read-only with banner explaining auto-regen.
- **F2-C-09** `Cmd/Ctrl+P` quick-open uses `B2.search?repositoryRid=&q=` (server-side fuzzy match).
- **F2-C-10** `Cmd/Ctrl+Shift+F` full-text search uses server-side grep with 1000-result cap (v1).
- **F2-C-11** EOL preserved on save (Monaco respects original EOL convention).
- **F2-C-12** Acceptance: tree matches `git ls-tree -r` of branch HEAD.
- **F2-C-13** Acceptance: rename `src/index.ts → src/main.ts` produces a single commit, one rename, same blob SHA.

**Section count: F2-C-01 .. F2-C-13 (13 IDs)**

---

## F3 — Repository Initialization Wizard

Source: `tasks/code-repository/code-repository-tasks.md:914-935`.

- **F3-C-01** Step 1: 4-column type picker (Transforms / Functions / Models / Libraries) populated from `B3.listTemplates` filtered by category.
- **F3-C-02** Step 2: name input has live regex validation (G-C-31), parent-folder picker via Compass UI, default-branch selector defaulting to `main`.
- **F3-C-03** Step 3: optional advanced — compute profile + initial branch protection toggle.
- **F3-C-04** Step 4: confirm calls `B2.createRepository` with a client-side UUIDv4 `Idempotency-Key`; saga progress is shown inline.
- **F3-C-05** On success: redirect to `/code/:rid` and show dismissible Welcome tour persisted in IndexedDB.
- **F3-C-06** `CodeRepos:NameConflict` highlights the name field with a link to the existing repo.
- **F3-C-07** `Templates:NotFound` displays unrecoverable error + retry.
- **F3-C-08** Network/timeout retries reuse the same `Idempotency-Key`.
- **F3-C-09** Acceptance: TS Functions + name `My First Function Gena` → repo created, IDE opens on `main` with template files visible.
- **F3-C-10** Acceptance: rapid double-submit creates exactly one repo (idempotency).

**Section count: F3-C-01 .. F3-C-10 (10 IDs)**

---

## F4 — Branch Switcher & Commit Panel

Source: `tasks/code-repository/code-repository-tasks.md:939-969`.

- **F4-C-01** Branch dropdown lists branches from `B2.listBranches` with HEAD short-sha, last-commit-author, protection badge.
- **F4-C-02** "Create branch from <current>" inline action validates name regex (G-C-29).
- **F4-C-03** Switching branch with dirty edits prompts: stash, discard, or cancel.
- **F4-C-04** Commit panel shows `dirtyFiles` with per-file Monaco split-diff preview.
- **F4-C-05** Commit message subject limit ≤ 72 chars; pre-fill `[<template>] <summary>` on feature branch.
- **F4-C-06** Commit calls `B2.commit` (B2-C-13) with `Idempotency-Key` + `If-Match: parentSha`.
- **F4-C-07** On `Stemma:RefUpdateRejected`, panel offers Rebase / Discard local / Force-push (force-push only when branch unprotected).
- **F4-C-08** Rebase calls `B2.rebaseOntoHead`; conflicts open the 3-pane resolver.
- **F4-C-09** Conflict resolver: theirs / base / ours panes with accept buttons; on resolve, retry commit.
- **F4-C-10** Acceptance: paste code, click Commit → single commit with one file change `src/index.ts`.
- **F4-C-11** Acceptance: concurrent commit by another user surfaces rebase prompt without losing local edits.

**Section count: F4-C-01 .. F4-C-11 (11 IDs)**

---

## F5 — Tag & Release Dialog

Source: `tasks/code-repository/code-repository-tasks.md:973-997`.

- **F5-C-01** Modal triggered by tag icon next to Commit.
- **F5-C-02** Shows last 10 tags from `B2.listTags` with dates + CI status badges.
- **F5-C-03** Major/Minor/Patch radio with auto-computed next semver.
- **F5-C-04** Optional pre-release label `-rc.1`.
- **F5-C-05** Optional release notes (markdown) → tag annotation message.
- **F5-C-06** Submit calls `B2.createTag({branch, sha:HEAD, name, annotation})`.
- **F5-C-07** UI switches to Branches → Tags & releases subview after submit; live polls `B6.getRun` (1 s) until terminal.
- **F5-C-08** Tag name conflict detected pre-submit via `B1.listRefs`.
- **F5-C-09** Pre-release tags don't bump default-branch resolution; warning shown.
- **F5-C-10** Tag on non-default branch shows yellow "preview release" banner.
- **F5-C-11** Acceptance: Major selection on a fresh repo → `v1.0.0` annotated, CI runs, function published, visible in `B8.listVersions`.

**Section count: F5-C-01 .. F5-C-11 (11 IDs)**

---

## F6 — Resource Imports Panel

Source: `tasks/code-repository/code-repository-tasks.md:1001-1023`.

- **F6-C-01** Header with Add button + currently-imported list (icon by kind, apiName, "rename detected" badge when snapshot ≠ current OMS).
- **F6-C-02** Add modal step 1: Ontology dropdown from OMS.
- **F6-C-03** Add modal step 2: search bar + type filter chips, paginated 50 at a time.
- **F6-C-04** Add modal step 3: multi-select; Save calls `B4.addImports`.
- **F6-C-05** Per-item context menu: Open in OM, Remove from imports, View generated SDK.
- **F6-C-06** Post-save toast: "Generating OSDK… (Run #abcd)"; on B5 completion: "OSDK updated. New types: GenaClinic, GenaFinancial. Preview." (links to file).
- **F6-C-07** `Imports:NotImportedInProject` → inline error + "Import to project" button (opens Compass UI in new tab).
- **F6-C-08** Removing an entity referenced in code: confirm dialog with impact summary + warning about CI failure.
- **F6-C-09** Acceptance: search "Clinic" + "Financial" → both imported, OSDK regenerates within 5 s.

**Section count: F6-C-01 .. F6-C-09 (9 IDs)**

---

## F7 — Live Preview / Functions Tab

Source: `tasks/code-repository/code-repository-tasks.md:1027-1055`.

- **F7-C-01** Function discovery via Web Worker AST walk on every Monaco buffer change (debounce 300 ms).
- **F7-C-02** TS: walks for `@Function`-decorated exports.
- **F7-C-03** Python: equivalent decorator walk.
- **F7-C-04** Inputs panel renders typed widgets per parameter.
- **F7-C-05** Object type input → autocomplete via `OSS.searchObjects(rid, query)` returning top 20 with primary key.
- **F7-C-06** Object set input → existing-set picker or inline build.
- **F7-C-07** Optional types → "use default" toggle.
- **F7-C-08** Run button calls `B9.invoke` with `allowMutations=false` by default; checkbox shown only if signature is Action.
- **F7-C-09** Result tab renders typed output (number with separators, object instance with title + RID link, etc.), execution time, logs, inputs echo.
- **F7-C-10** "Auto-run on save" toggle re-invokes on every successful save.
- **F7-C-11** SSE stream from `B9.invoke` shows logs as they arrive.
- **F7-C-12** TS compile error disables Run with tooltip pointing to first error.
- **F7-C-13** Function-name conflict surfaces ambiguity warning.
- **F7-C-14** Mutation attempt without checkbox → inline error + retry-with-mutations checkbox.
- **F7-C-15** Acceptance: select `calculateDaysSalesOutstanding`, Run → `40.51` in Result tab within 2 s warm.
- **F7-C-16** Acceptance: editing function and saving auto-reruns and shows new result.

**Section count: F7-C-01 .. F7-C-16 (16 IDs)**

---

## F8 — Checks / Builds Status Panel

Source: `tasks/code-repository/code-repository-tasks.md:1059-1083`.

- **F8-C-01** Bottom-drawer tab named "Checks".
- **F8-C-02** Header filters: branch (default current), trigger, state.
- **F8-C-03** Run row format: `[icon-status] <commit-sha7> <commit-message> · <branch> · <duration> · <triggered-by>`.
- **F8-C-04** Click expands to stage list with state, duration, log button.
- **F8-C-05** Log viewer is xterm.js or ANSI-aware React; SSE for live runs (`B6.streamLogs`); paginated `B6.getLogChunk` for finished.
- **F8-C-06** `Cmd/Ctrl+F` searches in-log.
- **F8-C-07** ESLint/pyright/pytest failures parsed for `<path>:<line>:<col>` and rendered as clickable links opening Monaco at position.
- **F8-C-08** Top-bar status badge (green/yellow/red) reflects latest run on current branch; tooltip shows last run time + triggerer.
- **F8-C-09** Cancelled run: SSE closes with terminating event; UI shows "Cancelled at <stage>".
- **F8-C-10** Logs > 100 MB paginated; download-full-log button available.
- **F8-C-11** Run on a deleted branch: still navigable; shows "Branch deleted" banner.
- **F8-C-12** Acceptance: pushing a commit shows the run < 1 s; QUEUED → RUNNING → SUCCEEDED visible live.
- **F8-C-13** Acceptance: a `src/index.test.ts:42:5` failure is clickable and opens Monaco at that location.

**Section count: F8-C-01 .. F8-C-13 (13 IDs)**

---

## F9 — Pull Request / Code Review UI

Source: `tasks/code-repository/code-repository-tasks.md:1087-1126`.

- **F9-C-01** `B2.createPullRequest POST /repositories/{rid}/pull-requests` body `{sourceBranch, targetBranch, title, description}`.
- **F9-C-02** `B2.listPullRequests GET /repositories/{rid}/pull-requests?state=&pageSize=` cursor-paginated.
- **F9-C-03** `B2.getPullRequest GET /pull-requests/{prRid}`.
- **F9-C-04** `B2.addReview POST /pull-requests/{prRid}/reviews` body `{decision: APPROVE|REQUEST_CHANGES|COMMENT, comments[]}`.
- **F9-C-05** `B2.addComment POST /pull-requests/{prRid}/comments` body `{path, line, body, threadId?}`.
- **F9-C-06** `B2.mergePullRequest POST /pull-requests/{prRid}:merge` body `{strategy: MERGE|SQUASH|REBASE, message?}` requires `If-Match`.
- **F9-C-07** PR list: sortable by date/state/author; row shows title, branches, CI badge, approval count.
- **F9-C-08** PR detail tabs: Overview, Files changed, Conversation.
- **F9-C-09** Files changed: split or unified Monaco diff with inline-comment threads.
- **F9-C-10** Conversation: chronological event log of comments, reviews, force-pushes, CI events.
- **F9-C-11** Strategy picker default `MERGE` unless repo settings override.
- **F9-C-12** Pre-flight: re-fetch CI status, latest sha, mergeable state. Disabled with reason when blocked.
- **F9-C-13** Merge `If-Match` set to latest sha; stale sha → 412 surfaced as "branch advanced; refresh".
- **F9-C-14** Source-branch update post-approval: approvals reset only when `repoSettings.dismissStaleApprovals=true`.
- **F9-C-15** Conflicts: merge disabled; "Resolve conflicts" opens the F4-style resolver against the PR's working merge.
- **F9-C-16** Acceptance: protected `main` PR cannot merge until CI passes AND ≥ 1 approval present.

**Section count: F9-C-01 .. F9-C-16 (16 IDs)**

---

## F10 — Repo Settings & Admin UI

Source: `tasks/code-repository/code-repository-tasks.md:1130-1158`.

- **F10-C-01** General section: display name, default branch, archive/unarchive, transfer ownership (calls Compass parent move).
- **F10-C-02** Branches section: protected branches multi-select with glob, required PR, required approvals, dismiss-stale toggle, branch-name regex.
- **F10-C-03** Tags section: tag-name regex, "tags require admin to delete" toggle.
- **F10-C-04** Build section: compute profile (default / warm-pool / high-memory), enabled checks (lint / unit tests / antipattern), encrypted-at-rest build env vars.
- **F10-C-05** Webhooks section: list/create/edit/delete `B10` subscriptions.
- **F10-C-06** Danger zone: delete repository (type-the-name confirmation).
- **F10-C-07** Save model: each section calls `B2.updateRepoSettings` with `If-Match`; on success the server commits `repoSettings.json` to the default branch as `chore: update repoSettings.json (UI)`.
- **F10-C-08** Stale ETag → "settings changed elsewhere; reload".
- **F10-C-09** Regex fields tested live with sample input.
- **F10-C-10** Glob patterns validated.
- **F10-C-11** Webhook target URLs must be HTTPS in non-dev env.
- **F10-C-12** Removing protected-branch entry: confirm dialog warns about side effects.
- **F10-C-13** Archiving: blocks pushes but keeps CI history readable.
- **F10-C-14** Deletion: irreversible after 30 days (matches B1-C-11 tombstone window).
- **F10-C-15** Acceptance: setting `main` protected blocks direct push (verified via Stemma).
- **F10-C-16** Acceptance: setting tag regex `^v\d+\.\d+\.\d+$` rejects `release-1` push, accepts `v1.0.0`.

**Section count: F10-C-01 .. F10-C-16 (16 IDs)**

---

## Totals

| Section | IDs |
|---|---|
| G (Global) | 54 |
| B1 Stemma | 51 |
| B2 Code Repository | 48 |
| B3 Templates | 18 |
| B4 Imports | 17 |
| B5 OSDK Generator | 17 |
| B6 Jemma | 34 |
| B7 JobSpec | 15 |
| B8 Functions Registry | 30 |
| B9 Live Preview | 24 |
| B10 Stemma Events / Branch Protection | 25 |
| F1 IDE Shell | 16 |
| F2 File Tree | 13 |
| F3 Init Wizard | 10 |
| F4 Branch & Commit | 11 |
| F5 Tag & Release | 11 |
| F6 Resource Imports Panel | 9 |
| F7 Live Preview Tab | 16 |
| F8 Checks / Builds | 13 |
| F9 PR / Code Review | 16 |
| F10 Settings & Admin | 16 |
| **Total** | **464** |

Every test added under §Testing Requirements MUST cite at least one ID from this file in its name. Tests that fail when a contract is violated are the only acceptable form of "contract coverage" for DoD purposes.
