E. Funnel Hardening (NEW — required for the 40 tasks above to work at Palantir scale)
These tasks address gaps in the implemented Funnel that, if left unaddressed, would block one or more of the 40 Pipeline Builder / Link Types tasks from meeting their acceptance criteria. They are not "improvements to the Funnel for its own sake" — each is a dependency of a task above. The Funnel's own open-items list (workflow continueAsNew(), partition evolution, RisingWave) is acknowledged but not extended here unless it directly blocks a task in this spec.

FNL-H1 — ObjectTypeFunnelWorkflow.continueAsNew() for production scale
Goal. Address the Funnel's documented open item (workflows.ts:91): without continueAsNew(), event history grows unbounded past ~100 active Object Types, eventually hitting Temporal's 50k-event-per-workflow soft limit. Required for LT-B1 (1B-edge link types) and PB-B8 (auto-fire on every deploy) — both of which dramatically increase the per-workflow event rate.

Spec. Refactor ObjectTypeFunnelWorkflow to call continueAsNew(...) after every N completed runs (default N=100, configurable via FUNNEL_WORKFLOW_CONTINUE_AS_NEW_THRESHOLD). State carried across the boundary: lastProcessedSignalId, runStats (rolling counters used by SLIs), the per-Object-Type config snapshot. The Postgres funnel_run history is the durable record; Temporal history is an optimization. Add an integration test that simulates 500 successive signals and asserts the workflow completes without hitting Temporal's WorkflowHistoryEventLimit exception.

Acceptance. (a) Workflow completes 500 signals end-to-end without Temporal history-size exceptions. (b) continueAsNew boundary preserves all in-flight state — verified by killing Temporal worker mid-boundary and asserting resume from correct point. (c) Per-Object-Type SLI counters survive the boundary correctly. (d) Postgres state continues to be the durable source of truth.

Risk. Temporal continueAsNew semantics are subtle — search-attributes and signals-in-flight need careful handling. Allocate a week.

Blocks: LT-B1 (production scale), PB-B8 (auto-fire frequency).

FNL-H2 — Add correlation_id, causation_id, actor_user_id to object_edits and surface in stage outputs
Goal. Today object_edits has actor_user_id but not correlation_id or causation_id. LT-B3 (link CDC v2) and LT-B8 (object CDC topic) require these fields to support cross-cutting Action replay and lineage-bound Markings.

Spec. Migration to add:

ALTER TABLE object_edits ADD COLUMN correlation_id UUID NULL;
ALTER TABLE object_edits ADD COLUMN causation_id UUID NULL;
ALTER TABLE object_edits ADD COLUMN action_rid TEXT NULL;
CREATE INDEX idx_object_edits_correlation ON object_edits(correlation_id) WHERE correlation_id IS NOT NULL;
Update editApplicator.applyEdits to populate all three fields from the request scope (correlation_id from the inbound HTTP request's X-Correlation-Id header or auto-generated UUID; causation_id from the upstream event if applicable; action_rid from the action workflow). The Merge stage propagates these into the Iceberg merged-snapshot summary metadata so they're queryable retroactively. Same migration applied to link_edit to maintain symmetry.

Acceptance. (a) Every Action that calls applyEdits produces object_edits rows with non-null correlation_id and action_rid. (b) Multi-edit Actions: all rows produced by the same Action share the same correlation_id. (c) Iceberg snapshot summary on the merged dataset contains the correlation_ids of all consumed edits. (d) link_edit rows produced in the same Action carry the same correlation_id as the corresponding object_edits rows.

Risk. Backfill of historical object_edits to populate correlation_id is impossible (information lost). Document that historical rows have NULL correlation_id and downstream consumers must tolerate that.

Blocks: LT-B3, LT-B8.

FNL-H3 — Extend funnel_signal.signal_type enum with pipelineDeployCompleted
Goal. PB-B8 fires sourceTransactionCommitted to trigger Funnel Changelog after a pipeline deploy. That works but loses the provenance (was this triggered by a pipeline deploy or by an external source commit?). Add a dedicated signal type so consumers can distinguish, and so PB-F9's "Funnel runs triggered by this pipeline" panel can filter accurately.

Spec. Migration to add 'pipelineDeployCompleted' to the funnel_signal.signal_type enum. The signal payload schema gains optional fields triggered_by_pipeline_deployment_id UUID NULL, triggered_by_pipeline_id UUID NULL. The Funnel workflow treats pipelineDeployCompleted exactly like sourceTransactionCommitted for orchestration purposes (same Changelog → Merge → Indexing → Hydration chain) — the distinction is preserved only in the audit trail. Add a triggered_by_pipeline_deployment_id column to funnel_run so GET /api/v1/funnel/runs?triggered_by_pipeline_deployment_id=X returns the relevant runs.

Acceptance. (a) POST /api/v1/funnel/signals with signalType=pipelineDeployCompleted is accepted and triggers the same workflow as sourceTransactionCommitted. (b) funnel_run.triggered_by_pipeline_deployment_id is correctly populated. (c) Filtering GET /api/v1/funnel/runs by pipeline deployment ID returns only the runs caused by that deploy. (d) Existing sourceTransactionCommitted consumers unaffected.

Risk. Trivial migration; main risk is forgetting to update consumer code in temporal/workflows.ts to handle the new signal type.

Blocks: PB-B8, PB-F9.

FNL-H4 — Generalize replacement pipeline (object_type_active_index_version) to support link types
Goal. The existing replacement pipeline handles Object Type schema changes via object_type_active_index_version. LT-F10 (link replacement wizard) and LT-B6 (bidirectional schema changes) need the same machinery for link types. Generalize the state machine to accept link types as a target, rather than building a parallel state machine.

Spec. Migration to rename object_type_active_index_version → active_index_version and add target_type ENUM('object_type','link_type') NOT NULL DEFAULT 'object_type' and target_api_name TEXT NOT NULL. The PK becomes (target_type, ontology_id, target_api_name). The replacement orchestrator (services/quickwit/replacement/orchestrator.ts) gains a target_type parameter and dispatches to the appropriate implementation: object-type backfill (existing) or link-type backfill (new code path that backfills the Iceberg link table from LT-B1 into a new ClickHouse MV version). All /api/v1/funnel/replacement/* endpoints accept ?target_type= query parameter, defaulting to object_type for backwards compatibility.

The state machine values are unchanged (LIVE → REPLACEMENT_BACKFILL → REPLACEMENT_SOAK → CUTOVER_PENDING → CUTOVER_COMPLETE → OLD_INDEX_DROPPED / ROLLED_BACK), the diff_rate gate logic is unchanged. Only the target of the cutover changes (Quickwit alias for Object Types, ClickHouse MV alias for link types).

Acceptance. (a) Existing Object Type replacement flows continue to work without changes. (b) POST /api/v1/funnel/replacement/start?target_type=link_type&link=foo initiates a link-type backfill that creates a new MV version, dual-writes during soak, and cuts over correctly. (c) The replacement_diff_log table is populated for both target types. (d) Rollback works for both target types within 48h. (e) GET /api/v1/funnel/replacement/<api>?target_type=link_type returns correct state.

Risk. Backfill semantics for link MVs differ from Quickwit indexes (CH MV refresh vs. Quickwit split publishing). Implement carefully and write integration tests for both paths. Existing column rename has migration risk — coordinate with on-call.

Blocks: LT-F10, LT-B6 (when schema change requires replacement).

FNL-H5 — Extend Writeback Overlay to link edits
Goal. The Funnel B7 overlay handles object edits with sub-1s visibility. Link edits do not currently have an overlay — when a user adds a link via an Action, the link is not visible until Funnel indexing catches up (seconds to minutes). LT-B5's pending state mitigates the symptom but not the cause. Add link-edge overlay support so Action-triggered link writes have the same sub-1s visibility as object writes.

Spec. Extend the writebackOverlay.ts API with writeOverlayForLinkEdit(linkType, source_pk, target_pk, link_props, markings, operation). Inside actions/editApplicator.ts, in the same Postgres transaction as the link_edit insert, also call writeOverlayForLinkEdit to write a Redis key overlay:link:<linktype>:<source_pk>:<target_pk> with TTL = quickwit_commit_timeout_secs * 3 (180s default, matching object overlay). At link-resolver query time (linkResolverService.ts), mergeWithLinkOverlay() consults overlay keys for any (source_pk, target_pk) pairs returned from the underlying query and overlays the most recent state. The sweeper (overlay/sweeper.ts) gains link-overlay handling: deletes overlay:link:* keys when the corresponding link_edit.applied_to_index_at is set.

Add SLI: link_overlay_to_index_lag_p99 parallel to existing overlay_to_index_lag_p99, alert at >60s.

Acceptance. (a) An Action that adds a link: the link is visible in linkResolverService.resolveLinks() within 1s of the action returning, regardless of indexer lag. (b) Removing a link via an Action: the removal is visible within 1s. (c) Sweeper correctly deletes link-overlay keys after indexing catches up. (d) link_overlay_to_index_lag_p99 metric exposed and alertable. (e) Existing object-overlay behavior unchanged.

Risk. M2M links can be high-volume — overlay key count can grow large. Add a per-link-type override on the TTL (default 180s, configurable to 60s for high-volume links) to manage Redis memory.

Blocks: LT-B5 (correct pending state), and the implicit user expectation that "I just added a link, where is it" doesn't require a 30s wait.

FNL-H6 — Lakekeeper namespace bootstrap for _pipeline.* and _links.*
Goal. The Funnel's Lakekeeper bootstrap (lakekeeperBootstrap.ts) provisions the _funnel.* namespace. PB-B4 needs _pipeline.* and LT-B1 needs _links.* under the same warehouse — extend the bootstrap to provision them up-front so deploys don't fail on first attempt.

Spec. Update services/funnel/lakekeeperBootstrap.ts to additionally create namespaces _pipeline and _links under the warehouse during initial bootstrap. Idempotent (skip if exists). Update POST /api/v1/funnel/lakekeeper/bootstrap documentation to reflect the expanded scope. Add a GET /api/v1/funnel/lakekeeper/namespaces admin endpoint that returns the list of namespaces under the warehouse, useful for verifying setup.

Acceptance. (a) Fresh bootstrap on a new Lakekeeper instance creates all three namespaces. (b) Re-running bootstrap on an existing warehouse does not error. (c) GET /api/v1/funnel/lakekeeper/namespaces returns ["_funnel", "_pipeline", "_links"] minimum. (d) PB-B4 and LT-B1 deploys succeed on first attempt without manual namespace creation.

Risk. Trivial. Main risk is missing the bootstrap step in production deployments — make it part of the standard deployment runbook.

Blocks: PB-B4, LT-B1.

Cross-cutting acceptance gate (unchanged from v1)
Before any task above is considered "done," it must satisfy:

Tests. Unit tests for pure logic (≥80% line coverage for new code), integration tests for cross-component flows (must run in CI under 5 min), property-based tests for any state transition logic (markings, cardinality, retraction).
Docs. Every new endpoint documented in OpenAPI 3.1; every new database column explained in docs/SCHEMA.md; every new env var in docs/CONFIG.md. Funnel-integration points additionally documented in docs/funnel.md's cross-feature table.
Observability. Every new code path emits at least one Prometheus metric and one structured log line; every new endpoint contributes spans to the existing trace.
Backwards compatibility. No breaking change to existing API shapes without a v2/ prefix or a release-cycle deprecation window. Every feature flag has a documented sunset date.
Security review. Any task touching markings, ACL, or RBAC requires a second engineer's sign-off and an updated threat model entry.
Performance regression. CI runs a benchmark suite per subsystem; >10% regression on any tracked metric blocks merge.
Funnel-integration verification. Any task that depends on a Funnel endpoint or Funnel data structure must have an integration test that exercises the actual Funnel path (not a mock), gated on the Funnel being healthy.
Updated execution order
The execution order has been revised to land Funnel Hardening tasks early so they do not block downstream work.

Funnel Hardening prerequisites (parallel): FNL-H1, FNL-H2, FNL-H3, FNL-H6. 3 weeks. No frontend work yet.
Foundation (parallel): PB-B1 (Temporal/dispatcher mirroring funnel pattern), LT-B1 (Iceberg M2M via Lakekeeper), LT-B3 (CDC v2 on existing per-link topics). 4 weeks. Frontend not yet started.
Compute swap: PB-B2 (DuckDB sharing funnel pool), PB-B3 (Parquet outputs). 3 weeks. Frontend: PB-F1 (WebSocket-based), PB-F4.
Iceberg deepening: PB-B4 (Iceberg via shared Lakekeeper), PB-B6 (snapshot pinning), LT-B2 (cap escalation via existing CH path). 4 weeks. Frontend: PB-F2, PB-F3, LT-F3.
Semantic completeness + Funnel link extensions: FNL-H4 (replacement pipeline generalization), FNL-H5 (link overlay), LT-B4, LT-B5 (using existing applied_to_index_at), LT-B6, LT-B8 (object_cdc topics). 5 weeks. Frontend: LT-F1, LT-F2, LT-F4, LT-F8.
Security & analytics: PB-B7 (RBAC reusing merge marking-helper), LT-B7 (MCP via mergeStage extension), LT-B10 (composite agg). 3 weeks. Frontend: PB-F8, LT-F5, LT-F7.
Streaming & operations: PB-B5 (streaming with shared ThroughputGuard), PB-B8 (signal via existing endpoint), PB-B9 (observability matching funnel shape), PB-B10 (schema evolution firing schemaChanged), LT-B9. 4 weeks. Frontend: PB-F5, PB-F6, PB-F7 (Funnel-aware), PB-F9 (Funnel-runs panel), PB-F10, LT-F6, LT-F9 (existing endpoint), LT-F10 (using FNL-H4).
Total: ~26 engineer-weeks of focused work for a 3-engineer team across roughly 9 calendar weeks of parallel execution. The Funnel Hardening tasks add 3 weeks vs. v1's 22 — a worthwhile cost given they de-risk every downstream task by ensuring the Funnel substrate can support them at scale.

End of v2 specification. Codex review notes: every task that integrates with the Funnel now references the specific file (mergeStage.ts, funnelDispatcher.ts, cdcLinkProducer.ts, etc.) or endpoint (/api/v1/funnel/signals, /api/v1/funnel/clickhouse/cdc-lag, etc.) it depends on. If during implementation any of those references prove inaccurate (file moved, endpoint renamed, schema differs), update the task spec rather than working around it — the goal is one mental model across Pipeline Builder, Link Types, and Funnel.