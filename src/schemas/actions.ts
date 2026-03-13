// ---------------------------------------------------------------------------
// Validation schemas for Action endpoints (Task 17B)
// ---------------------------------------------------------------------------

import { RequestSchema } from "../middleware/requestValidator";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMEL_CASE_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

export const createActionTypeSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
  },
  body: {
    apiName: { required: true, type: "string", pattern: CAMEL_CASE_PATTERN, max: 100 },
    displayName: { required: true, type: "string", min: 1, max: 500 },
    description: { type: "string", max: 10000 },
    parameters: { required: true, type: "array", min: 1 },
    rules: { required: true, type: "array", min: 1 },
  },
};

export const applyActionSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
  },
  body: {
    actionType: { required: true, type: "string" },
    parameters: { required: true, type: "object" },
  },
};

export const validateActionSchema: RequestSchema = {
  body: {
    actionType: { required: true, type: "string" },
    parameters: { required: true, type: "object" },
  },
};
