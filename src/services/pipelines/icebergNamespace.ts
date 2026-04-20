// ---------------------------------------------------------------------------
// Pipeline Iceberg namespace + slug helpers — PB-B4.
//
// Parallel namespace to the Funnel's `_funnel.<ot>.*` tree. Every
// Iceberg-backed pipeline output lives at
//
//   _pipeline.<project_slug>.<pipeline_slug>.output
//
// The slugifier is deterministic and idempotent: a pipeline's
// namespace must not change between deploys, so we fold case and
// substitute non-[a-z0-9_] with `_`. The max length is 60 chars per
// component to stay well under Lakekeeper's 128 identifier limit
// even after the warehouse prefix is prepended.
//
// NB: the Funnel's namespacing adds a `.changelog`/`.merged`/`.index`/
// `.hydration` suffix *per Object Type*; the Pipeline Builder only has
// one logical output per pipeline for now, so we pin the leaf to
// `output` and reserve the room for `.changelog` to be added as a
// CREATE VIEW in follow-4.
// ---------------------------------------------------------------------------

export const PIPELINE_NAMESPACE_ROOT = "_pipeline";
export const PIPELINE_LEAF_TABLE = "output";

/**
 * Slug a free-text identifier to something Iceberg / Lakekeeper accepts
 * as a namespace / table component. Lowercased; `[^a-z0-9_]` → `_`;
 * trimmed to 60 chars; empty inputs raise.
 */
export function slugForNamespace(raw: string): string {
  const s = (raw ?? "").toString().toLowerCase();
  const cleaned = s.replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (cleaned.length === 0) {
    throw new Error(`cannot slug empty identifier (raw=${JSON.stringify(raw)})`);
  }
  return cleaned.slice(0, 60);
}

/** `_pipeline.<project_slug>.<pipeline_slug>` */
export function pipelineNamespace(
  projectSlug: string,
  pipelineSlug: string,
): string {
  return [
    PIPELINE_NAMESPACE_ROOT,
    slugForNamespace(projectSlug),
    slugForNamespace(pipelineSlug),
  ].join(".");
}

/** Fully qualified table identifier (namespace.table). */
export function pipelineOutputTable(
  projectSlug: string,
  pipelineSlug: string,
): string {
  return `${pipelineNamespace(projectSlug, pipelineSlug)}.${PIPELINE_LEAF_TABLE}`;
}
