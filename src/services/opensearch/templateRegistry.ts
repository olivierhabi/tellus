// ---------------------------------------------------------------------------
// Index Template Registry
//
// Manages OpenSearch index templates that are applied automatically when new
// indices are created. Instead of specifying settings on every index creation
// call, we register a template that applies default settings to all
// `ontology-*` indices.
//
// The system field definitions here MUST stay in sync with the system fields
// defined in indexMappingGenerator.ts (Task 3). Both modules use the same
// field names and types so that indices created via the template and indices
// created via the explicit mapping generator produce identical schemas.
//
// Call ensureIndexTemplate() during application startup (before any indexing
// operations) so the template is in place before any index is created.
// ---------------------------------------------------------------------------

import { client } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by ensureIndexTemplate(). */
export interface EnsureTemplateResult {
  success: true;
  action: "created" | "updated";
  templateName: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Template name registered in OpenSearch. */
const TEMPLATE_NAME = "ontology-template";

/**
 * System field mappings — identical to the ones in indexMappingGenerator.ts.
 *
 * These fields are present on every indexed object regardless of the object
 * type's user-defined properties.
 */
const SYSTEM_FIELD_MAPPINGS = {
  __pk: { type: "keyword" as const },
  __ontology: { type: "keyword" as const },
  __rid: { type: "keyword" as const },
  __objectType: { type: "keyword" as const },
  __lastModified: { type: "date" as const },
  __version: { type: "long" as const },
  __editedBy: { type: "keyword" as const },
  __datasourceVersion: { type: "keyword" as const },
  __branch: { type: "keyword" as const },
};

/**
 * Default index settings applied to all ontology-* indices via the template.
 * These match the settings in indexMappingGenerator.ts.
 */
const DEFAULT_TEMPLATE_SETTINGS = {
  // Env-tunable: a single shard caps OpenSearch indexing at one thread, which
  // made the 5.6M-row OlivierOrder2 bulk-sync crawl (~8 s / 5000-doc page,
  // ~2 hr). 4 shards parallelise indexing on multi-core dev boxes (~4×). Prod
  // defaults to 1 (one OT index is small; shard overhead isn't worth it there).
  number_of_shards: Number(process.env.OS_INDEX_SHARDS ?? "1"),
  // Env-tunable: 0 replicas for single-node dev (no HA). Prod must set
  // OS_INDEX_REPLICAS >= 1 once a multi-node cluster topology exists; do NOT
  // hardcode a prod value here (we don't have that topology yet). Both this
  // file and indexMappingGenerator.ts read the SAME env var — keep them in
  // sync (drift would make template-created vs explicitly-created indices
  // diverge on replica count).
  number_of_replicas: Number(process.env.OS_INDEX_REPLICAS ?? "0"),
  refresh_interval: "1s",
  max_result_window: 100000,
};

// ---------------------------------------------------------------------------
// ensureIndexTemplate()
// ---------------------------------------------------------------------------

/**
 * Create or update the `ontology-template` index template in OpenSearch.
 *
 * This template matches all `ontology-*` indices and applies:
 *   - Default index settings (shards, replicas, refresh interval, etc.)
 *   - System field mappings (__pk, __objectType, __lastModified, etc.)
 *
 * The index mapping generator (Task 3) adds object-type-specific property
 * mappings on top of these template-provided defaults.
 *
 * @returns An EnsureTemplateResult with the action taken ("created" or "updated").
 * @throws Error if the OpenSearch put_template call fails.
 */
export async function ensureIndexTemplate(): Promise<EnsureTemplateResult> {
  // Check if the template already exists to determine the action
  let templateExists = false;

  try {
    const { body } = await client.indices.existsTemplate({
      name: TEMPLATE_NAME,
    });
    templateExists = !!body;
  } catch {
    // If the check fails, assume it doesn't exist and try to create it
    templateExists = false;
  }

  const action: "created" | "updated" = templateExists ? "updated" : "created";

  try {
    await client.indices.putTemplate({
      name: TEMPLATE_NAME,
      body: {
        index_patterns: ["ontology-*"],
        settings: DEFAULT_TEMPLATE_SETTINGS,
        mappings: {
          properties: SYSTEM_FIELD_MAPPINGS,
        },
      },
    });

    console.log(
      `Index template '${TEMPLATE_NAME}' ensured (action: ${action})`
    );

    return {
      success: true,
      action,
      templateName: TEMPLATE_NAME,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const details =
      err && typeof err === "object" && "meta" in err
        ? JSON.stringify((err as Record<string, unknown>).meta)
        : message;

    throw new Error(
      `Failed to ${action === "created" ? "create" : "update"} index template '${TEMPLATE_NAME}': ${details}`
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { ensureIndexTemplate };
