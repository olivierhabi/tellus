// ---------------------------------------------------------------------------
// Validation schemas for Object Type endpoints (Task 17B)
// ---------------------------------------------------------------------------

import { RequestSchema } from "../middleware/requestValidator";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASCAL_CASE_PATTERN = /^[A-Z][a-zA-Z0-9]*$/;
const CAMEL_CASE_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

const VALID_BASE_TYPES = [
  "string", "boolean", "integer", "long", "double", "float",
  "date", "timestamp", "byte", "short", "decimal",
  "geopoint", "geoshape",
  "string_array", "integer_array", "long_array",
  "double_array", "boolean_array", "timestamp_array",
  "struct",
];

export const createObjectTypeSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
  },
  body: {
    apiName: { required: true, type: "string", pattern: PASCAL_CASE_PATTERN, max: 100 },
    displayName: { required: true, type: "string", min: 1, max: 500 },
    description: { type: "string", max: 10000 },
    status: { type: "string", enum: ["active", "experimental", "deprecated"] },
    primaryKeyPropertyApiName: { required: true, type: "string", pattern: CAMEL_CASE_PATTERN },
    properties: {
      required: true,
      type: "array",
      min: 1,
      max: 2000,
    },
  },
};

export const updateObjectTypeSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
    apiName: { required: true, type: "string", pattern: PASCAL_CASE_PATTERN },
  },
  body: {
    displayName: { type: "string", min: 1, max: 500 },
    description: { type: "string", max: 10000 },
    status: { type: "string", enum: ["active", "experimental", "deprecated"] },
  },
};

export const addPropertySchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
    apiName: { required: true, type: "string" },
  },
  body: {
    apiName: { required: true, type: "string", pattern: CAMEL_CASE_PATTERN },
    displayName: { required: true, type: "string", min: 1, max: 500 },
    baseType: { required: true, type: "string", enum: VALID_BASE_TYPES },
    isRequired: { type: "boolean" },
  },
};
