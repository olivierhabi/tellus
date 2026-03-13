// ---------------------------------------------------------------------------
// Validation schemas for Datasource endpoints (Task 17B)
// ---------------------------------------------------------------------------

import { RequestSchema } from "../middleware/requestValidator";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const registerDatasourceSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
    apiName: { required: true, type: "string" },
  },
  body: {
    type: { required: true, type: "string", enum: ["postgres", "csv", "opensearch"] },
    connectionConfig: { required: true, type: "object" },
    columnMapping: { required: true, type: "object" },
  },
};

export const triggerIndexSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
    apiName: { required: true, type: "string" },
  },
};
