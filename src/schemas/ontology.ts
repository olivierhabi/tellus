// ---------------------------------------------------------------------------
// Validation schemas for Ontology endpoints (Task 17B)
// ---------------------------------------------------------------------------

import { RequestSchema } from "../middleware/requestValidator";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const createOntologySchema: RequestSchema = {
  body: {
    apiName: { required: true, type: "string", min: 1, max: 100 },
    displayName: { required: true, type: "string", min: 1, max: 500 },
    description: { type: "string", max: 10000 },
  },
};

export const updateOntologySchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
  },
  body: {
    displayName: { type: "string", min: 1, max: 500 },
    description: { type: "string", max: 10000 },
  },
};
