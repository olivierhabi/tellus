// ---------------------------------------------------------------------------
// OpenAPI path definitions for Pipeline Builder (PB-B1..B10), Funnel
// Hardening (FNL-H), and Link Types (LT-B) endpoints.
//
// Every path is grouped under a Swagger UI tag that maps 1:1 to the
// feature area, so an ops engineer reading /api/docs can jump straight
// to the subsystem they care about:
//
//   * Observability           — /health/ready, /api/v1/pipelines/metrics
//   * Pipeline Outputs        — output-format migration, Iceberg snapshots
//   * Pipeline Streaming      — Flink restart / streaming-stats
//   * Pipeline ACL            — role-based access control on pipelines
//   * Funnel — Lakekeeper     — catalog introspection
//   * Link Types — Governance — violations, orphans, one-to-one enforcement
//   * Link Types — Analytics  — edges, marking-trace, searchAround estimate
//   * Link Types — Migration  — storage backend migration, resolver config
//
// Shared shapes:
//   - All successful POST/PUT bodies envelope `{success: true, data: …}`.
//   - All error bodies use the OntologyError envelope already defined in
//     `baseSpec.components.schemas`.
//   - Path parameters are typed; query parameters carry `example`s so the
//     Swagger UI "Try it out" form is ready to execute.
// ---------------------------------------------------------------------------

type OpenApiPaths = Record<string, Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Shared parameter + response helpers.
// Kept local (not exported) so the naming convention can drift from other
// spec files without leaking into the merged components.schemas.
// ---------------------------------------------------------------------------

const pathParam = (name: string, format?: string): Record<string, unknown> => ({
  name,
  in: "path" as const,
  required: true,
  schema: { type: "string" as const, ...(format ? { format } : {}) },
});

const queryParam = (
  name: string,
  schema: Record<string, unknown>,
  description?: string,
): Record<string, unknown> => ({
  name,
  in: "query" as const,
  required: false,
  schema,
  ...(description ? { description } : {}),
});

const jsonResponse = (
  description: string,
  schema?: Record<string, unknown>,
): Record<string, unknown> => ({
  description,
  ...(schema
    ? {
        content: {
          "application/json": {
            schema,
          },
        },
      }
    : {}),
});

const envelope = (
  dataSchema: Record<string, unknown>,
): Record<string, unknown> => ({
  type: "object" as const,
  properties: {
    success: { type: "boolean" as const, example: true },
    data: dataSchema,
  },
  required: ["success", "data"],
});

// ---------------------------------------------------------------------------
// PB-B9 — Observability endpoints.
// ---------------------------------------------------------------------------
const observabilityPaths: OpenApiPaths = {
  "/health/ready": {
    get: {
      tags: ["Observability"],
      summary: "Readiness probe (PB-B9 acceptance b)",
      description:
        "Returns 200 when every hard dependency (Postgres, S3) is reachable " +
        "within a 1s probe budget. Soft probes (Temporal, Lakekeeper) are " +
        "reported per-probe but do not flip the top-level `ready` flag — the " +
        "PG-backed dispatcher keeps the system serving when those deps flap. " +
        "Increments `pipeline_health_check_failures_total{probe}` on any " +
        "per-probe failure.",
      responses: {
        "200": jsonResponse(
          "All hard probes green.",
          envelope({
            type: "object",
            properties: {
              ready: { type: "boolean", example: true },
              probes: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    latencyMs: { type: "number" },
                    error: { type: "string" },
                  },
                },
              },
            },
          }),
        ),
        "503": jsonResponse("One or more hard probes failed."),
      },
    },
  },
  "/v1/pipelines/metrics": {
    get: {
      tags: ["Observability"],
      summary: "Prometheus scrape endpoint (PB-B9)",
      description:
        "Exposes the 9 spec-mandated metric families in Prometheus text " +
        "exposition format: `pipeline_deploy_duration_seconds`, " +
        "`pipeline_deploy_total`, `pipeline_preview_duration_seconds`, " +
        "`pipeline_active_deploys`, `pipeline_input_rows_processed_total`, " +
        "`duckdb_memory_bytes`, `iceberg_snapshot_commit_duration_seconds`, " +
        "`temporal_workflow_failures_total`, `pipeline_orphan_runs_swept_total`.",
      responses: {
        "200": {
          description: "Prometheus text exposition.",
          content: {
            "text/plain; version=0.0.4": {
              schema: { type: "string" as const },
            },
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// PB-B3 / PB-B4 — Pipeline output surface.
// ---------------------------------------------------------------------------
const pipelineOutputPaths: OpenApiPaths = {
  "/v1/projects/{projectId}/pipelines/{pipelineId}/migrate-output-format": {
    post: {
      tags: ["Pipeline Outputs"],
      summary: "Atomically switch output_format (PB-B3)",
      description:
        "Admin endpoint that re-deploys a pipeline with `output_format=" +
        "parquet` (or `iceberg`) against its existing dataset, atomically " +
        "updating `foundry_datasets.format`. Rejects pipelines whose schema " +
        "has `null`-typed columns with `SCHEMA_NOT_TYPED_FOR_PARQUET`.",
      parameters: [pathParam("projectId", "uuid"), pathParam("pipelineId", "uuid")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["targetFormat"],
              properties: {
                targetFormat: {
                  type: "string",
                  enum: ["csv", "parquet", "iceberg"],
                },
              },
            },
          },
        },
      },
      responses: {
        "200": jsonResponse("Migration accepted and deployment started."),
        "400": jsonResponse(
          "SCHEMA_NOT_TYPED_FOR_PARQUET, NO_OUTPUTS, or VALIDATION_ERROR.",
        ),
        "403": jsonResponse("INSUFFICIENT_ROLE — owner required."),
      },
    },
  },
  "/v1/projects/{projectId}/pipelines/{pipelineId}/output/snapshots": {
    get: {
      tags: ["Pipeline Outputs"],
      summary: "Iceberg snapshot history (PB-B4)",
      description:
        "Returns the snapshot list for the pipeline's Iceberg output " +
        "table, one row per committed snapshot, ordered oldest→newest.",
      parameters: [pathParam("projectId", "uuid"), pathParam("pipelineId", "uuid")],
      responses: {
        "200": jsonResponse(
          "Snapshot list.",
          envelope({
            type: "object",
            properties: {
              snapshots: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    snapshot_id: { type: "string" },
                    parent_id: { type: "string", nullable: true },
                    timestamp_ms: { type: "integer" },
                    operation: { type: "string" },
                    summary: { type: "object" },
                  },
                },
              },
            },
          }),
        ),
        "404": jsonResponse("Pipeline not found or output_format ≠ iceberg."),
      },
    },
  },
  "/v1/projects/{projectId}/pipelines/{pipelineId}/output": {
    get: {
      tags: ["Pipeline Outputs"],
      summary: "Time-travel read of pipeline output (PB-B4)",
      description:
        "Queries the Iceberg output table at a specific snapshot via " +
        "DuckDB's `iceberg_scan`. Either `as_of_snapshot=N` or " +
        "`as_of_timestamp=ISO8601` must be supplied; the other is ignored.",
      parameters: [
        pathParam("projectId", "uuid"),
        pathParam("pipelineId", "uuid"),
        queryParam(
          "as_of_snapshot",
          { type: "integer", format: "int64" },
          "Iceberg snapshot id (as returned by /output/snapshots).",
        ),
        queryParam(
          "as_of_timestamp",
          { type: "string", format: "date-time" },
          "ISO-8601 timestamp; the catalog resolves it to the last snapshot ≤ t.",
        ),
        queryParam(
          "limit",
          { type: "integer", minimum: 1, maximum: 10000, default: 1000 },
          "Row cap for the scan.",
        ),
      ],
      responses: {
        "200": jsonResponse(
          "Arrow/JSON row set scoped to the chosen snapshot.",
          envelope({
            type: "object",
            properties: {
              columns: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "object" } },
              rowCount: { type: "integer" },
            },
          }),
        ),
        "400": jsonResponse("OUTPUT_NOT_ICEBERG or VALIDATION_ERROR."),
        "404": jsonResponse("Snapshot not found (may be expired)."),
      },
    },
  },
};

// ---------------------------------------------------------------------------
// PB-B5 — Streaming deploy surface (Flink).
// ---------------------------------------------------------------------------
const streamingPaths: OpenApiPaths = {
  "/v1/projects/{projectId}/pipelines/{pipelineId}/deployments/{deploymentId}/restart":
    {
      post: {
        tags: ["Pipeline Streaming"],
        summary: "Resume a streaming deploy from its last savepoint (PB-B5)",
        description:
          "Issues `flink run --fromSavepoint <s3-path>` using the savepoint " +
          "id stamped during a prior `DELETE /deployments/{id}` cancellation. " +
          "Creates a new deployment row with a fresh `flink_job_id` and " +
          "preserves the original deployment's idempotency-key fingerprint.",
        parameters: [
          pathParam("projectId", "uuid"),
          pathParam("pipelineId", "uuid"),
          pathParam("deploymentId", "uuid"),
        ],
        responses: {
          "200": jsonResponse(
            "Restart accepted.",
            envelope({
              type: "object",
              properties: {
                deploymentId: { type: "string", format: "uuid" },
                flinkJobId: { type: "string" },
              },
            }),
          ),
          "404": jsonResponse("NOT_FOUND — deployment id unknown."),
          "409": jsonResponse("CONFLICT — no savepoint captured."),
        },
      },
    },
  "/v1/projects/{projectId}/pipelines/{pipelineId}/deployments/{deploymentId}/streaming-stats":
    {
      get: {
        tags: ["Pipeline Streaming"],
        summary: "Flink watermark + lag + checkpoint health (PB-B5)",
        description:
          "Surfaces the per-operator watermark, consumer lag (bytes + " +
          "records), last successful checkpoint age, and backpressure " +
          "signal. Available only while the deploy is in status " +
          "`running_streaming`.",
        parameters: [
          pathParam("projectId", "uuid"),
          pathParam("pipelineId", "uuid"),
          pathParam("deploymentId", "uuid"),
        ],
        responses: {
          "200": jsonResponse(
            "Streaming stats snapshot.",
            envelope({
              type: "object",
              properties: {
                flinkJobId: { type: "string" },
                watermarkMs: { type: "integer" },
                lagBytes: { type: "integer" },
                lagRecords: { type: "integer" },
                lastCheckpointAgeMs: { type: "integer" },
                backpressureLevel: { type: "string", enum: ["ok", "medium", "high"] },
              },
            }),
          ),
          "404": jsonResponse("NOT_FOUND — deployment id unknown."),
        },
      },
    },
};

// ---------------------------------------------------------------------------
// PB-B7 — Pipeline ACL surface.
// ---------------------------------------------------------------------------
const pipelineAclPaths: OpenApiPaths = {
  "/v1/projects/{projectId}/pipelines/{pipelineId}/acl": {
    get: {
      tags: ["Pipeline ACL"],
      summary: "List ACL grants on a pipeline (PB-B7)",
      description:
        "Returns every `pipeline_acl` row on the given pipeline. Requires " +
        "`owner` role — editors/viewers get 403 INSUFFICIENT_ROLE.",
      parameters: [pathParam("projectId", "uuid"), pathParam("pipelineId", "uuid")],
      responses: {
        "200": jsonResponse(
          "ACL rows.",
          envelope({
            type: "object",
            properties: {
              acl: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    principalId: { type: "string", format: "uuid" },
                    principalType: { type: "string", enum: ["user", "group"] },
                    role: { type: "string", enum: ["owner", "editor", "viewer"] },
                    grantedBy: { type: "string", format: "uuid" },
                    grantedAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          }),
        ),
        "403": jsonResponse("INSUFFICIENT_ROLE — owner required."),
      },
    },
  },
  "/v1/projects/{projectId}/pipelines/{pipelineId}/acl/{principalId}": {
    put: {
      tags: ["Pipeline ACL"],
      summary: "Grant a role to a principal (PB-B7)",
      description:
        "Idempotent upsert — same principal with same role is a no-op. " +
        "Every grant/revoke emits a `pipeline_acl` audit event.",
      parameters: [
        pathParam("projectId", "uuid"),
        pathParam("pipelineId", "uuid"),
        pathParam("principalId", "uuid"),
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["role", "principalType"],
              properties: {
                role: { type: "string", enum: ["owner", "editor", "viewer"] },
                principalType: { type: "string", enum: ["user", "group"] },
              },
            },
          },
        },
      },
      responses: {
        "200": jsonResponse("Grant persisted."),
        "403": jsonResponse("INSUFFICIENT_ROLE — owner required."),
      },
    },
    delete: {
      tags: ["Pipeline ACL"],
      summary: "Revoke a role (PB-B7)",
      parameters: [
        pathParam("projectId", "uuid"),
        pathParam("pipelineId", "uuid"),
        pathParam("principalId", "uuid"),
      ],
      responses: {
        "200": jsonResponse("Grant removed."),
        "403": jsonResponse("INSUFFICIENT_ROLE — owner required."),
        "404": jsonResponse("No grant for this principal."),
      },
    },
  },
};

// ---------------------------------------------------------------------------
// FNL-H — Lakekeeper introspection.
// ---------------------------------------------------------------------------
const funnelLakekeeperPaths: OpenApiPaths = {
  "/v1/funnel/lakekeeper/namespaces": {
    get: {
      tags: ["Funnel — Lakekeeper"],
      summary: "List namespaces managed by Lakekeeper (FNL-H)",
      description:
        "Proxies to the Lakekeeper REST catalog's namespace listing for the " +
        "configured warehouse. Returns 503 when Lakekeeper is unreachable.",
      responses: {
        "200": jsonResponse(
          "Namespace list.",
          envelope({
            type: "object",
            properties: {
              warehouse: { type: "string" },
              namespaces: { type: "array", items: { type: "string" } },
            },
          }),
        ),
        "503": jsonResponse("Lakekeeper unreachable."),
      },
    },
  },
};

// ---------------------------------------------------------------------------
// LT-B — Link Types — Governance (violations, orphans, constraints).
// ---------------------------------------------------------------------------
const linkGovernancePaths: OpenApiPaths = {
  "/v1/ontology/{ontologyId}/linkTypes/_config/resolver": {
    get: {
      tags: ["Link Types — Migration"],
      summary: "Read link resolver configuration (LT-B)",
      description:
        "Returns the current resolver mode (`overlay_then_db`, `db_only`, " +
        "etc.) for link queries — controls whether the writeback overlay " +
        "is consulted before the authoritative store.",
      parameters: [pathParam("ontologyId", "uuid")],
      responses: {
        "200": jsonResponse("Current resolver config."),
      },
    },
    put: {
      tags: ["Link Types — Migration"],
      summary: "Update link resolver configuration (LT-B)",
      parameters: [pathParam("ontologyId", "uuid")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["mode"],
              properties: {
                mode: { type: "string", enum: ["overlay_then_db", "db_only"] },
              },
            },
          },
        },
      },
      responses: {
        "200": jsonResponse("Config updated."),
        "400": jsonResponse("VALIDATION_ERROR."),
      },
    },
  },
  "/v1/ontology/{ontologyId}/linkTypes/{apiName}/violations": {
    get: {
      tags: ["Link Types — Governance"],
      summary: "List constraint violations on a link type (LT-B)",
      description:
        "Surfaces rows that violate cardinality or marking invariants for " +
        "the given link type. Consumers use this before running " +
        "`enforce-one-to-one` or `migrate-storage`.",
      parameters: [
        pathParam("ontologyId", "uuid"),
        pathParam("apiName"),
      ],
      responses: {
        "200": jsonResponse("Paginated violation list."),
        "404": jsonResponse("Link type not found."),
      },
    },
  },
  "/v1/ontology/{ontologyId}/linkTypes/{apiName}/violations/{violationId}/resolve":
    {
      post: {
        tags: ["Link Types — Governance"],
        summary: "Resolve a violation (LT-B)",
        parameters: [
          pathParam("ontologyId", "uuid"),
          pathParam("apiName"),
          pathParam("violationId", "uuid"),
        ],
        responses: {
          "200": jsonResponse("Violation resolved."),
          "404": jsonResponse("Violation or link type not found."),
        },
      },
    },
  "/v1/ontology/{ontologyId}/linkTypes/{apiName}/violations/{violationId}/dismiss":
    {
      post: {
        tags: ["Link Types — Governance"],
        summary: "Dismiss a violation without repairing (LT-B)",
        parameters: [
          pathParam("ontologyId", "uuid"),
          pathParam("apiName"),
          pathParam("violationId", "uuid"),
        ],
        responses: {
          "200": jsonResponse("Violation dismissed."),
          "404": jsonResponse("Violation or link type not found."),
        },
      },
    },
  "/v1/ontology/{ontologyId}/linkTypes/{apiName}/enforce-one-to-one": {
    post: {
      tags: ["Link Types — Governance"],
      summary: "Rewrite link_edits to satisfy 1:1 cardinality (LT-B)",
      description:
        "Walks the link table, collapses any >1 incoming/outgoing edges to " +
        "the most recent survivor per source/target, and writes retraction " +
        "events for the rest.",
      parameters: [pathParam("ontologyId", "uuid"), pathParam("apiName")],
      responses: {
        "200": jsonResponse("Enforcement ran — summary in the response body."),
        "400": jsonResponse(
          "VALIDATION_ERROR — link is not MANY_TO_MANY or shape is incompatible.",
        ),
      },
    },
  },
  "/v1/ontology/{ontologyId}/linkTypes/{apiName}/orphan-stats": {
    get: {
      tags: ["Link Types — Governance"],
      summary: "Summary counts of orphaned link edges (LT-B)",
      parameters: [pathParam("ontologyId", "uuid"), pathParam("apiName")],
      responses: {
        "200": jsonResponse(
          "Orphan counts.",
          envelope({
            type: "object",
            properties: {
              totalEdges: { type: "integer" },
              orphanEdges: { type: "integer" },
              lastScanAt: { type: "string", format: "date-time", nullable: true },
            },
          }),
        ),
      },
    },
  },
  "/v1/ontology/{ontologyId}/linkTypes/{apiName}/orphan-scan": {
    post: {
      tags: ["Link Types — Governance"],
      summary: "Trigger an orphan-edge scan (LT-B)",
      description:
        "Samples up to `sampleLimit` edges and reports the Wilson CI of " +
        "orphan density so ops can decide whether to purge.",
      parameters: [pathParam("ontologyId", "uuid"), pathParam("apiName")],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                sampleLimit: { type: "integer", minimum: 10, maximum: 10000 },
              },
            },
          },
        },
      },
      responses: {
        "200": jsonResponse("Scan result with Wilson CI."),
      },
    },
  },
  "/v1/ontology/{ontologyId}/linkTypes/{apiName}/orphans": {
    get: {
      tags: ["Link Types — Governance"],
      summary: "Paginated list of orphan link edges (LT-B)",
      parameters: [
        pathParam("ontologyId", "uuid"),
        pathParam("apiName"),
        queryParam("cursor", { type: "string" }, "Pagination cursor."),
        queryParam("limit", { type: "integer", default: 100, maximum: 1000 }),
      ],
      responses: {
        "200": jsonResponse("Paginated orphan list."),
      },
    },
  },
};

// ---------------------------------------------------------------------------
// LT-B — Link Types — Analytics (edges, marking trace, searchAround).
// ---------------------------------------------------------------------------
const linkAnalyticsPaths: OpenApiPaths = {
  "/v1/ontology/{ontologyId}/linkTypes/{apiName}/edges": {
    get: {
      tags: ["Link Types — Analytics"],
      summary: "Paginated edge listing for a link type (LT-B)",
      parameters: [
        pathParam("ontologyId", "uuid"),
        pathParam("apiName"),
        queryParam("cursor", { type: "string" }),
        queryParam("limit", { type: "integer", default: 100, maximum: 1000 }),
      ],
      responses: {
        "200": jsonResponse("Paginated edge list."),
      },
    },
  },
  "/v1/ontology/{ontologyId}/linkTypes/{apiName}/edge/{sourcePK}/{targetPK}/marking-trace":
    {
      get: {
        tags: ["Link Types — Analytics"],
        summary: "Provenance trace of markings on one edge (LT-B)",
        description:
          "Returns the full set of markings the edge carries, plus the " +
          "source (backing datasource, overlay, inherited from object) for " +
          "each. Used by the Ontology Explorer for marking debugging.",
        parameters: [
          pathParam("ontologyId", "uuid"),
          pathParam("apiName"),
          pathParam("sourcePK"),
          pathParam("targetPK"),
        ],
        responses: {
          "200": jsonResponse("Trace payload."),
          "404": jsonResponse("Edge not found."),
        },
      },
    },
  "/v1/ontology/{ontologyId}/linkTypes/{apiName}/searchAround/estimate": {
    get: {
      tags: ["Link Types — Analytics"],
      summary: "Cost estimate for a multi-hop searchAround (LT-B)",
      description:
        "Returns predicted hop cardinalities and marking-filter selectivity " +
        "before the real searchAround runs — lets clients decide whether to " +
        "issue the expensive query.",
      parameters: [pathParam("ontologyId", "uuid"), pathParam("apiName")],
      responses: {
        "200": jsonResponse("Cost estimate envelope."),
      },
    },
  },
  "/v1/ontology/{ontologyId}/linkTypes/{apiName}/visibility-summary": {
    get: {
      tags: ["Link Types — Analytics"],
      summary: "Per-marking edge visibility breakdown (LT-B)",
      description:
        "Reports the count of edges visible to each marking set. Feeds the " +
        "Ontology Explorer's marking pie-chart.",
      parameters: [pathParam("ontologyId", "uuid"), pathParam("apiName")],
      responses: {
        "200": jsonResponse("Visibility summary."),
      },
    },
  },
};

// ---------------------------------------------------------------------------
// LT-B — Link Types — Migration (storage backend).
// ---------------------------------------------------------------------------
const linkMigrationPaths: OpenApiPaths = {
  "/v1/ontology/{ontologyId}/linkTypes/{apiName}/migrate-storage": {
    post: {
      tags: ["Link Types — Migration"],
      summary: "Change a link type's storage backend (LT-B)",
      description:
        "Moves the link table between storage backends (e.g. CSV → Iceberg " +
        "M2M). Validates pre-conditions (cardinality, row count, marking " +
        "coverage) before starting a supervised migration Temporal workflow.",
      parameters: [pathParam("ontologyId", "uuid"), pathParam("apiName")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["targetBackend"],
              properties: {
                targetBackend: {
                  type: "string",
                  enum: ["csv", "iceberg"],
                },
                dryRun: { type: "boolean", default: false },
              },
            },
          },
        },
      },
      responses: {
        "200": jsonResponse("Migration accepted or dry-run result."),
        "400": jsonResponse("VALIDATION_ERROR — pre-condition failed."),
        "404": jsonResponse("Link type not found."),
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Merged export — grouped in the same order the Swagger UI tags appear.
// ---------------------------------------------------------------------------
export const pbFnlLtPaths: OpenApiPaths = {
  ...observabilityPaths,
  ...pipelineOutputPaths,
  ...streamingPaths,
  ...pipelineAclPaths,
  ...funnelLakekeeperPaths,
  ...linkGovernancePaths,
  ...linkAnalyticsPaths,
  ...linkMigrationPaths,
};

// Tags to register in the Swagger UI left-rail so ops can jump straight
// to the subsystem they care about.
export const pbFnlLtTags: Array<{ name: string; description: string }> = [
  {
    name: "Observability",
    description:
      "Readiness probes, Prometheus metrics, and burn-rate indicators " +
      "(PB-B9).",
  },
  {
    name: "Pipeline Outputs",
    description:
      "output_format migration (CSV→Parquet→Iceberg) + Iceberg time-travel " +
      "reads (PB-B3 / PB-B4).",
  },
  {
    name: "Pipeline Streaming",
    description:
      "Flink-backed streaming pipelines: savepoint-based restart + " +
      "watermark/lag/checkpoint telemetry (PB-B5).",
  },
  {
    name: "Pipeline ACL",
    description:
      "Per-pipeline role-based access control (owner/editor/viewer) + " +
      "marking propagation (PB-B7).",
  },
  {
    name: "Funnel — Lakekeeper",
    description:
      "Lakekeeper REST catalog introspection: warehouses, namespaces, " +
      "table metadata (FNL-H).",
  },
  {
    name: "Link Types — Governance",
    description:
      "Constraint violations, orphan edge scans, cardinality enforcement " +
      "(LT-B).",
  },
  {
    name: "Link Types — Analytics",
    description:
      "Edge listing, marking provenance trace, searchAround cost estimate, " +
      "per-marking visibility summary (LT-B).",
  },
  {
    name: "Link Types — Migration",
    description:
      "Link resolver config + storage backend migration workflows " +
      "(LT-B).",
  },
];
