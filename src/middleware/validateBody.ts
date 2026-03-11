// ---------------------------------------------------------------------------
// Request Body Validation Middleware
//
// Provides a factory function `validateBody(schema)` that returns Express
// middleware. The middleware checks required fields, types, and constraints
// on `req.body` before the request reaches the service layer.
//
// Also exports pre-built schemas for each entity creation endpoint.
// ---------------------------------------------------------------------------

import { Request, Response, NextFunction } from "express";
import { sendError } from "../utils/responseFormatter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationRule {
  required?: boolean;
  type?: "string" | "number" | "boolean" | "object";
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  enum?: string[];
  default?: unknown;
}

export type ValidationSchema = Record<string, ValidationRule>;

// ---------------------------------------------------------------------------
// validateBody factory
// ---------------------------------------------------------------------------

/**
 * Returns Express middleware that validates `req.body` against the given
 * schema. Collects ALL validation errors (not just the first one) and
 * returns a 400 VALIDATION_FAILED response if any are found.
 *
 * For fields with a `default` value that are missing from the body, the
 * default is applied before calling `next()`.
 */
export function validateBody(schema: ValidationSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: string[] = [];

    for (const [fieldName, rules] of Object.entries(schema)) {
      const value = req.body[fieldName];

      // ---- Required check ------------------------------------------------
      if (rules.required && (value === undefined || value === null)) {
        errors.push(`Field '${fieldName}' is required.`);
        continue; // Skip further checks — field is missing
      }

      // ---- If the field is not present and not required, skip checks -----
      if (value === undefined || value === null) {
        continue;
      }

      // ---- Type check ----------------------------------------------------
      if (rules.type) {
        const actualType = typeof value;
        // Special case: arrays report as "object" but we don't want them
        // when expecting a plain object. However the spec type check is
        // simply `typeof`, so "object" matches both arrays and objects.
        if (actualType !== rules.type) {
          errors.push(
            `Field '${fieldName}' must be of type ${rules.type}. Got: ${actualType}.`
          );
          continue; // Type is wrong — skip further value checks
        }
      }

      // ---- String length checks ------------------------------------------
      if (rules.type === "string" && typeof value === "string") {
        if (
          rules.minLength !== undefined &&
          value.length < rules.minLength
        ) {
          errors.push(
            `Field '${fieldName}' must be at least ${rules.minLength} characters.`
          );
        }
        if (
          rules.maxLength !== undefined &&
          value.length > rules.maxLength
        ) {
          errors.push(
            `Field '${fieldName}' must be at most ${rules.maxLength} characters.`
          );
        }
      }

      // ---- Number range checks -------------------------------------------
      if (rules.type === "number" && typeof value === "number") {
        if (rules.min !== undefined && value < rules.min) {
          errors.push(
            `Field '${fieldName}' must be at least ${rules.min}.`
          );
        }
        if (rules.max !== undefined && value > rules.max) {
          errors.push(
            `Field '${fieldName}' must be at most ${rules.max}.`
          );
        }
      }

      // ---- Enum check ----------------------------------------------------
      if (rules.enum && !rules.enum.includes(value)) {
        errors.push(
          `Field '${fieldName}' must be one of: ${rules.enum.join(", ")}. Got: '${value}'.`
        );
      }
    }

    // ---- If any errors, return 400 --------------------------------------
    if (errors.length > 0) {
      sendError(res, "VALIDATION_FAILED", errors.join(" "));
      return;
    }

    // ---- Apply defaults for missing optional fields ---------------------
    for (const [fieldName, rules] of Object.entries(schema)) {
      if (
        rules.default !== undefined &&
        (req.body[fieldName] === undefined || req.body[fieldName] === null)
      ) {
        req.body[fieldName] = rules.default;
      }
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Pre-built schemas
// ---------------------------------------------------------------------------

export const CREATE_ONTOLOGY_SCHEMA: ValidationSchema = {
  displayName: {
    required: true,
    type: "string",
    minLength: 1,
    maxLength: 256,
  },
  description: { required: false, type: "string" },
};

export const CREATE_OBJECT_TYPE_SCHEMA: ValidationSchema = {
  apiName: {
    required: true,
    type: "string",
    minLength: 1,
    maxLength: 256,
  },
  displayName: {
    required: true,
    type: "string",
    minLength: 1,
    maxLength: 256,
  },
  description: { required: false, type: "string" },
  icon: { required: false, type: "string", default: "cube" },
  iconColor: { required: false, type: "string", default: "#1565C0" },
  status: {
    required: false,
    type: "string",
    enum: ["active", "experimental", "deprecated"],
    default: "active",
  },
};

export const CREATE_PROPERTY_SCHEMA: ValidationSchema = {
  apiName: {
    required: true,
    type: "string",
    minLength: 1,
    maxLength: 256,
  },
  displayName: {
    required: true,
    type: "string",
    minLength: 1,
    maxLength: 256,
  },
  baseType: { required: true, type: "string" },
  description: { required: false, type: "string" },
  structSchema: { required: false, type: "object" },
  isRequired: { required: false, type: "boolean", default: false },
  ordinal: { required: false, type: "number", min: 0, max: 10000, default: 0 },
};

export const REGISTER_DATASOURCE_SCHEMA: ValidationSchema = {
  datasetName: {
    required: true,
    type: "string",
    minLength: 1,
    maxLength: 256,
  },
  filePath: { required: true, type: "string", minLength: 1 },
  fileFormat: {
    required: true,
    type: "string",
    enum: ["csv", "json"],
  },
  columnMapping: { required: true, type: "object" },
};
