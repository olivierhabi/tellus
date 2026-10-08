// ---------------------------------------------------------------------------
// Production wiring for the ObjectSet engine (Phase 9).
//
// Every dep funnels into EXISTING infrastructure:
//   translateWhere  → queryTranslator
//   search          → opensearch client + injectSecurityFilter
//                     (the ONE mandatory-control choke point)
//   mergeOverlay    → writebackOverlay (read-your-writes)
//   traverse        → linkResolverService.searchAround
//   resolveStaticRids → object_instances (migration 138)
//   keywordOf       → propertyResolver
// ---------------------------------------------------------------------------

import { client, injectSecurityFilter } from "../opensearch/client";
import { getIndexName } from "../opensearch/indexLifecycleManager";
import { translateFilter } from "../queryTranslator";
import { resolveProperty } from "../propertyResolver";
import { mergeOverlayIntoSearch, readOverlay } from "../overlay/writebackOverlay";
import { matchesWhere } from "./subscriptionRegistry";
import { getOverlayStore } from "../overlay/getOverlayStore";
import { MAIN_BRANCH_SENTINEL } from "../overlay/overlayStore";
import { query } from "../../db";
import linkTypeModel, { resolveObjectTypeApiName } from "../../models/linkType";
import { searchAround as linkSearchAround } from "../linkResolverService";
import type { ExecutorDeps, OsSearchResponse } from "./objectSetExecutor";
import { ObjectSetExecutionError } from "./objectSetExecutor";
import {
  ObjectSetCompileError,
  type CompilerDeps,
} from "./objectSetCompiler";
import { createReferenceResolver } from "./objectSetStore";
import { deriveMainBranchId } from "../branchContext";
import { deterministicObjectRid } from "../objectIdentity";
import { createHmac } from "node:crypto";
import {
  adjustReadContextTotal,
  composeReadContexts,
  type ResolvedReadContext,
} from "./readContext";
import { embedTextForProperty } from "./embeddingProvider";
import { recordOssV2AuditBestEffort } from "./audit";

export interface RequestSecurity {
  securityFilter: Record<string, unknown> | null | undefined;
  branchId: string | null;
  /** Ontology identifier (uuid) for link-type resolution. */
  ontologyId: string;
  userId: string;
  tenant: string;
  markings: string[];
  cbac: string[];
  organizations: string[];
  markingBypass: boolean;
  requestId?: string | null;
  transactionId?: string | null;
  scenarioRid?: string | null;
}

const MAX_SEARCH_AROUND_PKS = 100_000;

/**
 * OSS v2 ontology-isolation predicate.
 *
 * Object Storage's legacy physical index is keyed only by object-type API
 * name. Until every writer has migrated to ontology-scoped aliases, v2 must
 * therefore bind the logical ontology in the final mandatory-control query.
 * Documents without the stamp fail closed.
 */
export function buildOssV2SecurityFilter(
  ontologyId: string,
  securityFilter: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return {
    bool: {
      must: [
        ...(securityFilter ? [securityFilter] : []),
        { term: { __ontology: ontologyId } },
      ],
    },
  };
}

export async function resolveInterfacePropertyMapping(
  ontologyId: string,
  interfaceApiName: string,
  objectType: string,
): Promise<Record<string, string>> {
  const { rows } = await query(
    `WITH RECURSIVE requested AS (
       SELECT interface_id, parent_interface_id
         FROM interface
        WHERE ontology_id = $1 AND api_name = $2
     ), ancestors AS (
       SELECT interface_id, parent_interface_id FROM requested
       UNION ALL
       SELECT parent.interface_id, parent.parent_interface_id
         FROM interface parent
         JOIN ancestors child
           ON child.parent_interface_id = parent.interface_id
     ), descendants AS (
       SELECT interface_id, parent_interface_id FROM requested
       UNION ALL
       SELECT child.interface_id, child.parent_interface_id
         FROM interface child
         JOIN descendants parent
           ON child.parent_interface_id = parent.interface_id
     ), relevant AS (
       SELECT interface_id FROM ancestors
       UNION
       SELECT interface_id FROM descendants
     )
     SELECT oti.property_mapping
       FROM object_type_interface oti
       JOIN relevant family ON family.interface_id = oti.interface_id
       JOIN object_type ot ON ot.object_type_id = oti.object_type_id
      WHERE ot.ontology_id = $1 AND ot.api_name = $3`,
    [ontologyId, interfaceApiName, objectType],
  );
  if (rows.length === 0) {
    throw new ObjectSetCompileError(
      "InterfaceResolutionUnsupported",
      `No property mapping exists for ${objectType} implementing ${interfaceApiName}.`,
      { interfaceType: interfaceApiName, objectType },
    );
  }
  const mapping = Object.assign(
    {},
    ...rows.map(
      (row) => row.property_mapping as Record<string, string>,
    ),
  ) as Record<string, string>;
  const required = await query(
    `WITH RECURSIVE ancestors AS (
       SELECT interface_id, parent_interface_id
         FROM interface
        WHERE ontology_id = $1 AND api_name = $2
       UNION ALL
       SELECT parent.interface_id, parent.parent_interface_id
         FROM interface parent
         JOIN ancestors child
           ON child.parent_interface_id = parent.interface_id
     )
     SELECT property.api_name
       FROM interface_property property
       JOIN ancestors family ON family.interface_id = property.interface_id
      WHERE property.is_required = true`,
    [ontologyId, interfaceApiName],
  );
  const missing = required.rows
    .map((row) => String(row.api_name))
    .filter((property) => !mapping[property]);
  if (missing.length > 0) {
    throw new ObjectSetCompileError(
      "InterfaceRequiredPropertyNotImplemented",
      "The object type does not implement every required interface property.",
      { interfaceType: interfaceApiName, objectType, properties: missing },
    );
  }
  return mapping;
}

function signMediaReadToken(input: {
  tenant: string;
  ontologyId: string;
  userId: string;
  mediaItemRid: string;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...input,
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  ).toString("base64url");
  const signature = createHmac(
    "sha256",
    process.env.TELLUS_MEDIA_REFERENCE_SIGNING_SECRET ??
      process.env.TELLUS_PAGE_TOKEN_SECRET ??
      "tellus-dev-media-reference-secret",
  )
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function makeProductionExecutorDeps(
  sec: RequestSecurity,
  opts: {
    snapshot: boolean;
    readContexts?: {
      transaction: ResolvedReadContext | null;
      scenario: ResolvedReadContext | null;
    };
  },
): ExecutorDeps {
  const scopedSecurityFilter = buildOssV2SecurityFilter(
    sec.ontologyId,
    sec.securityFilter,
  );
  const contextSecurity = {
    tenant: sec.tenant,
    ontologyId: sec.ontologyId,
    branchId: sec.branchId,
    userId: sec.userId,
    markings: sec.markings,
    cbac: sec.cbac,
    organizations: sec.organizations,
    markingBypass: sec.markingBypass,
  };
  const authorizeProperties = async (
    objectType: string,
    fields: string[],
    usage: "filter" | "order" | "aggregation" | "knn",
  ): Promise<void> => {
    if (sec.markingBypass || fields.length === 0) return;
    const requested = [...new Set(fields)].filter(
      (field) => !field.startsWith("__"),
    );
    if (requested.length === 0) return;
    const { rows } = await query(
      `SELECT p.api_name,
              COALESCE(p.marking_required, ARRAY[]::text[]) AS required
         FROM property p
         JOIN object_type ot ON ot.object_type_id = p.object_type_id
        WHERE ot.ontology_id = $1
          AND ot.api_name = $2
          AND p.api_name = ANY($3::text[])`,
      [sec.ontologyId, objectType, requested],
    );
    const granted = new Set(sec.markings);
    const denied = rows.find((row) =>
      (row.required as string[]).some((marking) => !granted.has(marking)),
    );
    if (!denied) return;
    recordOssV2AuditBestEffort({
      eventType: "restricted_property_attempt",
      outcome: "denied",
      tenantId: sec.tenant,
      ontologyId: sec.ontologyId,
      userId: sec.userId,
      branchId: sec.branchId,
      transactionId: sec.transactionId ?? null,
      scenarioRid: sec.scenarioRid ?? null,
      requestId: sec.requestId ?? null,
      parameters: {
        reason: "restricted_property",
        objectType,
        property: String(denied.api_name),
        usage,
      },
    });
    throw new ObjectSetExecutionError(
      "PropertySecurityDenied",
      `Access to property '${String(denied.api_name)}' is denied.`,
      { objectType, property: denied.api_name, usage },
      403,
    );
  };
  const applyContextTraversalEdits = async (input: {
    linkType: string;
    direction: "forward" | "reverse";
    fromObjectType: string;
    anchorWhere: unknown;
    baseTargetPks: string[];
  }): Promise<string[]> => {
    if (!opts.readContexts?.scenario && !opts.readContexts?.transaction) {
      return input.baseTargetPks;
    }
    const targets = new Set(input.baseTargetPks);
    const contexts = [
      opts.readContexts.scenario,
      opts.readContexts.transaction,
    ].filter((value): value is ResolvedReadContext => value !== null);
    for (const context of contexts) {
      const anchorColumn =
        input.direction === "forward"
          ? "source_primary_key"
          : "target_primary_key";
      const targetColumn =
        input.direction === "forward"
          ? "target_primary_key"
          : "source_primary_key";
      const edits = await query(
        `SELECT ${anchorColumn} AS anchor_primary_key,
                ${targetColumn} AS target_primary_key, operation
           FROM ontology_read_context_link_edit
          WHERE context_id = $1
            AND context_version <= $2
            AND link_type_api_name = $3
          ORDER BY edit_sequence`,
        [context.id, context.version, input.linkType],
      );
      for (const edit of edits.rows) {
        const anchorPk = String(edit.anchor_primary_key);
        const where = input.anchorWhere
          ? {
              type: "and",
              value: [
                input.anchorWhere,
                { type: "eq", field: "__pk", value: anchorPk },
              ],
            }
          : { type: "eq", field: "__pk", value: anchorPk };
        const translated = await translateFilter(
          where,
          input.fromObjectType,
        );
        const response = await client.search({
          index: getIndexName(input.fromObjectType),
          body: injectSecurityFilter(
            { size: 1, query: translated },
            scopedSecurityFilter,
            sec.branchId,
          ),
        });
        const body = response.body as unknown as {
          hits?: {
            hits?: Array<{
              _id: string;
              _source?: Record<string, unknown>;
            }>;
          };
        };
        const base = (body.hits?.hits ?? []).map((hit) => ({
          ...(hit._source ?? {}),
          __pk: hit._source?.__pk ?? hit._id,
          __primaryKey: hit._source?.__pk ?? hit._id,
          __apiName: input.fromObjectType,
        }));
        const composed = await composeReadContexts({
          objectType: input.fromObjectType,
          hits: base,
          where,
          contexts: opts.readContexts,
          security: contextSecurity,
        });
        if (composed.length === 0) continue;
        const targetPk = String(edit.target_primary_key);
        if (edit.operation === "add") targets.add(targetPk);
        else targets.delete(targetPk);
      }
    }
    return [...targets].sort();
  };
  // The real traversal implementation, hoisted out of the deps object so the
  // exported `traverse` can route it through single-flight coalescing (helper
  // at end of file): concurrent identical hops must execute ONCE.
  const traverseImpl = async ({
    fromObjectType,
    link,
    anchorWhere,
    interfaceLink,
  }: TraverseArgs): Promise<TraverseResult | TraverseResult[]> => {
    if (interfaceLink) {
      const { rows } = await query(
        `SELECT DISTINCT lt.api_name
           FROM interface_link_constraint ilc
           JOIN object_type source_ot
             ON source_ot.ontology_id = ilc.ontology_id
            AND source_ot.api_name = $3
           JOIN object_type_interface source_impl
             ON source_impl.object_type_id = source_ot.object_type_id
            AND source_impl.interface_id = ilc.interface_id
           JOIN link_type lt
             ON lt.ontology_id = ilc.ontology_id
            AND lt.source_object_type = source_ot.object_type_id
            AND lt.cardinality = ilc.cardinality
          WHERE ilc.ontology_id = $1
            AND ilc.api_name = $2
            AND ilc.status = 'active'
            AND (
              (
                ilc.target_object_type_id IS NOT NULL
                AND lt.target_object_type = ilc.target_object_type_id
              )
              OR (
                ilc.target_interface_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                    FROM object_type_interface target_impl
                   WHERE target_impl.object_type_id =
                         lt.target_object_type
                     AND target_impl.interface_id =
                         ilc.target_interface_id
                )
              )
            )
          ORDER BY lt.api_name`,
        [sec.ontologyId, link, fromObjectType],
      );
      if (rows.length === 0) {
        throw new ObjectSetExecutionError(
          "InterfaceLinkTypeNotFound",
          `No concrete link type implements interface link: ${link}`,
          { interfaceLink: link, fromObjectType },
          404,
        );
      }
      const grouped = new Map<string, Set<string>>();
      for (const row of rows) {
        const concrete = await linkTypeModel.getByApiName(
          sec.ontologyId,
          String(row.api_name),
        );
        if (!concrete) {
          throw new ObjectSetExecutionError(
            "InterfaceLinkTypeNotFound",
            `Concrete link type disappeared while resolving: ${String(row.api_name)}`,
            { interfaceLink: link, concreteLinkType: row.api_name },
            404,
          );
        }
        const targetType = await resolveObjectTypeApiName(
          concrete.target_object_type,
        );
        let pageToken: string | null = null;
        const pks = grouped.get(targetType) ?? new Set<string>();
        const { maybeServingEdgeResolver } = await import("../serving/linkServingStore");
        const weeder = await maybeServingEdgeResolver({
          linkType: concrete,
          direction: "forward",
          branchId: sec.branchId,
          userMarkings: new Set(sec.markings),
          tenantId: sec.tenant,
          capability: "oss.traverse",
        });
        do {
          const response = await linkSearchAround(
            concrete,
            "forward",
            {
              // See the non-interface branch below: `anchorWhere` is a query DSL,
              // `sourceFilter` is a legacy flat equality map, and a bare PK anchor
              // lets us skip the source-side index lookup.
              ...(anchorWhere ? { sourceWhere: anchorWhere as Record<string, unknown> } : {}),
              ...(anchorPrimaryKeys(anchorWhere)
                ? { sourcePks: anchorPrimaryKeys(anchorWhere)! }
                : {}),
              pageSize: 1000,
              pageToken: pageToken ?? undefined,
              edgeResolver: weeder,
            },
            scopedSecurityFilter,
            sec.branchId,
          );
          for (const object of response.linkedObjects) {
            const row = object as Record<string, unknown>;
            // See the non-interface branch: read both PK spellings.
            const pk = row.__primaryKey ?? row.__pk;
            if (typeof pk === "string") pks.add(String(pk));
          }
          pageToken = response.nextPageToken ?? null;
        } while (pageToken && pks.size < MAX_SEARCH_AROUND_PKS);
        grouped.set(
          targetType,
          new Set(
            await applyContextTraversalEdits({
              linkType: concrete.api_name,
              direction: "forward",
              fromObjectType,
              anchorWhere,
              baseTargetPks: [...pks],
            }),
          ),
        );
      }
      return [...grouped.entries()].map(([targetObjectType, pks]) => ({
        targetObjectType,
        targetPks: [...pks],
      }));
    }
    const lt = await linkTypeModel
      .getByApiName(sec.ontologyId, link)
      .catch(() => null);
    if (!lt) {
      throw new ObjectSetExecutionError(
        "LinkTypeNotFound",
        `Link type not found: ${link}`,
        { linkType: link },
        404,
      );
    }
    // Direction: hop source must match the plan's object type.
    const sourceApi = await resolveObjectTypeApiName(lt.source_object_type).catch(() => null);
    const direction =
      sourceApi === fromObjectType ? ("forward" as const) : ("reverse" as const);
    const targetId =
      direction === "forward" ? lt.target_object_type : lt.source_object_type;
    const targetType = await resolveObjectTypeApiName(targetId).catch(() => null);
    if (!targetType) {
      throw new ObjectSetExecutionError(
        "LinkTypeNotFound",
        `Could not resolve target of link type: ${link}`,
        { linkType: link },
        404,
      );
    }
    const targetPks: string[] = [];
    let pageToken: string | null = null;
    const { maybeServingEdgeResolver } = await import("../serving/linkServingStore");
    const weeder = await maybeServingEdgeResolver({
      linkType: lt,
      direction,
      branchId: sec.branchId,
      userMarkings: new Set(sec.markings),
      tenantId: sec.tenant,
      capability: "oss.traverse",
    });
    do {
      const r = await linkSearchAround(
        lt,
        direction,
        {
          // `anchorWhere` arrives from objectSetExecutor as a canonical ontology-search
          // where DSL (`{type:"in",field:"__pk",value:[…]}`), NOT the legacy flat
          // equality map `sourceFilter` expects — passing it there built `term`
          // clauses keyed on type/field/value and silently matched NOTHING.
          // `sourceWhere` is the DSL-aware field, translated against the search
          // side's object type inside linkResolverService. When the anchor is a
          // bare PK predicate we also hand over the keys so the source-side
          // index lookup is skipped entirely.
          ...(anchorWhere ? { sourceWhere: anchorWhere as Record<string, unknown> } : {}),
          ...(anchorPrimaryKeys(anchorWhere)
            ? { sourcePks: anchorPrimaryKeys(anchorWhere)! }
            : {}),
          pageSize: 1000,
          pageToken: pageToken ?? undefined,
          edgeResolver: weeder,
        },
        scopedSecurityFilter,
        sec.branchId,
      );
      for (const o of r.linkedObjects) {
        const row = o as Record<string, unknown>;
        // Read BOTH PK spellings: `linkSearchAround` emits `__pk`, while the legacy
        // /objects/:type/:pk/searchAround route additionally normalizes `__primaryKey`.
        // Reading only one made a 48-row hop resolve to 0 pks.
        const pk = row.__primaryKey ?? row.__pk;
        if (typeof pk === "string") targetPks.push(String(pk));
      }
      pageToken = r.nextPageToken ?? null;
    } while (pageToken && targetPks.length < MAX_SEARCH_AROUND_PKS);
    return {
      targetObjectType: targetType,
      targetPks: await applyContextTraversalEdits({
        linkType: lt.api_name,
        direction,
        fromObjectType,
        anchorWhere,
        baseTargetPks: targetPks,
      }),
    };
  };

  return {
    authorizeProperties,
    keywordOf: async (objectType, field) => {
      await authorizeProperties(objectType, [field], "aggregation");
      if (field === "__pk" || field === "__rid") return field;
      const meta = await resolveProperty(objectType, field);
      return meta.opensearchKeywordField;
    },

    translateWhere: async (objectType, where) => {
      const fields = new Set<string>();
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (typeof record.field === "string") fields.add(record.field);
        Object.values(record).forEach(visit);
      };
      visit(where);
      await authorizeProperties(objectType, [...fields], "filter");
      return translateFilter(
        where,
        objectType,
      ) as Promise<Record<string, unknown>>;
    },

    resolveKnnVector: async (objectType, field, knnQuery) => {
      await authorizeProperties(objectType, [field], "knn");
      const property = await query(
        `SELECT p.base_type, cfg.dimensions
           FROM property p
           JOIN object_type ot ON ot.object_type_id = p.object_type_id
           LEFT JOIN ontology_embedding_config cfg
             ON cfg.tenant_id = $1
            AND cfg.ontology_id = ot.ontology_id
            AND cfg.object_type_api_name = ot.api_name
            AND cfg.property_api_name = p.api_name
            AND cfg.enabled = true
          WHERE ot.ontology_id = $2 AND ot.api_name = $3 AND p.api_name = $4`,
        [sec.tenant, sec.ontologyId, objectType, field],
      );
      if (property.rows.length === 0) {
        throw new ObjectSetExecutionError(
          "PropertiesNotFound",
          "Nearest-neighbor property was not found.",
          { objectType, property: field },
          404,
        );
      }
      const row = property.rows[0] as {
        base_type: string;
        dimensions: number | null;
      };
      const vectorCapable =
        row.dimensions != null ||
        row.base_type === "vector" ||
        row.base_type === "embedding" ||
        row.base_type.endsWith("_vector");
      if (!vectorCapable) {
        throw new ObjectSetExecutionError(
          "InvalidNearestNeighborsProperty",
          "Nearest-neighbor queries require a vector property.",
          { objectType, property: field, baseType: row.base_type },
          400,
        );
      }
      const vector =
        knnQuery.type === "text"
          ? await embedTextForProperty({
              tenantId: sec.tenant,
              ontologyId: sec.ontologyId,
              objectType,
              property: field,
              text: knnQuery.value,
            })
          : knnQuery.value;
      if (row.dimensions != null && vector.length !== Number(row.dimensions)) {
        throw new ObjectSetExecutionError(
          "NearestNeighborsDimensionMismatch",
          "Query vector dimension does not match the configured property.",
          { expected: Number(row.dimensions), actual: vector.length },
          400,
        );
      }
      return vector;
    },

    search: async (objectType, body, options) => {
      // Single choke point: security + branch injected exactly once.
      const finalBody = injectSecurityFilter(
        body,
        scopedSecurityFilter,
        sec.branchId,
      );
      let resp: { body: Record<string, unknown> };
      try {
        resp = options?.pitId
          ? await client.search({
              body: {
                ...finalBody,
                pit: { id: options.pitId, keep_alive: "5m" },
              },
            })
          : await client.search({
              index: getIndexName(objectType),
              body: finalBody,
            });
      } catch (err: unknown) {
        const e = err as { statusCode?: number; meta?: { statusCode?: number } };
        if (e?.statusCode === 404 || e?.meta?.statusCode === 404) {
          if (options?.pitId) {
            throw new ObjectSetExecutionError(
              "ConsistentSnapshotError",
              "The consistent snapshot expired or is no longer available.",
              { objectType },
              409,
            );
          }
          return { hits: [], total: 0 };
        }
        throw new ObjectSetExecutionError(
          "SearchBackendUnavailable",
          "Object Storage is temporarily unavailable.",
          { objectType, retryable: true },
          503,
        );
      }
      const b = resp.body as {
        hits?: {
          hits?: Array<{
            _id: string;
            _source?: Record<string, unknown>;
            sort?: unknown[];
            _sort?: unknown[];
            _score?: number | null;
          }>;
          total?: { value?: number } | number;
        };
        aggregations?: Record<string, unknown>;
      };
      // OpenSearch's wire field is `sort`; the executor dependency uses
      // `_sort` to keep transport metadata distinct from object properties.
      // Normalize here or page tokens carry no cursor and replay page one.
      const hits: OsSearchResponse["hits"] = (b.hits?.hits ?? []).map(
        (hit) => ({
          _id: hit._id,
          _source: hit._source ?? {},
          _sort: hit.sort ?? hit._sort,
          _score: hit._score,
        }),
      );
      // The object_instances RID is the canonical persisted identity. Older
      // OpenSearch documents predate migration 138 and therefore either have
      // no __rid or carry the deterministic reindex fallback. Hydrate the
      // persisted RID in one bounded page query so v2 reads remain stable
      // before a full historical reindex completes.
      const primaryKeys = hits
        .map((hit) => String(hit._source?.__pk ?? hit._id ?? ""))
        .filter(Boolean);
      if (primaryKeys.length > 0) {
        const branchId = sec.branchId ?? deriveMainBranchId(sec.ontologyId);
        const persisted = await query(
          `SELECT DISTINCT ON (primary_key) primary_key, rid
             FROM object_instances
            WHERE ontology_id = $1
              AND branch_id = $2::uuid
              AND object_type_api_name = $3
              AND primary_key = ANY($4::text[])
              AND rid IS NOT NULL
            ORDER BY primary_key, last_modified_at DESC`,
          [sec.ontologyId, branchId, objectType, primaryKeys],
        );
        const ridByPrimaryKey = new Map(
          (persisted.rows as Array<{ primary_key: string; rid: string }>).map(
            (row) => [row.primary_key, row.rid],
          ),
        );
        const locatorRows: Array<{
          rid: string;
          primaryKey: string;
        }> = [];
        for (const hit of hits) {
          const primaryKey = String(hit._source?.__pk ?? hit._id ?? "");
          const rid =
            ridByPrimaryKey.get(primaryKey) ??
            String(
              hit._source?.__rid ??
                deterministicObjectRid(
                  sec.ontologyId,
                  objectType,
                  primaryKey,
                ),
            );
          hit._source = { ...hit._source, __rid: rid };
          locatorRows.push({ rid, primaryKey });
        }
        if (locatorRows.length > 0) {
          await query(
            `INSERT INTO object_rid_lookup
               (rid, ontology_id, object_type_api_name, primary_key)
             SELECT locator.rid, $1::uuid, $2, locator.primary_key
               FROM unnest($3::text[], $4::text[])
                    AS locator(rid, primary_key)
             ON CONFLICT DO NOTHING`,
            [
              sec.ontologyId,
              objectType,
              locatorRows.map((row) => row.rid),
              locatorRows.map((row) => row.primaryKey),
            ],
          );
        }
      }
      const totalRaw = b.hits?.total;
      return {
        hits,
        total:
          typeof totalRaw === "object" ? totalRaw?.value ?? 0 : totalRaw ?? 0,
        aggregations: b.aggregations,
      };
    },

    secureProperties: async (objectType, hits) => {
      if (hits.length === 0 || sec.markingBypass) return hits;
      const primaryKeys = hits
        .map((hit) => String(hit.__primaryKey ?? hit.__pk ?? ""))
        .filter(Boolean);
      const [columns, cells] = await Promise.all([
        query(
          `SELECT p.api_name, COALESCE(p.marking_required, ARRAY[]::text[]) AS markings
             FROM property p
             JOIN object_type ot ON ot.object_type_id = p.object_type_id
            WHERE ot.ontology_id = $1
              AND ot.api_name = $2
              AND COALESCE(cardinality(p.marking_required), 0) > 0`,
          [sec.ontologyId, objectType],
        ),
        primaryKeys.length === 0
          ? Promise.resolve({ rows: [] })
          : query(
              `SELECT primary_key, property_api_name, markings
                 FROM object_cell_marking
                WHERE object_type_api_name = $1
                  AND primary_key = ANY($2::text[])
                  AND (ontology_id IS NULL OR ontology_id = $3::uuid)`,
              [objectType, primaryKeys, sec.ontologyId],
            ),
      ]);
      const columnMarks = new Map<string, string[]>(
        (columns.rows as Array<{ api_name: string; markings: string[] }>).map(
          (row) => [row.api_name, row.markings ?? []],
        ),
      );
      const cellMarks = new Map<string, Map<string, string[]>>();
      for (const row of cells.rows as Array<{
        primary_key: string;
        property_api_name: string;
        markings: string[];
      }>) {
        const byProperty =
          cellMarks.get(row.primary_key) ?? new Map<string, string[]>();
        byProperty.set(row.property_api_name, row.markings ?? []);
        cellMarks.set(row.primary_key, byProperty);
      }
      const granted = new Set(sec.markings);
      const restrictedProperties = new Set<string>();
      const secured = hits.map((hit) => {
        const out = { ...hit };
        const primaryKey = String(hit.__primaryKey ?? hit.__pk ?? "");
        const properties = new Set<string>([
          ...columnMarks.keys(),
          ...(cellMarks.get(primaryKey)?.keys() ?? []),
        ]);
        const descriptors: Record<string, { conjunctive: string[] }> = {};
        for (const property of properties) {
          const required = [
            ...new Set([
              ...(columnMarks.get(property) ?? []),
              ...(cellMarks.get(primaryKey)?.get(property) ?? []),
            ]),
          ].sort();
          if (required.length === 0) continue;
          if (!required.every((marking) => granted.has(marking))) {
            delete out[property];
            restrictedProperties.add(property);
            continue;
          }
          if (property in out) {
            descriptors[property] = { conjunctive: required };
          }
        }
        if (Object.keys(descriptors).length > 0) {
          out.__propertySecurity = descriptors;
        }
        return out;
      });
      if (restrictedProperties.size > 0) {
        recordOssV2AuditBestEffort({
          eventType: "restricted_property_attempt",
          tenantId: sec.tenant,
          ontologyId: sec.ontologyId,
          userId: sec.userId,
          branchId: sec.branchId,
          transactionId: sec.transactionId,
          scenarioRid: sec.scenarioRid,
          requestId: sec.requestId,
          outcome: "denied",
          parameters: {
            objectType,
            propertyCount: restrictedProperties.size,
          },
        });
      }
      return secured;
    },

    signMediaReferences: async (objectType, hits) => {
      const result = await query(
        `SELECT p.api_name
           FROM property p
           JOIN object_type ot ON ot.object_type_id = p.object_type_id
          WHERE ot.ontology_id = $1
            AND ot.api_name = $2
            AND p.base_type = 'media_reference'`,
        [sec.ontologyId, objectType],
      );
      const properties = result.rows.map((row) => String(row.api_name));
      if (properties.length === 0) return hits;
      return hits.map((hit) => {
        const out = { ...hit };
        for (const property of properties) {
          const value = out[property] as
            | {
                mimeType?: string;
                reference?: {
                  type?: string;
                  mediaSetViewItem?: {
                    mediaItemRid?: string;
                    token?: string;
                    [key: string]: unknown;
                  };
                };
              }
            | undefined;
          const item = value?.reference?.mediaSetViewItem;
          if (
            value?.reference?.type !== "mediaSetViewItem" ||
            !item?.mediaItemRid
          ) {
            continue;
          }
          out[property] = {
            ...value,
            reference: {
              ...value.reference,
              mediaSetViewItem: {
                ...item,
                token: signMediaReadToken({
                  tenant: sec.tenant,
                  ontologyId: sec.ontologyId,
                  userId: sec.userId,
                  mediaItemRid: item.mediaItemRid,
                }),
              },
            },
          };
        }
        return out;
      });
    },

    ...(opts.readContexts?.transaction || opts.readContexts?.scenario
      ? {
          composeReadContext: (
            objectType: string,
            hits: Array<Record<string, unknown>>,
            where: unknown,
            versions: {
              transactionVersion: number | null;
              scenarioVersion: number | null;
            },
          ) =>
            composeReadContexts({
              objectType,
              hits,
              where,
              contexts: opts.readContexts!,
              versions,
              security: {
                tenant: sec.tenant,
                ontologyId: sec.ontologyId,
                branchId: sec.branchId,
                userId: sec.userId,
                markings: sec.markings,
                cbac: sec.cbac,
                organizations: sec.organizations,
                markingBypass: sec.markingBypass,
              },
            }),
          adjustReadContextTotal: (
            objectType: string,
            baseTotal: number,
            where: unknown,
            versions: {
              transactionVersion: number | null;
              scenarioVersion: number | null;
            },
          ) =>
            adjustReadContextTotal({
              objectType,
              baseTotal,
              where,
              contexts: opts.readContexts!,
              versions,
              security: {
                tenant: sec.tenant,
                ontologyId: sec.ontologyId,
                branchId: sec.branchId,
                userId: sec.userId,
                markings: sec.markings,
                cbac: sec.cbac,
                organizations: sec.organizations,
                markingBypass: sec.markingBypass,
              },
            }),
        }
      : {}),

    assertSnapshotReady: async (objectTypes) => {
      const store = await getOverlayStore();
      const branchSlot = sec.branchId ?? MAIN_BRANCH_SENTINEL;
      for (const objectType of objectTypes) {
        const scanned = await store.scan(objectType);
        const latest = new Map<string, (typeof scanned)[number]>();
        for (const record of scanned) {
          if (record.branchId !== branchSlot) continue;
          const previous = latest.get(record.primaryKey);
          if (!previous || record.version > previous.version) {
            latest.set(record.primaryKey, record);
          }
        }
        const records = [...latest.values()];
        for (let offset = 0; offset < records.length; offset += 500) {
          const batch = records.slice(offset, offset + 500);
          const { body } = await client.mget({
            index: getIndexName(objectType),
            body: { ids: batch.map((record) => record.primaryKey) },
          });
          const docs = (body as {
            docs?: Array<{
              _id: string;
              found: boolean;
              _source?: Record<string, unknown>;
            }>;
          }).docs ?? [];
          const byId = new Map(docs.map((doc) => [doc._id, doc]));
          const lagging = batch.filter((record) => {
            const indexed = byId.get(record.primaryKey);
            if (record.deleted) return indexed?.found === true;
            const indexedVersion = Number(indexed?._source?.__version ?? 0);
            return !indexed?.found || indexedVersion < record.version;
          });
          if (lagging.length > 0) {
            throw new ObjectSetExecutionError(
              "ConsistentSnapshotError",
              "Recent writeback edits have not reached Object Storage yet.",
              {
                objectType,
                pendingObjectCount: lagging.length,
              },
              409,
            );
          }
        }
      }
    },

    createPointInTime: async (objectTypes) => {
      const opened: Record<string, string> = {};
      try {
        for (const objectType of objectTypes) {
          const { body } = await client.createPit({
            index: [getIndexName(objectType)],
            keep_alive: "5m",
            allow_partial_pit_creation: false,
          });
          const pitId = (body as { pit_id?: string }).pit_id;
          if (!pitId) {
            throw new Error(`OpenSearch returned no PIT id for ${objectType}`);
          }
          opened[objectType] = pitId;
        }
        return opened;
      } catch (cause) {
        if (Object.keys(opened).length > 0) {
          await client
            .deletePit({ body: { pit_id: Object.values(opened) } })
            .catch(() => undefined);
        }
        throw new ObjectSetExecutionError(
          "ConsistentSnapshotError",
          "Could not create a consistent Object Storage snapshot.",
          {
            cause:
              cause instanceof Error ? cause.message : "unknown OpenSearch error",
          },
          409,
        );
      }
    },

    closePointInTime: async (pitIds) => {
      const ids = Object.values(pitIds);
      if (ids.length === 0) return;
      await client.deletePit({ body: { pit_id: ids } });
    },

    // Read-your-writes for non-snapshot reads. Snapshot reads bypass
    // this merge after the preflight and read only from their PIT.
    mergeOverlay: async (objectType, hits, where) => {
      try {
        const store = await getOverlayStore();
        const merged = await mergeOverlayIntoSearch({
          objectType,
          hits: hits as Array<Record<string, unknown>>,
          // NEW objects (not yet in the serving index) must be injected
          // from the overlay, not just merged over existing hits. The
          // membership predicate is the same in-memory where-DSL matcher
          // the change-subscription registry uses.
          filter: (doc) => matchesWhere(doc, where),
          store,
          branchId: sec.branchId,
        });
        return merged as unknown as Array<Record<string, unknown>>;
      } catch (err) {
        return hits; // default reads: documented eventual consistency
      }
    },

    traverse: (args: TraverseArgs) => singleFlightTraverse(sec, args, traverseImpl),

    resolveStaticRids: async (rids) => {
      const { rows } = await query(
        `SELECT DISTINCT ON (rid) rid, object_type_api_name, primary_key
           FROM (
             SELECT rid, object_type_api_name, primary_key, 0 AS priority
               FROM object_instances
              WHERE ontology_id = $2
                AND rid = ANY($1::text[])
             UNION ALL
             SELECT rid, object_type_api_name, primary_key, 1 AS priority
               FROM object_rid_lookup
              WHERE ontology_id = $2
                AND rid = ANY($1::text[])
           ) located
          ORDER BY rid, priority`,
        [rids, sec.ontologyId],
      );
      return (rows as Array<{
        rid: string;
        object_type_api_name: string;
        primary_key: string;
      }>).map((r) => ({
        rid: r.rid,
        objectType: r.object_type_api_name,
        primaryKey: r.primary_key,
      }));
    },

    getSelectionMetadata: async (objectType) => {
      const { rows } = await query(
        `SELECT ot.primary_key_property_id,
                ot.title_property_id,
                p.property_id,
                p.api_name,
                p.base_type,
                p.struct_schema,
                p.reducer_config,
                p.struct_main_value_field
           FROM object_type ot
           LEFT JOIN property p ON p.object_type_id = ot.object_type_id
          WHERE ot.ontology_id = $1
            AND ot.api_name = $2
          ORDER BY p.ordinal, p.api_name`,
        [sec.ontologyId, objectType],
      );
      if (rows.length === 0) {
        throw new ObjectSetExecutionError(
          "ObjectTypeNotFound",
          `Object type not found: ${objectType}`,
          { objectType },
          404,
        );
      }
      const first = rows[0] as {
        primary_key_property_id: string | null;
        title_property_id: string | null;
      };
      let primaryKeyPropertyApiName: string | null = null;
      let titlePropertyApiName: string | null = null;
      const properties: Record<
        string,
        {
          baseType: string;
          structSchema?: Array<{ name: string; type?: string }> | null;
          reducerConfig?: { type?: string } | null;
          structMainValueField?: string | null;
        }
      > = {};
      for (const row of rows as Array<{
        property_id: string | null;
        api_name: string | null;
        base_type: string | null;
        struct_schema: Array<{ name: string; type?: string }> | null;
        reducer_config: { type?: string } | null;
        struct_main_value_field: string | null;
      }>) {
        if (!row.property_id || !row.api_name || !row.base_type) continue;
        properties[row.api_name] = {
          baseType: row.base_type,
          structSchema: row.struct_schema,
          reducerConfig: row.reducer_config,
          structMainValueField: row.struct_main_value_field,
        };
        if (row.property_id === first.primary_key_property_id) {
          primaryKeyPropertyApiName = row.api_name;
        }
        if (row.property_id === first.title_property_id) {
          titlePropertyApiName = row.api_name;
        }
      }
      return {
        primaryKeyPropertyApiName,
        titlePropertyApiName,
        properties,
      };
    },
  };
}

export function makeProductionCompilerDeps(opts: {
  tenant: string;
  ontologyRid: string;
  branchRid: string | null;
  userId?: string;
}): CompilerDeps {
  return {
    resolveObjectType: async (objectTypeApiName) => {
      const result = await query(
        `SELECT 1
           FROM object_type
          WHERE ontology_id = $1 AND api_name = $2
          LIMIT 1`,
        [opts.ontologyRid, objectTypeApiName],
      );
      return result.rows.length > 0;
    },
    resolveReference: createReferenceResolver({
      tenant: opts.tenant,
      ontologyRid: opts.ontologyRid,
      branchRid: opts.branchRid,
      userId: opts.userId,
    }),
    resolveInterfaceImplementations: async (interfaceApiName) => {
      const { rows } = await query(
        `WITH RECURSIVE interface_family AS (
           SELECT interface_id
             FROM interface
            WHERE ontology_id = $1 AND api_name = $2
           UNION ALL
           SELECT child.interface_id
             FROM interface child
             JOIN interface_family parent
               ON child.parent_interface_id = parent.interface_id
         )
         SELECT DISTINCT ot.api_name
           FROM object_type_interface oti
           JOIN interface_family family
             ON family.interface_id = oti.interface_id
           JOIN object_type ot ON ot.object_type_id = oti.object_type_id
          ORDER BY ot.api_name`,
        [opts.ontologyRid, interfaceApiName],
      );
      return (rows as Array<{ api_name: string }>).map((r) => r.api_name);
    },
    translateInterfaceWhere: async (iface, objectType, where) => {
      const mapping = await resolveInterfacePropertyMapping(
        opts.ontologyRid,
        iface,
        objectType,
      );
      const rewrite = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(rewrite);
        if (!node || typeof node !== "object") return node;
        const record = node as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
          if (key === "field" && typeof value === "string") {
            const local = mapping[value];
            if (!local) {
              throw new ObjectSetCompileError(
                "PropertyNotFound",
                `Interface property ${iface}.${value} has no implementation on ${objectType}.`,
                {
                  interfaceType: iface,
                  interfaceProperty: value,
                  objectType,
                },
              );
            }
            out[key] = local;
          } else {
            out[key] = rewrite(value);
          }
        }
        return out;
      };
      return rewrite(where);
    },
  };
}

/** Read overlay helper re-exported for snapshot route paths. */
export { readOverlay };

// ---------------------------------------------------------------------------
// Single-flight traversal coalescing
// ---------------------------------------------------------------------------
//
// A Workshop page with N Search-Around widgets compiles to N object-set
// expressions that share a traversal PREFIX. Measured on the RSSB Provider
// Profile page (2026-10-03): 10 concurrent `loadObjects` requests recomputed
// the provider->claims hop SEVEN times, and 5 of those 10 requests were exact
// duplicates of another. Each hop costs an OpenSearch source query plus an
// edge resolution plus a target fetch, so that redundancy dominated wall
// clock (~3s to paint one Pivot Table).
//
// This is CONCURRENT-ONLY coalescing (single flight): the map entry is deleted
// the instant the promise settles, so nothing is ever served from a cache
// afterwards. There is therefore NO staleness window — a caller arriving after
// completion always re-executes, and the only work suppressed is a duplicate
// of an identical IN-FLIGHT request. Read-your-writes after an Action is
// unaffected, and a rejection propagates to every sharer exactly as each would
// have failed independently.
//
// The key carries the full security scope (ontology, tenant, branch, user,
// markings, cbac, organizations, markingBypass) so a result can never be
// shared across security contexts.

// Mirrors `ExecutorDeps["traverse"]` exactly — the wrapper must not narrow
// or widen the contract the executor depends on.
interface TraverseArgs {
  fromObjectType: string;
  link: string;
  anchorWhere: unknown;
  interfaceLink?: boolean | undefined;
}

interface TraverseResult {
  targetObjectType: string;
  targetPks: string[];
}

const traverseInFlight = new Map<
  string,
  Promise<TraverseResult | TraverseResult[]>
>();

/**
 * Cross-request hop cache TTL. `0` disables the cache entirely (single-flight
 * still applies).
 *
 * Why a TTL is acceptable here: `searchAround` is ALREADY eventually
 * consistent — `linkResolverService` explicitly returns the index answer on a
 * merge failure ("default reads: documented eventual consistency"). A
 * sub-second cache therefore weakens no guarantee the platform makes, and it
 * is what lets a page-load BURST (a Workshop page fires every widget's
 * traversal at once, and deep chains re-request the same shared prefix)
 * collapse onto one execution.
 *
 * Kept short deliberately. If this is ever raised to a user-visible window,
 * it MUST be paired with explicit invalidation from the edit-apply path — a
 * TTL alone is not an invalidation strategy for a read path.
 */
function traversalCacheTtlMs(): number {
  const raw = process.env.OSS_TRAVERSAL_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === "") return 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function traversalCacheMax(): number {
  const raw = process.env.OSS_TRAVERSAL_CACHE_MAX;
  if (raw === undefined || raw.trim() === "") return 500;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

interface TraverseCacheEntry {
  value: TraverseResult | TraverseResult[];
  expiresAt: number;
}

const traverseCache = new Map<string, TraverseCacheEntry>();

function traverseKey(sec: RequestSecurity, a: TraverseArgs): string {
  return JSON.stringify([
    sec.ontologyId,
    sec.tenant,
    sec.branchId ?? null,
    sec.userId,
    [...sec.markings].sort(),
    [...sec.cbac].sort(),
    [...sec.organizations].sort(),
    sec.markingBypass,
    a.fromObjectType,
    a.link,
    a.interfaceLink ?? null,
    a.anchorWhere ?? null,
  ]);
}

function singleFlightTraverse(
  sec: RequestSecurity,
  args: TraverseArgs,
  run: (a: TraverseArgs) => Promise<TraverseResult | TraverseResult[]>,
): Promise<TraverseResult | TraverseResult[]> {
  const key = traverseKey(sec, args);
  const ttl = traversalCacheTtlMs();

  if (ttl > 0) {
    const hit = traverseCache.get(key);
    if (hit) {
      if (hit.expiresAt > Date.now()) {
        // Refresh LRU position.
        traverseCache.delete(key);
        traverseCache.set(key, hit);
        return Promise.resolve(hit.value);
      }
      traverseCache.delete(key);
    }
  }

  const existing = traverseInFlight.get(key);
  if (existing) return existing;

  const promise = run(args).then(
    (value) => {
      if (ttl > 0) {
        const max = traversalCacheMax();
        if (max > 0) {
          // Insertion-ordered eviction: oldest first.
          while (traverseCache.size >= max) {
            const oldest = traverseCache.keys().next();
            if (oldest.done) break;
            traverseCache.delete(oldest.value);
          }
          traverseCache.set(key, { value, expiresAt: Date.now() + ttl });
        }
      }
      return value;
    },
    (err) => {
      throw err;
    },
  ).finally(() => {
    if (traverseInFlight.get(key) === promise) traverseInFlight.delete(key);
  });

  traverseInFlight.set(key, promise);
  return promise;
}

/**
 * Extract source-side primary keys from an object-set anchor when it is
 * unambiguously a primary-key predicate. `objectSetExecutor` builds every
 * hop after the first as `{type:"in", field:"__pk", value:[...]}` and a
 * selection-rooted first hop as the same shape with one element, so this
 * covers effectively every traversal the OSS v2 path issues.
 *
 * Returns `null` for anything else (arbitrary filters, `and`/`or` trees,
 * linked predicates) so the caller falls back to the source-side index lookup
 * rather than guessing. Never populated from user input — see the
 * `sourcePks` contract in `SearchAroundOptions`.
 */
function anchorPrimaryKeys(anchorWhere: unknown): string[] | null {
  if (!anchorWhere || typeof anchorWhere !== "object") return null;
  const node = anchorWhere as { type?: unknown; field?: unknown; value?: unknown };
  if (node.field !== "__pk") return null;
  if (node.type === "in" && Array.isArray(node.value)) {
    return node.value.map((v) => String(v));
  }
  if (node.type === "eq" && typeof node.value === "string") {
    return [node.value];
  }
  return null;
}
