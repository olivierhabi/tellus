# Files & Projects — SUBTASKS

> Status table for the 158-turn execution plan in
> `tasks/files-projects/files-projects-tasks-v2.md`.
>
> Mutates only to flip status: `⏳ → IN_PROGRESS → ✅` (or `❌` only when a
> structural block is documented in `progress/<TASK>.md`).

| Turn    | Title                                                           | Status      | Exit log                  |
|---------|-----------------------------------------------------------------|-------------|---------------------------|
| B1.bf1  | Cypress E2E for Compass resource model                          | ✅          | scripts/verify-B1.bf1.sh  |
| B1.bf2  | Wiring proof execution (B1-C-24)                                | ✅          | scripts/verify-B1.bf2.sh  |
| B1.bf3  | Docker stack snapshot in integration log                        | ✅          | scripts/verify-B1.bf3.sh  |
| B2.bf1  | Cypress E2E for spaces                                          | ✅          | scripts/verify-B2.bf1.sh  |
| B2.bf2  | Load probe + integration docker snapshot                        | ✅          | scripts/verify-B2.bf2.sh  |
| B3.bf1  | Integration log docker snapshot                                 | ✅          | scripts/verify-B3.bf1.sh  |
| B3.bf2  | Load probe scripts/b3-load.ts                                   | ✅          | scripts/verify-B3.bf2.sh  |
| B3.bf3  | Wiring proof execution (B3-C-15)                                | ✅          | scripts/verify-B3.bf3.sh  |
| B3.bf4  | Cypress E2E for filesystem v2                                   | ✅          | scripts/verify-B3.bf4.sh  |
| B4.01   | Roles + role_operations DDL + seed                              | ✅          | scripts/verify-B4.01.sh  |
| B4.02   | role_grants DDL + project_members mirror trigger                | ✅          | scripts/verify-B4.02.sh  |
| B4.03   | Markings DDL                                                    | ✅          | scripts/verify-B4.03.sh  |
| B4.04   | Organizations DDL (4 tables)                                    | ✅          | scripts/verify-B4.04.sh  |
| B4.05   | gatekeeperService skeleton + step 1 (org check)                 | ✅          | scripts/verify-B4.05.sh  |
| B4.06   | gatekeeperService step 2 (markings check)                       | ✅          | scripts/verify-B4.06.sh  |
| B4.07   | gatekeeperService step 3 (role ancestor walk)                   | ✅          | scripts/verify-B4.07.sh  |
| B4.08   | Integration test: full evaluate flow                            | ✅          | scripts/verify-B4.08.sh  |
| B4.09   | evaluateBatch implementation                                    | ✅          | scripts/verify-B4.09.sh  |
| B4.10   | LRU cache + LISTEN/NOTIFY invalidation                          | ✅          | scripts/verify-B4.10.sh  |
| B4.11   | requirePermission middleware swap                               | ✅          | scripts/verify-B4.11.sh  |
| B4.12   | verify-B4.sh + load + cypress + tail                            | ✅          | scripts/verify-B4.12.sh  |
| B5.01   | audit_log DDL + audit.ts writer                                 | ✅          | scripts/verify-B5.01.sh  |
| B5.02   | etag middleware                                                 | ✅          | scripts/verify-B5.02.sh  |
| B5.03   | Wire etag middleware into v2 router                             | ✅          | scripts/verify-B5.03.sh  |
| B5.04   | trashService.trash with recursive CTE                           | ✅          | scripts/verify-B5.04.sh  |
| B5.05   | trashService.restore                                            | ✅          | scripts/verify-B5.05.sh  |
| B5.06   | trashService.permanentlyDelete + retention                      | ✅          | scripts/verify-B5.06.sh  |
| B5.07   | Endpoint wiring (POST /trash, /restore, /permanentlyDelete)     | ✅          | scripts/verify-B5.07.sh  |
| B5.08   | verify-B5.sh + load + cypress + tail                            | ✅          | scripts/verify-B5.08.sh  |
| B6.01   | resource_dependencies DDL + indexes                             | ✅          | scripts/verify-B6.01.sh  |
| B6.02   | project_references DDL                                          | ✅          | scripts/verify-B6.02.sh  |
| B6.03   | resourceGraphService addEdge/removeEdge + cycle detection       | ✅          | scripts/verify-B6.03.sh  |
| B6.04   | getUpstream / getDownstream / getLineage                        | ✅          | scripts/verify-B6.04.sh  |
| B6.05   | projectReferenceService                                         | ✅          | scripts/verify-B6.05.sh  |
| B6.06   | Gatekeeper extension for cross-project visibility               | ✅          | scripts/verify-B6.06.sh  |
| B6.07   | Endpoint wiring                                                 | ✅          | scripts/verify-B6.07.sh  |
| B6.08   | verify-B6.sh + load + cypress + tail                            | ✅          | scripts/verify-B6.08.sh  |
| B7.01   | branches table DDL + branch_resources                           | ✅          | scripts/verify-B7.01.sh  |
| B7.02   | proposals + proposal_approvals DDL                              | ✅          | scripts/verify-B7.02.sh  |
| B7.03   | approval_policies + branch_overlays DDL                         | ✅          | scripts/verify-B7.03.sh  |
| B7.04   | branchService.create + read                                     | ✅          | scripts/verify-B7.04.sh  |
| B7.05   | proposalService skeleton (open + status)                        | ✅          | scripts/verify-B7.05.sh  |
| B7.06   | proposalService.approve                                         | ✅          | scripts/verify-B7.06.sh  |
| B7.07   | Merge algorithm (conflict detection)                            | ✅          | scripts/verify-B7.07.sh  |
| B7.08   | Merge algorithm (apply overlays + audit + Kafka emit)           | ✅          | scripts/verify-B7.08.sh  |
| B7.09   | Idempotent merge replay                                         | ✅          | scripts/verify-B7.09.sh  |
| B7.10   | Inactive auto-close cron                                        | ✅          | scripts/verify-B7.10.sh  |
| B7.11   | Endpoint wiring                                                 | ✅          | scripts/verify-B7.11.sh  |
| B7.12   | verify-B7.sh + load + cypress + tail                            | ✅          | scripts/verify-B7.12.sh  |
| B8.01   | ontologies table DDL + seed default ontology                    | ✅          | scripts/verify-B8.01.sh  |
| B8.02   | object_types DDL + UNIQUE constraint                            | ✅          | scripts/verify-B8.02.sh  |
| B8.03   | object_type_properties DDL                                      | ✅          | scripts/verify-B8.03.sh  |
| B8.04   | object_type_datasources DDL                                     | ✅          | scripts/verify-B8.04.sh  |
| B8.05   | link_types DDL                                                  | ✅          | scripts/verify-B8.05.sh  |
| B8.06   | shared_property_types + interfaces DDL                          | ✅          | scripts/verify-B8.06.sh  |
| B8.07   | omsService.createObjectType (validation + insert)               | ✅          | scripts/verify-B8.07.sh  |
| B8.08   | omsService.getObjectType + listObjectTypes (branch-aware)       | ✅          | scripts/verify-B8.08.sh  |
| B8.09   | omsService.updateObjectType (If-Match, immutability)            | ✅          | scripts/verify-B8.09.sh  |
| B8.10   | BACKS edge registration + lineage chain                         | ✅          | scripts/verify-B8.10.sh  |
| B8.11   | Kafka emit on update                                            | ✅          | scripts/verify-B8.11.sh  |
| B8.12   | omsService for linkTypes                                        | ✅          | scripts/verify-B8.12.sh  |
| B8.13   | omsService for sharedPropertyTypes + interfaces                 | ✅          | scripts/verify-B8.13.sh  |
| B8.14   | Endpoints (6 routes)                                            | ✅          | scripts/verify-B8.14.sh  |
| B8.15   | verify-B8.sh + load + cypress + tail                            | ✅          | scripts/verify-B8.15.sh  |
| B9.01   | funnel_pipeline_state DDL                                       | ✅          | scripts/verify-B9.01.sh  |
| B9.02   | OpenSearch client setup + index template                        | ✅          | scripts/verify-B9.02.sh  |
| B9.03   | Changelog phase                                                 | ✅          | scripts/verify-B9.03.sh  |
| B9.04   | MergeChanges phase                                              | ✅          | scripts/verify-B9.04.sh  |
| B9.05   | Indexer phase (bulk OpenSearch writes)                          | ✅          | scripts/verify-B9.05.sh  |
| B9.06   | Hydrator phase                                                  | ✅          | scripts/verify-B9.06.sh  |
| B9.07   | funnelService orchestrator                                      | ✅          | scripts/verify-B9.07.sh  |
| B9.08   | Kafka consumer for tellus.oms.object-type.updated               | ✅          | scripts/verify-B9.08.sh  |
| B9.09   | Replacement pipeline (schema change)                            | ✅          | scripts/verify-B9.09.sh  |
| B9.10   | Throughput cap + backpressure                                   | ✅          | scripts/verify-B9.10.sh  |
| B9.11   | 6h scheduled re-run                                             | ✅          | scripts/verify-B9.11.sh  |
| B9.12   | verify-B9.sh + 1M-row test + cypress + tail                     | ✅          | scripts/verify-B9.12.sh  |
| B10.01  | IR types + zod schema                                           | ✅          | scripts/verify-B10.01.sh  |
| B10.02  | IR → OpenSearch DSL compiler (filters)                          | ✅          | scripts/verify-B10.02.sh  |
| B10.03  | IR compiler (geoDistance, knn)                                  | ✅          | scripts/verify-B10.03.sh  |
| B10.04  | load endpoint                                                   | ✅          | scripts/verify-B10.04.sh  |
| B10.05  | aggregate endpoint                                              | ✅          | scripts/verify-B10.05.sh  |
| B10.06  | searchAround endpoint (M:1, 1:M)                                | ✅          | scripts/verify-B10.06.sh  |
| B10.07  | save / get object set as Compass resource                       | ✅          | scripts/verify-B10.07.sh  |
| B10.08  | load-by-PK convenience endpoint                                 | ✅          | scripts/verify-B10.08.sh  |
| B10.09  | Permission stripping (mandatory_control)                        | ✅          | scripts/verify-B10.09.sh  |
| B10.10  | verify-B10.sh + load + cypress + tail                           | ✅          | scripts/verify-B10.10.sh  |
| F1.01   | FilesPageHeader + FilesTabBar refactor                          | ✅          | scripts/verify-F1.01.sh  |
| F1.02   | Projects tab (virtualized table)                                | ✅          | scripts/verify-F1.02.sh  |
| F1.03   | Your files tab                                                  | ✅          | scripts/verify-F1.03.sh  |
| F1.04   | Shared with you tab                                             | ✅          | scripts/verify-F1.04.sh  |
| F1.05   | Portfolios tab (Recents portfolio)                              | ✅          | scripts/verify-F1.05.sh  |
| F1.06   | Header search bar + empty states + verify-F1.sh                 | ✅          | scripts/verify-F1.06.sh  |
| F2.01   | Project header (sticky, inline-renamable)                       | ✅          | scripts/verify-F2.01.sh  |
| F2.02   | Sub-tab strip + URL routing                                     | ✅          | scripts/verify-F2.02.sh  |
| F2.03   | Files sub-tab (folder browser embedded)                         | ✅          | scripts/verify-F2.03.sh  |
| F2.04   | Autosaved sub-tab                                               | ✅          | scripts/verify-F2.04.sh  |
| F2.05   | References sub-tab                                              | ✅          | scripts/verify-F2.05.sh  |
| F2.06   | Trash sub-tab                                                   | ✅          | scripts/verify-F2.06.sh  |
| F2.07   | Members sub-tab + verify-F2.sh                                  | ✅          | scripts/verify-F2.07.sh  |
| F3.01   | Tree sidebar (collapsible, lazy-load)                           | ✅          | scripts/verify-F3.01.sh  |
| F3.02   | Table view (configurable columns, virtualized at 200+)          | ✅          | scripts/verify-F3.02.sh  |
| F3.03   | Multi-select (shift-range, cmd-toggle)                          | ✅          | scripts/verify-F3.03.sh  |
| F3.04   | Multi-select toolbar                                            | ✅          | scripts/verify-F3.04.sh  |
| F3.05   | Drag-drop move (HTML5 DnD)                                      | ✅          | scripts/verify-F3.05.sh  |
| F3.06   | Keyboard shortcuts + help overlay                               | ✅          | scripts/verify-F3.06.sh  |
| F3.07   | Concurrency UX (412 handling, auto-refetch)                     | ✅          | scripts/verify-F3.07.sh  |
| F3.08   | Breadcrumb truncation + verify-F3.sh                            | ✅          | scripts/verify-F3.08.sh  |
| F4.01   | ShareDialog scaffold + tab switcher                             | ✅          | scripts/verify-F4.01.sh  |
| F4.02   | PrincipalPicker (autocomplete users + groups)                   | ✅          | scripts/verify-F4.02.sh  |
| F4.03   | Roles tab (grant + revoke + role select)                        | ✅          | scripts/verify-F4.03.sh  |
| F4.04   | Markings tab                                                    | ✅          | scripts/verify-F4.04.sh  |
| F4.05   | Organizations tab (project-only)                                | ✅          | scripts/verify-F4.05.sh  |
| F4.06   | Effective permissions tab                                       | ✅          | scripts/verify-F4.06.sh  |
| F4.07   | Concurrency, A11y, verify-F4.sh                                 | ✅          | scripts/verify-F4.07.sh  |
| F5.01   | QuickOpenProvider + global ⌘K binding                           | ✅          | scripts/verify-F5.01.sh  |
| F5.02   | QuickOpenDialog + result rendering                              | ✅          | scripts/verify-F5.02.sh  |
| F5.03   | Filter chips                                                    | ✅          | scripts/verify-F5.03.sh  |
| F5.04   | Backend /api/v2/filesystem/search                               | ✅          | scripts/verify-F5.04.sh  |
| F5.05   | Recent visited + abort-on-keystroke + verify-F5.sh              | ✅          | scripts/verify-F5.05.sh  |
| F6.01   | Global /trash page + TrashTable                                 | ✅          | scripts/verify-F6.01.sh  |
| F6.02   | RestoreDialog                                                   | ✅          | scripts/verify-F6.02.sh  |
| F6.03   | PermanentDeleteDialog                                           | ✅          | scripts/verify-F6.03.sh  |
| F6.04   | Status pills + auto-purge live timer                            | ✅          | scripts/verify-F6.04.sh  |
| F6.05   | Empty trash bulk action + verify-F6.sh                          | ✅          | scripts/verify-F6.05.sh  |
| F7.01   | branchStore (Zustand)                                           | ✅          | scripts/verify-F7.01.sh  |
| F7.02   | BranchSwitcher dropdown component                               | ✅          | scripts/verify-F7.02.sh  |
| F7.03   | Hooks pass ?branch= to all queries                              | ✅          | scripts/verify-F7.03.sh  |
| F7.04   | BranchCreateDialog                                              | ✅          | scripts/verify-F7.04.sh  |
| F7.05   | /branches list page                                             | ✅          | scripts/verify-F7.05.sh  |
| F7.06   | /branches/[rid] detail page                                     | ✅          | scripts/verify-F7.06.sh  |
| F7.07   | /proposals/[rid] review page (4 panels)                         | ✅          | scripts/verify-F7.07.sh  |
| F7.08   | Diff renderer (per-resource-type)                               | ✅          | scripts/verify-F7.08.sh  |
| F7.09   | Merge flow + MERGE_CONFLICT panel + verify-F7.sh                | ✅          | scripts/verify-F7.09.sh  |
| F8.01   | /ontology ontology list page                                    | ✅          | scripts/verify-F8.01.sh  |
| F8.02   | /ontology/[rid] object types list                               | ✅          | scripts/verify-F8.02.sh  |
| F8.03   | Object type editor scaffold (3-pane layout)                     | ✅          | scripts/verify-F8.03.sh  |
| F8.04   | Properties list pane (left)                                     | ✅          | scripts/verify-F8.04.sh  |
| F8.05   | Property detail pane (center)                                   | ✅          | scripts/verify-F8.05.sh  |
| F8.06   | Datasources panel (right) + property mapping table              | ✅          | scripts/verify-F8.06.sh  |
| F8.07   | Header (apiName, status, visibility, icon, type classes, groups)| ✅          | scripts/verify-F8.07.sh  |
| F8.08   | Save flow with If-Match + validation banner                     | ✅          | scripts/verify-F8.08.sh  |
| F8.09   | Link type editor (single column)                                | ✅          | scripts/verify-F8.09.sh  |
| F8.10   | verify-F8.sh                                                    | ✅          | scripts/verify-F8.sh     |
| F9.01   | /object-explorer page scaffold (3-pane)                         | ✅          | scripts/verify-F9.01.sh  |
| F9.02   | Results table (virtualized, configurable columns)               | ✅          | scripts/verify-F9.02.sh  |
| F9.03   | Facet sidebar                                                   | ✅          | scripts/verify-F9.03.sh  |
| F9.04   | Filter chip bar                                                 | ✅          | scripts/verify-F9.04.sh  |
| F9.05   | Query box (Lucene-like → IR)                                    | ✅          | scripts/verify-F9.05.sh  |
| F9.06   | Search-around action                                            | ✅          | scripts/verify-F9.06.sh  |
| F9.07   | Object set save dialog                                          | ✅          | scripts/verify-F9.07.sh  |
| F9.08   | Mandatory-control rendering + verify-F9.sh                      | ✅          | scripts/verify-F9.08.sh  |
| F10.01  | Canvas scaffold (@xyflow/react)                                 | ✅          | scripts/verify-F10.01.sh  |
| F10.02  | Card library + CardEdge typed connections                       | ✅          | scripts/verify-F10.02.sh  |
| F10.03  | ObjectSetSourceCard                                             | ✅          | scripts/verify-F10.03.sh  |
| F10.04  | FilterCard                                                      | ✅          | scripts/verify-F10.04.sh  |
| F10.05  | SearchAroundCard                                                | ✅          | scripts/verify-F10.05.sh  |
| F10.06  | AggregateCard                                                   | ✅          | scripts/verify-F10.06.sh  |
| F10.07  | TransformTableCard (DuckDB-WASM)                                | ✅          | scripts/verify-F10.07.sh  |
| F10.08  | ChartCard (vega-embed)                                          | ✅          | scripts/verify-F10.08.sh  |
| F10.09  | Auto-save + URL state                                           | ✅          | scripts/verify-F10.09.sh  |
| F10.10  | Keyboard shortcuts + verify-F10.sh                              | ✅          | scripts/verify-F10.10.sh |
| FINAL.01| End-to-end scenario 1                                           | ✅          | scripts/verify-FINAL.01.sh  |
| FINAL.02| End-to-end scenario 2                                           | ✅          | scripts/verify-FINAL.02.sh  |
| FINAL.03| End-to-end scenario 3                                           | ✅          | scripts/verify-FINAL.03.sh  |
| FINAL.04| End-to-end scenario 4                                           | ✅          | scripts/verify-FINAL.04.sh  |
| FINAL.05| End-to-end scenario 5                                           | ✅          | scripts/verify-FINAL.05.sh  |
| FINAL.06| End-to-end scenario 6                                           | ✅          | scripts/verify-FINAL.06.sh  |
| FINAL.07| Definition of Done                                              | ✅          | scripts/verify-FINAL.07.sh  |

<!-- 158 rows above -->
