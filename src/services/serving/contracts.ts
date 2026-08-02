// ---------------------------------------------------------------------------
// Serving-store contracts (OSv2 parity).
//
// Public object reads MUST route through ObjectServingStore; public link
// traversals through LinkServingStore. Durable stores (PostgreSQL, Iceberg,
// changelogs) remain sources of truth for audit/replay/rebuilds and are
// NEVER alternative public query backends. Backend-specific logic
// (OpenSearch client details, ClickHouse SQL) must not leak into routes —
// routes see only these contracts and dependency injection selects the
// implementation (legacy/shadow/indexed) per servingFlags.ts.
//
// Identity invariants:
//   * ObjectDoc identity  = (tenant, ontology, branch, objectType, primaryKey)
//   * Edge identity       = (tenant, ontology, branch, linkType, sourcePk, targetPk)
//   * version monotonically increases per identity; an older version must
//     NEVER overwrite a newer indexed document (idempotent replays only)
//   * deleted=true is a versioned tombstone and hides ALL older versions.
// ---------------------------------------------------------------------------

export interface IsolationScope {
  tenantId: string;
  ontologyId: string;
  branchId: string;
}

export interface VersionedObjectDoc {
  scope: IsolationScope;
  objectType: string;
  primaryKey: string;
  version: number;
  deleted: boolean;
  properties: Record<string, unknown>;
  markings: string[];
  indexedAt?: string;
  datasourceOffsets?: Record<string, string | number>;
}

export interface ObjectSearchArgs {
  scope: IsolationScope;
  objectType: string;
  where?: unknown;        // translated by the backend adapter
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  pageSize?: number;
  pageToken?: string;
  securityFilter?: unknown;
}

export interface ObjectSearchResult {
  docs: VersionedObjectDoc[];
  total?: number;
  nextPageToken?: string;
}

export interface ObjectServingStore {
  get(args: {
    scope: IsolationScope;
    objectType: string;
    primaryKey: string;
    securityFilter?: unknown;
  }): Promise<VersionedObjectDoc | null>;
  search(args: ObjectSearchArgs): Promise<ObjectSearchResult>;
  batchGet(args: {
    scope: IsolationScope;
    objectType: string;
    primaryKeys: string[];
    securityFilter?: unknown;
  }): Promise<VersionedObjectDoc[]>;
  aggregate(args: ObjectSearchArgs & { spec: unknown }): Promise<unknown>;
  /**
   * Read-after-write barrier: resolves once the store has confirmed
   * indexing at least the given version/offset for the scope, or rejects
   * with StoreWatermarkTimeout after `timeoutMs`.
   */
  waitForWatermark(args: {
    scope: IsolationScope;
    resourceType: string;
    minOffset: string | number;
    timeoutMs: number;
  }): Promise<void>;
}

export class StoreWatermarkTimeout extends Error {
  constructor(scope: IsolationScope, resourceType: string, minOffset: string | number) {
    super(
      `serving store watermark for ${resourceType} in ` +
        `${scope.tenantId}/${scope.ontologyId}/${scope.branchId} did not reach ${minOffset}`,
    );
    this.name = "StoreWatermarkTimeout";
  }
}

export interface EdgeIdentity {
  scope: IsolationScope;
  linkType: string;
  sourcePk: string;
  targetPk: string;
}

export interface VersionedEdge {
  identity: EdgeIdentity;
  version: number;
  operation: "ADD" | "REMOVE" | "RETRACT";
  /** deleted=true ⇒ tombstone: hides all older versions of the identity. */
  deleted: boolean;
  linkProps: Record<string, unknown>;
  markings: string[];
  eventId?: string;
}

export interface LinkTraverseArgs {
  scope: IsolationScope;
  linkType: string;
  sourceObjectType: string;
  targetObjectType: string;
  direction: "forward" | "reverse";
  anchorPks: string[];
  userMarkings: ReadonlySet<string>;
  maxRows?: number;
}

export interface LinkTraverseResult {
  targetPks: string[];
  cappedAtMax: boolean;
  securityWithheld: boolean;
}

export interface LinkServingStore {
  /** Single-hop traversal; always authorizes edge + endpoint markings. */
  traverse(args: LinkTraverseArgs): Promise<LinkTraverseResult>;
  /** Active-edge cardinality per anchor. Counts must not leak denied rows. */
  count(args: Omit<LinkTraverseArgs, "maxRows">): Promise<number>;
  waitForWatermark(args: {
    scope: IsolationScope;
    resourceType: string;
    minOffset: string | number;
    timeoutMs: number;
  }): Promise<void>;
}
