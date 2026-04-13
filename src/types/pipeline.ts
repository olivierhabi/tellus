import { z } from 'zod';

// ---------------------------------------------------------------------------
// Pipeline type enums
// ---------------------------------------------------------------------------

export const PIPELINE_TYPES = ['batch', 'streaming'] as const;
export const COMPUTE_TYPES = ['standard', 'lightweight', 'external'] as const;
export const PIPELINE_STATUSES = ['draft', 'active', 'paused', 'failed', 'archived'] as const;

export type PipelineType = (typeof PIPELINE_TYPES)[number];
export type ComputeType = (typeof COMPUTE_TYPES)[number];
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const CreatePipelineSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Pipeline name is required')
    .max(255, 'Pipeline name must be 255 characters or fewer'),
  description: z.string().max(2000, 'Description must be 2000 characters or fewer').optional(),
  pipelineType: z.enum(PIPELINE_TYPES, {
    message: `Pipeline type must be one of: ${PIPELINE_TYPES.join(', ')}`,
  }).default('batch'),
  computeType: z.enum(COMPUTE_TYPES, {
    message: `Compute type must be one of: ${COMPUTE_TYPES.join(', ')}`,
  }).default('standard'),
  folderId: z.string().uuid('Invalid folder UUID format').optional().nullable(),
});

export const UpdatePipelineSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Pipeline name is required')
      .max(255, 'Pipeline name must be 255 characters or fewer')
      .optional(),
    description: z.string().max(2000).optional(),
    pipelineType: z.enum(PIPELINE_TYPES).optional(),
    computeType: z.enum(COMPUTE_TYPES).optional(),
    status: z.enum(PIPELINE_STATUSES).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.pipelineType !== undefined ||
      data.computeType !== undefined ||
      data.status !== undefined ||
      data.config !== undefined,
    { message: 'At least one field must be provided for update' },
  );

export const PipelineParamsSchema = z.object({
  pipelineId: z.string().uuid('Invalid pipeline UUID format'),
});

export const ProjectParamsSchema = z.object({
  projectId: z.string().uuid('Invalid project UUID format'),
});

// ---------------------------------------------------------------------------
// Pipeline node schemas
// ---------------------------------------------------------------------------

export const NODE_TYPES = ['dataset', 'transform', 'join', 'union', 'output'] as const;
export type PipelineNodeType = (typeof NODE_TYPES)[number];

export const CreatePipelineNodeSchema = z.object({
  datasetId: z.string().uuid('Invalid dataset UUID format').optional().nullable(),
  nodeType: z.enum(NODE_TYPES, {
    message: `Node type must be one of: ${NODE_TYPES.join(', ')}`,
  }).default('dataset'),
  label: z
    .string()
    .trim()
    .min(1, 'Node label is required')
    .max(255, 'Node label must be 255 characters or fewer'),
  positionX: z.number().default(0),
  positionY: z.number().default(0),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const BulkCreatePipelineNodesSchema = z.object({
  nodes: z.array(CreatePipelineNodeSchema).min(1, 'At least one node is required').max(50, 'Cannot add more than 50 nodes at once'),
});

export const UpdatePipelineNodeSchema = z
  .object({
    label: z.string().trim().min(1).max(255).optional(),
    nodeType: z.enum(NODE_TYPES).optional(),
    positionX: z.number().optional(),
    positionY: z.number().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (data) =>
      data.label !== undefined ||
      data.nodeType !== undefined ||
      data.positionX !== undefined ||
      data.positionY !== undefined ||
      data.config !== undefined,
    { message: 'At least one field must be provided for update' },
  );

export const PipelineNodeParamsSchema = z.object({
  nodeId: z.string().uuid('Invalid node UUID format'),
});

// ---------------------------------------------------------------------------
// Transform execution schemas
// ---------------------------------------------------------------------------

/**
 * Supported target types for the Cast transform.
 * Mirrors Palantir Pipeline Builder's castV2 semantics:
 *   https://www.palantir.com/docs/foundry/pb-functions-expression/castV2/
 */
export const CAST_TARGET_TYPES = [
  'string',
  'integer',
  'numeric',
  'boolean',
  'date',
  'timestamp',
] as const;

export type CastTargetType = (typeof CAST_TARGET_TYPES)[number];

/**
 * Request body for POST .../nodes/:nodeId/transforms/cast/preview
 *
 * Cast a column (the "expression") to a target type, producing a new or
 * replaced column in the output. Follows Palantir's castV2 contract:
 *   - expression: source column name to cast
 *   - targetType: the SQL type to cast into
 *   - outputColumn: destination column name (defaults to expression column)
 *   - limit: max rows to return in the preview (default 100)
 */
/**
 * A single transform descriptor sent by the frontend so the backend can
 * replay the full chain before previewing the current transform.
 */
const PriorTransformSchema = z.object({
  function: z.string(),
  expression: z.string().optional(),
  targetType: z.string().optional(),
  outputColumn: z.string().optional(),
  mode: z.string().optional(),
  match: z.string().optional(),
  conditions: z.array(z.record(z.string(), z.unknown())).optional(),
}).passthrough();

export const CastPreviewSchema = z.object({
  expression: z
    .string()
    .trim()
    .min(1, 'Expression (source column) is required'),
  targetType: z.enum(CAST_TARGET_TYPES, {
    message: `Target type must be one of: ${CAST_TARGET_TYPES.join(', ')}`,
  }),
  outputColumn: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional(),
  limit: z.number().int().min(1).max(5000).default(100),
  /** All transforms that come before this one in the chain. */
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type CastPreviewInput = z.infer<typeof CastPreviewSchema>;

/**
 * Request body for POST .../nodes/:nodeId/transforms/cast/apply
 *
 * Persists the Cast transform into the node's config. Does NOT execute
 * SQL — just saves the configuration for later pipeline builds.
 */
export const CastApplySchema = z.object({
  expression: z
    .string()
    .trim()
    .min(1, 'Expression (source column) is required'),
  targetType: z.enum(CAST_TARGET_TYPES, {
    message: `Target type must be one of: ${CAST_TARGET_TYPES.join(', ')}`,
  }),
  outputColumn: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional(),
});

export type CastApplyInput = z.infer<typeof CastApplySchema>;

// ---------------------------------------------------------------------------
// Filter transform schemas
// ---------------------------------------------------------------------------

/**
 * Supported filter operators.
 * Covers all operators in the Pipeline Builder Filter UI.
 */
export const FILTER_OPERATORS = [
  'is_null',
  'is_not_null',
  'eq',
  'neq',
  'starts_with',
  'ends_with',
  'contains',
  'regex_find',
  'regex_match',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** A single filter condition. */
const FilterConditionSchema = z.object({
  /** Column name to filter on. */
  column: z.string().trim().min(1, 'Column is required'),
  /** The operator to apply. */
  operator: z.enum(FILTER_OPERATORS, {
    message: `Operator must be one of: ${FILTER_OPERATORS.join(', ')}`,
  }),
  /**
   * The value to compare against.
   * Required for binary operators (eq, neq, starts_with, etc.).
   * Ignored for unary operators (is_null, is_not_null).
   */
  value: z.string().optional(),
  /** When true and operator is is_not_null, treat "" as null. */
  treatEmptyAsNull: z.boolean().optional(),
});

export type FilterCondition = z.infer<typeof FilterConditionSchema>;

/**
 * Request body for POST .../nodes/:nodeId/transforms/filter/preview
 */
export const FilterPreviewSchema = z.object({
  /** "keep" retains matching rows; "remove" discards them. */
  mode: z.enum(['keep', 'remove']).default('keep'),
  /** "all" = AND logic; "any" = OR logic across conditions. */
  match: z.enum(['all', 'any']).default('all'),
  /** One or more filter conditions. */
  conditions: z.array(FilterConditionSchema).min(1, 'At least one condition is required'),
  /** Max rows to return in the preview. */
  limit: z.number().int().min(1).max(5000).default(500),
  /** All transforms that come before this one in the chain. */
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type FilterPreviewInput = z.infer<typeof FilterPreviewSchema>;

/**
 * Request body for POST .../nodes/:nodeId/transforms/filter/apply
 */
export const FilterApplySchema = z.object({
  mode: z.enum(['keep', 'remove']).default('keep'),
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(FilterConditionSchema).min(1, 'At least one condition is required'),
});

export type FilterApplyInput = z.infer<typeof FilterApplySchema>;

// ---------------------------------------------------------------------------
// Drop Columns transform schemas
// ---------------------------------------------------------------------------

/**
 * Request body for POST .../nodes/:nodeId/transforms/drop/preview
 *
 * Drops one or more columns from the dataset. The preview returns
 * all rows with the specified columns removed.
 */
export const DropPreviewSchema = z.object({
  /** Column names to drop. */
  columns: z.array(z.string().trim().min(1)).min(1, 'At least one column is required'),
  /** Max rows to return in the preview. */
  limit: z.number().int().min(1).max(5000).default(500),
  /** Prior transforms in the chain (for chaining). */
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type DropPreviewInput = z.infer<typeof DropPreviewSchema>;

/**
 * Request body for POST .../nodes/:nodeId/transforms/drop/apply
 */
export const DropApplySchema = z.object({
  columns: z.array(z.string().trim().min(1)).min(1, 'At least one column is required'),
});

export type DropApplyInput = z.infer<typeof DropApplySchema>;

// ---------------------------------------------------------------------------
// Rename Columns transform schemas
// ---------------------------------------------------------------------------

/** A single column rename mapping. */
const RenameMapping = z.object({
  from: z.string().trim().min(1, 'Source column name is required'),
  to: z.string().trim().min(1, 'Target column name is required').max(255),
});

/**
 * Request body for POST .../nodes/:nodeId/transforms/rename/preview
 */
export const RenamePreviewSchema = z.object({
  /** One or more column rename mappings. */
  renames: z.array(RenameMapping).min(1, 'At least one rename is required'),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type RenamePreviewInput = z.infer<typeof RenamePreviewSchema>;

/**
 * Request body for POST .../nodes/:nodeId/transforms/rename/apply
 */
export const RenameApplySchema = z.object({
  renames: z.array(RenameMapping).min(1, 'At least one rename is required'),
});

export type RenameApplyInput = z.infer<typeof RenameApplySchema>;

// ---------------------------------------------------------------------------
// Normalize Column Names transform schemas
// ---------------------------------------------------------------------------

/**
 * Request body for POST .../nodes/:nodeId/transforms/normalize/preview
 *
 * Normalizes column names to lower_snake_case.
 * Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/normalizeColumnNamesV1
 *
 * Rules:
 *   1. Convert to lowercase
 *   2. Replace spaces, hyphens, dots with underscores
 *   3. Optionally remove special characters (non-alphanumeric except underscore)
 *   4. Collapse consecutive underscores
 *   5. Trim leading/trailing underscores
 */
export const NormalizePreviewSchema = z.object({
  /** When true, strip all non-alphanumeric characters except underscores. */
  removeSpecialCharacters: z.boolean().default(false),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type NormalizePreviewInput = z.infer<typeof NormalizePreviewSchema>;

export const NormalizeApplySchema = z.object({
  removeSpecialCharacters: z.boolean().default(false),
});

export type NormalizeApplyInput = z.infer<typeof NormalizeApplySchema>;

// ---------------------------------------------------------------------------
// Transform Preview Snapshot — saved when user clicks "Apply All"
// ---------------------------------------------------------------------------

export const SavePreviewSnapshotSchema = z.object({
  columns: z.array(z.object({
    name: z.string(),
    type: z.string(),
    isNew: z.boolean().optional(),
    renamed: z.boolean().optional(),
    normalized: z.boolean().optional(),
  })),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  transforms: z.array(z.record(z.string(), z.unknown())).optional(),
});

export type SavePreviewSnapshotInput = z.infer<typeof SavePreviewSnapshotSchema>;

// ---------------------------------------------------------------------------
// Join transform schemas
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/joinV2/
// ---------------------------------------------------------------------------

export const JOIN_TYPES = [
  'left',
  'right',
  'inner',
  'full_outer',
  'cross',
] as const;

export type JoinType = (typeof JOIN_TYPES)[number];

/** A single join condition (left column = right column). */
const JoinConditionSchema = z.object({
  leftColumn: z.string().trim().min(1, 'Left column is required'),
  rightColumn: z.string().trim().min(1, 'Right column is required'),
});

/**
 * Request body for POST .../nodes/:nodeId/transforms/join/preview
 *
 * Joins two datasets by reading both from S3, matching rows based on
 * the join conditions, and returning the merged result.
 */
export const JoinPreviewSchema = z.object({
  /** UUID of the right-side node (the left is resolved from the node's sourceNodeId). */
  rightNodeId: z.string().uuid('Invalid right node UUID'),
  /** Join type — left, right, inner, full_outer, cross. */
  joinType: z.enum(JOIN_TYPES, { message: `Join type must be one of: ${JOIN_TYPES.join(', ')}` }),
  /** Join conditions (column equality pairs). Required for all types except cross. */
  conditions: z.array(JoinConditionSchema).default([]),
  /** Prefix for columns from the right side (default: "right_"). */
  rightPrefix: z.string().optional().default('right_'),
  /** Max rows to return. */
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
  /** Optional: only include these left columns in the output. If omitted, all left columns are included. */
  leftSelectedColumns: z.array(z.string()).optional(),
  /** Optional: only include these right columns in the output. If omitted, all right columns are included. */
  rightSelectedColumns: z.array(z.string()).optional(),
});

export type JoinPreviewInput = z.infer<typeof JoinPreviewSchema>;

/**
 * Request body for POST .../nodes/:nodeId/transforms/join/apply
 */
export const JoinApplySchema = z.object({
  rightNodeId: z.string().uuid('Invalid right node UUID'),
  joinType: z.enum(JOIN_TYPES),
  conditions: z.array(JoinConditionSchema).default([]),
  rightPrefix: z.string().optional().default('right_'),
});

export type JoinApplyInput = z.infer<typeof JoinApplySchema>;

// ---------------------------------------------------------------------------
// Union by name (Palantir unionByNameV1)
// ---------------------------------------------------------------------------

/**
 * Request body for POST .../nodes/:nodeId/union/preview
 *
 * Union by name: stacks rows from two datasets, matching columns by name.
 * Columns unique to one side get null in rows from the other side.
 */
export const UnionPreviewSchema = z.object({
  /** UUID of the second input node. */
  rightNodeId: z.string().uuid('Invalid right node UUID'),
  /** Max rows to return. */
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type UnionPreviewInput = z.infer<typeof UnionPreviewSchema>;

/**
 * Request body for POST .../nodes/:nodeId/union/apply
 */
export const UnionApplySchema = z.object({
  rightNodeId: z.string().uuid('Invalid right node UUID'),
});

export type UnionApplyInput = z.infer<typeof UnionApplySchema>;

// ---------------------------------------------------------------------------
// Batch position update
// ---------------------------------------------------------------------------

export const BatchUpdatePositionsSchema = z.object({
  positions: z.array(z.object({
    nodeId: z.string().uuid('Invalid node UUID'),
    positionX: z.number(),
    positionY: z.number(),
  })).min(1, 'At least one position update is required'),
});

export type BatchUpdatePositionsInput = z.infer<typeof BatchUpdatePositionsSchema>;

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Save pipeline progress (atomic full-state save)
// ---------------------------------------------------------------------------

export const SavePipelineProgressSchema = z.object({
  /** Node positions — every node currently on the canvas */
  positions: z.array(z.object({
    nodeId: z.string().uuid('Invalid node UUID'),
    positionX: z.number(),
    positionY: z.number(),
  })).optional(),

  /** Canvas viewport (zoom + pan) */
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number().min(0.01).max(10),
  }).optional(),

  /** Pipeline-level metadata updates */
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).optional(),
  status: z.enum(['draft', 'active', 'paused', 'failed', 'archived']).optional(),
});

export type SavePipelineProgressInput = z.infer<typeof SavePipelineProgressSchema>;

// ---------------------------------------------------------------------------
// Deploy pipeline
// ---------------------------------------------------------------------------

export const DeployPipelineSchema = z.object({
  /** Which output node IDs to build. If empty/omitted, builds ALL output nodes. */
  outputNodeIds: z.array(z.string().uuid('Invalid output node UUID')).optional(),
});

export type DeployPipelineInput = z.infer<typeof DeployPipelineSchema>;

// ---------------------------------------------------------------------------

export type CreatePipelineInput = z.infer<typeof CreatePipelineSchema>;
export type UpdatePipelineInput = z.infer<typeof UpdatePipelineSchema>;
export type CreatePipelineNodeInput = z.infer<typeof CreatePipelineNodeSchema>;
export type BulkCreatePipelineNodesInput = z.infer<typeof BulkCreatePipelineNodesSchema>;
export type UpdatePipelineNodeInput = z.infer<typeof UpdatePipelineNodeSchema>;
