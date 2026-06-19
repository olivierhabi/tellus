# Files & Projects — Sequencing & Dependencies (DAG)

> Source: `tasks/files-projects/files-projects-tasks.md` lines 12–24, expanded.
> The critical path is `B1 → B2 → B3 → B4 → B5 → B6 → B7`, branching to `B7 → B8 → B9 → B10`.
> F-tasks gate on their declared B-deps. **No F-task may begin before its declared B-deps are DONE.**

## Backend critical path

```
B1 ── B2 ── B3 ── B4 ── B5 ── B6 ── B7 ── B8 ── B9 ── B10
```

Edges (each labeled with the contract that creates the dep):

- `B1 → B2`  — `resources.rid` PK is referenced by `spaces.rid`; root space row needs B1 trigger.
- `B2 → B3`  — Filesystem v2 routes resolve paths under root space (`/Root/...` ≡ `/...`).
- `B3 → B4`  — Routes need `requirePermission(operationId, ridFromParams)` from gatekeeper; before B4 they ship a deny-by-default stub.
- `B4 → B5`  — `compass:trash-resource` / `compass:permanently-delete-resource` are gated.
- `B5 → B6`  — `audit_log` single-writer is the audit floor for graph mutations.
- `B6 → B7`  — `branch_overlays` writes go through the same edge model.
- `B7 → B8`  — Object types are branch-aware; `branch_rid` column references `branches(rid)`.
- `B8 → B9`  — Funnel consumes `tellus.oms.object-type.updated` and indexes per `(object_type_rid, branch_rid)`.
- `B9 → B10` — OSS reads `obj-{objectTypeRid}-{branchRid}` indices; without indexed data, reads return `OBJECT_TYPE_NOT_INDEXED`.

## Frontend gating (each F-task starts only when ALL its deps are DONE)

| Task | Deps | Reason |
|------|------|--------|
| F1 — Files Hub | B1, B3 | Tabs read from v2 resources/sharedWithMe; needs RID + listing API. |
| F2 — Project Detail | B3, B6 | Sub-tabs include References (B6); core read is v2 (B3). |
| F3 — Folder Browser | B3, B5 | Move/rename go through v2; trash flows through B5. |
| F4 — Share Dialog | B4 | Roles/markings/orgs are the gatekeeper surface. |
| F5 — Quick Open | B3 | `/api/v2/filesystem/search` is added in B3. |
| F6 — Trash Pages | B5 | Trash semantics + retention live in B5. |
| F7 — Branch Switcher | B7 | Branch state + proposals are B7. |
| F8 — Object Type Editor | B8 | OMS object types come from B8. |
| F9 — Object Explorer | B10 | Faceted load/aggregate are OSS reads. |
| F10 — Quiver Canvas | B10 | Card execution dispatches through OSS. |

## End-to-End Gate (Cypress + verify-all.sh)

Gate exercises (B1+B2+B3+B4+B5+B6+B7+B8+B9+B10) ⨯ (F1+F2+F3+F4+F5+F6+F7+F8+F9+F10) per Verification Matrix
(`tasks/files-projects/files-projects-tasks.md:1272-1282`). Must pass three runs in a row on a clean Docker stack.

## Reopen rule

If a downstream task surfaces a defect in an upstream Done task, the downstream task halts; the upstream task is reopened with new tests covering the defect and re-verified before resumption.
