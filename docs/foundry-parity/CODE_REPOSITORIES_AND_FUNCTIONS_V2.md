# Foundry Parity — Code Repositories & TypeScript Functions v2

> ## ✅ Implementation update (2026-05-31) — TypeScript Functions v2 is now functional fullstack
>
> The gaps and defects this document originally catalogued for **Functions v2**
> have been **implemented**. What changed:
>
> | Area | Before | After |
> |---|---|---|
> | **A9** If-Match concurrency | 🔴 stale→400, malformed→500 | ✅ stale→**412** (`CodeRepos:PreconditionFailed`), malformed→**400** (`parseVersionEtagOrNull`) |
> | **B3** Functions Registry | ∅ not mounted | ✅ live at `/api/v1/functions/*` (`server.ts` re-base shim + `globalAuth` allowlist) |
> | **A16/B5** Tag & Release | ∅ no endpoint | ✅ `POST /:rid/tags` discovers→builds→hashes→publishes an immutable SemVer version |
> | **B6** Backward-compat check | ∅ none | ✅ dropping a function requires a major bump; monotonic SemVer enforced |
> | **B4** SemVer/immutability | unreachable | ✅ reachable + tested (dedupe, immutable-conflict, caret resolve, yank) |
> | **B2/B7** Ontology in functions | pure compute only | ✅ injected **Ontology SDK** — `Objects.search/get/filter/aggregate` + `Edits.create/update/delete` over a snapshot; `applyEdits` persists via Action semantics |
> | **Invoke published** | n/a | ✅ `source:"published"` runs the registered artifact |
> | **Frontend** | Tag dialog was a `console.log` stub | ✅ wired to `tagAndRelease()` with real `latestTag`, toasts, refetch; invoke types carry edits/ontology |
>
> **Proof:** `scripts/foundry-parity/verify-foundry-parity.sh` → **29 PASS / 0 FAIL / 4 GAP**;
> `scripts/foundry-parity/demo-typescript-functions-v2.sh` runs the full flow over a
> seeded Flight/Airport ontology; backend unit+integration suites green; Cypress
> `foundry-parity-code-repositories.cy.ts` → 20 passing / 0 failing.
>
> The 4 remaining GAPs are **Code Repositories** features outside Functions v2:
> pagination (CR-14), Pull Requests (CR-15), branch protection (CR-16), CI checks
> (CR-17). The per-piece sections below describe the *original* audit; treat the
> table above as the current source of truth for the items it lists.
>
> **Run the demo:**
> ```bash
> bash scripts/foundry-parity/demo-typescript-functions-v2.sh
> ```

> **Purpose.** A piece-by-piece, 1:1 reference of how Palantir Foundry **Code
> Repositories** and **TypeScript Functions v2** actually behave (grounded in
> Palantir's public docs + patents), mapped against what the tellus clone does
> today, with an executable verification harness for every claim.
>
> **Author's stance.** Written as a senior engineer doing a conformance audit:
> each piece states the Foundry contract (cited), how it *should* work, the
> clone's current status, and the test ID that proves it.
>
> **Ground truth sources.** `palantir.com/docs/foundry/code-repositories/*`,
> `palantir.com/docs/foundry/functions/*`, the Palantir engineering blog
> (Stemma), and Palantir-assignee patents **US11593336B2** (data-pipeline
> branching) and **US20210365244A1** (function access system). Full URLs are
> inline per piece. Two patents that surface in keyword searches —
> US9430229B1 (merge preview) and US10114833B2 (distributed repo locking) — are
> **Atlassian** and **GitHub/Microsoft**, *not* Palantir; not used as ground truth.

---

## How to run the verification

```bash
# 1. Dependency containers (postgres at minimum) must be up:
docker compose up -d postgres opensearch zookeeper kafka schema-registry keycloak minio minio-init

# 2. Backend API conformance harness (boots its own test instance on :3055):
bash scripts/foundry-parity/verify-foundry-parity.sh
#    → prints a PASS/FAIL/GAP matrix; writes docs/foundry-parity/last-run-matrix.txt

# 3. Frontend E2E (needs the FE dev server on :3001 and a logged-in session):
cd ../tellus-fe && npx cypress run --spec cypress/e2e/foundry-parity-code-repositories.cy.ts
```

**Verdict legend**

| Verdict | Meaning |
|---|---|
| **PASS** | Clone matches the Foundry contract. |
| **FAIL** | Endpoint exists but behaves incorrectly — a real defect to fix. |
| **GAP** | Foundry feature has **no** clone implementation — must be built for 1:1. |
| **PARTIAL** | Works but diverges materially (documented under the piece). |

**Latest run:** 19 PASS · 2 FAIL · 9 GAP (backend). See "Scoreboard" at the end.

---

## System-name mapping (Foundry → clone)

| Foundry internal name | What it is | Clone equivalent |
|---|---|---|
| **Stemma** | Distributed Git server (JGit DfsRepository + AtlasDB); immutable objects, mutable refs; ref-level write auth via a JGit `PreReceiveHook`. [blog.palantir.com/stemma](https://blog.palantir.com/stemma-distributed-git-server-70afbca0fc29) | `src/services/stemma/*` (Postgres store) **but the running server uses the in-memory adapter** — RIDs are `ri.stemma.main.repository.<uuid>`. |
| **Compass** | Catalog/folder/Project filesystem; Trash; READMEs. [docs](https://www.palantir.com/docs/foundry/compass/overview) | `parentFolderRid`/`project_rid` + `CompassAdapter` (in-process stub). |
| **Functions registry** | Platform-wide store of published, versioned functions. [docs](https://www.palantir.com/docs/foundry/functions/manage-functions) | `function_version` table + `functionsRegistry/*` — **not mounted in the server**. |

---

# PART A — CODE REPOSITORIES

### A1 · Repository creation from a template — **PASS** (`CR-1`, `CR-1b`)
- **Foundry:** `+ New > Code repository`, pick a language/stack template (Python, PySpark, Java, SQL, R, Containers; Functions: **TypeScript v1, TypeScript v2, Python**), name it, **Initialize repository**. Repo is a Compass resource in a Project; default branch usually `master`. [overview](https://www.palantir.com/docs/foundry/code-repositories/overview), [functions getting-started](https://www.palantir.com/docs/foundry/functions/getting-started)
- **Should work:** `POST` create scaffolds a stack-specific tree from the chosen template and returns the new repo with a version/ETag.
- **Clone:** `POST /api/v1/code-repositories {displayName, parentFolderRid, templateId:"typescript-functions", templateVersion:"2.4.0", defaultBranch}` → `201`, `rid=ri.stemma.main.repository.*`, `state=ACTIVE`, `ETag: W/"1"`. Template catalog: `typescript-functions@2.4.0`, `python-functions@1.0.0`, `transforms-{python,java,sql}@1.0.0` (`src/services/templates/manifest.ts`).
- **Divergence:** Foundry's default branch is `master`; the clone accepts any (`defaultBranch`). No TypeScript **v1** template (only v2 + python + transforms). Creation is a 4-step **saga** (Compass reserve → Stemma create → template push → activate) — a reasonable model of Foundry's provisioning.

### A2 · Authentication & access — **PASS** (`CR-2`)
- **Foundry:** repo read auth via Stemma `RepositoryResolver`; unauthorized = denied. [stemma](https://blog.palantir.com/stemma-distributed-git-server-70afbca0fc29)
- **Clone:** every `/api/v1/code-repositories/*` route requires a Bearer JWT/PAT; unauthenticated → `401` with the `Stemma:Unauthenticated` envelope. Test-only bypass `X-Tellus-Test-Principal` gated behind `CODE_REPOS_TEST_AUTH=1`.

### A3 · Idempotent creation — **PASS** (`CR-3`)
- **Foundry:** creation is a provisioning operation; safe-retry is implied by the saga model (patent US11593336B2 describes pointer-based isolated provisioning).
- **Clone:** `Idempotency-Key` (UUIDv4) on `POST` → replay returns the **same** rid with `X-Idempotent-Replay: true`. Two-layer idempotency (ledger unique index + HTTP middleware).

### A4 · Name uniqueness in a folder — **PASS** (`CR-4`)
- **Foundry:** repo names are unique within their Project/folder. [overview](https://www.palantir.com/docs/foundry/code-repositories/overview)
- **Clone:** duplicate `(parentFolderRid, lower(displayName))` while `state='ACTIVE'` → `409 CodeRepos:NameConflict` (enforced by a partial unique index).

### A5 · Get / IDOR-safety — **PASS** (`CR-5`, `CR-5b`)
- **Foundry/REST norm:** an object you can't see returns 404, not 403 (no existence leak).
- **Clone:** `GET /:rid` → 200 with strong `ETag: W/"<resource_version>"`; unknown/forbidden rid → `404`.

### A6 · Branching model — **PASS (read) / PARTIAL** (`CR-6`)
- **Foundry:** default branch (usually `master`); protected branches are **not directly editable** — you work on a **sandbox branch** and the **Branches tab** lists all branches. [navigation](https://www.palantir.com/docs/foundry/code-repositories/navigation), [faq](https://www.palantir.com/docs/foundry/code-repositories/faq)
- **Clone:** `GET /:rid/branches` lists branches (default `master` present), with a `branch_cache` table + Stemma-HEAD fallback.
- **Divergence (PARTIAL):** no **sandbox-branch** concept and no "protected vs editable" distinction — commits go directly to any branch (see A12). No create-branch endpoint surfaced.

### A7 · Commits — **PASS** (`CR-7`, `CR-7b`, `CR-8`, `CR-10`)
- **Foundry:** commit from a sandbox branch; **a commit message is mandatory** (the dialog requires one); commits are immutable, content-addressed; checks auto-run after commit. [overview](https://www.palantir.com/docs/foundry/code-repositories/overview), [navigation](https://www.palantir.com/docs/foundry/code-repositories/navigation)
- **Clone:** `POST /:rid/branches/:branch/commits {message, parentSha, fileChanges:[{path, op:add|modify|delete, contentBase64?, mode?}]}`:
  - empty `message` → `400` ✔ (matches Foundry's mandatory-message rule).
  - `If-Match: "<parentSha>"`; stale parent SHA → `412 StaleRefHead` ✔ (matches "push rejected on stale ref").
  - committed blob is immediately readable via `GET …/files?path=` ✔.
- **Divergence:** checks do **not** auto-run after commit (see A16); commits live only in the in-memory Stemma (not durable — see "Cross-cutting risks").

### A8 · File tree & blob read — **PASS** (`CR-9`, `CR-9b`, `CR-10`)
- **Foundry:** web IDE with a file tree ("Foundry Explorer"), IntelliSense/lint, Markdown READMEs, sandbox-branch editing. [navigation](https://www.palantir.com/docs/foundry/code-repositories/navigation)
- **Clone:** `GET …/tree?path=&depth=` → scaffolded files; **strong ETag = tree sha** with `If-None-Match → 304`. `GET …/files?path=` → blob (base64 if binary, 5 MiB cap). Frontend uses Monaco + Blueprint tree (FE parity below).

### A9 · Optimistic concurrency (metadata) — **PARTIAL: 2 DEFECTS** (`CR-11`, `CR-11b`, `CR-11c`, `CR-11d`)
- **Foundry/REST norm (RFC 7232):** conditional writes use `If-Match`; a **version mismatch → 412 Precondition Failed**; a missing precondition → 428.
- **Clone:** `PATCH /:rid` with correct `If-Match: W/"N"` → 200 and bumps the version ✔. Missing `If-Match` → 400 ✔ (Foundry-acceptable; 428 would be more correct).
  - 🔴 **DEFECT `CR-11b`:** a **stale** `If-Match` returns `CodeRepos:InvalidSettings` → **400**, not **412**. The route conflates ETag-mismatch with generic invalid-input (`src/services/codeRepository/admin/routes.ts:348`). A client cannot distinguish "your input was bad" from "someone else edited this first."
  - 🔴 **DEFECT `CR-11d`:** a **malformed** `If-Match` (e.g. `not-a-version`) → **500** (`parseEtag` returns `NaN`, cast to `bigint` crashes the query — `routes.ts:2001` + `:338`). Should be a clean 400/412.
- **Fix sketch:** map ETag-mismatch to `412` with a dedicated `CodeRepos:PreconditionFailed`; validate `parseEtag` and return `400` on NaN before hitting Postgres.

### A10 · Ontology resource imports — **PASS (surface) / PARTIAL** (`CR-12`)
- **Foundry:** the **Ontology tab** + **Resource Imports sidebar** import object/link/interface/action types so code can reference them via `@foundry/ontology-api`; imports are **version-controlled in `resources.json`**. [ontology-imports](https://www.palantir.com/docs/foundry/code-repositories/ontology-imports), [resource-imports-sidebar](https://www.palantir.com/docs/foundry/functions/resource-imports-sidebar)
- **Clone:** `GET/PUT /:rid/resource-imports` with a content-derived ETag and replace-all semantics → binds a repo to an ontology + imported object/link types. FE has a Resource Imports panel with a localStorage warm-cache.
- **Divergence (PARTIAL):** imports are stored in a DB table, **not** as a versioned `resources.json` in the repo tree — so they aren't branch/commit/revert-able the way Foundry's are. No generated `@foundry/ontology-api` typed package.

### A11 · Lifecycle — soft-delete / Trash — **PASS (delete) / PARTIAL** (`CR-13`)
- **Foundry:** resources can be **trashed and restored**, or **permanently deleted**. [delete-resource](https://www.palantir.com/docs/foundry/api/filesystem-v2-resources/resources/delete-resource)
- **Clone:** `DELETE /:rid` (If-Match) → soft-trash to `state='TRASHED'` (204) ✔.
- **Divergence (PARTIAL):** no **restore** and no **permanent-delete** endpoint; no `ARCHIVED` transition surfaced.

### A12 · Pagination — **GAP** (`CR-14`)
- **Foundry:** repo browse is paginated.
- **Clone:** `GET /` returns `nextPageToken` but it is **always `null`** — the cursor is ignored (`routes.ts:222`). Listing >1 page of repos is impossible. FE `/browse` mirrors this ("pagination wired in F2", never landed).

### A13 · Pull Requests / Proposals — **GAP** (`CR-15`)
- **Foundry:** **Propose changes** → PR (to `master` by default) → line-by-line review + comments → **≥1 approving review** if required → **Squash-and-merge** or **Merge**. Required reviewers can be a user or group; advanced file-path approval policies. [navigation](https://www.palantir.com/docs/foundry/code-repositories/navigation), [branch-settings](https://www.palantir.com/docs/foundry/code-repositories/branch-settings)
- **Clone:** **no endpoint** (`POST /:rid/pulls` → 404). The entire code-review workflow — the heart of Foundry's collaboration model — is missing.

### A14 · Branch protection — **GAP** (`CR-16`)
- **Foundry:** protected branches can't be pushed directly; **Owners** change protection, **Owners+Editors** merge; required checks (e.g. `ci/foundry-publish`); "only allow stable versions tagged from protected branches"; enforced at the Git layer by Stemma's **`PreReceiveHook`**. [branch-settings](https://www.palantir.com/docs/foundry/code-repositories/branch-settings)
- **Clone:** **no endpoint** (`…/protection` → 404). Commits to any branch are unconditionally accepted (no pre-receive hook, no protection policy). The FE has a *simulator* page (`branch-protection`) with a hardcoded principal, but no backend enforcement.

### A15 · CI Checks / builds — **GAP** (`CR-17`)
- **Foundry:** every commit/PR runs a CI check that **compiles** the code; status in the **Checks tab** with logs; `ci/foundry-publish` gates publish; gradle `check`/`test`/`publish`; custom checks. [faq](https://www.palantir.com/docs/foundry/code-repositories/faq), [create-custom-checks](https://www.palantir.com/docs/foundry/code-repositories/create-custom-checks)
- **Clone:** **no endpoint** (`…/checks` → 404). The TS-Functions template *declares* CI steps (`install/type-check/lint/build/test/publish` — `manifest.ts`) but **nothing executes them**. No compile/type-check gate on commit.

### A16 · Tags & Releases — **GAP** (`CR-18`)
- **Foundry:** tag a commit → **Tag and release** → **publishes all functions in the repo to the functions registry**; **SemVer** `X.Y.Z` (+ prerelease); **immutable** versions; **backward-compatibility checks** before publish; tag-name regex policy. [functions-versioning](https://www.palantir.com/docs/foundry/functions/functions-versioning), [branch-settings](https://www.palantir.com/docs/foundry/code-repositories/branch-settings)
- **Clone:** **no endpoint** (`POST /:rid/tags` → 404). This is the load-bearing bridge from repo → published function; its absence is why Functions v2 can't actually publish (see B3/B5). The FE "Tag & Release" dialog is a `console.log` stub.

---

# PART B — TYPESCRIPT FUNCTIONS v2

> **Key finding:** the clone has **two unrelated "function" systems**. The one
> that runs live (`/api/v1/ontology/:id/functions`, inline source in Postgres,
> executed via Node `vm`) is **not** v2. The actual v2 surface — the
> **Functions Registry** (`function_version` table, SemVer, immutable artifacts
> built from a repo) — exists but is **not mounted** in the server.

### B1 · Function discovery in a repo — **PASS** (`FN-1`)
- **Foundry:** functions are authored in a Functions repo; TS **v2** = one function per file under `typescript-functions/src/functions/`, **`export default`**, **filename == function name**, file path is the function's identity. [ts-v2-getting-started](https://www.palantir.com/docs/foundry/functions/typescript-v2-getting-started)
- **Clone:** `GET /:rid/functions?branch=` returns the union of **published** + **working-tree** functions (200). Discovery walks the repo tree.
- **Divergence:** no enforcement that filename==function name or that there's a single default export; "Live Preview" working-tree discovery is UI-blocked (F7 AST discovery shows "unavailable").

### B2 · Invocation / Live Preview — **PARTIAL (security divergence)** (`FN-2`, `FN-2x`)
- **Foundry:** the **Functions panel → Live Preview → Run** executes a function with user-supplied inputs in an **isolated server-side runtime** (TS v1 = restricted V8, 128 MB/1 CPU/30s CPU; TS v2 = Node, up to 5 GB/8 CPU); default timeout 60s, preview up to 280s; **snapshot isolation** over the Ontology; runs **as the end user** (RLS-respecting). [getting-started](https://www.palantir.com/docs/foundry/functions/getting-started), [manage-functions](https://www.palantir.com/docs/foundry/functions/manage-functions), [permissions](https://www.palantir.com/docs/foundry/functions/permissions)
- **Clone:** `POST /:rid/functions/invoke {apiName, branch, inlineSource, inlineSourcePath, args}` transpiles TS and runs it → returns `{result, durationMs, stdout, stderr}`. Verified: `21*2 → {doubled:42}`.
- 🔴 **Divergence (`FN-2x`):** execution uses Node's **`vm` module, which is *not* a security boundary** (`src/services/functionRuntime.ts`) — escapable to host context, running **in-process inside the API**. Foundry isolates in V8/Node sandboxes out-of-process. No per-user permission/RLS context; no snapshot isolation; async functions unsupported. This is the single biggest runtime-fidelity and security gap.

### B3 · Functions Registry (publish/list/resolve/yank) — **GAP** (`FN-3`, `FN-4`)
- **Foundry:** published functions live in a platform-wide **functions registry**, searchable by name/description/API-name/RID, with multiple **immutable** versions per function and permission-tiered access (patent **US20210365244A1** "Function access system"). [manage-functions](https://www.palantir.com/docs/foundry/functions/manage-functions)
- **Clone:** the registry is **fully implemented but never mounted** — `createFunctionsApp` is not `app.use()`'d anywhere in `src/server.ts` (verified). `GET/POST /api/v1/functions/*` → 401/404 (global auth wall / catch-all, not the registry). So: no publish, no list, no resolve, no yank in the running product.
- **What's already built (just unwired):** `function_version` table with DB-level immutability (`UNIQUE(repository_rid, branch, semver)`), `runtime ∈ {NODE_20, PY_311}`, `state ∈ {AVAILABLE, YANKED}` lifecycle, sha256/commit regex checks; a `SERIALIZABLE` + `FOR UPDATE` publish path; a correct from-scratch SemVer range resolver. **Mounting it is low-effort, high-value.**

### B4 · SemVer & immutability — **GAP (unreachable)** (`FN-7`)
- **Foundry:** versions are SemVer `X.Y.Z` (+ prerelease `-rc1`); **immutable after creation**; stable versions can be gated to protected branches; API-named queries always resolve to the **latest** tag (no ranges); consumers use **caret ranges** (`^1.2.3` → max satisfying). [functions-versioning](https://www.palantir.com/docs/foundry/functions/functions-versioning), [version-range-dependencies](https://www.palantir.com/docs/foundry/functions/version-range-dependencies-for-functions)
- **Clone:** the immutability + caret-range logic **exists and is unit-tested** (`functionsRegistry/semver.ts`, `store.ts`) but is **unreachable** because the registry isn't mounted (B3). The publish path also trusts caller-supplied `artifactSha256` (never recomputes it), so `ArtifactCorrupt`/`RepositoryNotPublishable` are declared but never thrown.

### B5 · Tag → release → publish pipeline — **GAP** (`FN-5`)
- **Foundry:** tagging the repo runs version/compat checks and **publishes every function** to the registry as an immutable artifact. [getting-started](https://www.palantir.com/docs/foundry/functions/getting-started)
- **Clone:** **no producer exists** — nothing builds a function artifact from a repo + commit, hashes it, and registers it. (The orchestration "builds" in migration 077 are an unrelated data-import→Iceberg pipeline.) Without A16 (tags) + this producer, functions can never reach the registry. The FE release dialog is a stub.

### B6 · Backward-compatibility checks — **GAP** (`FN-6`)
- **Foundry:** before publishing a new version, breaking-change checks **block/warn** on: dropping a function, removing an input (even optional), reordering inputs, adding a required input, incompatible type change, output degradation. [functions-versioning](https://www.palantir.com/docs/foundry/functions/functions-versioning)
- **Clone:** none. No diff of a new version's signatures against the prior stable version.

### B7 · Ontology edits / function-backed Actions — **GAP**
- **Foundry:** **edit functions** (`@OntologyEditFunction`/`@Edits` in v1; `createEditBatch`→`getEdits()`→`OntologyEdit[]` in v2) only **persist via a configured Action**; in-function reads see pre-edit state; edits collapse to a minimal set; functions run as the end user. [edits-overview](https://www.palantir.com/docs/foundry/functions/edits-overview), [ts-v2-ontology-edits](https://www.palantir.com/docs/foundry/functions/typescript-v2-ontology-edits)
- **Clone:** the `vm` invoke path returns a plain value; there is no edit-batch API, no function-backed Action binding, no Ontology mutation path. Pure read-only ad-hoc execution.

### B8 · OSDK typing inside functions — **GAP / unrelated**
- **Foundry:** TS v2 functions get a typed `Client` + generated Ontology SDK (`@ontology/sdk`, `@osdk/functions`, `@osdk/client`). [ts-osdk](https://www.palantir.com/docs/foundry/ontology-sdk/typescript-osdk)
- **Clone:** `src/services/osdk-generator` emits an SDK for **ontology object types** (binding flow), **not** for functions; functions get no typed ontology client. No relationship between the two today.

---

## Cross-cutting risks (apply to both features)

1. 🔴 **In-memory git storage in the running server.** `server.ts:591` mounts the code-repo service with the **in-memory** Stemma adapter — branches, files, and **user commits are process-local and lost on restart**, masked by a boot-time "rehydrate" that only re-creates the *template scaffold*. Foundry's Stemma is durable + distributed. **Switch to the Postgres Stemma adapter.**
2. 🔴 **`vm` is not a sandbox.** See B2. Move to `isolated-vm` / out-of-process / WASM before any untrusted invoke is exposed.
3. 🟠 **Two function systems.** Reconcile the live inline-source ontology-functions path with the unmounted v2 registry; pick one identity model.
4. 🟠 **HTTP-contract correctness.** The 412/500 If-Match defects (A9) indicate conditional-request handling needs a pass across all mutating routes.

---

## Prioritized roadmap to 1:1

| Pri | Item | Pieces | Effort |
|---|---|---|---|
| P0 | Fix If-Match → 412 / validate parseEtag (no 500) | A9 | XS |
| P0 | Move function execution off `vm` to an isolate | B2 | M |
| P0 | Durable Stemma (Postgres adapter in prod) | cross-cut #1 | M |
| P1 | Mount the Functions Registry app | B3, B4 | S |
| P1 | Tag & Release endpoint + artifact producer (repo→registry) | A16, B5 | L |
| P1 | Pull Requests / Proposals (propose→review→merge) | A13 | L |
| P2 | Branch protection + pre-receive enforcement | A14 | M |
| P2 | CI checks (run template's compile/type-check on commit) | A15 | L |
| P2 | Backward-compat checks on publish | B6 | M |
| P2 | Real pagination; restore/permanent-delete; resources.json | A12, A11, A10 | M |
| P3 | Function-backed Actions / Ontology edits; OSDK-in-functions | B7, B8 | XL |

---

## Scoreboard (latest backend harness run)

```
PASS=29  FAIL=0  GAP=4
PASS  CR-1 CR-1b CR-2 CR-3 CR-4 CR-5 CR-5b CR-6 CR-7 CR-7b CR-8 CR-9 CR-9b CR-10
      CR-11 CR-11b CR-11c CR-11d CR-12 CR-13 CR-18
      FN-1 FN-3 FN-4 FN-5 FN-5b FN-6 FN-7 FN-8
GAP   CR-14 (pagination)  CR-15 (Pull Requests)  CR-16 (branch protection)  CR-17 (CI checks)
```

Was `PASS=19 FAIL=2 GAP=9` before the Functions-v2 implementation; the 2 FAILs
(If-Match 412/500) are fixed and 6 of the 9 GAPs (registry, tag&release,
immutability, backward-compat, caret resolve, ontology invoke) are now PASS.

The machine-readable matrix is regenerated at `docs/foundry-parity/last-run-matrix.txt` on every run.
