// ---------------------------------------------------------------------------
// B9 — Object Type binding contract (spec §B9 line 456).
// ---------------------------------------------------------------------------

import { z } from "zod";

const RID = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix.replace(/\./g, "\\.")}\\..+$`));

export const ObjectTypeBinding = z.object({
  rid: RID("ri.funnel.main.binding"),
  /** Dataset to index. */
  datasetRid: RID("ri.compass.main.dataset"),
  /** Target Object Type. */
  objectTypeRid: RID("ri.ontology.main.object-type"),
  /** Column-to-property map. */
  propertyMap: z.record(z.string(), z.string()),
  /** Indexed properties (must be ≤ 250, criterion 3). */
  indexedProperties: z.array(z.string()),
  /** Primary key column on source. */
  pkColumn: z.string(),
  /** Optional title property (for OS list view rendering). */
  titleProperty: z.string().optional(),
  /** Shard count; must be power-of-2 between 1 and 256. */
  shardCount: z.number().int().min(1).max(256),
  /** Pipeline mode. */
  mode: z.enum(["batch", "streaming"]),
  /** For streaming mode: the CDC topic short. */
  cdcTopicShort: z.string().optional(),
  status: z.enum(["pending", "indexing", "ready", "failed", "reindexing"]),
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ObjectTypeBindingT = z.infer<typeof ObjectTypeBinding>;
/** Re-export under the canonical name expected by repo / handlers / pipeline. */
export type ObjectTypeBinding = ObjectTypeBindingT;
/** Alias for handlers that import the Zod schema under a Schema suffix. */
export const ObjectTypeBindingSchema = ObjectTypeBinding;

export const ObjectTypeBindingCreateRequest = z.object({
  datasetRid: RID("ri.compass.main.dataset"),
  objectTypeRid: RID("ri.ontology.main.object-type"),
  propertyMap: z.record(z.string(), z.string()),
  indexedProperties: z.array(z.string()).max(250),
  pkColumn: z.string(),
  titleProperty: z.string().optional(),
  shardCount: z.number().int().min(1).max(256).default(16),
  mode: z.enum(["batch", "streaming"]),
  cdcTopicShort: z.string().optional(),
});
