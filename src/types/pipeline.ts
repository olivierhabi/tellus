import { z } from 'zod';

// ---------------------------------------------------------------------------
// Pipeline type enums
// ---------------------------------------------------------------------------

export const PIPELINE_TYPES = ['batch', 'streaming'] as const;
// PB-B2: compute_type is now the TransformService engine selector.
//   'duckdb'         → default for new pipelines. Compiles transforms to
//                      one SQL statement and runs via the shared DuckDB
//                      pool (services/duckdb/pool.ts).
//   'legacy_nodejs'  → pure-TS engine, kept for one release cycle as a
//                      fallback. Required for chains with Normalize
//                      until PB-B2.follow-2 ships the Rust UDF.
export const COMPUTE_TYPES = ['duckdb', 'legacy_nodejs'] as const;
// PB-B3: deploy output format. 'csv' is the default for one release;
// PB-B4 flips the default to 'parquet' once Iceberg catalog lands.
export const OUTPUT_FORMATS = ['csv', 'parquet', 'iceberg'] as const;
export const PIPELINE_STATUSES = ['draft', 'active', 'paused', 'failed', 'archived'] as const;

export type PipelineType = (typeof PIPELINE_TYPES)[number];
export type ComputeType = (typeof COMPUTE_TYPES)[number];
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
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
  }).default('duckdb'),
  outputFormat: z.enum(OUTPUT_FORMATS, {
    message: `Output format must be one of: ${OUTPUT_FORMATS.join(', ')}`,
  }).default('csv'),
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
    outputFormat: z.enum(OUTPUT_FORMATS).optional(),
    status: z.enum(PIPELINE_STATUSES).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.pipelineType !== undefined ||
      data.computeType !== undefined ||
      data.outputFormat !== undefined ||
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
 *
 * Ordering operators (lt/lte/gt/gte) support both literal and
 * column-to-column comparison (valueIsColumn) — Palantir filterV1 parity:
 * the condition is an Expression<Boolean>, so `service_at < valid_from`
 * compares the two columns row-by-row. Numeric/date values are coerced
 * before comparison (ISO date strings compare chronologically).
 */
export const FILTER_OPERATORS = [
  'is_null',
  'is_not_null',
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
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
  /**
   * When true, `value` is interpreted as the name of another column and the
   * condition compares column-to-column (Palantir Pipeline Builder parity:
   * the right operand can be a column OR a literal value).
   * When false/omitted, `value` is a literal.
   */
  valueIsColumn: z.boolean().optional(),
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
// Select Columns transform — keep only the listed columns (inverse of Drop)
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/selectV1
// ---------------------------------------------------------------------------

export const SelectPreviewSchema = z.object({
  /** Column names to keep; all others are removed. Order is preserved. */
  columns: z.array(z.string().trim().min(1)).min(1, 'At least one column is required'),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type SelectPreviewInput = z.infer<typeof SelectPreviewSchema>;

export const SelectApplySchema = z.object({
  columns: z.array(z.string().trim().min(1)).min(1, 'At least one column is required'),
});

export type SelectApplyInput = z.infer<typeof SelectApplySchema>;

// ---------------------------------------------------------------------------
// Sort transform — ORDER BY columns with per-column direction
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/sortV2
// ---------------------------------------------------------------------------

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const SORT_NULLS = ['first', 'last'] as const;

const SortKeySchema = z.object({
  column: z.string().trim().min(1, 'Sort column is required'),
  direction: z.enum(SORT_DIRECTIONS).default('asc'),
  nulls: z.enum(SORT_NULLS).optional(),
});

export const SortPreviewSchema = z.object({
  sorts: z.array(SortKeySchema).min(1, 'At least one sort key is required'),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type SortPreviewInput = z.infer<typeof SortPreviewSchema>;

export const SortApplySchema = z.object({
  sorts: z.array(SortKeySchema).min(1, 'At least one sort key is required'),
});

export type SortApplyInput = z.infer<typeof SortApplySchema>;

// ---------------------------------------------------------------------------
// DropDuplicates transform — remove rows that are duplicates on key columns
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/dropDuplicatesV1
// ---------------------------------------------------------------------------

export const DropDuplicatesPreviewSchema = z.object({
  /** Columns defining the deduplicate key. Omit (= null, default) to dedupe on ALL columns. */
  columns: z.array(z.string().trim().min(1)).optional(),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type DropDuplicatesPreviewInput = z.infer<typeof DropDuplicatesPreviewSchema>;

export const DropDuplicatesApplySchema = z.object({
  columns: z.array(z.string().trim().min(1)).optional(),
});

export type DropDuplicatesApplyInput = z.infer<typeof DropDuplicatesApplySchema>;

// ---------------------------------------------------------------------------
// Uppercase Column Names transform — rename every column to UPPER_CASE
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/uppercaseColumnNamesV1
// ---------------------------------------------------------------------------

export const UppercaseColumnNamesPreviewSchema = z.object({
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type UppercaseColumnNamesPreviewInput = z.infer<typeof UppercaseColumnNamesPreviewSchema>;

export const UppercaseColumnNamesApplySchema = z.object({});

export type UppercaseColumnNamesApplyInput = z.infer<typeof UppercaseColumnNamesApplySchema>;

// ---------------------------------------------------------------------------
// Row Size transform — add a column with the row's estimated byte size
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/rowSizeV1
// ---------------------------------------------------------------------------

export const RowSizePreviewSchema = z.object({
  /** Name of the new column. Default: 'row_size'. */
  outputColumn: z.string().trim().min(1).max(255).optional(),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type RowSizePreviewInput = z.infer<typeof RowSizePreviewSchema>;

export const RowSizeApplySchema = z.object({
  outputColumn: z.string().trim().min(1).max(255).optional(),
});

export type RowSizeApplyInput = z.infer<typeof RowSizeApplySchema>;

// ---------------------------------------------------------------------------
// Shared binary-expression model used by Apply Expression,
// Apply Multiple Expressions, Apply to Multiple Columns, and
// Compute if Expression Absent.
// ---------------------------------------------------------------------------

export const BINARY_OPERATORS = [
  '+',
  '-',
  '*',
  '/',
  '||',
  '==',
  '!=',
  '>',
  '<',
  '>=',
  '<=',
] as const;

export type BinaryOperator = (typeof BINARY_OPERATORS)[number];

const OperandSchema = z.object({
  /** 'column' = reference an existing column; 'literal' = a constant. */
  kind: z.enum(['column', 'literal']),
  /**
   * When kind=column, the column name.
   * When kind=literal, the value is the literal stored as a string; it is
   * parsed according to `literalType` (default: string).
   */
  value: z.string(),
  /** For literals only — how to parse `value`. Ignored for columns. */
  literalType: z.enum(['string', 'integer', 'numeric', 'boolean']).optional(),
});

export type Operand = z.infer<typeof OperandSchema>;

export const StringOperandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('column'), value: z.string().trim().min(1) }),
  z.object({ kind: z.literal('literal'), value: z.string(), literalType: z.literal('string').optional() }),
]);

export type StringOperand = z.infer<typeof StringOperandSchema>;

export const ExpressionItemSchema = z.object({
  left: OperandSchema,
  operator: z.enum(BINARY_OPERATORS),
  right: OperandSchema,
  /** Target column for the result. */
  outputColumn: z.string().trim().min(1, 'outputColumn is required').max(255),
  /** Logical type of the result; defaults inferred from operands at evaluation. */
  outputType: z.enum(CAST_TARGET_TYPES).optional(),
});

export type ExpressionItem = z.infer<typeof ExpressionItemSchema>;

// ---------------------------------------------------------------------------
// Apply expression transform — single binary expression producing a column
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/applyExpressionV1
// ---------------------------------------------------------------------------

export const ApplyExpressionPreviewSchema = z.object({
  expression: ExpressionItemSchema,
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type ApplyExpressionPreviewInput = z.infer<typeof ApplyExpressionPreviewSchema>;

export const ApplyExpressionApplySchema = z.object({
  expression: ExpressionItemSchema,
});

export type ApplyExpressionApplyInput = z.infer<typeof ApplyExpressionApplySchema>;

// Pipeline Builder Case expression. Conditions are evaluated in order and the
// first true branch wins; false/null conditions fall through to `defaultValue`.
// Reference: https://www.palantir.com/docs/foundry/pb-functions-expression/caseV2
export const CaseBranchSchema = z.object({
  condition: ExpressionItemSchema.omit({ outputColumn: true, outputType: true }),
  value: OperandSchema,
});

export const CaseExpressionBaseSchema = z.object({
  branches: z.array(CaseBranchSchema).min(1).max(100),
  defaultValue: OperandSchema.nullable().default(null),
  outputColumn: z.string().trim().min(1, 'outputColumn is required').max(255),
  outputType: z.enum(CAST_TARGET_TYPES).optional(),
});

export const CaseExpressionPreviewSchema = CaseExpressionBaseSchema.extend({
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});
export type CaseExpressionPreviewInput = z.infer<typeof CaseExpressionPreviewSchema>;
export const CaseExpressionApplySchema = CaseExpressionBaseSchema;
export type CaseExpressionApplyInput = z.infer<typeof CaseExpressionApplySchema>;

// Palantir concatStringsV1 — ordered string expressions joined by a literal
// separator. Nulls are skipped by default; strict mode propagates any null.
export const ConcatenateStringsBaseSchema = z.object({
  expressions: z.array(StringOperandSchema).min(1, 'At least one expression is required').max(100),
  separator: z.string().max(10_000).default(''),
  nullOutputIfAnyInputIsNull: z.boolean().default(false),
  outputColumn: z.string().trim().min(1, 'outputColumn is required').max(255),
});

export const ConcatenateStringsPreviewSchema = ConcatenateStringsBaseSchema.extend({
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});
export type ConcatenateStringsPreviewInput = z.infer<typeof ConcatenateStringsPreviewSchema>;

export const ConcatenateStringsApplySchema = ConcatenateStringsBaseSchema;
export type ConcatenateStringsApplyInput = z.infer<typeof ConcatenateStringsApplySchema>;

// Palantir formatStringV1 — printf-style template over an ordered argument
// list. Frame: the PB UI exposes it as a transform panel (template + args +
// output column), like the String.format / Java printf mini-language. Null
// arguments format as the literal text "null".
// Reference: https://www.palantir.com/docs/foundry/pb-functions-expression/formatStringV1
export const FormatStringBaseSchema = z.object({
  /** printf-style template ("%s", "%d", "%+.4f", "%%"). Args consumed in order. */
  format: z.string().max(10_000),
  /** Ordered args inserted into the format string — columns or literals. */
  arguments: z.array(OperandSchema).max(100).default([]),
  outputColumn: z.string().trim().min(1, 'outputColumn is required').max(255),
});

export const FormatStringPreviewSchema = FormatStringBaseSchema.extend({
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});
export type FormatStringPreviewInput = z.infer<typeof FormatStringPreviewSchema>;

export const FormatStringApplySchema = FormatStringBaseSchema;
export type FormatStringApplyInput = z.infer<typeof FormatStringApplySchema>;

// ---------------------------------------------------------------------------
// Apply multiple expressions transform
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/projectV1
// ---------------------------------------------------------------------------

export const ApplyMultipleExpressionsPreviewSchema = z.object({
  expressions: z.array(ExpressionItemSchema).min(1, 'At least one expression is required'),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type ApplyMultipleExpressionsPreviewInput = z.infer<typeof ApplyMultipleExpressionsPreviewSchema>;

export const ApplyMultipleExpressionsApplySchema = z.object({
  expressions: z.array(ExpressionItemSchema).min(1, 'At least one expression is required'),
});

export type ApplyMultipleExpressionsApplyInput = z.infer<typeof ApplyMultipleExpressionsApplySchema>;

// ---------------------------------------------------------------------------
// Apply to multiple columns — apply the same operator+right operand to N
// columns (substituted in the left role), producing N new columns.
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/projectOnConditionV1
// ---------------------------------------------------------------------------

export const ApplyToMultipleColumnsPreviewSchema = z.object({
  /** Columns to substitute into the left operand role. */
  columns: z.array(z.string().trim().min(1)).min(1, 'At least one column is required'),
  operator: z.enum(BINARY_OPERATORS),
  /** Right operand (literal or column); shared across all columns. */
  right: OperandSchema,
  /** Suffix appended to each input column name for the output column name. Default: '_calc'. */
  outputSuffix: z.string().trim().min(1).max(64).optional(),
  /** Optional explicit output column names (must match `columns` length if provided). */
  outputColumns: z.array(z.string().trim().min(1)).optional(),
  outputType: z.enum(CAST_TARGET_TYPES).optional(),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type ApplyToMultipleColumnsPreviewInput = z.infer<typeof ApplyToMultipleColumnsPreviewSchema>;

export const ApplyToMultipleColumnsApplySchema = z.object({
  columns: z.array(z.string().trim().min(1)).min(1, 'At least one column is required'),
  operator: z.enum(BINARY_OPERATORS),
  right: OperandSchema,
  outputSuffix: z.string().trim().min(1).max(64).optional(),
  outputColumns: z.array(z.string().trim().min(1)).optional(),
  outputType: z.enum(CAST_TARGET_TYPES).optional(),
});

export type ApplyToMultipleColumnsApplyInput = z.infer<typeof ApplyToMultipleColumnsApplySchema>;

// ---------------------------------------------------------------------------
// Compute if Expression Absent — fill a column with the result of an
// expression only when the target column is null/empty/missing.
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/computeExpressionIfAbsentV1
// ---------------------------------------------------------------------------

export const ComputeIfExpressionAbsentPreviewSchema = z.object({
  /** The output column to populate; created if missing. */
  outputColumn: z.string().trim().min(1).max(255),
  /** The expression to evaluate when `outputColumn` is null/empty/absent. */
  expression: ExpressionItemSchema.omit({ outputColumn: true }),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type ComputeIfExpressionAbsentPreviewInput = z.infer<typeof ComputeIfExpressionAbsentPreviewSchema>;

export const ComputeIfExpressionAbsentApplySchema = z.object({
  outputColumn: z.string().trim().min(1).max(255),
  expression: ExpressionItemSchema.omit({ outputColumn: true }),
});

export type ComputeIfExpressionAbsentApplyInput = z.infer<typeof ComputeIfExpressionAbsentApplySchema>;

// ---------------------------------------------------------------------------
// Text block transform — documentation annotation; passes data through
// untouched. Useful for in-canvas documentation of pipeline logic.
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/textBlockV1
// ---------------------------------------------------------------------------

export const TextBlockPreviewSchema = z.object({
  /** Free-form documentation text. Plain or limited markdown; up to 4000 chars. */
  text: z.string().trim().min(1, 'Text is required').max(4000),
  /** Optional short title shown above the text block. */
  title: z.string().trim().max(255).optional(),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type TextBlockPreviewInput = z.infer<typeof TextBlockPreviewSchema>;

export const TextBlockApplySchema = z.object({
  text: z.string().trim().min(1).max(4000),
  title: z.string().trim().max(255).optional(),
});

export type TextBlockApplyInput = z.infer<typeof TextBlockApplySchema>;

// ---------------------------------------------------------------------------
// Tier B aggregate-family transforms (PB-B2.follow-2).
//
// Shared aggregation model used by Aggregate, Rollup, Pivot and (in its
// dynamic-alias form) Aggregate on condition.
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/aggregateV1
// ---------------------------------------------------------------------------

export const AGGREGATE_FUNCTIONS = [
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'count_distinct',
  'stddev',
  'variance',
] as const;

export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number];

/**
 * One aggregation in an Aggregate / Rollup / Pivot spec.
 * `column` is optional ONLY for `count` — bare count aggregates the whole
 * group (SQL COUNT(*)); count with a column counts non-null values,
 * mirroring Palantir's `rowCount(expression)` helper.
 */
export const AggregationItemSchema = z.object({
  column: z.string().trim().min(1).optional(),
  function: z.enum(AGGREGATE_FUNCTIONS),
  /** Name of the output column produced by this aggregation. */
  outputColumn: z.string().trim().min(1, 'Output column is required'),
}).refine(
  (a) => a.function === 'count' || !!a.column,
  { message: 'column is required for aggregations other than count' },
);

export type AggregationItem = z.infer<typeof AggregationItemSchema>;

// ---------------------------------------------------------------------------
// Aggregate transform — GROUP BY + aggregations (aggregateV1)
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/aggregateV1
// ---------------------------------------------------------------------------

export const AggregatePreviewSchema = z.object({
  /** Columns to group by. Empty = single global aggregation row. */
  groupBy: z.array(z.string().trim().min(1)).default([]),
  aggregations: z.array(AggregationItemSchema).min(1, 'At least one aggregation is required'),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type AggregatePreviewInput = z.infer<typeof AggregatePreviewSchema>;

export const AggregateApplySchema = z.object({
  groupBy: z.array(z.string().trim().min(1)).default([]),
  aggregations: z.array(AggregationItemSchema).min(1),
});

export type AggregateApplyInput = z.infer<typeof AggregateApplySchema>;

// ---------------------------------------------------------------------------
// Rollup transform — GROUP BY ROLLUP(...) super-aggregates (rollUpV1)
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/rollUpV1
// ---------------------------------------------------------------------------

export const RollupPreviewSchema = z.object({
  /** Columns to rollup. Empty = single global aggregation row (Palantir example 5). */
  rollupColumns: z.array(z.string().trim().min(1)).default([]),
  aggregations: z.array(AggregationItemSchema).min(1, 'At least one aggregation is required'),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type RollupPreviewInput = z.infer<typeof RollupPreviewSchema>;

export const RollupApplySchema = z.object({
  rollupColumns: z.array(z.string().trim().min(1)).default([]),
  aggregations: z.array(AggregationItemSchema).min(1),
});

export type RollupApplyInput = z.infer<typeof RollupApplySchema>;

// ---------------------------------------------------------------------------
// Aggregate on condition — apply each expression once per column matching a
// ColumnPredicate, naming outputs with a dynamic suffix (columnNameConcat).
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/aggregateOnConditionV1
// ---------------------------------------------------------------------------

export const ColumnPredicateSchema = z.object({
  /** `all` = every column; `columnHasType` = columns with the given type. */
  kind: z.enum(['all', 'columnHasType']),
  columnType: z
    .enum(['string', 'integer', 'numeric', 'boolean', 'date', 'timestamp'])
    .optional(),
}).refine(
  (p) => p.kind === 'all' || !!p.columnType,
  { message: 'columnType is required when kind=columnHasType' },
);

export type ColumnPredicate = z.infer<typeof ColumnPredicateSchema>;

/**
 * One dynamic aggregation: applied once per predicate-matched column, the
 * output column named `<column><suffix>` (Palantir columnNameConcat).
 * `count` counts non-null values (Palantir rowCount).
 */
export const DynamicAggregationSchema = z.object({
  function: z.enum(['sum', 'avg', 'min', 'max', 'count']),
  suffix: z.string().trim().min(1, 'Suffix is required'),
});

export type DynamicAggregation = z.infer<typeof DynamicAggregationSchema>;

export const AggregateOnConditionPreviewSchema = z.object({
  predicate: ColumnPredicateSchema,
  aggregations: z.array(DynamicAggregationSchema).min(1, 'At least one aggregation is required'),
  groupBy: z.array(z.string().trim().min(1)).default([]),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type AggregateOnConditionPreviewInput = z.infer<typeof AggregateOnConditionPreviewSchema>;

export const AggregateOnConditionApplySchema = z.object({
  predicate: ColumnPredicateSchema,
  aggregations: z.array(DynamicAggregationSchema).min(1),
  groupBy: z.array(z.string().trim().min(1)).default([]),
});

export type AggregateOnConditionApplyInput = z.infer<typeof AggregateOnConditionApplySchema>;

// ---------------------------------------------------------------------------
// Top rows transform — top N rows per sorted partition (topRowV2)
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/topRowV2
// ---------------------------------------------------------------------------

export const TopRowsPreviewSchema = z.object({
  /** Columns defining each partition. Empty = one partition (the whole dataset). */
  partitionBy: z.array(z.string().trim().min(1)).default([]),
  /** Sort specification within each partition. */
  sorts: z.array(SortKeySchema).default([]),
  /** Number of rows to select per partition (Palantir "Number of rows"). Defaults to 1. */
  topN: z.number().int().min(1).max(10000).default(1),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type TopRowsPreviewInput = z.infer<typeof TopRowsPreviewSchema>;

export const TopRowsApplySchema = z.object({
  partitionBy: z.array(z.string().trim().min(1)).default([]),
  sorts: z.array(SortKeySchema).default([]),
  topN: z.number().int().min(1).max(10000).default(1),
});

export type TopRowsApplyInput = z.infer<typeof TopRowsApplySchema>;

// ---------------------------------------------------------------------------
// Pivot transform — values of `pivotColumn` become columns (pivotV1)
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/pivotV1
// ---------------------------------------------------------------------------

/** One (value, alias) pivot pair — alias feeds the output column name. */
export const PivotValueSchema = z.object({
  value: z.string().trim().min(1, 'Pivot value is required'),
  alias: z.string().trim().min(1, 'Pivot alias is required'),
});

export type PivotValue = z.infer<typeof PivotValueSchema>;

export const PivotPreviewSchema = z.object({
  groupBy: z.array(z.string().trim().min(1)).default([]),
  pivotColumn: z.string().trim().min(1, 'Pivot column is required'),
  pivotValues: z.array(PivotValueSchema).min(1, 'At least one pivot value is required'),
  aggregations: z.array(AggregationItemSchema).min(1, 'At least one aggregation is required'),
  /** `prefix` (default): '<alias><sep><aggName>'; `suffix`: '<aggName><sep><alias>'. */
  aliasPosition: z.enum(['prefix', 'suffix']).default('prefix'),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type PivotPreviewInput = z.infer<typeof PivotPreviewSchema>;

export const PivotApplySchema = z.object({
  groupBy: z.array(z.string().trim().min(1)).default([]),
  pivotColumn: z.string().trim().min(1),
  pivotValues: z.array(PivotValueSchema).min(1),
  aggregations: z.array(AggregationItemSchema).min(1),
  aliasPosition: z.enum(['prefix', 'suffix']).default('prefix'),
});

export type PivotApplyInput = z.infer<typeof PivotApplySchema>;

// ---------------------------------------------------------------------------
// Unpivot transform — wide → long; columns become (name, value) rows
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/unpivotV1
// ---------------------------------------------------------------------------

export const UnpivotPreviewSchema = z.object({
  /** Columns to unpivot. All other columns are kept as-is. */
  columns: z.array(z.string().trim().min(1)).min(1, 'At least one column to unpivot is required'),
  /** Output column holding the original column names. */
  nameColumn: z.string().trim().min(1, 'Name column is required'),
  /** Output column holding the values. */
  valueColumn: z.string().trim().min(1, 'Value column is required'),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type UnpivotPreviewInput = z.infer<typeof UnpivotPreviewSchema>;

export const UnpivotApplySchema = z.object({
  columns: z.array(z.string().trim().min(1)).min(1),
  nameColumn: z.string().trim().min(1),
  valueColumn: z.string().trim().min(1),
});

export type UnpivotApplyInput = z.infer<typeof UnpivotApplySchema>;

// ---------------------------------------------------------------------------
// Keeps duplicates transform — inverse of Drop duplicates (keepDuplicatesV1)
// Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/keepDuplicatesV1
// ---------------------------------------------------------------------------

export const KeepDuplicatesPreviewSchema = z.object({
  /** Columns defining the duplicate key. Omit/null = exact duplicate rows. */
  columns: z.array(z.string().trim().min(1)).optional(),
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
});

export type KeepDuplicatesPreviewInput = z.infer<typeof KeepDuplicatesPreviewSchema>;

export const KeepDuplicatesApplySchema = z.object({
  columns: z.array(z.string().trim().min(1)).optional(),
});

export type KeepDuplicatesApplyInput = z.infer<typeof KeepDuplicatesApplySchema>;

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
  // Palantir complexSemiJoinV1 / complexAntiJoinV1 — left-only output:
  // semi keeps left rows WITH a match; anti keeps left rows WITHOUT one.
  'semi',
  'anti',
] as const;

export type JoinType = (typeof JOIN_TYPES)[number];

/**
 * Comparison operators for a join condition.
 *
 * Palantir's `joinV2` is equality-only, but the `complex*JoinV1` family accepts
 * an arbitrary `Expression<Boolean>` built from comparisons combined with
 * `and(...)`. A list of conditions here is that `and(...)`: every condition must
 * hold. `equals` is the default so existing equality-only payloads are
 * unchanged, and the inequality operators cover the documented `lessThan` /
 * `greaterThan` theta joins.
 */
export const JOIN_OPERATORS = [
  'equals',
  'notEquals',
  'lessThan',
  'lessThanOrEqual',
  'greaterThan',
  'greaterThanOrEqual',
] as const;

export type JoinOperator = (typeof JOIN_OPERATORS)[number];

/** Operators that can be satisfied by hash lookup rather than a full scan. */
export function isEqualityJoinOperator(op: JoinOperator | undefined): boolean {
  return op === undefined || op === 'equals';
}

/** A single join condition: `leftColumn <operator> rightColumn`. */
const JoinConditionSchema = z.object({
  leftColumn: z.string().trim().min(1, 'Left column is required'),
  rightColumn: z.string().trim().min(1, 'Right column is required'),
  /**
   * Comparison to apply. Omitted = `equals`, which keeps the historical
   * equality-only wire shape valid.
   */
  operator: z.enum(JOIN_OPERATORS).optional(),
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
  /**
   * Merge same-named equality join keys into ONE output column instead of
   * emitting a prefixed duplicate (Palantir `complexOuterJoinV1` Example 4:
   * "the join columns are coalesced" when no right-side prefix is applied).
   * Only equality conditions are coalesced — an inequality has no single
   * shared value to collapse to. Omitted = false (historical behaviour).
   */
  coalesceJoinKeys: z.boolean().optional(),
  /**
   * When true, the computed preview is also persisted as the node's
   * previewSnapshot in the same request (union/apply-style atomicity) —
   * closes the failure window between "preview computed" and a separate
   * client-side snapshot save, which previously left join nodes
   * wired-but-schemaless ("0 columns", downstream SNAPSHOT_REQUIRED).
   */
  persist: z.boolean().optional(),
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
  coalesceJoinKeys: z.boolean().optional(),
});

export type JoinApplyInput = z.infer<typeof JoinApplySchema>;

// ---------------------------------------------------------------------------
// Union by name (Palantir unionByNameV1)
// ---------------------------------------------------------------------------

/**
 * Request body for POST .../nodes/:nodeId/union/preview
 *
 * Union semantics:
 *   - `name-merge` (default, backwards-compatible): stacks rows from both
 *     sides matching columns by name. Columns unique to one side get
 *     null on rows from the other side. Output column count can EXCEED
 *     either input's column count when names diverge (e.g. one side
 *     renamed `order_id` to `orderid`). The response includes
 *     `LEFT_ONLY_COLUMNS` / `RIGHT_ONLY_COLUMNS` warnings AND, when the
 *     near-name detector finds plausible same-column-renamed pairs
 *     (e.g. `orderid` ↔ `order_id`, `customerName` ↔ `customer_name`),
 *     a high-severity `NAME_MISMATCH_SUGGESTION` warning so the UI can
 *     surface a "Did you mean to align these?" hint.
 *   - `strict`: fail with a structured 400 if either side has any
 *     column the other does not. Use this in pipelines that promise a
 *     stable output schema to downstream consumers (deploy graph
 *     fingerprinting, Iceberg writers, ontology object types).
 */
/**
 * Both input fields are individually optional so either wire shape validates,
 * so the "at least one input" rule has to be a schema-level refinement.
 */
const UNION_INPUT_REQUIRED = {
  message: 'A union needs at least one additional input — send rightNodeIds (or the legacy rightNodeId).',
  path: ['rightNodeIds'],
};

function hasAtLeastOneUnionInput(v: { rightNodeId?: string; rightNodeIds?: string[] }): boolean {
  return Boolean(v.rightNodeId) || (v.rightNodeIds?.length ?? 0) > 0;
}

export const UnionPreviewSchema = z.object({
  /**
   * UUID of the second input node. Retained for back-compat; prefer
   * `rightNodeIds` for the N-input form. When both are present,
   * `rightNodeId` is treated as the first entry of the list.
   */
  rightNodeId: z.string().uuid('Invalid right node UUID').optional(),
  /**
   * UUIDs of every additional input, in order. Palantir's `union*ByNameV1`
   * transforms all take `List<Table>`, so a three-way union is one node, not
   * two chained ones. Column ordering follows the FIRST input (the node the
   * request is addressed to), then each additional input in list order.
   */
  rightNodeIds: z.array(z.string().uuid('Invalid right node UUID')).optional(),
  /** Max rows to return. */
  limit: z.number().int().min(1).max(5000).default(500),
  priorTransforms: z.array(PriorTransformSchema).optional(),
  /**
   * Schema-reconciliation policy. Omitted = `name-merge` (legacy default).
   *
   * Palantir variants (PB-B2.follow-2):
   *   - `first`  (firstUnionByNameV1): output columns = FIRST input's
   *     columns only; extra right-side columns are dropped, missing
   *     right values become null.
   *   - `narrow` (narrowUnionByNameV1): output columns = the INTERSECTION
   *     of both inputs' column names.
   *   - `wide`   (wideUnionByNameV1): output columns = the SUPERSET of
   *     both inputs' column names; missing values become null.
   *     (`name-merge` is the historical equivalent plus mismatch hints.)
   */
  mode: z.enum(['name-merge', 'strict', 'first', 'narrow', 'wide']).optional(),
}).refine(hasAtLeastOneUnionInput, UNION_INPUT_REQUIRED);

export type UnionPreviewInput = z.infer<typeof UnionPreviewSchema>;

/**
 * Request body for POST .../nodes/:nodeId/union/apply
 */
export const UnionApplySchema = z.object({
  rightNodeId: z.string().uuid('Invalid right node UUID').optional(),
  rightNodeIds: z.array(z.string().uuid('Invalid right node UUID')).optional(),
  /** Persisted so deploy/replay paths reproduce the same schema policy. */
  mode: z.enum(['name-merge', 'strict', 'first', 'narrow', 'wide']).optional(),
}).refine(hasAtLeastOneUnionInput, UNION_INPUT_REQUIRED);

export type UnionApplyInput = z.infer<typeof UnionApplySchema>;

/**
 * Normalize the two accepted wire shapes into one ordered, de-duplicated list.
 * `rightNodeId` (singular, legacy) leads; `rightNodeIds` follows in order.
 * De-duplication matters because a repeated input would double its rows
 * silently — a union of a table with itself is a request a user can make on
 * purpose, but not by sending the same id twice in one payload.
 */
export function resolveUnionInputIds(input: {
  rightNodeId?: string;
  rightNodeIds?: string[];
}): string[] {
  const ordered = [
    ...(input.rightNodeId ? [input.rightNodeId] : []),
    ...(input.rightNodeIds ?? []),
  ];
  return [...new Set(ordered)];
}

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

/**
 * Foundry Pipeline Builder parity — build schedule config. Enabling seeds
 * `schedule_next_run_at = now() + interval`; the pipeline build scheduler
 * (services/pipelines/buildScheduler.ts) then rebuilds every interval
 * minutes through the regular deploy path.
 */
export const UpdateBuildScheduleSchema = z.object({
  enabled: z.boolean({
    message: 'enabled must be boolean',
  }),
  intervalMinutes: z
    .number({
      message: 'intervalMinutes must be a number',
    })
    .int('intervalMinutes must be an integer')
    .min(1, 'intervalMinutes must be at least 1')
    .max(43200, 'intervalMinutes must be at most 30 days')
    .optional(),
}).refine(
  (d) => !d.enabled || (d.intervalMinutes !== undefined && d.intervalMinutes > 0),
  { message: 'intervalMinutes is required when enabling the build schedule' },
);

export type UpdateBuildScheduleInput = z.infer<typeof UpdateBuildScheduleSchema>;

/**
 * Foundry data expectations on pipeline builds.
 * Types: row_count_bounds {min?,max?} · not_null {columns: string[]} ·
 * unique {columns: string[]}. severity 'fail' gates the build pre-commit.
 */
export const CreateExpectationSchema = z.object({
  nodeId: z.string().uuid('Invalid node UUID').optional().nullable(),
  name: z.string().trim().min(1, 'Expectation name is required').max(255),
  type: z.enum(['row_count_bounds', 'not_null', 'unique'], {
    message: "type must be one of: row_count_bounds, not_null, unique",
  }),
  config: z.record(z.string(), z.unknown()),
  severity: z.enum(['fail', 'warn'], {
    message: "severity must be 'fail' or 'warn'",
  }).default('fail'),
});

export type CreateExpectationInput = z.infer<typeof CreateExpectationSchema>;

export const DeployPipelineSchema = z.object({
  /** Which output node IDs to build. If empty/omitted, builds ALL output nodes. */
  outputNodeIds: z.array(z.string().uuid('Invalid output node UUID')).optional(),
  /**
   * PB-B6: override the preview-chain-hash stale check. Set to true when
   * the user has reviewed the transform-chain drift and still wants the
   * deploy. Without this flag, deploys with a mismatched chain hash
   * return PREVIEW_STALE.
   */
  force: z.boolean().optional(),
});

export type DeployPipelineInput = z.infer<typeof DeployPipelineSchema>;

// ---------------------------------------------------------------------------

export type CreatePipelineInput = z.infer<typeof CreatePipelineSchema>;
export type UpdatePipelineInput = z.infer<typeof UpdatePipelineSchema>;
export type CreatePipelineNodeInput = z.infer<typeof CreatePipelineNodeSchema>;
export type BulkCreatePipelineNodesInput = z.infer<typeof BulkCreatePipelineNodesSchema>;
export type UpdatePipelineNodeInput = z.infer<typeof UpdatePipelineNodeSchema>;
