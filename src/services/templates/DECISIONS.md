# DECISIONS.md — transforms-python template parity (TR_PYTHON_2_0_0)

Records the four policy decisions the parity audit (`docs/foundry-parity/` /
prior audit) left open, plus the Step 0 verification that grounds them. Written
before the implementation diff (per the brief's Step 1) so nothing is decided
implicitly inside code.

## Step 0 — verification (2026-07-09)

- **Foundry docs re-fetched live** (curl of
  `https://www.palantir.com/docs/foundry/transforms-python/project-structure/`,
  776,970 bytes). The live page **confirms** the audit's file list with **no
  material difference** from the brief's §3/§4:
  - Visible tree: `conda_recipe/meta.yaml`, `src/myproject/__init__.py`,
    `src/myproject/datasets/__init__.py`, `src/myproject/datasets/examples.py`,
    `src/myproject/pipeline.py`, `src/setup.cfg`, `src/setup.py`.
  - Hidden (mentioned on live page): **inner AND outer `build.gradle`**
    (not-overwritten on upgrade), `gradle.properties` + `versions.properties`
    (merged on upgrade).
  - **NOT mentioned on the live page** (so still unconfirmed, sourced only from
    the audit's lower-priority summary): `templateConfig.json`,
    `conda-versions.run.linux-64.lock`, `src/.pylintrc`.
  - `examples.py` ships **commented out** ("an uncommented version of the
    default", "After un-commenting the sample code"). ⚠️ resolved.
  - `meta.yaml` pins `python 3.9.*` in build AND run; run deps
    `transforms {{ PYTHON_TRANSFORMS_VERSION }}`, `transforms-expectations`,
    `transforms-verbs`; build script
    `python setup.py install --single-version-externally-managed --record=record.txt`.
  - `setup.py` uses `name=os.environ['PKG_NAME']`, `version=os.environ['PKG_VERSION']`,
    `author='{{REPOSITORY_ORG_NAME}}'`, `find_packages(exclude=['contrib','docs','test'])`,
    `install_requires=[]`, entry point `'transforms.pipelines': ['root = myproject.pipeline:my_pipeline']`.
  - `pipeline.py` is 4 lines, **no blank line** between the imports and
    `my_pipeline = Pipeline()` (the brief's §4 block showed a blank line; the
    live doc's "Copied 1-4" widget and the curled HTML show 4 contiguous lines —
    we match the live doc).
- **Clean-slate confirmed**: `grep` for `myproject`/`discover_transforms`/
  `transforms.pipelines`/`conda_recipe`/`find_packages`/`PKG_NAME` across
  `tellus/src` (excluding tests/docs) = 0 hits. No existing Foundry-faithful
  transforms-python content to collide with.
- **Production wiring confirmed**: `deps.template` → `InMemoryTemplate`
  (`inMemory.ts` ~line 438), built at `mount.ts:77` as
  `new InMemoryTemplate({ stemma })` with the real `PostgresStemma` from
  `server.ts:782`. `postgres.ts` is the Stemma *storage* adapter (`commitFiles`)
  only — not a separate template source. Flow `getTemplateManifest → substitute
  → stemma.commitFiles`; orchestrated by `saga/executor.ts:284`.
- **No migration needed for a new version**: `templates_index` holds metadata
  only (migration `056_b3_templates.sql` + `store.ts` confirm). The list route
  cross-references `listTemplateManifests()` (in-memory catalog) as the source
  of truth; `upsertTemplatesIndex` has **no boot call site** in production code
  (the cache is effectively unused — deprecation flags fall through to the
  manifest's `deprecated` field). Adding `TR_PYTHON_2_0_0` to `manifest.ts` is
  sufficient for it to be listable + scaffoldable.
- **Existing harness to reuse**: `tests/integration/code-repos/code-repository/scaffold-parity-integration.test.ts`,
  `tests/unit/code-repos/templates/scaffold-unit.test.ts`,
  `tests/integration/code-repos/templates/admin-routes-integration.test.ts`;
  bash pattern `scripts/demo-code-repository-commit.sh` (curl + `X-Tellus-Test-Principal`
  header + `CODE_REPOS_TEST_AUTH=1`); cypress pattern
  `tellus-fe/cypress/e2e/transforms-python-create.cy.ts` (`X-Tellus-Test-Principal`
  + `TELLUS_SESSION_EXPIRES` cookie + `cy.request` to `${apiUrl}`). The
  transforms-parity CI workflow checks out `tellus-fe` and runs its cypress.

## Decision 1 — Do tellus's 5 extra files survive?

- **`ci.yml` — KEEP**, with one necessary consistency fix: the lint stage
  `python -m pyflakes transforms/` → `python -m pyflakes src/` because 2.0.0
  moves sources from the flat `transforms/` dir to `src/<package>/`. The
  `discover`/`build`/`test` stages are CLI command names (`tellus transforms
  discover` etc.), not path refs, so they are unchanged. (See follow-up: tellus
  runtime discover/build may need to learn the `src/<pkg>/datasets/` layout —
  runtime concern, out of scaffold scope.)
- **`repoSettings.json` — KEEP** as-is (no dir references; tellus platform file
  enforced via git hooks).
- **`transforms/example.py` — role superseded** by the ported
  `src/<package>/datasets/examples.py` (Foundry's commented-out starter). Not
  shipped in 2.0.0.
- **`transforms/enrich.py` and `transforms/_incremental_example.py` — REMOVED**
  from 2.0.0. Foundry ships exactly one starter transform (commented-out
  `examples.py`); tellus's `@transform_df` / `@incremental` demos were
  tellus-invented extras with no Foundry counterpart.

Rationale: `ci.yml`/`repoSettings.json` are tellus/Stemma-Jemma platform
plumbing outside Foundry's domain; the three `transforms/*.py` were Foundry-domain
starter content competing with the ported layout.

## Decision 2 — Package name  (USER-DIRECTED)

Foundry's literal default package name is `myproject`. **User direction
("use palantir") overrides this**: the package name is **`palantir`**,
implemented as a new `packageName` template parameter with
`default: "palantir"` (regex `^[a-z][a-z0-9_]{0,63}$`). The parameter is wired
into every location that uses the package name: the `src/{{packageName}}/…`
paths, `from {{packageName}} import datasets` in `pipeline.py`, and the
`root = {{packageName}}.pipeline:my_pipeline` entry point in `setup.py`.

- This is a **deliberate, user-directed deviation from strict 1:1** (Foundry
  literal = `myproject`; tellus default = `palantir`). Flagged in the PR
  description. All other structure is verbatim Foundry.
- The `code-repositories/new` wizard currently sends **no** template parameters,
  so the default `palantir` always applies (until a future FE change wires
  `packageName` derivation — out of scope here). The parameter nonetheless
  allows API callers to override.
- **Scope beyond strict 1:1 cloning**, called out explicitly per the brief.
- If `myproject` is later preferred, change the `default` to `"myproject"` (or
  to `"<derived from repo name>"` for per-repo names, matching
  `TS_FUNCTIONS_2_4_0`/`PY_FUNCTIONS_1_0_0`).

## Decision 3 — Unconfirmed files (do NOT fabricate)

Per the guardrail, no content is invented for files whose default contents are
not documented on the live Foundry page. **Ship only confirmed-content or
confirmed-empty pieces; omit the rest with a tracked follow-up.**

- **Ship verbatim (live-confirmed content):** `src/setup.py`, `src/<pkg>/pipeline.py`,
  `src/<pkg>/datasets/examples.py`, `conda_recipe/meta.yaml`.
- **Ship empty (confirmed-empty package markers, per brief §4):**
  `src/<pkg>/__init__.py`, `src/<pkg>/datasets/__init__.py`.
- **Ship tellus tooling (NOT Foundry content — Foundry equivalents are UNVERIFIED
  or replaced by original tellus design; see Reconciliation §5):**
  - `src/setup.cfg` — Foundry ships this file but its default body is NOT documented
    (`# UNVERIFIED`); tellus ships its OWN OSS tool config (pytest/pycodestyle/pylint),
    mapping Foundry's pep8/pylint Gradle plugins to OSS tools. No fabricated Foundry body.
  - `requirements.lock` — pip-tools lock resolving `meta.yaml` run-deps; replaces
    Foundry's Hawk resolution (`# original implementation, not a port`; Hawk UNVERIFIED).
  - `Makefile` — convenience orchestration (`make check` = lint+test+build); replaces
    Foundry's Gradle Checks (`# original implementation, not a port`).
- **OMIT (presence confirmed but content undocumented → leave out, do not
  fabricate):**
  - `build.gradle` (inner AND outer) — live page confirms presence +
    "not-overwritten" upgrade category but gives no content; even the paths for
    inner vs outer are not documented, so they cannot be placed correctly.
  - `gradle.properties`, `versions.properties` — live page confirms presence +
    "merged on upgrade" but gives no content. (The audit-summary claim that
    `gradle.properties` "holds `condaPackageName`" is **not corroborated** by
    the live page.)
  - `templateConfig.json` — **0 hits on the live page** for transforms-python
    (it appears only in tellus's `TS_FUNCTIONS_2_4_0` and the audit summary).
    Not added.
  - `conda-versions.run.linux-64.lock` — 0 hits on the live page; only the
    summary asserts it.
  - `src/.pylintrc` — 0 hits on the live page; summary says "optional".

**Tracked follow-ups (would require a live Foundry bootstrap to resolve):**
populate `build.gradle` (inner+outer), `gradle.properties`,
`versions.properties`, `templateConfig.json`, `conda-versions.run.linux-64.lock`,
`src/.pylintrc` with verified on-disk content. Until then these remain ❓ by
design, not by omission.

**Token-handling note:** Foundry's own template/build variables in the ported
files — `{{ PACKAGE_NAME }}`, `{{ PACKAGE_VERSION }}`, `{{ PYTHON_TRANSFORMS_VERSION }}`
(in `meta.yaml`) and `{{REPOSITORY_ORG_NAME}}` (in `setup.py`) — are Foundry's
concern, not tellus parameters. tellus's `substitute()` matches only no-whitespace
`{{name}}` tokens, so the spaced Foundry tokens pass through literal. The one
no-whitespace Foundry token, `{{REPOSITORY_ORG_NAME}}`, is written in the manifest
as `{{ REPOSITORY_ORG_NAME }}` (spaced) so tellus leaves it literal rather than
throwing `unknown-substitution-token`. This is a cosmetic, non-functional
deviation (Foundry's template engine and conda accept both forms) that avoids
fabricating an org name. `os.environ['PKG_NAME']`/`['PKG_VERSION']` are literal
Python (Foundry conda-build env vars) and pass through untouched.

## Decision 4 — Version bump

- **Add `TR_PYTHON_2_0_0` (version `"2.0.0"`)**; do **not** mutate `1.0.0` in
  place. This is a breaking structural change (flat `transforms/` → nested
  `src/<pkg>/`).
- **Keep `TR_PYTHON_1_0_0` intact and non-deprecated** so anything that pinned
  `1.0.0` keeps scaffolding (POST `/scaffold` rejects deprecated versions, so
  deprecating `1.0.0` would break pinned consumers — avoided).
- **No schema migration** for `templates_index` — content is TS literals, and
  the in-memory catalog is the source of truth (see Step 0).
- **List route dedupes to latest version per templateId** (new
  `listLatestTemplateManifests()` helper, semver-max). Without this, adding
  `2.0.0` makes `GET /templates` return two `transforms-python` rows (6 total),
  breaking `admin-routes-integration.test.ts` (`length === 5`) and the FE wizard
  (which expects one row per template). Dedup keeps the list at 5 (one row per
  template, latest version) — Foundry-faithful ("bootstrapped with the latest
  version"). `GET /templates/:id/versions/:v` still serves any version
  (1.0.0 included) for pinned access.

## Behavior change to flag (PR description)

A freshly-scaffolded transforms-python repo on 2.0.0 **no longer builds green
out of the box**: the starter `examples.py` ships commented-out (Foundry-faithful),
so the user must uncomment it and fill real dataset paths before building. This
is the deliberate scaffold-philosophy change the brief requested (Foundry ships
commented, non-building starter code; tellus 1.0.0 shipped active green-out-of-
the-box code). The `datasetRid` parameter is substituted into both commented
paths of `examples.py` per the brief.

## Decision 5 — Reconciliation: a single "tellus transform" (post-parity)

There is ONE source of truth for "what a transforms-python repo looks like": the
scaffold template (`TR_PYTHON_2_0_0` here in `manifest.ts`). A new repo gets the
11 files above (6 Foundry-confirmed + 3 tellus tooling + 2 tellus platform).

The `transforms.api` library + the `tellus-transforms` build CLI are **NOT
committed into scaffolded repos** — they are tellus's PUBLISHED packages, living
at `packages/transforms-python/` (distribution `tellus-transforms`, providing the
`transforms` + `tellus_transforms` import packages + the `tellus-transforms`
console script). A scaffolded repo declares `transforms` as a run-dep in
`conda_recipe/meta.yaml` (Foundry-shape, DX-portable) and resolves it into
`requirements.lock` via `tellus-transforms lock` (pip-tools; replaces Hawk). This
mirrors Foundry, where `transforms` is a conda dep, not committed into the repo.

Consequence: `packages/transforms-python/` is the library+CLI package ONLY — it
no longer carries a duplicate `src/myproject/` reference repo (the scaffold is
the canonical repo). `pip install -e packages/transforms-python/` installs
`tellus-transforms` (→ `from transforms.api import ...` + the `tellus-transforms`
CLI); a scaffolded repo's `requirements.lock`/`meta.yaml` pull it as a dep.
