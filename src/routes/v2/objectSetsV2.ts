// ---------------------------------------------------------------------------
// OSS v2 routes — thin adapters (Phase 9)
//
//   POST /api/v2/ontologies/:ontology/objectSets/loadObjects
//   POST /api/v2/ontologies/:ontology/objectSets/aggregate
//   POST /api/v2/ontologies/:ontology/objectSets/createTemporary
//   POST /api/v2/ontologies/:ontology/objectSets/loadMultipleObjectTypes
//
// No business logic here: validate → compile → execute → map errors.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import { z } from "zod";
import { buildSecurityFilter } from "../../middleware/securityContext";
import { requireSecurityContext } from "../../middleware/securityContext";
import { readBranchHeader } from "../../middleware/branchHeader";
import { query } from "../../db";
import { resolveRequestTenant } from "../../utils/requestTenant";
import {
  parseLoadObjectSetRequest,
  parseLoadObjectSetQuery,
  parseCreateTemporaryObjectSetQuery,
  parseAggregateObjectSetRequest,
  objectSetFingerprint,
  CreateTemporaryObjectSetRequestV2,
  type LoadObjectSetQueryV2,
} from "../../services/oss/objectSetDefinition";
import { compileObjectSet } from "../../services/oss/objectSetCompiler";
import {
  loadObjectSet,
  aggregateObjectSet,
} from "../../services/oss/objectSetExecutor";
import {
  makeProductionExecutorDeps,
  makeProductionCompilerDeps,
  resolveInterfacePropertyMapping,
} from "../../services/oss/productionDeps";
import {
  savedObjectSetStore,
  temporaryObjectSetStore,
} from "../../services/oss/objectSetStore";
import { toV2Error } from "../../services/oss/v2Errors";
import { assertSupportedLoadObjectSetRequest } from "../../services/oss/loadObjectSetContract";
import {
  composeReadContextLinkTargets,
  resolveReadContexts,
} from "../../services/oss/readContext";
import { recordOssV2AuditBestEffort } from "../../services/oss/audit";
import { requireOntology } from "./ontologyParam";
import type { CompiledObjectSet } from "../../services/oss/objectSetCompiler";
import linkTypeModel, {
  resolveObjectTypeApiName,
} from "../../models/linkType";
import { resolveLinks } from "../../services/linkResolverService";

const router = Router({ mergeParams: true });

function sendJson(res: Response, body: unknown): void {
  if (!res.headersSent && !res.writableEnded) res.json(body);
}

function sendV2Error(req: Request, res: Response, err: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const { status, body } = toV2Error(err);
  if (status === 401 || status === 403) {
    const security = req.security;
    recordOssV2AuditBestEffort({
      eventType: "security_denied",
      tenantId: resolveRequestTenant(req),
      ontologyId:
        typeof req.params.ontology === "string" &&
        /^[0-9a-f-]{36}$/i.test(req.params.ontology)
          ? req.params.ontology
          : null,
      userId: security?.userId ?? "anonymous",
      branchId: readBranchHeader(req),
      transactionId:
        typeof req.query.transactionId === "string"
          ? req.query.transactionId
          : null,
      scenarioRid:
        typeof req.query.scenarioRid === "string" ? req.query.scenarioRid : null,
      requestId:
        (req as Request & { requestId?: string }).requestId ??
        String(req.headers["x-request-id"] ?? ""),
      outcome: "denied",
      parameters: {
        errorName: body.errorName,
        status,
      },
    });
  }
  res.status(status).json(body);
}

function auditRead(
  req: Request,
  ontologyId: string,
  query: Pick<
    LoadObjectSetQueryV2,
    "branch" | "transactionId" | "scenarioRid"
  >,
  parameters: Record<string, string | number | boolean | null> = {},
): void {
  const security = requireSecurityContext(req);
  const common = {
    tenantId: resolveRequestTenant(req),
    ontologyId,
    userId: security.userId,
    branchId: readV2Branch(req, query),
    transactionId: query.transactionId ?? null,
    scenarioRid: query.scenarioRid ?? null,
    requestId:
      (req as Request & { requestId?: string }).requestId ??
      String(req.headers["x-request-id"] ?? ""),
    outcome: "success" as const,
    parameters,
  };
  recordOssV2AuditBestEffort({ ...common, eventType: "object_load" });
  if (query.transactionId) {
    recordOssV2AuditBestEffort({ ...common, eventType: "transaction_read" });
  }
  if (query.scenarioRid) {
    recordOssV2AuditBestEffort({ ...common, eventType: "scenario_read" });
  }
}

const LoadLinksRequest = z
  .object({
    objectSet: z.unknown(),
    links: z.array(z.string().min(1)).min(1).max(100),
    pageToken: z.string().min(1).optional(),
    includeComputeUsage: z.boolean().optional(),
  })
  .strict();

const PreviewQuery = z
  .object({
    sdkPackageRid: z.string().min(1).optional(),
    sdkVersion: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    transactionId: z.string().min(1).optional(),
    scenarioRid: z.string().min(1).optional(),
    executeInMemoryOnly: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    preview: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

const LoadLinksQuery = PreviewQuery;

function parsePreviewQuery(req: Request) {
  const parsed = PreviewQuery.safeParse(req.query);
  if (!parsed.success) {
    throw Object.assign(new Error("Invalid ObjectSet query parameters"), {
      errorName: "InvalidLoadObjectSetRequest",
      parameters: { issues: parsed.error.issues },
    });
  }
  const { preview: _preview, ...loadQuery } = parsed.data;
  return loadQuery;
}

function parseLoadLinksQuery(req: Request) {
  const parsed = LoadLinksQuery.safeParse(req.query);
  if (!parsed.success) {
    throw Object.assign(new Error("Invalid loadLinks query parameters"), {
      errorName: "InvalidLoadObjectSetRequest",
      parameters: { issues: parsed.error.issues },
    });
  }
  const { preview: _preview, ...loadQuery } = parsed.data;
  return loadQuery;
}

function parseObjectSetGetPreview(req: Request): void {
  const parsed = z
    .object({ preview: z.enum(["true", "false"]).optional() })
    .strict()
    .safeParse(req.query);
  if (!parsed.success) {
    throw Object.assign(new Error("Invalid ObjectSet get query parameters"), {
      errorName: "InvalidLoadObjectSetRequest",
      parameters: { issues: parsed.error.issues },
    });
  }
}

async function interfaceScope(
  compiled: CompiledObjectSet,
  ontologyId: string,
) {
  const scopedByType = new Map<string, Set<string> | null>();
  const legacy: Record<string, Record<string, Record<string, string>>> = {};
  const v2: Record<
    string,
    Record<string, Record<string, Record<string, unknown>>>
  > = {};
  for (const plan of compiled.plans) {
    const current = scopedByType.get(plan.objectType);
    if (!plan.interfaceApiName) {
      scopedByType.set(plan.objectType, null);
      continue;
    }
    if (current === null) continue;
    const mapping = await resolveInterfacePropertyMapping(
      ontologyId,
      plan.interfaceApiName,
      plan.objectType,
    );
    const selected = current ?? new Set<string>();
    Object.values(mapping).forEach((property) => selected.add(property));
    scopedByType.set(plan.objectType, selected);
    legacy[plan.interfaceApiName] ??= {};
    legacy[plan.interfaceApiName]![plan.objectType] = mapping;
    v2[plan.interfaceApiName] ??= {};
    v2[plan.interfaceApiName]![plan.objectType] = Object.fromEntries(
      Object.entries(mapping).map(([interfaceProperty, localProperty]) => [
        interfaceProperty,
        {
          type: "localPropertyImplementation",
          propertyApiName: localProperty,
        },
      ]),
    );
  }
  return { scopedByType, legacy, v2 };
}

function shapeMultiTypeData(
  data: Array<Record<string, unknown>>,
  scopedByType: Map<string, Set<string> | null>,
) {
  return data.map((object) => {
    const objectType = String(object.__apiName ?? "");
    const selected = scopedByType.get(objectType);
    const shaped: Record<string, unknown> = {
      $apiName: object.__apiName,
      $primaryKey: object.__primaryKey,
      ...(object.__rid === undefined ? {} : { $rid: object.__rid }),
    };
    for (const [key, value] of Object.entries(object)) {
      if (key.startsWith("__")) continue;
      if (selected instanceof Set && !selected.has(key)) continue;
      shaped[key] = value;
    }
    return shaped;
  });
}

function shapeInterfaceData(
  data: Array<Record<string, unknown>>,
  mappings: Record<string, Record<string, Record<string, string>>>,
) {
  const interfaceNames = Object.keys(mappings);
  return data.map((object) => {
    const objectType = String(object.__apiName ?? "");
    const shaped: Record<string, unknown> = {
      $apiName: object.__apiName,
      $primaryKey: object.__primaryKey,
      ...(object.__rid === undefined ? {} : { $rid: object.__rid }),
    };
    for (const interfaceName of interfaceNames) {
      const mapping = mappings[interfaceName]?.[objectType] ?? {};
      for (const [interfaceProperty, localProperty] of Object.entries(
        mapping,
      )) {
        if (object[localProperty] !== undefined) {
          shaped[interfaceProperty] = object[localProperty];
        }
      }
    }
    return shaped;
  });
}

function expandInterfaceSelection<T extends {
  select?: string[];
  selectV2?: unknown[];
}>(
  request: T,
  mappings: Record<string, Record<string, Record<string, string>>>,
): T {
  const concreteByInterfaceProperty = new Map<string, Set<string>>();
  for (const byType of Object.values(mappings)) {
    for (const mapping of Object.values(byType)) {
      for (const [interfaceProperty, localProperty] of Object.entries(
        mapping,
      )) {
        const set =
          concreteByInterfaceProperty.get(interfaceProperty) ??
          new Set<string>();
        set.add(localProperty);
        concreteByInterfaceProperty.set(interfaceProperty, set);
      }
    }
  }
  const expandIdentifier = (
    identifier: Record<string, unknown>,
  ): Array<Record<string, unknown>> => {
    if (identifier.type === "property") {
      const properties = concreteByInterfaceProperty.get(
        String(identifier.apiName),
      );
      return properties
        ? [...properties].map((apiName) => ({
            ...identifier,
            apiName,
          }))
        : [identifier];
    }
    if (identifier.type === "structField") {
      const properties = concreteByInterfaceProperty.get(
        String(identifier.propertyApiName),
      );
      return properties
        ? [...properties].map((propertyApiName) => ({
            ...identifier,
            propertyApiName,
          }))
        : [identifier];
    }
    if (
      identifier.type === "propertyWithLoadLevel" &&
      identifier.propertyIdentifier &&
      typeof identifier.propertyIdentifier === "object"
    ) {
      return expandIdentifier(
        identifier.propertyIdentifier as Record<string, unknown>,
      ).map((propertyIdentifier) => ({
        ...identifier,
        propertyIdentifier,
      }));
    }
    return [identifier];
  };
  return {
    ...request,
    ...(request.select && request.select.length > 0
      ? {
          select: [
            ...new Set(
              request.select.flatMap((property) => [
                ...(concreteByInterfaceProperty.get(property) ?? [property]),
              ]),
            ),
          ],
        }
      : {}),
    ...(request.selectV2 && request.selectV2.length > 0
      ? {
          selectV2: request.selectV2.flatMap((identifier) =>
            identifier && typeof identifier === "object"
              ? expandIdentifier(identifier as Record<string, unknown>)
              : [],
          ),
        }
      : {}),
  } as T;
}

function omitEmptyPageToken<T extends { nextPageToken: string | null }>(
  result: T,
): Omit<T, "nextPageToken"> & { nextPageToken?: string } {
  const { nextPageToken, ...rest } = result;
  return {
    ...rest,
    ...(nextPageToken ? { nextPageToken } : {}),
  };
}

function readV2Branch(
  req: Request,
  query: Pick<LoadObjectSetQueryV2, "branch">,
): string | null {
  return query.branch ?? readBranchHeader(req);
}

async function makeCtx(
  req: Request,
  ontologyId: string,
  query: Pick<
    LoadObjectSetQueryV2,
    "branch" | "transactionId" | "scenarioRid"
  >,
) {
  const snapshot = (req.body?.snapshot ?? false) === true;
  const branchId = readV2Branch(req, query);
  const security = requireSecurityContext(req);
  const tenant = resolveRequestTenant(req);
  const readContexts = await resolveReadContexts(
    {
      transactionId: query.transactionId,
      scenarioRid: query.scenarioRid,
    },
    {
      tenant,
      ontologyId,
      branchId,
      userId: security.userId,
      markings: security.markings,
      cbac: security.cbac,
      organizations: security.organizations,
      markingBypass: security.markingBypass,
    },
  );
  return {
    executorDeps: makeProductionExecutorDeps(
      {
        securityFilter: buildSecurityFilter(security),
        branchId,
        ontologyId,
        userId: security.userId,
        tenant,
        markings: security.markings,
        cbac: security.cbac,
        organizations: security.organizations,
        markingBypass: security.markingBypass,
        requestId:
          (req as Request & { requestId?: string }).requestId ??
          String(req.headers["x-request-id"] ?? ""),
        transactionId: query.transactionId ?? null,
        scenarioRid: query.scenarioRid ?? null,
      },
      { snapshot, readContexts },
    ),
    ctx: {
      ontologyRid: ontologyId,
      branchRid: branchId,
      tenant,
      userId: security.userId,
      securityFingerprint: objectSetFingerprint({
        markings: [...security.markings].sort(),
        cbac: [...security.cbac].sort(),
        organizations: [...security.organizations].sort(),
        markingBypass: security.markingBypass,
      }),
      transactionId: query.transactionId ?? null,
      transactionVersion: readContexts.transaction?.version ?? null,
      scenarioRid: query.scenarioRid ?? null,
      scenarioVersion: readContexts.scenario?.version ?? null,
      snapshot,
    },
    readContexts,
  };
}

router.post(
  "/objectSets/loadObjects",
  async (req: Request, res: Response) => {
    try {
      const started = process.hrtime.bigint();
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      const parsed = parseLoadObjectSetRequest(req.body);
      const query = parseLoadObjectSetQuery(req.query);
      assertSupportedLoadObjectSetRequest(parsed, query);
      const branchId = readV2Branch(req, query);
      const compiled = await compileObjectSet(
        parsed.objectSet,
        makeProductionCompilerDeps({
          tenant: resolveRequestTenant(req),
          ontologyRid: ontologyId,
          branchRid: branchId,
          userId: requireSecurityContext(req).userId,
        }),
      );
      const { executorDeps, ctx } = await makeCtx(req, ontologyId, query);
      const result = await loadObjectSet(compiled, parsed, ctx, executorDeps);
      auditRead(req, ontologyId, query, {
        objectTypes: compiled.plans.length,
        snapshot: parsed.snapshot === true,
      });
      sendJson(res, {
        ...omitEmptyPageToken(result),
        ...(parsed.includeComputeUsage === true
          ? {
              computeUsage:
                Number(process.hrtime.bigint() - started) / 1_000_000_000,
            }
          : {}),
      });
    } catch (err) {
      sendV2Error(req, res, err);
    }
  },
);

router.post(
  [
    "/objectSets/loadObjectsMultipleObjectTypes",
    // Compatibility alias from the initial Tellus preview.
    "/objectSets/loadMultipleObjectTypes",
  ],
  async (req: Request, res: Response) => {
    // Verified endpoint exists for cross-type loads; the canonical
    // compiler already fans cross-type sets into typed plans, so
    // this delegates to the same execution path.
    try {
      const started = process.hrtime.bigint();
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      const parsed = parseLoadObjectSetRequest(req.body);
      const query = parsePreviewQuery(req);
      assertSupportedLoadObjectSetRequest(parsed, query);
      const branchId = readV2Branch(req, query);
      const compiled = await compileObjectSet(
        parsed.objectSet,
        makeProductionCompilerDeps({
          tenant: resolveRequestTenant(req),
          ontologyRid: ontologyId,
          branchRid: branchId,
          userId: requireSecurityContext(req).userId,
        }),
      );
      const { executorDeps, ctx } = await makeCtx(req, ontologyId, query);
      const result = await loadObjectSet(compiled, parsed, ctx, executorDeps);
      auditRead(req, ontologyId, query, {
        objectTypes: compiled.plans.length,
        snapshot: parsed.snapshot === true,
      });
      const scope = await interfaceScope(compiled, ontologyId);
      sendJson(res, {
        ...omitEmptyPageToken(result),
        data: shapeMultiTypeData(result.data, scope.scopedByType),
        interfaceToObjectTypeMappings: scope.legacy,
        interfaceToObjectTypeMappingsV2: scope.v2,
        ...(parsed.includeComputeUsage === true
          ? {
              computeUsage:
                Number(process.hrtime.bigint() - started) / 1_000_000_000,
            }
          : {}),
      });
    } catch (err) {
      sendV2Error(req, res, err);
    }
  },
);

router.post(
  "/objectSets/loadObjectsOrInterfaces",
  async (req: Request, res: Response) => {
    try {
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      const parsed = parseLoadObjectSetRequest(req.body);
      if (
        Object.prototype.hasOwnProperty.call(
          req.body ?? {},
          "loadPropertySecurities",
        ) ||
        Object.prototype.hasOwnProperty.call(
          req.body ?? {},
          "includeComputeUsage",
        )
      ) {
        throw Object.assign(
          new Error(
            "loadObjectsOrInterfaces does not accept loadPropertySecurities or includeComputeUsage.",
          ),
          {
            errorName: "InvalidLoadObjectSetRequest",
            parameters: { endpoint: "loadObjectsOrInterfaces" },
          },
        );
      }
      const query = parsePreviewQuery(req);
      assertSupportedLoadObjectSetRequest(parsed, query);
      const branchId = readV2Branch(req, query);
      const compiled = await compileObjectSet(
        parsed.objectSet,
        makeProductionCompilerDeps({
          tenant: resolveRequestTenant(req),
          ontologyRid: ontologyId,
          branchRid: branchId,
          userId: requireSecurityContext(req).userId,
        }),
      );
      const interfaceScoped = compiled.plans.filter(
        (plan) => plan.interfaceApiName,
      ).length;
      if (
        interfaceScoped > 0 &&
        interfaceScoped !== compiled.plans.length
      ) {
        throw Object.assign(
          new Error(
            "loadObjectsOrInterfaces cannot mix interface and object-type scopes.",
          ),
          {
            errorName: "InvalidObjectSet",
            parameters: { reason: "mixedTypeScope" },
          },
        );
      }
      const { executorDeps, ctx } = await makeCtx(req, ontologyId, query);
      const scope = await interfaceScope(compiled, ontologyId);
      const executionRequest =
        interfaceScoped > 0
          ? expandInterfaceSelection(parsed, scope.legacy)
          : parsed;
      const result = await loadObjectSet(
        compiled,
        executionRequest,
        ctx,
        executorDeps,
      );
      auditRead(req, ontologyId, query, {
        objectTypes: compiled.plans.length,
        snapshot: parsed.snapshot === true,
      });
      sendJson(res, {
        data:
          interfaceScoped > 0
            ? shapeInterfaceData(result.data, scope.legacy)
            : shapeMultiTypeData(result.data, scope.scopedByType),
        ...(result.nextPageToken
          ? { nextPageToken: result.nextPageToken }
          : {}),
        totalCount: result.totalCount,
      });
    } catch (err) {
      sendV2Error(req, res, err);
    }
  },
);

router.post(
  "/objectSets/loadLinks",
  async (req: Request, res: Response) => {
    try {
      const started = process.hrtime.bigint();
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      const parsed = LoadLinksRequest.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid load-links request"), {
          errorName: "InvalidLoadObjectSetRequest",
          parameters: { issues: parsed.error.issues },
        });
      }
      const queryParams = parseLoadLinksQuery(req);
      if (queryParams.executeInMemoryOnly === true) {
        throw Object.assign(
          new Error("executeInMemoryOnly is unavailable for loadLinks."),
          {
            errorName: "UnsupportedObjectSetFeature",
            parameters: { feature: "executeInMemoryOnly" },
          },
        );
      }
      const branchId = readV2Branch(req, queryParams);
      const objectSet = parseLoadObjectSetRequest({
        objectSet: parsed.data.objectSet,
        select: [],
        pageSize: 1_000,
        pageToken: parsed.data.pageToken,
      });
      const compiled = await compileObjectSet(
        objectSet.objectSet,
        makeProductionCompilerDeps({
          tenant: resolveRequestTenant(req),
          ontologyRid: ontologyId,
          branchRid: branchId,
          userId: requireSecurityContext(req).userId,
        }),
      );
      const { executorDeps, ctx, readContexts } = await makeCtx(
        req,
        ontologyId,
        queryParams,
      );
      const sources = await loadObjectSet(
        compiled,
        objectSet,
        ctx,
        executorDeps,
      );
      const linkTypes = await Promise.all(
        parsed.data.links.map(async (apiName) => {
          let linkType = await linkTypeModel.getByApiName(
            ontologyId,
            apiName,
          );
          let requestedDirection: "forward" | "reverse" | null = linkType
            ? "forward"
            : null;
          if (!linkType) {
            const reverse = await query(
              `SELECT api_name
                 FROM link_type
                WHERE ontology_id = $1
                  AND reverse_visible = true
                  AND reverse_api_name = $2
                LIMIT 1`,
              [ontologyId, apiName],
            );
            if (reverse.rows.length > 0) {
              linkType = await linkTypeModel.getByApiName(
                ontologyId,
                String(reverse.rows[0].api_name),
              );
              requestedDirection = "reverse";
            }
          }
          if (!linkType) {
            throw Object.assign(
              new Error(`Link type not found: ${apiName}`),
              {
                errorName: "LinkTypeNotFound",
                parameters: { linkType: apiName },
              },
            );
          }
          return {
            linkType,
            sourceType: await resolveObjectTypeApiName(
              linkType.source_object_type,
            ),
            targetType: await resolveObjectTypeApiName(
              linkType.target_object_type,
            ),
            requestedApiName: apiName,
            requestedDirection,
          };
        }),
      );
      let returnedLinks = 0;
      const data = [];
      for (const source of sources.data) {
        const sourceType = String(source.__apiName);
        const sourcePk = String(source.__primaryKey);
        const linkedObjects: Array<Record<string, unknown>> = [];
        for (const candidate of linkTypes) {
          const direction =
            candidate.requestedDirection === "reverse" &&
            candidate.targetType === sourceType
              ? "reverse"
              : candidate.requestedDirection === "forward" &&
                  candidate.sourceType === sourceType
              ? "forward"
              : candidate.requestedDirection === null &&
                  candidate.targetType === sourceType
                ? "reverse"
                : null;
          if (!direction) continue;
          const baseTargetPks: string[] = [];
          let linkPageToken: string | null = null;
          do {
            const linked = await resolveLinks(
              candidate.linkType,
              sourcePk,
              direction,
              {
                pageSize: Math.min(1_000, 100_000 - returnedLinks),
                pageToken: linkPageToken ?? undefined,
              },
              buildSecurityFilter(req.security!),
              branchId,
            );
            for (const target of linked.linkedObjects as Array<
              Record<string, unknown>
            >) {
              // The canonical resolver returns raw OpenSearch documents
              // (`__pk`); overlay/context resolvers may already return the
              // public formatter name (`__primaryKey`). Accept both at this
              // boundary and normalize before composing context link edits.
              const targetPrimaryKey =
                target.__primaryKey ?? target.__pk;
              if (targetPrimaryKey != null) {
                baseTargetPks.push(String(targetPrimaryKey));
              }
            }
            linkPageToken = linked.nextPageToken ?? null;
          } while (linkPageToken && returnedLinks < 100_000);
          const targetPks = await composeReadContextLinkTargets({
            linkType: candidate.linkType.api_name,
            direction,
            sourcePrimaryKey: sourcePk,
            baseTargetPrimaryKeys: baseTargetPks,
            contexts: readContexts,
            versions: {
              transactionVersion: ctx.transactionVersion,
              scenarioVersion: ctx.scenarioVersion,
            },
          });
          const targetType =
            direction === "forward"
              ? candidate.targetType
              : candidate.sourceType;
          for (let offset = 0; offset < targetPks.length; offset += 5_000) {
            const chunk = targetPks.slice(offset, offset + 5_000);
            const targetDefinition = {
              type: "filter" as const,
              objectSet: {
                type: "base" as const,
                objectType: targetType,
              },
              where: {
                type: "in" as const,
                field: "__pk",
                value: chunk,
              },
            };
            const targetCompiled = await compileObjectSet(
              targetDefinition,
              makeProductionCompilerDeps({
                tenant: resolveRequestTenant(req),
                ontologyRid: ontologyId,
                branchRid: branchId,
                userId: requireSecurityContext(req).userId,
              }),
            );
            const securedTargets = await loadObjectSet(
              targetCompiled,
              {
                objectSet: targetDefinition,
                select: [],
                selectV2: [],
                pageSize: Math.min(chunk.length, 10_000),
              },
              ctx,
              executorDeps,
            );
            for (const target of securedTargets.data) {
              linkedObjects.push({
                targetObject: {
                  __primaryKey: target.__primaryKey,
                  __apiName: target.__apiName ?? targetType,
                },
                linkType: candidate.requestedApiName,
              });
              returnedLinks += 1;
              if (returnedLinks >= 100_000) break;
            }
            if (returnedLinks >= 100_000) break;
          }
          if (returnedLinks >= 100_000) break;
        }
        data.push({
          sourceObject: {
            __primaryKey: sourcePk,
            __apiName: sourceType,
          },
          linkedObjects,
        });
        if (returnedLinks >= 100_000) break;
      }
      sendJson(res, {
        data,
        ...(sources.nextPageToken
          ? { nextPageToken: sources.nextPageToken }
          : {}),
        ...(parsed.data.includeComputeUsage === true
          ? {
              computeUsage:
                Number(process.hrtime.bigint() - started) / 1_000_000_000,
            }
          : {}),
      });
    } catch (err) {
      sendV2Error(req, res, err);
    }
  },
);

router.post(
  "/objectSets/aggregate",
  async (req: Request, res: Response) => {
    try {
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      const query = parseLoadObjectSetQuery(req.query);
      if (
        query.transactionId ||
        query.scenarioRid ||
        query.executeInMemoryOnly === true
      ) {
        // Aggregate has the same documented experimental query features
        // as loadObjects. Reuse the load-contract guard with a minimal
        // request so they fail explicitly rather than being ignored.
        assertSupportedLoadObjectSetRequest(
          parseLoadObjectSetRequest({
            objectSet: req.body?.objectSet,
            select: [],
          }),
          query,
        );
      }
      const parsed = parseAggregateObjectSetRequest(req.body);
      const branchId = readV2Branch(req, query);
      const compiled = await compileObjectSet(
        parsed.objectSet,
        makeProductionCompilerDeps({
          tenant: resolveRequestTenant(req),
          ontologyRid: ontologyId,
          branchRid: branchId,
          userId: requireSecurityContext(req).userId,
        }),
      );
      const { executorDeps, ctx } = await makeCtx(req, ontologyId, query);
      const result = await aggregateObjectSet(
        compiled,
        parsed,
        ctx,
        executorDeps,
      );
      auditRead(req, ontologyId, query, {
        objectTypes: compiled.plans.length,
        aggregationMetrics: parsed.aggregation.length,
      });
      sendJson(res, result);
    } catch (err) {
      sendV2Error(req, res, err);
    }
  },
);

router.post(
  "/objectSets/createTemporary",
  async (req: Request, res: Response) => {
    try {
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      const query = parseCreateTemporaryObjectSetQuery(req.query);
      if (query.preview !== true) {
        throw Object.assign(
          new Error(
            "createTemporary is a preview endpoint; set preview=true.",
          ),
          {
            errorName: "PreviewRequired",
            parameters: { preview: true },
          },
        );
      }
      const parsed = CreateTemporaryObjectSetRequestV2.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid temporary object set request"),
          {
            errorName: "InvalidObjectSet",
            parameters: { issues: parsed.error.issues },
          },
        );
      }
      const result = await temporaryObjectSetStore.create({
        objectSet: parsed.data.objectSet,
        ontologyRid: ontologyId,
        tenant: resolveRequestTenant(req),
        branchRid: query.branch ?? readBranchHeader(req),
        createdBy: requireSecurityContext(req).userId,
      });
      const security = requireSecurityContext(req);
      recordOssV2AuditBestEffort({
        eventType: "temporary_object_set_access",
        tenantId: resolveRequestTenant(req),
        ontologyId,
        userId: security.userId,
        branchId: query.branch ?? readBranchHeader(req),
        requestId:
          (req as Request & { requestId?: string }).requestId ?? null,
        outcome: "success",
        parameters: { operation: "create" },
      });
      sendJson(res, result);
    } catch (err) {
      sendV2Error(req, res, err);
    }
  },
);

router.get(
  "/objectSets/:objectSetRid",
  async (req: Request, res: Response) => {
    try {
      parseObjectSetGetPreview(req);
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      const tenant = resolveRequestTenant(req);
      const branchRid = readBranchHeader(req);
      const rid = req.params.objectSetRid;
      const objectSet = rid.startsWith(
        "ri.object-set.main.temporary-object-set.",
      )
        ? await temporaryObjectSetStore.resolve(rid, {
            tenant,
            ontologyRid: ontologyId,
            branchRid,
            userId: requireSecurityContext(req).userId,
          })
        : await savedObjectSetStore.get(rid);
      if (!objectSet) {
        throw Object.assign(new Error(`ObjectSet not found: ${rid}`), {
          errorName: "ObjectSetNotFound",
          parameters: { objectSetRid: rid },
        });
      }
      const security = requireSecurityContext(req);
      recordOssV2AuditBestEffort({
        eventType: "temporary_object_set_access",
        tenantId: tenant,
        ontologyId,
        userId: security.userId,
        branchId: branchRid,
        requestId:
          (req as Request & { requestId?: string }).requestId ?? null,
        outcome: "success",
        parameters: {
          operation: "resolve",
          temporary: rid.startsWith(
            "ri.object-set.main.temporary-object-set.",
          ),
        },
      });
      sendJson(res, objectSet);
    } catch (err) {
      sendV2Error(req, res, err);
    }
  },
);

export default router;
