/**
 * /api/v1/developer-console/* — Palantir Foundry Developer Console API.
 *
 * See tellus-fe/docs/developer-console/BACKEND_PALANTIR_PARITY.md
 */

import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import foundryDb from '../config/foundryDb';
import { AppError } from '../utils/foundryAppError';
import { requireTellusAuth } from '../middleware/tellusAuth';
import { getDeveloperConsoleService } from '../services/developerConsole/developerConsoleService';
import {
  applicationEtag,
  authorizeDeveloperApplication,
  parseIfMatch,
  type DeveloperConsoleActor,
  type RequiredApplicationRole,
} from '../services/developerConsole/developerConsoleSecurity';

const router = Router();

function knex(): Knex {
  return foundryDb as unknown as Knex;
}

function sendError(err: unknown, _req: Request, res: Response): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      errorCode: err.code,
      message: err.message,
    });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[developer-console]', err);
  res.status(500).json({
    success: false,
    errorCode: 'INTERNAL_ERROR',
    message: 'Internal server error',
  });
}

function principal(req: Request): DeveloperConsoleActor {
  const p = req.tellusPrincipal;
  const user = (req as Request & {
    user?: { id?: string | null; displayName?: string; email?: string };
  }).user;
  const userId =
    p?.userId ?? p?.keycloakSub ?? (user?.id ?? undefined) ?? 'anonymous';
  const claims = req.tellusClaims as {
    preferred_username?: string;
    email?: string;
    org?: string;
  } | undefined;
  const userName =
    user?.displayName ?? user?.email ?? claims?.preferred_username ?? claims?.email ?? 'You';
  const roles = p?.roles ?? [];
  return {
    userId: String(userId),
    userName,
    tenantId:
      claims?.org?.trim() ||
      process.env.TELLUS_SINGLE_TENANT_ID?.trim() ||
      (process.env.NODE_ENV === 'production' ? null : 'default'),
    roles,
    requestId:
      (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id']) ||
      undefined,
  };
}

function requireApplicationAccess(required: RequiredApplicationRole) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await authorizeDeveloperApplication(
        knex(),
        req.params.applicationId,
        principal(req),
        required,
      );
      next();
    } catch (err) {
      sendError(err, req, res);
    }
  };
}

function expectedVersion(req: Request): number | undefined {
  const parsed = parseIfMatch(req.header('If-Match'));
  if (process.env.NODE_ENV === 'production' && parsed === undefined) {
    throw new AppError('If-Match is required for this mutation', 428, 'PRECONDITION_REQUIRED');
  }
  return parsed;
}

function sendData(res: Response, data: unknown, statusCode = 200): void {
  const version = (data as { rowVersion?: number } | null)?.rowVersion;
  if (version !== undefined) res.setHeader('ETag', applicationEtag(version));
  res.status(statusCode).json({ success: true, data });
}

function requireTelemetryPublisher(req: Request, res: Response, next: NextFunction): void {
  const actor = principal(req);
  if (
    process.env.NODE_ENV !== 'production' ||
    actor.roles.includes('tellus-telemetry-publisher') ||
    actor.roles.includes('tellus-superadmin')
  ) {
    next();
    return;
  }
  sendError(
    new AppError('Trusted telemetry publisher role required', 403, 'TELEMETRY_PUBLISHER_REQUIRED'),
    req,
    res,
  );
}

const CreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(4000).optional().default(''),
  clientType: z.enum(['public', 'confidential']).optional(),
  applicationTypes: z
    .array(z.enum(['client-facing', 'backend-service']))
    .min(1)
    .max(2)
    .optional(),
  permissionMode: z.enum(['user', 'application']).optional().default('user'),
  organizationName: z.string().max(255).optional(),
  locationPath: z.string().max(1024).optional(),
  projectName: z.string().max(255).optional(),
  projectRid: z.string().max(255).nullable().optional(),
  // Foundry allows http(s) localhost during local OSDK development
  redirectUris: z.array(z.string().url()).max(100).optional().default([]),
  resourceScopes: z.array(z.string().min(1).max(255)).max(1000).optional().default([]),
});

const PatchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(4000).optional(),
  organizationName: z.string().max(255).optional(),
  locationPath: z.string().max(1024).optional(),
  projectName: z.string().max(255).optional(),
  projectRid: z.string().max(255).nullable().optional(),
  logoUrl: z.string().max(2048).nullable().optional(),
});

const OauthPutSchema = z.object({
  redirectUris: z.array(z.string().url()).max(100).optional(),
  resourceRestrictions: z.enum(['restricted', 'unrestricted']).optional(),
  operationRestrictions: z.enum(['restricted', 'unrestricted']).optional(),
  markingRestrictions: z.enum(['restricted', 'unrestricted']).optional(),
});

const OntologyResourcesSchema = z.object({
  resources: z
    .array(
      z.object({
        kind: z.enum(['object_type', 'action_type', 'function', 'interface']),
        apiName: z.string().min(1).max(255),
        displayName: z.string().min(1).max(255),
        icon: z.record(z.string(), z.unknown()).optional(),
        status: z.string().max(64).optional(),
        parentApiName: z.string().max(255).nullable().optional(),
        hasNoResources: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(2000),
});

const MetricsIngestSchema = z.object({
  points: z
    .array(
      z.object({
        metric: z.enum(['requests', 'errors', 'latency_ms']).optional(),
        value: z.number().optional(),
        dimensions: z.record(z.string(), z.string()).optional(),
        timestamp: z.string().optional(),
      }),
    )
    .min(1)
    .max(5000),
});

const ServiceSharesSchema = z.object({
  shares: z
    .array(
      z.object({
        resourceKind: z.enum([
          'object_type',
          'action_type',
          'function',
          'interface',
          'project',
          'dataset',
          'ontology',
        ]),
        resourceId: z.string().min(1).max(512),
        resourceName: z.string().max(512).optional(),
        accessLevel: z.enum(['viewer', 'editor', 'owner']).optional(),
      }),
    )
    .max(2000),
});

const ApplicationMembersSchema = z.object({
  members: z
    .array(
      z.object({
        principalId: z.string().min(1).max(255),
        role: z.enum(['viewer', 'editor', 'owner']),
      }),
    )
    .max(500),
});

const PlatformPutSchema = z.object({
  scopes: z
    .array(
      z.object({
        scope: z.string().min(1).max(255),
        enabled: z.boolean(),
      }),
    )
    .max(1000)
    .optional(),
  projectGrants: z
    .array(
      z.object({
        projectId: z.string().min(1).max(128),
        projectName: z.string().min(1).max(255),
        projectRid: z.string().max(255).nullable().optional(),
        description: z.string().max(4000).optional(),
        iconClass: z.string().max(128).optional(),
        href: z.string().max(2048).nullable().optional(),
      }),
    )
    .max(500)
    .optional(),
});

// ----- Applications ---------------------------------------------------------

router.get(
  '/applications',
  requireTellusAuth({ allowPat: true }),
  async (req: Request, res: Response) => {
    try {
      const { userId, tenantId, roles } = principal(req);
      const filter = (req.query.filter as 'all' | 'mine' | 'favorites' | 'recents' | undefined) ?? 'all';
      const data = await getDeveloperConsoleService(knex()).listApplications({
        userId,
        tenantId,
        roles,
        filter,
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.post(
  '/applications',
  requireTellusAuth({ allowPat: false }),
  async (req: Request, res: Response) => {
    try {
      const { userId, userName, tenantId } = principal(req);
      if (!tenantId) {
        throw new AppError('Authenticated tenant claim is required', 400, 'TENANT_REQUIRED');
      }
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const idempotencyKeyRaw = req.header('Idempotency-Key') ?? req.header('idempotency-key');
      const idempotencyKey =
        typeof idempotencyKeyRaw === 'string' && idempotencyKeyRaw.trim()
          ? idempotencyKeyRaw.trim().slice(0, 128)
          : undefined;

      const data = await getDeveloperConsoleService(knex()).createApplication({
        ...parsed.data,
        creatorId: userId,
        creatorName: userName,
        tenantId,
        idempotencyKey,
      });
      sendData(res, data, 201);
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.get(
  '/applications/:applicationId',
  requireTellusAuth({ allowPat: true }),
  requireApplicationAccess('read'),
  async (req: Request, res: Response) => {
    try {
      const { userId } = principal(req);
      const data = await getDeveloperConsoleService(knex()).getApplication(
        req.params.applicationId,
        userId,
      );
      sendData(res, data);
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.patch(
  '/applications/:applicationId',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('write'),
  async (req: Request, res: Response) => {
    try {
      const { userId, userName } = principal(req);
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const data = await getDeveloperConsoleService(knex()).patchApplication(
        req.params.applicationId,
        userId,
        userName,
        parsed.data,
        expectedVersion(req),
      );
      sendData(res, data);
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.delete(
  '/applications/:applicationId',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('admin'),
  async (req: Request, res: Response) => {
    try {
      const actor = principal(req);
      await getDeveloperConsoleService(knex()).deleteApplication(
        req.params.applicationId,
        actor,
        expectedVersion(req),
      );
      res.status(204).end();
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.post(
  '/applications/:applicationId/favorite',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('read'),
  async (req: Request, res: Response) => {
    try {
      const { userId } = principal(req);
      const data = await getDeveloperConsoleService(knex()).toggleFavorite(
        req.params.applicationId,
        userId,
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.get(
  '/applications/:applicationId/members',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('admin'),
  async (req: Request, res: Response) => {
    try {
      const data = await getDeveloperConsoleService(knex()).listApplicationMembers(
        req.params.applicationId,
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.put(
  '/applications/:applicationId/members',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('admin'),
  async (req: Request, res: Response) => {
    try {
      const parsed = ApplicationMembersSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const data = await getDeveloperConsoleService(knex()).putApplicationMembers(
        req.params.applicationId,
        principal(req),
        parsed.data.members,
        expectedVersion(req),
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.get(
  '/applications/:applicationId/audit',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('admin'),
  async (req: Request, res: Response) => {
    try {
      const data = await getDeveloperConsoleService(knex()).listApplicationAudit(
        req.params.applicationId,
        req.query.limit ? Number(req.query.limit) : undefined,
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

// ----- OAuth ----------------------------------------------------------------

router.get(
  '/applications/:applicationId/oauth',
  requireTellusAuth({ allowPat: true }),
  requireApplicationAccess('read'),
  async (req: Request, res: Response) => {
    try {
      const { userId } = principal(req);
      const data = await getDeveloperConsoleService(knex()).getOauth(
        req.params.applicationId,
        userId,
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.put(
  '/applications/:applicationId/oauth',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('write'),
  async (req: Request, res: Response) => {
    try {
      const { userId, userName } = principal(req);
      const parsed = OauthPutSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const data = await getDeveloperConsoleService(knex()).putOauth(
        req.params.applicationId,
        userId,
        userName,
        parsed.data,
        expectedVersion(req),
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.post(
  '/applications/:applicationId/oauth/rotate-secret',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('admin'),
  async (req: Request, res: Response) => {
    try {
      const data = await getDeveloperConsoleService(knex()).rotateSecret(
        req.params.applicationId,
        principal(req),
        expectedVersion(req),
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

// ----- Ontology SDK ---------------------------------------------------------

router.get(
  '/applications/:applicationId/ontology-sdk',
  requireTellusAuth({ allowPat: true }),
  requireApplicationAccess('read'),
  async (req: Request, res: Response) => {
    try {
      const data = await getDeveloperConsoleService(knex()).getOntologySdk(
        req.params.applicationId,
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.put(
  '/applications/:applicationId/ontology-sdk/resources',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('write'),
  async (req: Request, res: Response) => {
    try {
      const actor = principal(req);
      const parsed = OntologyResourcesSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const data = await getDeveloperConsoleService(knex()).putOntologyResources(
        req.params.applicationId,
        actor.userId,
        actor.userName,
        parsed.data.resources,
        expectedVersion(req),
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.post(
  '/applications/:applicationId/ontology-sdk/versions',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('write'),
  async (req: Request, res: Response) => {
    try {
      const actor = principal(req);
      const data = await getDeveloperConsoleService(knex()).generateSdkVersion(
        req.params.applicationId,
        actor.userId,
        actor.userName,
        expectedVersion(req),
      );
      res.status(201).json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.get(
  '/applications/:applicationId/ontology-sdk/registry',
  requireTellusAuth({ allowPat: true }),
  requireApplicationAccess('read'),
  async (req: Request, res: Response) => {
    try {
      const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}/applications/${encodeURIComponent(req.params.applicationId)}/ontology-sdk/versions`;
      const data = await getDeveloperConsoleService(knex()).getSdkRegistryMetadata(
        req.params.applicationId,
        baseUrl,
      );
      res.type('application/vnd.npm.install-v1+json').json(data);
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.get(
  '/applications/:applicationId/ontology-sdk/versions/:version/tarball',
  requireTellusAuth({ allowPat: true }),
  requireApplicationAccess('read'),
  async (req: Request, res: Response) => {
    try {
      const artifact = await getDeveloperConsoleService(knex()).downloadSdkArtifact(
        req.params.applicationId,
        req.params.version,
      );
      const safeName = artifact.packageName.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safeName}-${req.params.version}.tgz"`,
        'Content-Length': String(artifact.tarball.length),
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: `"sha256-${artifact.digest}"`,
        Digest: `sha-256=${Buffer.from(artifact.digest, 'hex').toString('base64')}`,
      });
      res.send(artifact.tarball);
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.get(
  '/applications/:applicationId/ontology-sdk/versions/:version',
  requireTellusAuth({ allowPat: true }),
  requireApplicationAccess('read'),
  async (req: Request, res: Response) => {
    try {
      const data = await getDeveloperConsoleService(knex()).getSdkVersionPackage(
        req.params.applicationId,
        req.params.version,
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

// Live Ontology catalog for the "Add resources" dialog (object_type / action_type / …)
router.get(
  '/ontology-catalog',
  requireTellusAuth({ allowPat: true }),
  async (req: Request, res: Response) => {
    try {
      const data = await getDeveloperConsoleService(knex()).listOntologyCatalog({
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
      });
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

// Service-user resource shares (Sharing & tokens)
router.get(
  '/applications/:applicationId/shares',
  requireTellusAuth({ allowPat: true }),
  requireApplicationAccess('read'),
  async (req: Request, res: Response) => {
    try {
      const data = await getDeveloperConsoleService(knex()).listServiceShares(
        req.params.applicationId,
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.put(
  '/applications/:applicationId/shares',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('admin'),
  async (req: Request, res: Response) => {
    try {
      const actor = principal(req);
      const parsed = ServiceSharesSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const data = await getDeveloperConsoleService(knex()).putServiceShares(
        req.params.applicationId,
        actor.userId,
        actor.userName,
        parsed.data.shares,
        expectedVersion(req),
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

// ----- Platform SDK ---------------------------------------------------------

router.get(
  '/applications/:applicationId/platform-sdk',
  requireTellusAuth({ allowPat: true }),
  requireApplicationAccess('read'),
  async (req: Request, res: Response) => {
    try {
      const data = await getDeveloperConsoleService(knex()).getPlatformSdk(
        req.params.applicationId,
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.put(
  '/applications/:applicationId/platform-sdk',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('write'),
  async (req: Request, res: Response) => {
    try {
      const actor = principal(req);
      const parsed = PlatformPutSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const data = await getDeveloperConsoleService(knex()).putPlatformSdk(
        req.params.applicationId,
        actor.userId,
        actor.userName,
        parsed.data,
        expectedVersion(req),
      );
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

// ----- Metrics --------------------------------------------------------------

router.get(
  '/applications/:applicationId/metrics',
  requireTellusAuth({ allowPat: true }),
  requireApplicationAccess('read'),
  async (req: Request, res: Response) => {
    try {
      const data = await getDeveloperConsoleService(knex()).getMetrics(req.params.applicationId, {
        range: typeof req.query.range === 'string' ? req.query.range : undefined,
        groupBy: typeof req.query.groupBy === 'string' ? req.query.groupBy : undefined,
      });
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.post(
  '/applications/:applicationId/metrics',
  requireTellusAuth({ allowPat: false }),
  requireApplicationAccess('write'),
  requireTelemetryPublisher,
  async (req: Request, res: Response) => {
    try {
      const parsed = MetricsIngestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const data = await getDeveloperConsoleService(knex()).ingestMetrics(
        req.params.applicationId,
        parsed.data.points,
      );
      res.status(201).json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

// ----- Project catalog (Select Projects dialog) -----------------------------

router.get(
  '/projects',
  requireTellusAuth({ allowPat: true }),
  async (req: Request, res: Response) => {
    try {
      const data = await getDeveloperConsoleService(knex()).listProjectCatalog({
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
      });
      res.json({ success: true, data });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

// Scope catalog (static, for Platform SDK UI without an application)
router.get(
  '/platform-scopes',
  requireTellusAuth({ allowPat: true }),
  async (req: Request, res: Response) => {
    try {
      const { PLATFORM_SCOPE_CATALOG } = await import(
        '../services/developerConsole/developerConsoleService'
      );
      res.json({ success: true, data: PLATFORM_SCOPE_CATALOG });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

export default router;
