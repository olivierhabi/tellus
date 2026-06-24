/**
 * FOUNDRY-GAPS §5 — OSDK codegen core (the OSDK analog).
 *
 * Pure, DB-free code generator: given an `OntologySnapshot` (object types,
 * link types, action types) it emits a set of TypeScript source files
 * ({path, content}[]) forming a typed SDK for app builders. The generated
 * client wraps the SAME REST endpoints the frontend consumes today
 * (tellus-fe/lib/ontologyApi.ts), i.e. paths relative to an API base URL
 * that already ends in `/api`:
 *
 *   GET  /v1/objects/:apiName                       — fetchPage
 *   GET  /v1/objects/:apiName/:primaryKey           — get
 *   POST /v1/objects/:apiName/search                — search / filtered pages
 *   POST /v1/objects/:apiName/aggregate             — aggregate
 *   GET  /v1/objects/:apiName/:pk/links/:linkApiName — link traversal
 *   POST /v1/ontology/:ontologyId/actions/:apiName/apply — actions
 *
 * Output is deterministic: all collections are sorted by apiName and the
 * only timestamp embedded is `snapshot.ontology.generatedAt` (caller
 * supplied), so regenerating from an identical snapshot produces an
 * identical diff.
 */

// ---------------------------------------------------------------------------
// Snapshot input contracts
// ---------------------------------------------------------------------------

export interface SnapshotProperty {
  apiName: string;
  /** Ontology base type: string|integer|long|double|float|boolean|date|timestamp|… */
  type: string;
  nullable?: boolean;
}

export interface SnapshotObjectType {
  apiName: string;
  displayName?: string;
  /** apiName of the primary-key property. */
  primaryKey: string;
  properties: SnapshotProperty[];
}

export interface SnapshotLinkType {
  apiName: string;
  displayName?: string;
  cardinality: string; // ONE_TO_ONE | ONE_TO_MANY | MANY_TO_ONE | MANY_TO_MANY
  sourceObjectType: string; // object type apiName
  targetObjectType: string; // object type apiName
}

export interface SnapshotActionParameter {
  apiName: string;
  type: string;
  required?: boolean;
  objectType?: string;
}

export interface SnapshotActionType {
  apiName: string;
  displayName?: string;
  parameters: SnapshotActionParameter[];
}

export interface OntologySnapshot {
  ontology: {
    id: string;
    apiName?: string;
    displayName?: string;
    version?: string | number;
    /** ISO timestamp baked into the generated header. Caller-supplied so output is deterministic. */
    generatedAt?: string;
  };
  objectTypes: SnapshotObjectType[];
  linkTypes: SnapshotLinkType[];
  actionTypes: SnapshotActionType[];
}

export interface GeneratedFile {
  path: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Identifier sanitization
// ---------------------------------------------------------------------------

const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "import", "in", "instanceof", "new",
  "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield", "let", "static",
  "implements", "interface", "package", "private", "protected", "public",
  "await", "object", "string", "number", "boolean", "any", "unknown",
]);

/** Split an arbitrary apiName into word chunks on non-alphanumerics + case boundaries. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0);
}

/** camelCase identifier, valid TS (handles `flight-data 2024` → `flightData2024`). */
export function sanitizeIdentifier(name: string): string {
  const ws = words(name);
  let out = ws
    .map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
  if (out.length === 0) out = "unnamed";
  if (/^[0-9]/.test(out)) out = `_${out}`;
  if (RESERVED.has(out)) out = `${out}_`;
  return out;
}

/** PascalCase identifier for type names (`flight-data 2024` → `FlightData2024`). */
export function pascalCase(name: string): string {
  const id = sanitizeIdentifier(name);
  const base = id.replace(/^_+/, "");
  let out = base.charAt(0).toUpperCase() + base.slice(1);
  if (out.length === 0) out = "Unnamed";
  if (/^[0-9]/.test(out)) out = `_${out}`;
  return out;
}

/** Render a property key for an interface — quote it when not a valid identifier. */
function propertyKey(apiName: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(apiName) ? apiName : JSON.stringify(apiName);
}

// ---------------------------------------------------------------------------
// Type mapping (ontology base type → TS type)
// ---------------------------------------------------------------------------

export function mapPropertyType(baseType: string): string {
  switch (baseType) {
    case "string":
    case "decimal":
    case "marking":
    case "attachment":
    case "media_reference":
      return "string";
    case "date":
    case "timestamp":
      return "string"; // ISO 8601
    case "integer":
    case "long":
    case "double":
    case "float":
    case "byte":
    case "short":
      return "number";
    case "boolean":
      return "boolean";
    case "geopoint":
      return "{ lat: number; lon: number } | string";
    case "string_array":
      return "string[]";
    case "integer_array":
    case "double_array":
      return "number[]";
    case "boolean_array":
      return "boolean[]";
    case "timestamp_array":
      return "string[]";
    case "geoshape":
    case "struct":
    case "timeseries":
      return "Record<string, unknown>";
    default:
      return "unknown";
  }
}

function mapActionParamType(p: SnapshotActionParameter): string {
  switch (p.type) {
    case "object_reference":
      return "string | number"; // primary key of an existing object
    case "object_set":
      return "Record<string, unknown>"; // filter resolving to a set of objects
    default:
      return mapPropertyType(p.type);
  }
}

// ---------------------------------------------------------------------------
// Codegen helpers
// ---------------------------------------------------------------------------

function sortByApiName<T extends { apiName: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.apiName.localeCompare(b.apiName));
}

function header(snapshot: OntologySnapshot): string {
  const o = snapshot.ontology;
  const name = o.displayName ?? o.apiName ?? o.id;
  return [
    `// =====================================================================`,
    `// AUTO-GENERATED OSDK — do not edit by hand.`,
    `// Ontology: ${name} (${o.id})`,
    `// Version: ${o.version ?? "unversioned"}`,
    `// Generated at: ${o.generatedAt ?? "unknown"}`,
    `// Regenerate: npx tsx scripts/osdk-regen.ts --ontology ${o.id}`,
    `// =====================================================================`,
  ].join("\n");
}

function objectInterfaceName(ot: SnapshotObjectType): string {
  return pascalCase(ot.apiName);
}

function primaryKeyTsType(ot: SnapshotObjectType): string {
  const pk = ot.properties.find((p) => p.apiName === ot.primaryKey);
  if (!pk) return "string | number";
  const t = mapPropertyType(pk.type);
  return t === "string" || t === "number" ? t : "string | number";
}

// ---------------------------------------------------------------------------
// types.ts
// ---------------------------------------------------------------------------

function genTypes(snapshot: OntologySnapshot): string {
  const lines: string[] = [header(snapshot), ""];
  const objectTypes = sortByApiName(snapshot.objectTypes);
  const linkTypes = sortByApiName(snapshot.linkTypes);
  const actionTypes = sortByApiName(snapshot.actionTypes);

  lines.push("// ----- Object types -------------------------------------------------");
  for (const ot of objectTypes) {
    const iface = objectInterfaceName(ot);
    lines.push("");
    lines.push(`/** ${ot.displayName ?? ot.apiName} (apiName: ${JSON.stringify(ot.apiName)}, primaryKey: ${JSON.stringify(ot.primaryKey)}) */`);
    lines.push(`export interface ${iface} {`);
    for (const p of sortByApiName(ot.properties)) {
      const ts = mapPropertyType(p.type);
      if (p.nullable) {
        lines.push(`  ${propertyKey(p.apiName)}?: ${ts} | null;`);
      } else {
        lines.push(`  ${propertyKey(p.apiName)}: ${ts};`);
      }
    }
    lines.push(`}`);
    lines.push("");
    lines.push(`/** Primary-key type of ${iface} (property ${JSON.stringify(ot.primaryKey)}). */`);
    lines.push(`export type ${iface}PrimaryKey = ${primaryKeyTsType(ot)};`);
  }

  lines.push("");
  lines.push("// ----- Link types ---------------------------------------------------");
  lines.push("");
  lines.push(`export interface LinkTypeDescriptor {`);
  lines.push(`  apiName: string;`);
  lines.push(`  displayName: string;`);
  lines.push(`  cardinality: "ONE_TO_ONE" | "ONE_TO_MANY" | "MANY_TO_ONE" | "MANY_TO_MANY";`);
  lines.push(`  sourceObjectType: string;`);
  lines.push(`  targetObjectType: string;`);
  lines.push(`}`);
  lines.push("");
  lines.push(`export const LINK_TYPES = {`);
  for (const lt of linkTypes) {
    lines.push(`  ${sanitizeIdentifier(lt.apiName)}: {`);
    lines.push(`    apiName: ${JSON.stringify(lt.apiName)},`);
    lines.push(`    displayName: ${JSON.stringify(lt.displayName ?? lt.apiName)},`);
    lines.push(`    cardinality: ${JSON.stringify(lt.cardinality)},`);
    lines.push(`    sourceObjectType: ${JSON.stringify(lt.sourceObjectType)},`);
    lines.push(`    targetObjectType: ${JSON.stringify(lt.targetObjectType)},`);
    lines.push(`  },`);
  }
  lines.push(`} as const;`);

  lines.push("");
  lines.push("// ----- Action parameter types ---------------------------------------");
  for (const at of actionTypes) {
    const iface = `${pascalCase(at.apiName)}Parameters`;
    lines.push("");
    lines.push(`/** Parameters for action ${JSON.stringify(at.apiName)}${at.displayName ? ` (${at.displayName})` : ""} */`);
    lines.push(`export interface ${iface} {`);
    for (const p of sortByApiName(at.parameters)) {
      const opt = p.required ? "" : "?";
      const comment = p.objectType ? ` // ${p.type} → ${p.objectType}` : "";
      lines.push(`  ${propertyKey(p.apiName)}${opt}: ${mapActionParamType(p)};${comment}`);
    }
    lines.push(`}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// client.ts
// ---------------------------------------------------------------------------

const CLIENT_RUNTIME = `
export interface OsdkClientOptions {
  /** API base URL, e.g. "http://localhost:4000/api" — generated paths are "/v1/...". */
  baseUrl: string;
  /** Override the ontology id baked in at generation time (used by action apply). */
  ontologyId?: string;
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
  /** Extra headers (e.g. Authorization) sent with every request. */
  headers?: Record<string, string>;
}

export interface PageResult<T> {
  data: T[];
  nextPageToken?: string | null;
  totalCount?: number;
}

export interface FetchPageOptions {
  pageSize?: number;
  pageToken?: string;
  /** Filter tree (same shape as POST /v1/objects/:apiName/search "where"). When set, the search endpoint is used. */
  where?: Record<string, unknown>;
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  select?: string[];
}

export interface SearchBody {
  where?: Record<string, unknown>;
  filter?: Array<{ property: string; operator: string; value?: unknown; values?: unknown[] }>;
  pageSize?: number;
  pageToken?: string;
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  select?: string[];
}

export interface AggregateBody {
  aggregations: Array<Record<string, unknown>>;
  where?: Record<string, unknown>;
  groupBy?: Array<Record<string, unknown>>;
}

export class OsdkError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "OsdkError";
  }
}

class HttpCore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;

  constructor(opts: OsdkClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.headers = opts.headers ?? {};
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...this.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      throw new OsdkError(\`\${method} \${path} → \${res.status}\`, res.status, parsed);
    }
    return parsed as T;
  }
}

function asPage<T>(raw: unknown): PageResult<T> {
  if (Array.isArray(raw)) return { data: raw as T[] };
  return raw as PageResult<T>;
}

/** Typed accessor over the /v1/objects/:apiName data plane. */
export class ObjectSet<O, PK extends string | number> {
  constructor(
    private readonly core: HttpCore,
    /** Raw ontology apiName used in URLs (NOT the sanitized TS identifier). */
    public readonly apiName: string,
  ) {}

  /** GET /v1/objects/:apiName (or POST /search when \`where\` is provided). */
  async fetchPage(opts: FetchPageOptions = {}): Promise<PageResult<O>> {
    if (opts.where || opts.orderBy || opts.select) {
      const body: Record<string, unknown> = {};
      if (opts.where) body.where = opts.where;
      if (opts.orderBy) body.$orderBy = opts.orderBy;
      if (opts.pageSize != null) body.$pageSize = opts.pageSize;
      if (opts.pageToken) body.$pageToken = opts.pageToken;
      if (opts.select) body.$select = opts.select;
      const raw = await this.core.request<unknown>(
        "POST",
        \`/v1/objects/\${encodeURIComponent(this.apiName)}/search\`,
        body,
      );
      return asPage<O>(raw);
    }
    const qs = new URLSearchParams();
    if (opts.pageSize != null) qs.set("pageSize", String(opts.pageSize));
    if (opts.pageToken) qs.set("pageToken", opts.pageToken);
    const q = qs.toString();
    const raw = await this.core.request<unknown>(
      "GET",
      \`/v1/objects/\${encodeURIComponent(this.apiName)}\${q ? \`?\${q}\` : ""}\`,
    );
    return asPage<O>(raw);
  }

  /** GET /v1/objects/:apiName/:primaryKey */
  async get(primaryKey: PK): Promise<O> {
    const raw = await this.core.request<unknown>(
      "GET",
      \`/v1/objects/\${encodeURIComponent(this.apiName)}/\${encodeURIComponent(String(primaryKey))}\`,
    );
    const envelope = raw as { data?: O };
    return (envelope && typeof envelope === "object" && "data" in envelope
      ? (envelope.data as O)
      : (raw as O));
  }

  /** POST /v1/objects/:apiName/search */
  async search(query: SearchBody = {}): Promise<PageResult<O>> {
    const body: Record<string, unknown> = {};
    if (query.where) body.where = query.where;
    if (query.filter) body.filter = query.filter;
    if (query.orderBy) body.$orderBy = query.orderBy;
    if (query.pageSize != null) body.$pageSize = query.pageSize;
    if (query.pageToken) body.$pageToken = query.pageToken;
    if (query.select) body.$select = query.select;
    const raw = await this.core.request<unknown>(
      "POST",
      \`/v1/objects/\${encodeURIComponent(this.apiName)}/search\`,
      body,
    );
    return asPage<O>(raw);
  }

  /** POST /v1/objects/:apiName/aggregate */
  async aggregate(body: AggregateBody): Promise<unknown> {
    return this.core.request<unknown>(
      "POST",
      \`/v1/objects/\${encodeURIComponent(this.apiName)}/aggregate\`,
      body,
    );
  }
}

export interface LinkTraversalOptions {
  pageSize?: number;
  pageToken?: string;
}

function traverseLink<T>(
  core: HttpCore,
  sourceApiName: string,
  linkApiName: string,
  sourcePrimaryKey: string | number,
  opts: LinkTraversalOptions = {},
): Promise<PageResult<T>> {
  const qs = new URLSearchParams();
  if (opts.pageSize != null) qs.set("pageSize", String(opts.pageSize));
  if (opts.pageToken) qs.set("pageToken", opts.pageToken);
  const q = qs.toString();
  return core
    .request<unknown>(
      "GET",
      \`/v1/objects/\${encodeURIComponent(sourceApiName)}/\${encodeURIComponent(String(sourcePrimaryKey))}/links/\${encodeURIComponent(linkApiName)}\${q ? \`?\${q}\` : ""}\`,
    )
    .then((raw) => asPage<T>(raw));
}
`;

function genClient(snapshot: OntologySnapshot): string {
  const objectTypes = sortByApiName(snapshot.objectTypes);
  const linkTypes = sortByApiName(snapshot.linkTypes);
  const actionTypes = sortByApiName(snapshot.actionTypes);
  const byApiName = new Map(objectTypes.map((ot) => [ot.apiName, ot]));

  const lines: string[] = [header(snapshot), ""];
  lines.push(`import type * as T from "./types";`);
  lines.push(CLIENT_RUNTIME.trimEnd());
  lines.push("");
  lines.push(`/** Ontology id baked in at generation time (override via OsdkClientOptions.ontologyId). */`);
  lines.push(`export const DEFAULT_ONTOLOGY_ID = ${JSON.stringify(snapshot.ontology.id)};`);
  lines.push("");
  lines.push(`export class OsdkClient {`);
  lines.push(`  private readonly core: HttpCore;`);
  lines.push(`  private readonly ontologyId: string;`);
  lines.push("");

  // objects
  lines.push(`  /** Typed per-object-type accessors over /v1/objects/:apiName. */`);
  lines.push(`  readonly objects: {`);
  for (const ot of objectTypes) {
    const iface = objectInterfaceName(ot);
    lines.push(`    ${iface}: ObjectSet<T.${iface}, T.${iface}PrimaryKey>;`);
  }
  lines.push(`  };`);
  lines.push("");

  // actions
  lines.push(`  /** Typed action invokers — POST /v1/ontology/:ontologyId/actions/:apiName/apply. */`);
  lines.push(`  readonly actions: {`);
  for (const at of actionTypes) {
    lines.push(`    ${sanitizeIdentifier(at.apiName)}(params: T.${pascalCase(at.apiName)}Parameters): Promise<unknown>;`);
  }
  lines.push(`  };`);
  lines.push("");

  // links
  lines.push(`  /** Link traversal helpers — GET /v1/objects/:src/:pk/links/:linkApiName. */`);
  lines.push(`  readonly links: {`);
  for (const lt of linkTypes) {
    const src = byApiName.get(lt.sourceObjectType);
    const tgt = byApiName.get(lt.targetObjectType);
    const pkType = src ? `T.${objectInterfaceName(src)}PrimaryKey` : "string | number";
    const tgtType = tgt ? `T.${objectInterfaceName(tgt)}` : "Record<string, unknown>";
    lines.push(`    ${sanitizeIdentifier(lt.apiName)}(sourcePrimaryKey: ${pkType}, opts?: LinkTraversalOptions): Promise<PageResult<${tgtType}>>;`);
  }
  lines.push(`  };`);
  lines.push("");

  // constructor
  lines.push(`  constructor(options: OsdkClientOptions) {`);
  lines.push(`    this.core = new HttpCore(options);`);
  lines.push(`    this.ontologyId = options.ontologyId ?? DEFAULT_ONTOLOGY_ID;`);
  lines.push(`    this.objects = {`);
  for (const ot of objectTypes) {
    const iface = objectInterfaceName(ot);
    lines.push(`      ${iface}: new ObjectSet<T.${iface}, T.${iface}PrimaryKey>(this.core, ${JSON.stringify(ot.apiName)}),`);
  }
  lines.push(`    };`);
  lines.push(`    this.actions = {`);
  for (const at of actionTypes) {
    lines.push(`      ${sanitizeIdentifier(at.apiName)}: (params: T.${pascalCase(at.apiName)}Parameters) =>`);
    lines.push(`        this.applyAction(${JSON.stringify(at.apiName)}, params as unknown as Record<string, unknown>),`);
  }
  lines.push(`    };`);
  lines.push(`    this.links = {`);
  for (const lt of linkTypes) {
    const src = byApiName.get(lt.sourceObjectType);
    const tgt = byApiName.get(lt.targetObjectType);
    const pkType = src ? `T.${objectInterfaceName(src)}PrimaryKey` : "string | number";
    const tgtType = tgt ? `T.${objectInterfaceName(tgt)}` : "Record<string, unknown>";
    lines.push(`      ${sanitizeIdentifier(lt.apiName)}: (sourcePrimaryKey: ${pkType}, opts?: LinkTraversalOptions) =>`);
    lines.push(`        traverseLink<${tgtType}>(this.core, ${JSON.stringify(lt.sourceObjectType)}, ${JSON.stringify(lt.apiName)}, sourcePrimaryKey, opts),`);
  }
  lines.push(`    };`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  /** POST /v1/ontology/:ontologyId/actions/:actionApiName/apply */`);
  lines.push(`  private applyAction(actionApiName: string, parameters: Record<string, unknown>): Promise<unknown> {`);
  lines.push("    return this.core.request<unknown>(");
  lines.push("      \"POST\",");
  lines.push("      `/v1/ontology/${encodeURIComponent(this.ontologyId)}/actions/${encodeURIComponent(actionApiName)}/apply`,");
  lines.push(`      { parameters },`);
  lines.push(`    );`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// index.ts
// ---------------------------------------------------------------------------

function genIndex(snapshot: OntologySnapshot): string {
  const o = snapshot.ontology;
  const name = o.displayName ?? o.apiName ?? o.id;
  return [
    header(snapshot),
    `//`,
    `// README`,
    `// ------`,
    `// Typed OSDK for the "${name}" ontology.`,
    `//   Ontology id: ${o.id}`,
    `//   Version:     ${o.version ?? "unversioned"}`,
    `//   Generated:   ${o.generatedAt ?? "unknown"}`,
    `//`,
    `// Usage:`,
    `//   import { OsdkClient } from "./index";`,
    `//   const client = new OsdkClient({ baseUrl: "http://localhost:4000/api" });`,
    `//   const page = await client.objects.<ObjectType>.fetchPage({ pageSize: 25 });`,
    `//   const one  = await client.objects.<ObjectType>.get(primaryKey);`,
    `//   await client.actions.<actionApiName>({ ...parameters });`,
    `//   const linked = await client.links.<linkApiName>(sourcePrimaryKey);`,
    ``,
    `export * from "./types";`,
    `export * from "./client";`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function generateOsdk(snapshot: OntologySnapshot): GeneratedFile[] {
  return [
    { path: "types.ts", content: genTypes(snapshot) },
    { path: "client.ts", content: genClient(snapshot) },
    { path: "index.ts", content: genIndex(snapshot) },
  ];
}
