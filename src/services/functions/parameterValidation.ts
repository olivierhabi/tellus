// ---------------------------------------------------------------------------
// parameterValidation.ts — authoritative, recursive backend validation of
// Function-effect parameter bindings against the canonical published
// signature (canonicalSignature.ts).
//
// Semantics (authoritative — the UI mirrors them, never replaces them):
//   • false, 0 and "" are VALID configured values.
//   • A missing/undefined required parameter is rejected
//     (FUNCTION_PARAMETER_MISSING).
//   • null is rejected unless the published type explicitly permits it
//     (`T | null` → optional wrapper with allowsNull).
//   • Optional omission preserves JavaScript default-parameter semantics
//     (the argument is `undefined`, so declared defaults apply).
//   • Numeric strings NEVER silently execute as numbers.
//   • date    — canonical format "YYYY-MM-DD".
//   • timestamp — canonical RFC 3339 with an explicit zone offset
//     (e.g. "2026-08-02T10:00:00Z" or "+02:00"); normalized to UTC ISO.
//   • Lists/structs validate recursively and report precise paths.
//   • Unsupported declared types pass through WITHOUT coercion
//     (documented escape hatch — never silent casting).
// ---------------------------------------------------------------------------

import {
  type FunctionType,
  type PublishedParameter,
  positionalParameters,
} from "./canonicalSignature";

// ---------------------------------------------------------------------------
// Structured errors — suitable for API responses AND inline UI field errors.
// ---------------------------------------------------------------------------

export interface ParameterIssue {
  /** Dotted/indexed path, e.g. `name`, `address.city`, `items[2].id`. */
  path: string;
  code:
    | "FUNCTION_PARAMETER_MISSING"
    | "FUNCTION_PARAMETER_NULL"
    | "FUNCTION_PARAMETER_TYPE"
    | "FUNCTION_PARAMETER_UNKNOWN";
  message: string;
  /** Canonical expected type kind (for UI hints). */
  expected?: string;
}

export class ParameterValidationError extends Error {
  readonly code = "FUNCTION_PARAMETER_INVALID";
  readonly status = 422;
  readonly issues: ParameterIssue[];
  constructor(issues: ParameterIssue[]) {
    super(
      `Function parameter validation failed (${issues.length} issue${
        issues.length === 1 ? "" : "s"
      }): ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
    this.name = "ParameterValidationError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Configuration support gate (Phase: honest unsupported-type gating).
//
// These canonical type kinds have NO supported binding surface in this
// release (no picker, no resolver): configuring ANY binding for them is a
// stable rejection — FUNCTION_PARAMETER_UNSUPPORTED_TYPE (422) at
// activation AND at execution (fail-closed for stale configs). Omission
// (optional/hasDefault parameters) stays legal. Everything NOT in this set
// — scalars, date/timestamp, optional/list/map/struct — is fully supported
// with recursive server-side validation.
// ---------------------------------------------------------------------------

export const UNSUPPORTED_BINDING_TYPE_KINDS: ReadonlySet<FunctionType["kind"]> =
  new Set<FunctionType["kind"]>(["objectSet", "ontologyObject", "unsupported"]);

export function isUnsupportedBindingKind(kind: FunctionType["kind"]): boolean {
  return UNSUPPORTED_BINDING_TYPE_KINDS.has(kind);
}

/**
 * Configured bindings that target an unsupported canonical type kind, in
 * published order. Shared by activation validation (automate/validation.ts)
 * and the executor's fail-closed check (automate/effectExecutors.ts).
 */
export function unsupportedConfiguredParameters(
  parameters: ReadonlyArray<PublishedParameter>,
  configuredNames: ReadonlySet<string>,
): PublishedParameter[] {
  return parameters
    .filter(
      (parameter) =>
        isUnsupportedBindingKind(parameter.type.kind) &&
        configuredNames.has(parameter.name),
    )
    .slice()
    .sort((a, b) => a.position - b.position);
}

// ---------------------------------------------------------------------------
// Recursive value validation. Returns the NORMALIZED value (timestamps are
// normalized to UTC ISO-8601). NEVER coerces: rejects on mismatch.
// ---------------------------------------------------------------------------

const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function validateValue(
  type: FunctionType,
  value: unknown,
  path: string,
  issues: ParameterIssue[],
): unknown {
  const fail = (expected: string): null => {
    issues.push({
      path,
      code: "FUNCTION_PARAMETER_TYPE",
      message: `Expected ${expected}, got ${describe(value)}.`,
      expected,
    });
    return null;
  };
  switch (type.kind) {
    case "string":
      // "" is a perfectly valid configured string.
      return typeof value === "string" ? value : fail("string");
    case "boolean":
      // false is a perfectly valid configured boolean.
      return typeof value === "boolean" ? value : fail("boolean");
    case "integer":
    case "long":
      // 0 is valid; numeric strings are NOT silently accepted.
      return typeof value === "number" && Number.isSafeInteger(value)
        ? value
        : fail(type.kind);
    case "float":
    case "double":
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : fail(type.kind);
    case "date": {
      if (typeof value !== "string" || !CANONICAL_DATE.test(value)) {
        return fail("date (YYYY-MM-DD)");
      }
      if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        return fail("date (YYYY-MM-DD)");
      }
      return value;
    }
    case "timestamp": {
      if (typeof value !== "string" || !RFC3339_WITH_ZONE.test(value)) {
        return fail("timestamp (RFC 3339 with zone offset)");
      }
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) return fail("timestamp (RFC 3339 with zone offset)");
      return new Date(parsed).toISOString();
    }
    case "optional":
      if (value === null) {
        if (type.allowsNull) return null;
        issues.push({
          path,
          code: "FUNCTION_PARAMETER_NULL",
          message:
            "null is not a configured value for this parameter — omit the binding or provide a value of the published type.",
          expected: type.value.kind,
        });
        return null;
      }
      if (value === undefined) return undefined;
      return validateValue(type.value, value, path, issues);
    case "list": {
      if (!Array.isArray(value)) return fail("list");
      return value.map((element, index) =>
        validateValue(type.element, element, `${path}[${index}]`, issues),
      );
    }
    case "map": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return fail("map");
      }
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        out[key] = validateValue(type.value, entry, `${path}.${key}`, issues);
      }
      return out;
    }
    case "struct": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return fail("struct");
      }
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const field of type.fields) {
        const fieldValue = record[field.name];
        if (fieldValue === undefined) {
          if (field.type.kind !== "optional") {
            issues.push({
              path: `${path}.${field.name}`,
              code: "FUNCTION_PARAMETER_MISSING",
              message: `Struct field '${field.name}' is required.`,
              expected: field.type.kind,
            });
          }
          continue;
        }
        out[field.name] = validateValue(
          field.type,
          fieldValue,
          `${path}.${field.name}`,
          issues,
        );
      }
      for (const key of Object.keys(record)) {
        if (!type.fields.some((field) => field.name === key)) {
          issues.push({
            path: `${path}.${key}`,
            code: "FUNCTION_PARAMETER_UNKNOWN",
            message: `Unknown struct field '${key}' — not in the published type.`,
          });
        }
      }
      return out;
    }
    case "ontologyObject":
      // An object reference: a primary key (string/number) or a resolved
      // object surface. Ontology-type compatibility is enforced where the
      // binding source is known (activation-time validation).
      if (typeof value === "string" || typeof value === "number") return value;
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
      return fail("ontology object reference");
    case "objectSet":
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") return value;
      return fail("object set");
    case "client":
      // Injected by the runtime — never a user-configured value.
      issues.push({
        path,
        code: "FUNCTION_PARAMETER_UNKNOWN",
        message: "This parameter is runtime-injected and cannot be configured.",
      });
      return null;
    case "unsupported":
      // Declared type is not yet validatable — pass through verbatim.
      // NO coercion, NO casting; documented escape hatch.
      return value;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ---------------------------------------------------------------------------
// Positional resolution — the typescript-v2-positional-v2 invocation path.
// ---------------------------------------------------------------------------

export interface ResolvedArguments {
  /** Values in PUBLISHED positional order; omitted optionals are `undefined`
   *  (JavaScript default-parameter semantics preserved). */
  args: unknown[];
  /** Normalized values keyed by published name (timestamps normalized to
   *  UTC ISO). Use this bag for execution so exactly what was validated is
   *  what executes. */
  normalizedValues: Record<string, unknown>;
  /** Parameter names that were configured but are not in the signature. */
  unknown: string[];
}

/**
 * Resolve and validate every configured parameter BY PUBLISHED NAME and
 * return invocation arguments in PUBLISHED POSITIONAL ORDER. Throws
 * ParameterValidationError on the first batch of issues.
 *
 * `injectClient` supplies the value for parameters whose published type is
 * `Client` (Foundry edit convention) — injection is signature-driven, never
 * arity-driven.
 */
export function resolvePositionalArguments(input: {
  parameters: PublishedParameter[];
  /** Resolved binding values keyed by published parameter name. */
  values: Record<string, unknown>;
  injectClient: () => unknown;
}): ResolvedArguments {
  const issues: ParameterIssue[] = [];
  const ordered = positionalParameters({
    contractVersion: 2,
    parameters: input.parameters,
    output: "",
  });
  const args: unknown[] = [];
  const normalizedValues: Record<string, unknown> = {};
  for (const parameter of ordered) {
    if (parameter.type.kind === "client") {
      args.push(input.injectClient());
      continue;
    }
    const value = input.values[parameter.name];
    if (value === undefined) {
      // Missing (no binding) or resolved-to-undefined.
      if (!parameter.optional && !parameter.hasDefault) {
        issues.push({
          path: parameter.name,
          code: "FUNCTION_PARAMETER_MISSING",
          message: `Required parameter '${parameter.name}' (${parameter.typeText || parameter.type.kind}) is not configured.`,
          expected: parameter.type.kind,
        });
        args.push(undefined);
      } else {
        // Preserve omission/default semantics: explicit `undefined`.
        args.push(undefined);
      }
      continue;
    }
    const normalized = validateValue(parameter.type, value, parameter.name, issues);
    args.push(normalized);
    normalizedValues[parameter.name] = normalized;
  }
  if (issues.length > 0) throw new ParameterValidationError(issues);
  const known = new Set(input.parameters.map((p) => p.name));
  const unknown = Object.keys(input.values).filter(
    (key) => !known.has(key) && input.values[key] !== undefined,
  );
  return { args, normalizedValues, unknown };
}

// ---------------------------------------------------------------------------
// Static (activation-time) validation of a constant binding value.
// ---------------------------------------------------------------------------

/**
 * Validate a statically-known constant value for a published parameter.
 * Returns issues (empty = valid). `undefined`/missing should be checked by
 * the caller against required-ness; explicit `null` is checked here.
 */
export function validateConstantValue(
  parameter: PublishedParameter,
  value: unknown,
): ParameterIssue[] {
  if (value === undefined) {
    return parameter.optional || parameter.hasDefault
      ? []
      : [
          {
            path: parameter.name,
            code: "FUNCTION_PARAMETER_MISSING",
            message: `Required parameter '${parameter.name}' is not configured.`,
            expected: parameter.type.kind,
          },
        ];
  }
  if (parameter.type.kind === "client") {
    return []; // injected, not user-configurable
  }
  if (
    value === null &&
    !(parameter.type.kind === "optional" && parameter.type.allowsNull)
  ) {
    // null must not count as configured. For REQUIRED parameters surface the
    // required-error (the automation is unusable); for optional ones surface
    // the null rule.
    return [
      {
        path: parameter.name,
        code:
          parameter.optional || parameter.hasDefault
            ? "FUNCTION_PARAMETER_NULL"
            : "FUNCTION_PARAMETER_MISSING",
        message:
          parameter.optional || parameter.hasDefault
            ? `'${parameter.name}' is bound to null, which the published type does not permit — omit it or bind a value.`
            : `Required parameter '${parameter.name}' is bound to null.`,
        expected: parameter.type.kind,
      },
    ];
  }
  const issues: ParameterIssue[] = [];
  validateValue(parameter.type, value, parameter.name, issues);
  return issues;
}
