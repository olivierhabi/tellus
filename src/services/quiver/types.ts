// Quiver — shared TypeScript / zod types.
// Single source of truth for the Conjure-equivalent wire shapes (D-07).

import { z } from "zod";

// ---------- Card types (B2 registry) ---------------------------------------
export const CARD_TYPES = [
  "OBJECT_SET",
  "FILTER_OBJECT_SET",
  "SEARCH_AROUND",
  "AGGREGATION",
  "TRANSFORM_TABLE",
  "MATERIALIZATION",
  "JOIN_MATERIALIZATION",
  "EXPRESSION",
  "NUMERIC_FORMULA",
  "BOOLEAN_FORMULA",
  "TIME_SERIES_PLOT",
  "TIME_SERIES_CHART",
  "ROLLING_AGGREGATE",
  "EVENT_SET",
  "TIME_SERIES_FORMULA",
  "CATEGORICAL_CHART",
  "PIVOT_TABLE",
  "VEGA_PLOT",
  "PARAMETER_STRING",
  "PARAMETER_NUMBER",
  "PARAMETER_DATETIME",
  "PARAMETER_BOOLEAN",
  "PROPERTY_VALUE_SELECT",
  "ACTION_BUTTON",
  "FUNCTION_CALL",
  "VISUAL_FUNCTION_CALL",
] as const;

export const CardType = z.enum(CARD_TYPES);
export type CardType = z.infer<typeof CardType>;

export const OUTPUT_TYPES = [
  "OBJECT_SET",
  "TRANSFORM_TABLE",
  "MATERIALIZATION",
  "NUMBER",
  "STRING",
  "BOOLEAN",
  "DATETIME",
  "TIME_SERIES_PLOT",
  "TIME_SERIES_CHART",
  "EVENT_SET",
  "CATEGORICAL_CHART",
  "VEGA_PLOT",
  "NONE",
  "ANY",
] as const;
export const OutputType = z.enum(OUTPUT_TYPES);
export type OutputType = z.infer<typeof OutputType>;

// CardId regex: leading "$", uppercase letters only (B2 C-10).
export const CardId = z
  .string()
  .regex(/^\$[A-Z]+$/u, "card id must match /^\\$[A-Z]+$/");
export type CardId = z.infer<typeof CardId>;

export const Card = z.object({
  id: CardId,
  type: CardType,
  config: z.record(z.string(), z.unknown()).default({}),
  inputs: z.record(z.string(), CardId).default({}),
  hidden: z.boolean().default(false),
  displayName: z.string().max(200).optional(),
});
export type Card = z.infer<typeof Card>;

export const CanvasId = z.string().min(1).max(80);
export type CanvasId = z.infer<typeof CanvasId>;

export const CanvasPlacement = z.object({
  cardId: CardId,
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
export const Canvas = z.object({
  id: CanvasId,
  name: z.string().min(1).max(200),
  placements: z.array(CanvasPlacement).default([]),
  ordering: z.array(CardId).default([]),
});
export type Canvas = z.infer<typeof Canvas>;

export const Parameter = z.object({
  cardId: CardId,
  type: z.enum(["STRING", "NUMBER", "DATETIME", "BOOLEAN"]),
  defaultValueJson: z.unknown().nullable().default(null),
  externalName: z.string().min(1).max(100).optional(),
});
export type Parameter = z.infer<typeof Parameter>;

export const NotebookMetadata = z.object({
  defaultLoad: z.enum(["ALL", "VISIBLE"]).default("VISIBLE"),
  cardIdCounter: z.number().int().nonnegative().default(0),
  branchRid: z.string().nullable().optional(),
});
export type NotebookMetadata = z.infer<typeof NotebookMetadata>;

// ---------- AnalysisDocument (B1) ------------------------------------------
export const AnalysisRid = z
  .string()
  .regex(
    /^ri\.tellus-quiver\.main\.analysis\.[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    "must be ri.tellus-quiver.main.analysis.<uuidv7>",
  );
export type AnalysisRid = z.infer<typeof AnalysisRid>;

export const AnalysisDocument = z.object({
  rid: AnalysisRid,
  parentFolderRid: z.string().min(1),
  displayName: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().default(null),
  notebookMetadata: NotebookMetadata,
  cards: z.record(CardId, Card).default({}),
  canvases: z.array(Canvas).default([]),
  parameters: z.record(CardId, Parameter).default({}),
  currentVersion: z.number().int().nonnegative(),
  etag: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
  markings: z.array(z.string()).default([]),
  isDeleted: z.boolean().default(false),
  deletedAt: z.string().nullable().default(null),
});
export type AnalysisDocument = z.infer<typeof AnalysisDocument>;

export const ObjectSetReference = z.object({
  ontologyRid: z.string().min(1),
  objectSetRid: z.string().min(1).optional(),
  inlineDefinition: z.unknown().optional(),
});
export type ObjectSetReference = z.infer<typeof ObjectSetReference>;

export const CreateAnalysisRequest = z
  .object({
    parentFolderRid: z.string().min(1),
    displayName: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    seedFromObjectSet: ObjectSetReference.optional(),
    seedFromTemplate: z.string().min(1).optional(),
    markings: z.array(z.string()).max(64).optional(),
  })
  .refine(
    (v) => !(v.seedFromObjectSet && v.seedFromTemplate),
    {
      message: "seedFromObjectSet and seedFromTemplate are mutually exclusive",
      path: ["seedFromObjectSet"],
    },
  );
export type CreateAnalysisRequest = z.infer<typeof CreateAnalysisRequest>;

export const UpdateAnalysisMetadataRequest = z.object({
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  markings: z.array(z.string()).max(64).optional(),
});
export type UpdateAnalysisMetadataRequest = z.infer<typeof UpdateAnalysisMetadataRequest>;

export const AnalysesPage = z.object({
  items: z.array(AnalysisDocument),
  nextPageToken: z.string().nullable(),
});
export type AnalysesPage = z.infer<typeof AnalysesPage>;
