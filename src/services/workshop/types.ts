// Workshop B01 — wire-level types.
//
// Decision D-03: Zod is the contract source-of-truth in the absence of a
// Conjure pipeline. Server validation and client typed wrappers both
// consume these schemas. Strict mode (`.strict()`) on every object shape
// because Workshop never accepts unknown keys silently.

import { z } from "zod";

export const RID_REGEX = /^ri\.workshop\.main\.module\.[0-9a-fA-F-]{36}$/;
export const ONTOLOGY_RID_REGEX = /^ri\.ontology\.main\.ontology\.[0-9a-fA-F-]{36}$/;
export const FOLDER_RID_REGEX = /^ri\.compass\.main\.folder\.[0-9a-fA-F-]{36}$/;
export const BRANCH_RID_REGEX = /^ri\.[a-zA-Z0-9-]+\.main\.branch\.[0-9a-fA-F-]{36}$/;

// Module-level page header. Distinct from `layout.header` (which is the
// header-WIDGET slot pointer inside the layout graph). This is the
// visible page-header strip at the top of the canvas — the editor's
// HeaderInspector writes to it via PUT and the viewer renders it on
// hydration. The FE has carried this shape since F02; the schema was
// missing the slot which caused a round-trip data-loss bug for every
// title edit (saves were rejected with Tellus:Workshop:InvalidModuleSchema
// `unrecognized_keys: ["header"]`). All fields optional + .strict() so
// future header attributes are explicit additions, not silent passthroughs.
const moduleHeaderSchema = z
  .object({
    title: z.string().max(200).optional(),
    icon: z.string().max(100).nullable().optional(),
    color: z.string().max(100).nullable().optional(),
  })
  .strict()
  .optional();

// Per-section COLUMN WIDTH. The empty-shell editor lays widgets out across two
// fixed columns ("section-box" / "section-page"), AND any section in the layout
// tree (split/added sections) can carry its own width. Each section's COLUMN
// WIDTH (Absolute px or Flex factor) — optionally RESIZABLE — is authored in the
// SectionInspector / dragged on the canvas and persisted here so a reloaded
// module keeps the user's resized layout. The FE carries a "fat record" (both px
// + flex values plus the active mode and a resizable flag) so toggling mode
// doesn't lose the other value — mirrored verbatim here. Without this slot every
// section resize was rejected with Tellus:Workshop:InvalidModuleSchema
// `unrecognized_keys: ["columnWidths"]` (the same round-trip data-loss class the
// `header` slot above fixed); keying by the two fixed columns ALONE likewise
// rejected tree-section widths with `unrecognized_keys: ["<sectionId>"]`.
const sectionWidthSpecSchema = z
  .object({
    mode: z.enum(["absolute", "flex"]),
    pxWidth: z.number(),
    flexValue: z.number(),
    resizable: z.boolean().optional(),
  })
  .strict();

// A map keyed by section id (the two fixed columns OR any tree section id) →
// width spec. `z.record` accepts arbitrary keys while still strictly validating
// each value, so the two-fixed-column behavior is preserved and generalized.
const columnWidthsSchema = z
  .record(z.string(), sectionWidthSpecSchema)
  .optional();

export const moduleDefinitionSchema = z
  .object({
    schemaVersion: z.literal(4),
    displayName: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    moduleInterface: z.unknown().optional(),
    routing: z.unknown().optional(),
    variables: z.array(z.unknown()).default([]),
    widgets: z.array(z.unknown()).default([]),
    sections: z.array(z.unknown()).optional(),
    header: moduleHeaderSchema,
    layout: z
      .object({
        rootSection: z.string(),
        header: z.object({ widgetId: z.string() }).strict().optional(),
        columnWidths: columnWidthsSchema,
      })
      .strict(),
  })
  .strict();

export type ModuleDefinition = z.infer<typeof moduleDefinitionSchema>;

export const createModuleRequestSchema = z
  .object({
    displayName: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    parentFolderRid: z.string().regex(FOLDER_RID_REGEX),
    ontologyRid: z.string().regex(ONTOLOGY_RID_REGEX),
    branchRid: z.string().regex(BRANCH_RID_REGEX).nullable().optional(),
    definition: moduleDefinitionSchema,
  })
  .strict();

export type CreateModuleRequest = z.infer<typeof createModuleRequestSchema>;

export const updateModuleRequestSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    definition: moduleDefinitionSchema,
  })
  .strict();

export type UpdateModuleRequest = z.infer<typeof updateModuleRequestSchema>;

export interface ModuleRow {
  rid: string;
  ontology_rid: string;
  display_name: string;
  description: string | null;
  current_semver: string;
  published_semver: string | null;
  definition: unknown;
  etag: string;
  schema_version: number;
  parent_folder_rid: string;
  branch_rid: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
}

export interface ModuleResponse {
  rid: string;
  ontologyRid: string;
  displayName: string;
  description: string | null;
  currentSemver: string;
  publishedSemver: string | null;
  parentFolderRid: string;
  branchRid: string | null;
  schemaVersion: number;
  definition: unknown;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export function rowToResponse(row: ModuleRow): ModuleResponse {
  return {
    rid: row.rid,
    ontologyRid: row.ontology_rid,
    displayName: row.display_name,
    description: row.description,
    currentSemver: row.current_semver,
    publishedSemver: row.published_semver,
    parentFolderRid: row.parent_folder_rid,
    branchRid: row.branch_rid,
    schemaVersion: row.schema_version,
    definition: row.definition,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}
