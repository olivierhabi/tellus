// ---------------------------------------------------------------------------
// Tellus error registry.
// Spec §844 / agent prompt §10.3: every error reachable in code is registered
// here with its errorName, HTTP status, and operator-facing description. Tests
// assert that every registered code is reachable by at least one test case.
//
// Naming: Tellus:<Service>:<PascalCase>. ErrorCode follows Conjure-flavoured
// coarse categories (INVALID_ARGUMENT, CONFLICT, NOT_FOUND, PERMISSION_DENIED,
// FAILED_PRECONDITION, UNAUTHENTICATED, INTERNAL, UNAVAILABLE, DEADLINE_EXCEEDED).
//
// IMPLEMENTATION NOTE — circular-init safety:
// The per-service catalogs (connectivity.errors, funnel.errors, …) are
// side-effect-imported at the bottom of this file so that importing the
// registry surfaces every definition. Under CommonJS those `require`s are
// hoisted above this module's top-level `const`s, so the catalogs can call
// `def()`/`register()` *before* a `const`-bound table/Map is initialized
// (temporal dead zone). To stay safe regardless of evaluation order, the
// category→HTTP table and the registry Map are exposed via *hoisted function
// declarations* (which are fully initialized at module-eval start), not
// TDZ-bound `const`s.
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | "INVALID_ARGUMENT"
  | "FAILED_PRECONDITION"
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RESOURCE_EXHAUSTED"
  | "INTERNAL"
  | "UNAVAILABLE"
  | "DEADLINE_EXCEEDED";

export interface ErrorDefinition {
  /** Coarse Conjure-style code. */
  errorCode: ErrorCategory;
  /** Stable identifier (Tellus:<Service>:<PascalCase>). */
  errorName: string;
  /** HTTP status returned to clients. */
  httpStatus: number;
  /** One-line operator-facing description. Becomes the alert label. */
  description: string;
}

/** Category → default HTTP status. Hoisted function: no TDZ. */
function categoryHttp(c: ErrorCategory): number {
  switch (c) {
    case "INVALID_ARGUMENT":
      return 400;
    case "FAILED_PRECONDITION":
      return 412;
    case "UNAUTHENTICATED":
      return 401;
    case "PERMISSION_DENIED":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "RESOURCE_EXHAUSTED":
      return 429;
    case "INTERNAL":
      return 500;
    case "UNAVAILABLE":
      return 503;
    case "DEADLINE_EXCEEDED":
      return 504;
    default:
      return 500;
  }
}

/**
 * Process-wide registry Map, created lazily on first access. Hoisted function
 * declaration + a module-scoped holder that is safe to read during the
 * circular catalog imports (the holder var is `undefined` until first call,
 * never in TDZ because `var`/function semantics initialize before any code
 * runs in CJS).
 */
// Intentionally `var`: hoisted AND initialized to `undefined` at module-eval
// start (no temporal dead zone), so the hoisted catalog `require`s below can
// call register() → registryMap() before this line is reached in source order.
// eslint-disable-next-line no-var
var _registry: Map<string, ErrorDefinition> | undefined;
function registryMap(): Map<string, ErrorDefinition> {
  if (!_registry) _registry = new Map<string, ErrorDefinition>();
  return _registry;
}

/** Construct an ErrorDefinition with HTTP status derived from category. */
export function def(
  errorName: string,
  errorCode: ErrorCategory,
  description: string,
  overrideStatus?: number,
): ErrorDefinition {
  return {
    errorCode,
    errorName,
    httpStatus: overrideStatus ?? categoryHttp(errorCode),
    description,
  };
}

/** Register a definition exactly once. Duplicate names throw at module load. */
export function register(d: ErrorDefinition): ErrorDefinition {
  const reg = registryMap();
  const existing = reg.get(d.errorName);
  if (existing && existing !== d) {
    throw new Error(
      `Tellus error registry collision: ${d.errorName} registered twice with different definitions.`,
    );
  }
  if (!/^Tellus:[A-Z][A-Za-z0-9]+:[A-Z][A-Za-z0-9]+$/.test(d.errorName)) {
    throw new Error(
      `Tellus error name "${d.errorName}" does not match Tellus:Service:PascalCase.`,
    );
  }
  reg.set(d.errorName, d);
  return d;
}

export function get(errorName: string): ErrorDefinition | undefined {
  return registryMap().get(errorName);
}

export function all(): ErrorDefinition[] {
  return Array.from(registryMap().values());
}

// Force-load the per-service catalogs so that any module importing the registry
// sees every definition. New service catalogs append imports here.
import "./connectivity.errors";
import "./funnel.errors";
import "./ontology.errors";
