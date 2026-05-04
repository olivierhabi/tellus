// ---------------------------------------------------------------------------
// Code Repositories — RID parser/generator
//
// Spec: tasks/code-repository/code-repository-tasks.md §1.1 (line 60).
// Contract IDs covered:
//   G-C-01  RID format: ri.<service>.<instance>.<type>.<uuidv4>
//   G-C-02  Reserved namespaces: stemma, code-repos, jemma, functions, osdk
//   G-C-03  Repository RID: ri.stemma.main.repository.<uuid>
//   G-C-04  JobSpec RID: ri.code-repos.main.job-spec.<uuid>
//   G-C-05  Function-version RID: ri.functions.main.function-version.<uuid>
//   G-C-06  CI run RID: ri.jemma.main.run.<uuid>
//
// All identifiers are LOWERCASE; UUIDv4 lowercase hyphenated.
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";

/** UUIDv4 regex — strict: version=4, variant in {8,9,a,b}. */
export const UUIDV4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Component regex — used by both service/instance/type segments. */
const COMPONENT_REGEX = /^[a-z][a-z0-9-]*$/;

/**
 * Reserved service namespaces for this surface (G-C-02). Any other namespace
 * in this surface is a regression. Code that mints RIDs imports its namespace
 * from this list; a typo at the call site is caught by TypeScript.
 */
export const SERVICE_NAMESPACES = Object.freeze({
  STEMMA: "stemma",
  CODE_REPOS: "code-repos",
  JEMMA: "jemma",
  FUNCTIONS: "functions",
  OSDK: "osdk",
} as const);

export type ServiceNamespace =
  (typeof SERVICE_NAMESPACES)[keyof typeof SERVICE_NAMESPACES];

const SERVICE_NAMESPACE_SET: ReadonlySet<string> = new Set(
  Object.values(SERVICE_NAMESPACES)
);

export interface ParsedRid {
  readonly service: string;
  readonly instance: string;
  readonly type: string;
  readonly uuid: string;
}

/**
 * Parse a RID. Returns null on any structural failure (wrong prefix, wrong
 * component count, non-lowercase, bad UUID, unknown namespace). Does NOT
 * throw — callers that want to throw lift to a higher layer.
 */
export function parseRid(rid: string): ParsedRid | null {
  if (typeof rid !== "string" || rid.length === 0) return null;
  // Must be all-lowercase per G-C-01.
  if (rid !== rid.toLowerCase()) return null;
  const parts = rid.split(".");
  if (parts.length !== 5) return null;
  const [prefix, service, instance, type, uuid] = parts;
  if (prefix !== "ri") return null;
  if (!COMPONENT_REGEX.test(service)) return null;
  if (!COMPONENT_REGEX.test(instance)) return null;
  if (!COMPONENT_REGEX.test(type)) return null;
  if (!UUIDV4_REGEX.test(uuid)) return null;
  if (!SERVICE_NAMESPACE_SET.has(service)) return null;
  return { service, instance, type, uuid };
}

export function isRid(rid: string): boolean {
  return parseRid(rid) !== null;
}

/**
 * Structural-only RID check (no namespace whitelist). Use for *external*
 * RIDs we accept but do not own — e.g. Compass folder RIDs in B2 routes.
 * G-C-02 restricts the namespaces *we mint*; it does not restrict the RIDs
 * we accept as opaque references from upstream services.
 */
export function isStructurallyRid(rid: string): boolean {
  if (typeof rid !== "string" || rid.length === 0) return false;
  if (rid !== rid.toLowerCase()) return false;
  const parts = rid.split(".");
  if (parts.length !== 5) return false;
  const [prefix, service, instance, type, uuid] = parts;
  if (prefix !== "ri") return false;
  if (!COMPONENT_REGEX.test(service)) return false;
  if (!COMPONENT_REGEX.test(instance)) return false;
  if (!COMPONENT_REGEX.test(type)) return false;
  return UUIDV4_REGEX.test(uuid);
}

/**
 * Mint a new RID. The instance defaults to `main` (the only instance in v1
 * per the spec's RID examples). Type is the resource kind (`repository`,
 * `job-spec`, `function-version`, `run`).
 */
export function mintRid(args: {
  service: ServiceNamespace;
  type: string;
  instance?: string;
}): string {
  const { service, type, instance = "main" } = args;
  if (!COMPONENT_REGEX.test(type)) {
    throw new Error(`mintRid: invalid type ${JSON.stringify(type)}`);
  }
  if (!COMPONENT_REGEX.test(instance)) {
    throw new Error(`mintRid: invalid instance ${JSON.stringify(instance)}`);
  }
  return `ri.${service}.${instance}.${type}.${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Typed minters per resource (G-C-03..06). Wrappers exist so that a caller
// who wants a repository RID writes `mintRepositoryRid()`, not a literal
// string with a typo waiting to happen.
// ---------------------------------------------------------------------------

export const mintRepositoryRid = (): string =>
  mintRid({ service: SERVICE_NAMESPACES.STEMMA, type: "repository" });

export const mintJobSpecRid = (): string =>
  mintRid({ service: SERVICE_NAMESPACES.CODE_REPOS, type: "job-spec" });

export const mintFunctionVersionRid = (): string =>
  mintRid({ service: SERVICE_NAMESPACES.FUNCTIONS, type: "function-version" });

export const mintRunRid = (): string =>
  mintRid({ service: SERVICE_NAMESPACES.JEMMA, type: "run" });

export const mintSubscriptionRid = (): string =>
  mintRid({ service: SERVICE_NAMESPACES.STEMMA, type: "subscription" });

export const mintEventRid = (): string =>
  mintRid({ service: SERVICE_NAMESPACES.STEMMA, type: "event" });

// ---------------------------------------------------------------------------
// Type-asserting parsers — throw if the RID is the wrong kind.
// ---------------------------------------------------------------------------

function expectRid(rid: string, expectedService: string, expectedType: string): ParsedRid {
  const parsed = parseRid(rid);
  if (!parsed) throw new Error(`Not a RID: ${JSON.stringify(rid)}`);
  if (parsed.service !== expectedService) {
    throw new Error(
      `Expected service=${expectedService}, got ${parsed.service} in ${rid}`
    );
  }
  if (parsed.type !== expectedType) {
    throw new Error(`Expected type=${expectedType}, got ${parsed.type} in ${rid}`);
  }
  return parsed;
}

export const assertRepositoryRid = (rid: string): ParsedRid =>
  expectRid(rid, SERVICE_NAMESPACES.STEMMA, "repository");

export const assertJobSpecRid = (rid: string): ParsedRid =>
  expectRid(rid, SERVICE_NAMESPACES.CODE_REPOS, "job-spec");

export const assertFunctionVersionRid = (rid: string): ParsedRid =>
  expectRid(rid, SERVICE_NAMESPACES.FUNCTIONS, "function-version");

export const assertRunRid = (rid: string): ParsedRid =>
  expectRid(rid, SERVICE_NAMESPACES.JEMMA, "run");
