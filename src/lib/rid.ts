/**
 * RID (Resource Identifier) value type and helpers.
 *
 * Spec: tasks/files-projects/files-projects-tasks.md (B1, §1.2 of the
 * Compass Replication Blueprint). The grammar is taken verbatim from the
 * `palantir/resource-identifier` library:
 *
 *   ri.<service>.<instance>.<type>.<locator>
 *
 * - service / instance / type: kebab-case lowercase (`[a-z][a-z0-9-]*`).
 *   `instance` may be empty (the canonical "default instance" form is
 *   `ri.<service>..<type>.<locator>`).
 * - locator: arbitrary printable string. For new mints we use UUIDv4
 *   unless the caller passes an override.
 *
 * Storage-side DDL (resources.rid CHECK) uses the identical regex
 * (foundryMigrate.ts B1 block). Keeping the regex in one constant keeps
 * the DB and the runtime aligned.
 *
 * Contract IDs covered: B1-C-01 .. B1-C-05, B1-C-30 (errorCode), B1-C-42 (metric).
 */

import { randomUUID } from "node:crypto";
import { Counter } from "prom-client";

// Single source of truth for the RID grammar. Mirrors the CHECK constraint
// on `resources.rid` in foundryMigrate.ts (B1).
export const RID_REGEX =
  /^ri\.[a-z][a-z0-9-]*\.([a-z0-9][a-z0-9-]*)?\.[a-z][a-z0-9-]*\..+$/;

// Per-component grammars. `instance` may be empty.
const COMPONENT_REGEX = /^[a-z][a-z0-9-]*$/;
const INSTANCE_REGEX = /^([a-z0-9][a-z0-9-]*)?$/;

// UUIDv4 grammar (RFC 4122 §4.1). We pin to v4 because the spec says
// "locator is a UUIDv4 unless otherwise specified" — overrides may use
// any printable string but `mintRid` always emits v4.
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Branded type. Plain strings are not assignable to Rid without going
// through `parseRid`/`mintRid`. (B1-C-05.)
declare const __rid_brand: unique symbol;
export type Rid = string & { readonly [__rid_brand]: "Rid" };

export interface ParsedRid {
  service: string;
  instance: string; // empty string for the default-instance form
  type: string;
  locator: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InvalidRidFormatError extends Error {
  readonly errorCode = "INVALID_RID_FORMAT";
  readonly statusCode = 400;
  readonly parameters: { input: string; reason: string };
  constructor(input: string, reason: string) {
    super(`INVALID_RID_FORMAT: ${reason} (input=${JSON.stringify(input)})`);
    this.name = "InvalidRidFormatError";
    this.parameters = { input, reason };
  }
}

// ---------------------------------------------------------------------------
// Metrics — B1-C-42
// ---------------------------------------------------------------------------

// Lazy registration so `import` order does not break tests that recreate the
// default registry between suites. `prom-client` deduplicates by name.
let parseErrorsCounter: Counter<string> | null = null;
function getParseErrorsCounter(): Counter<string> {
  if (parseErrorsCounter) return parseErrorsCounter;
  // prom-client throws on duplicate registration; query first.
  const existing = (
    require("prom-client") as typeof import("prom-client")
  ).register.getSingleMetric("tellus_compass_rid_parse_errors_total");
  if (existing && existing instanceof Counter) {
    parseErrorsCounter = existing as Counter<string>;
    return parseErrorsCounter;
  }
  parseErrorsCounter = new Counter({
    name: "tellus_compass_rid_parse_errors_total",
    help: "Count of RID strings rejected by parseRid, broken down by reason.",
    labelNames: ["reason"],
  });
  return parseErrorsCounter;
}

function bumpParseError(reason: string): void {
  try {
    getParseErrorsCounter().inc({ reason }, 1);
  } catch {
    // Counter unavailable (e.g., test isolation cleared the registry). Do
    // not let metric emission abort RID validation.
  }
}

// ---------------------------------------------------------------------------
// Public API — B1-C-01 .. B1-C-04
// ---------------------------------------------------------------------------

/**
 * Parse a RID string into its components, or throw `InvalidRidFormatError`.
 *
 * The grammar is enforced both lexically (via `RID_REGEX`) and structurally
 * (each component validated separately so failure messages are actionable).
 *
 * Round-trips: every output of `formatRid` re-parses to an equivalent
 * `ParsedRid`; every output of `mintRid` re-parses cleanly. (B1-C-03.)
 */
export function parseRid(input: unknown): ParsedRid {
  if (typeof input !== "string") {
    bumpParseError("not_string");
    throw new InvalidRidFormatError(String(input), "RID must be a string");
  }
  if (input.length === 0) {
    bumpParseError("empty");
    throw new InvalidRidFormatError(input, "RID must not be empty");
  }
  if (input.length > 1024) {
    bumpParseError("too_long");
    throw new InvalidRidFormatError(input, "RID exceeds 1024-char ceiling");
  }
  if (!RID_REGEX.test(input)) {
    bumpParseError("regex");
    throw new InvalidRidFormatError(input, "RID does not match grammar");
  }

  // Split on '.' but preserve the locator (which may itself contain '.'):
  //   ri.<service>.<instance>.<type>.<locator>
  // → ["ri", service, instance, type, ...locatorParts]
  const parts = input.split(".");
  if (parts.length < 5 || parts[0] !== "ri") {
    bumpParseError("structure");
    throw new InvalidRidFormatError(input, "RID must start with 'ri.' and contain 5+ segments");
  }
  const [, service, instance, type, ...locatorParts] = parts;
  const locator = locatorParts.join(".");

  if (!COMPONENT_REGEX.test(service)) {
    bumpParseError("service");
    throw new InvalidRidFormatError(input, `service must match ${COMPONENT_REGEX} (got ${JSON.stringify(service)})`);
  }
  if (!INSTANCE_REGEX.test(instance)) {
    bumpParseError("instance");
    throw new InvalidRidFormatError(input, `instance must match ${INSTANCE_REGEX} (got ${JSON.stringify(instance)})`);
  }
  if (!COMPONENT_REGEX.test(type)) {
    bumpParseError("type");
    throw new InvalidRidFormatError(input, `type must match ${COMPONENT_REGEX} (got ${JSON.stringify(type)})`);
  }
  if (locator.length === 0) {
    bumpParseError("locator");
    throw new InvalidRidFormatError(input, "locator must not be empty");
  }

  return { service, instance, type, locator };
}

/** Try-flavored variant: returns null instead of throwing. */
export function tryParseRid(input: unknown): ParsedRid | null {
  try {
    return parseRid(input);
  } catch {
    return null;
  }
}

/**
 * Format a `ParsedRid` back to a RID string. Validates each component to
 * guarantee `parseRid(formatRid(p)) ≡ p` for any `p` produced by parseRid.
 */
export function formatRid(p: ParsedRid): Rid {
  if (!COMPONENT_REGEX.test(p.service)) {
    throw new InvalidRidFormatError(JSON.stringify(p), `formatRid: invalid service ${JSON.stringify(p.service)}`);
  }
  if (!INSTANCE_REGEX.test(p.instance)) {
    throw new InvalidRidFormatError(JSON.stringify(p), `formatRid: invalid instance ${JSON.stringify(p.instance)}`);
  }
  if (!COMPONENT_REGEX.test(p.type)) {
    throw new InvalidRidFormatError(JSON.stringify(p), `formatRid: invalid type ${JSON.stringify(p.type)}`);
  }
  if (typeof p.locator !== "string" || p.locator.length === 0) {
    throw new InvalidRidFormatError(JSON.stringify(p), "formatRid: locator must be non-empty string");
  }
  const out = `ri.${p.service}.${p.instance}.${p.type}.${p.locator}`;
  if (!RID_REGEX.test(out)) {
    // Defensive: should be unreachable given component checks above.
    throw new InvalidRidFormatError(out, "formatRid produced a string that fails RID_REGEX");
  }
  return out as Rid;
}

/**
 * Mint a fresh RID. By default uses the empty-instance form
 * (`ri.<service>..<type>.<uuid>`), which is the canonical Tellus form.
 *
 * Caller may pin a non-empty instance for cross-realm rids (e.g., shadow
 * envs). Caller may pin a `locator` (used by migrations that need to
 * preserve a legacy UUID); otherwise a fresh UUIDv4 is generated.
 *
 * B1-C-04.
 */
export function mintRid(
  service: string,
  type: string,
  options: { instance?: string; locator?: string } = {}
): Rid {
  const instance = options.instance ?? "";
  const locator = options.locator ?? randomUUID();
  return formatRid({ service, instance, type, locator });
}

/**
 * Type guard. Use this at trust boundaries (HTTP handlers, queue consumers)
 * to convert untrusted strings into the branded `Rid` type. Returns false
 * for strings that fail any component check.
 */
export function isRid(value: unknown): value is Rid {
  return tryParseRid(value) !== null;
}

/** Assert variant of `isRid` — narrows `value` to `Rid` or throws. */
export function assertRid(value: unknown): asserts value is Rid {
  parseRid(value); // throws InvalidRidFormatError on failure
}

/**
 * Brand a string we already know is a RID (because it came from the database
 * with a CHECK constraint matching `RID_REGEX`). This lets persistence-layer
 * code skip the runtime parse on hot paths without losing the brand.
 *
 * **Do not call** at trust boundaries — use `parseRid`/`assertRid` there.
 */
export function unsafeAsRid(value: string): Rid {
  return value as Rid;
}

// ---------------------------------------------------------------------------
// Helpers used by Compass services (B1-C-20 .. B1-C-25 and onward).
// ---------------------------------------------------------------------------

/** Returns true iff the parsed RID is the well-known root space RID. */
export const ROOT_SPACE_RID =
  "ri.compass.main.space.00000000-0000-0000-0000-000000000000" as Rid;

/** Returns true iff the locator is a v4 UUID. Used by tests. */
export function isUuidV4Locator(locator: string): boolean {
  return UUID_V4_REGEX.test(locator);
}
