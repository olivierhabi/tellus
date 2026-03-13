// ---------------------------------------------------------------------------
// Validation schemas for Interface endpoints (Task 17B)
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

export const createInterfaceSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
  },
  body: {
    apiName: { required: true, type: "string", pattern: PASCAL_CASE_PATTERN, max: 100 },
    displayName: { required: true, type: "string", min: 1, max: 500 },
    description: { type: "string", max: 10000 },
    properties: {
      required: true,
      type: "array",
      min: 1,
      max: 100,
      items: {
        type: "object",
        custom: (value: unknown, field: string) => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return "each property must be an object";
          }
          const prop = value as Record<string, unknown>;
          const errors: string[] = [];
          if (!prop.apiName || typeof prop.apiName !== "string") {
            errors.push(`${field}.apiName is required`);
          } else if (!CAMEL_CASE_PATTERN.test(prop.apiName as string)) {
            errors.push(`${field}.apiName must be camelCase`);
          }
          if (!prop.displayName || typeof prop.displayName !== "string") {
            errors.push(`${field}.displayName is required`);
          }
          if (!prop.baseType || !VALID_BASE_TYPES.includes(prop.baseType as string)) {
            errors.push(`${field}.baseType must be one of: ${VALID_BASE_TYPES.join(", ")}`);
          }
          if (prop.isRequired !== undefined && typeof prop.isRequired !== "boolean") {
            errors.push(`${field}.isRequired must be a boolean`);
          }
          return errors.length > 0 ? errors.join("; ") : null;
        },
      },
    },
  },
};

export const updateInterfaceSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
    interfaceApiName: { required: true, type: "string", pattern: PASCAL_CASE_PATTERN },
  },
  body: {
    displayName: { type: "string", min: 1, max: 500 },
    description: { type: "string", max: 10000 },
    properties: {
      type: "array",
      min: 1,
      max: 100,
    },
  },
};

export const interfaceSearchSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
    interfaceApiName: { required: true, type: "string" },
  },
  body: {
    $pageSize: { type: "number", min: 1, max: 1000 },
  },
};

export const interfaceAggregateSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
    interfaceApiName: { required: true, type: "string" },
  },
  body: {
    aggregations: { required: true, type: "array", min: 1 },
  },
};

export const implementInterfaceSchema: RequestSchema = {
  params: {
    ontologyId: { required: true, type: "string", pattern: UUID_PATTERN },
    objectTypeApiName: { required: true, type: "string" },
  },
  body: {
    interfaceApiName: { required: true, type: "string", pattern: PASCAL_CASE_PATTERN },
    propertyMapping: { required: true, type: "object" },
  },
};
