# Code Repositories — Dependency DAG

> Render of §0 of the spec plus the implicit edges declared in each task's
> "Depends on" header. Edges are unidirectional `upstream → downstream`. **A task
> may not start until every upstream task is in DONE state per the brief's
> Definition of Done.** Per §6.1 of the brief, downstream regressions reopen
> upstream tasks (no proceeding past a partial-green dep).
>
> Last updated: 2026-05-01 (Starting Protocol §3).

---

## 0. Pre-existing assumed-live services

These are not implemented in this drive but are dependencies. Mocked in tests
ONLY where they are **not owned by us**; otherwise live testcontainer:

```
Compass · Multipass · OMS · OSv2 · OSS · Funnel · Kafka · Postgres · Redis · S3-compatible blob (MinIO) · Kubernetes (kind/k3d in test)
```

---

## 1. Backend critical path

```
            Compass · Multipass · OMS                  Kubernetes (kind in test)
                      │                                       │
                      ▼                                       │
                     B1 ◀───────────────── B10 ───────────────┘
                      │                     ▲
                      ▼                     │
                     B2 ◀──────────────────┘   (B2 listens to B10 post-receive)
                      │
        ┌─────────────┼──────────────────────────────┐
        ▼             ▼                              ▼
       B3            B4 ──▶ B5 ──▶ B6 ──┬──▶ B7
                                        ├──▶ B8
                                        └──▶ B9 (uses B8 for resolve)
```

### 1.1 Explicit edges (backend)

| Edge | Reason | Spec citation |
|---|---|---|
| `Compass → B1` | auth (VIEWER/EDITOR/OWNER) | `tasks/code-repository/code-repository-tasks.md:124,129` |
| `Multipass → B1` | bearer JWT verification | `tasks/code-repository/code-repository-tasks.md:124,129` |
| `B1 → B2` | B2 talks to Stemma for content + ref ops | `tasks/code-repository/code-repository-tasks.md:235` |
| `Compass → B2` | folder/project resolution | `tasks/code-repository/code-repository-tasks.md:235` |
| `Multipass → B2` | bearer JWT | (global G-C-07) |
| `B1 → B3` | template content stored in system Stemma repo | `tasks/code-repository/code-repository-tasks.md:336,367` |
| `B2 → B4` | imports are scoped per repository | `tasks/code-repository/code-repository-tasks.md:389` |
| `OMS → B4` | entity existence + project-import scope | `tasks/code-repository/code-repository-tasks.md:389,431` |
| `Compass → B4` | project context for import-scope check | `tasks/code-repository/code-repository-tasks.md:389` |
| `B4 → B5` | code-repos.imports.changed event | `tasks/code-repository/code-repository-tasks.md:447,463` |
| `OMS → B5` | type metadata for codegen | `tasks/code-repository/code-repository-tasks.md:447` |
| `B1 → B5` | codegen pushes commits via Stemma | `tasks/code-repository/code-repository-tasks.md:447,475` |
| `B1 → B6` | CI clones from Stemma | `tasks/code-repository/code-repository-tasks.md:491` |
| `B2 → B6` | run metadata addresses repo via B2 | `tasks/code-repository/code-repository-tasks.md:491` |
| `B10 → B6` | post-receive event triggers run | `tasks/code-repository/code-repository-tasks.md:491,541` |
| `Kubernetes → B6` | worker pods | `tasks/code-repository/code-repository-tasks.md:491` |
| `B6 → B7` | publish stage emits JobSpecs | `tasks/code-repository/code-repository-tasks.md:574` |
| `OMS → B7` | dataset RID resolution | `tasks/code-repository/code-repository-tasks.md:574` |
| `B6 → B8` | publish stage uploads function artifacts | `tasks/code-repository/code-repository-tasks.md:646` |
| `B5 → B8` | function entry point types come from generated SDK shape | `tasks/code-repository/code-repository-tasks.md:646` |
| `Multipass → B8` | scope checks on publish + download | `tasks/code-repository/code-repository-tasks.md:646` |
| `B8 → B9` | preview pulls artifacts of resolved version | `tasks/code-repository/code-repository-tasks.md:734` |
| `OSS → B9` | live ontology read for object inputs | `tasks/code-repository/code-repository-tasks.md:734` |
| `OMS → B9` | type signatures | `tasks/code-repository/code-repository-tasks.md:734` |
| `Multipass → B9` | per-invocation scoped token | `tasks/code-repository/code-repository-tasks.md:734` |
| `B1 → B10` | pre-receive hook callback origin | `tasks/code-repository/code-repository-tasks.md:780` |
| `B2 → B10` | branch-protection rules read from repoSettings | `tasks/code-repository/code-repository-tasks.md:780` |

### 1.2 Backend critical path for the demo (linear)

```
B1 → B2 → B3 → B4 → B5 → B6 → B8 → B9
```
B7 and B10 are demo-adjacent: B10 is required for protected branches and event fan-out, B7 is required only for transforms repos (out of the function demo path but mandatory for spec parity).

---

## 2. Frontend layer

The §0 frontend layer is a fan from F1 (shell) to the panel-level tasks; only F4 has a strict ordering with F2 (it consumes dirtyFiles).

```
F1 (IDE Shell)
 ├──▶ F2 (File Tree / VFS)
 │        ▲
 │        └─── feeds dirtyFiles to ───▶ F4 (Branch & Commit)
 ├──▶ F3 (Init Wizard)
 ├──▶ F4 (Branch & Commit)
 ├──▶ F5 (Tag & Release)
 ├──▶ F6 (Imports Panel)
 ├──▶ F7 (Live Preview / Functions Tab)
 ├──▶ F8 (Checks / Builds)
 ├──▶ F9 (PR / Code Review)
 └──▶ F10 (Settings & Admin)
```

### 2.1 F-task → backend dependency table

| Frontend task | Required backend tasks DONE | Spec citation |
|---|---|---|
| F1 | B2 | `tasks/code-repository/code-repository-tasks.md:858` |
| F2 | B1, B2 | `tasks/code-repository/code-repository-tasks.md:886` |
| F3 | B2, B3 (+ Compass UI primitives) | `tasks/code-repository/code-repository-tasks.md:916` |
| F4 | B1, B2, B10 | `tasks/code-repository/code-repository-tasks.md:941` |
| F5 | B1, B6, B8 | `tasks/code-repository/code-repository-tasks.md:975` |
| F6 | B4, OMS, B5 | `tasks/code-repository/code-repository-tasks.md:1003` |
| F7 | B9, B5 | `tasks/code-repository/code-repository-tasks.md:1029` |
| F8 | B6, B7, B8, B10 | `tasks/code-repository/code-repository-tasks.md:1061` |
| F9 | B2, B10, B6 | `tasks/code-repository/code-repository-tasks.md:1089` |
| F10 | B2 | `tasks/code-repository/code-repository-tasks.md:1132` |

### 2.2 Frontend critical-path order (per the brief's "Mandatory Order")

```
F1 → F2 → F3 → F6 → F7 → F4 → F5 → F8 → F9 → F10
```
This order matches the demo flow (init repo → file edit → import resources → live preview → commit → tag → check status → ...) and is the binding execution order.

---

## 3. Combined execution order (block-respecting)

The brief's Mandatory Order section explicitly says: **F-tasks may not start before their B-dependency is DONE.** Working back from §2.1 + the backend critical path, the legal interleaving is:

```
B1 → B2 → [B3, B10 in parallel]
                │       │
                ▼       ▼
             F3 (after B2+B3)        F1 (after B2)
                │                            │
                ▼                            ▼
             B4 ──▶ B5                    F2 (after B1+B2)
                          │
                          ▼
                       B6 ──▶ B7
                          │      │
                          ▼      ▼
                       B8 ──▶ B9
                          │
                  F4 (B1+B2+B10), F5 (B1+B6+B8),
                  F6 (B4+B5), F7 (B5+B9),
                  F8 (B6+B7+B8+B10), F9 (B2+B6+B10),
                  F10 (B2)
```

**Practical batching for delegation to agent sub-tasks:**

1. **Wave 0 (Starting Protocol):** contracts.md, dag.md, baselines, test infra harness.
2. **Wave 1:** B1 + B10-pre-hook stub (B10 only blocks B1-C-08; the rest of B10 can come later).
3. **Wave 2:** B2 + B3 in parallel (both depend only on B1).
4. **Wave 3:** B4, F1, F3 (F1 and F3 only need B2; F3 also needs B3).
5. **Wave 4:** B5 (after B4) + F2 (after B1 + B2).
6. **Wave 5:** B6 (after B5 + B10).
7. **Wave 6:** B7, B8 (after B6) — independent siblings.
8. **Wave 7:** B9 (after B8).
9. **Wave 8:** F4, F5, F6, F7, F8, F9, F10 once their B-deps are green.
10. **Wave 9:** Demo Flow Gate — three clean Playwright runs of `tests/e2e/demo-flow.spec.ts`.

---

## 4. Verification rules (apply per task transition)

- **Before starting `T-XX`:** every entry in `tasks/code-repository/PROGRESS.md` for the upstream tasks is `DONE` and shows the SLO scorecard + chaos pass + audit verification.
- **If a downstream task surfaces a defect in upstream `T-YY`:**
  1. Stop the downstream work.
  2. Reopen `T-YY` (status flipped to `IN_PROGRESS` in PROGRESS.md).
  3. Add a regression test in `tests/<layer>/<service>/` citing the relevant contract ID(s).
  4. Re-run the full suite for `T-YY`.
  5. Resume the downstream task.
- **No skipping the chaos/load suites** even when "the demo doesn't exercise it" (per Forbidden Behaviors §1).
