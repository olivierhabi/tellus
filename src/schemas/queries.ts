// ---------------------------------------------------------------------------
// Validation schemas for Query endpoints (Task 17B)
// ---------------------------------------------------------------------------

import { RequestSchema } from "../middleware/requestValidator";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const searchSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
    apiName: { required: true, type: "string" },
  },
  body: {
    $pageSize: { type: "number", min: 1, max: 1000 },
  },
};

export const aggregateSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
    apiName: { required: true, type: "string" },
  },
  body: {
    aggregations: { required: true, type: "array", min: 1 },
  },
};

export const fullTextSearchSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
    apiName: { required: true, type: "string" },
  },
  body: {
    query: { required: true, type: "string", min: 1, max: 1000 },
    $pageSize: { type: "number", min: 1, max: 1000 },
  },
};
