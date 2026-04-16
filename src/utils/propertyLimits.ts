// ---------------------------------------------------------------------------
// propertyLimits.ts — validation for struct/vector/timeseries property types
// ---------------------------------------------------------------------------
// Ontology Platform spec §2.4 Validation Rules:
//   struct depth      ≤ 3
//   vector dimensions ∈ [1, 2048]
//   timeseries window ≤ 1 year
//
// Throws OntologyError subclasses with the spec-mandated error codes so the
// error-handler middleware serialises them via the spec §2.1 envelope.
// ---------------------------------------------------------------------------

import { OntologyError } from "./queryErrors";

export const MAX_STRUCT_DEPTH = 3;
export const MIN_VECTOR_DIMS = 1;
export const MAX_VECTOR_DIMS = 2048;
export const MAX_TIMESERIES_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_COMPOSITE_PK_PROPERTIES = 5;
export const MAX_ACTION_PARAMETERS = 50;
export const MAX_BULK_ACTION_OBJECTS = 1000;
export const MAX_SQL_QUERY_LENGTH = 10000;
export const MAX_SEARCH_QUERY_LENGTH = 1000;

/**
 * Recursively measure the nesting depth of a struct schema. A flat struct
 * whose fields are all scalar counts as depth 1; a struct whose fields are
 * themselves structs counts as depth 2, etc.
 */
export function structDepth(schema: unknown): number {
  if (!Array.isArray(schema)) return 0;
  let maxChild = 0;
  for (const field of schema) {
    if (field && typeof field === "object") {
      const f = field as Record<string, unknown>;
      const inner = f.fields ?? f.structSchema ?? f.struct_fields;
      if (Array.isArray(inner)) {
        const child = structDepth(inner);
        if (child > maxChild) maxChild = child;
      }
    }
  }
  return 1 + maxChild;
}

export interface PropertyInput {
  baseType?: string;
  structSchema?: unknown;
  config?: {
    dimensions?: number;
    valueType?: string;
    [key: string]: unknown;
  };
  vectorDimensions?: number;
}

/**
 * Validate a property definition against all §2.4 limits. Throws an
 * OntologyError on first violation.
 */
export function validatePropertyLimits(input: PropertyInput): void {
  const baseType = (input.baseType || "").toLowerCase();

  if (baseType === "struct") {
    const depth = structDepth(input.structSchema);
    if (depth > MAX_STRUCT_DEPTH) {
      throw new OntologyError(
        `Struct nesting depth ${depth} exceeds maximum ${MAX_STRUCT_DEPTH}.`,
        "STRUCT_DEPTH_EXCEEDED",
        400,
        { depth, maxDepth: MAX_STRUCT_DEPTH }
      );
    }
  }

  if (baseType === "vector") {
    const dims =
      input.vectorDimensions ??
      input.config?.dimensions ??
      undefined;
    if (dims !== undefined) {
      if (typeof dims !== "number" || !Number.isInteger(dims)) {
        throw new OntologyError(
          "Vector dimensions must be an integer.",
          "INVALID_PARAMETER",
          400,
          { dimensions: dims }
        );
      }
      if (dims < MIN_VECTOR_DIMS || dims > MAX_VECTOR_DIMS) {
        throw new OntologyError(
          `Vector dimensions ${dims} out of range [${MIN_VECTOR_DIMS}, ${MAX_VECTOR_DIMS}].`,
          "VECTOR_DIMS_EXCEEDED",
          400,
          { dimensions: dims, min: MIN_VECTOR_DIMS, max: MAX_VECTOR_DIMS }
        );
      }
    }
  }
}

/**
 * Validate a TimeSeries query window. The spec requires windows ≤ 1 year.
 */
export function validateTimeseriesWindow(
  startMs: number,
  endMs: number
): void {
  const window = endMs - startMs;
  if (window < 0) {
    throw new OntologyError(
      "TimeSeries window: end must be ≥ start.",
      "INVALID_PARAMETER",
      400,
      { startMs, endMs }
    );
  }
  if (window > MAX_TIMESERIES_WINDOW_MS) {
    throw new OntologyError(
      "TimeSeries window exceeds maximum of 1 year.",
      "TIMESERIES_WINDOW_TOO_LARGE",
      400,
      { windowMs: window, maxMs: MAX_TIMESERIES_WINDOW_MS }
    );
  }
}
