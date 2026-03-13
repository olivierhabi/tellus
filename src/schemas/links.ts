// ---------------------------------------------------------------------------
// Validation schemas for Link Type endpoints (Task 17B)
// ---------------------------------------------------------------------------

import { RequestSchema } from "../middleware/requestValidator";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMEL_CASE_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

export const createLinkTypeSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
  },
  body: {
    apiName: { required: true, type: "string", pattern: CAMEL_CASE_PATTERN, max: 100 },
    displayName: { required: true, type: "string", min: 1, max: 500 },
    sourceObjectType: { required: true, type: "string" },
    targetObjectType: { required: true, type: "string" },
    cardinality: { required: true, type: "string", enum: ["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_ONE", "MANY_TO_MANY"] },
  },
};

export const searchAroundSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
  },
  body: {
    objectType: { required: true, type: "string" },
    primaryKey: { required: true, type: "string" },
    linkType: { required: true, type: "string" },
    $pageSize: { type: "number", min: 1, max: 1000 },
  },
};
