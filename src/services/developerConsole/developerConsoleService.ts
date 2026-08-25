/**
 * Developer Console (Palantir third-party applications) domain service.
 *
 * Product metadata + RIDs live in Postgres. OAuth client secrets live in
 * Keycloak and are only returned on create / rotate.
 */

import crypto from 'crypto';
import type { Knex } from 'knex';
import { AppError } from '../../utils/foundryAppError';
import { getKeycloakAdminService } from '../keycloakAdminService';
import { DeveloperConsoleArtifactRegistry } from './artifactRegistryService';
import {
  decryptIdempotencyResponse,
  encryptIdempotencyResponse,
  idempotencyRequestHash,
  isDeveloperConsoleSuperadmin,
  type DeveloperConsoleActor,
} from './developerConsoleSecurity';

export const APP_RID_PREFIX = 'ri.third-party-applications.main.application.' as const;

export type ClientType = 'public' | 'confidential';
export type PermissionMode = 'user' | 'application';
export type RestrictionLevel = 'restricted' | 'unrestricted';

export interface DeveloperApplicationRow {
  id: string;
  rid: string;
  name: string;
  description: string;
  client_id: string;
  client_type: ClientType;
  keycloak_client_uuid: string | null;
  organization_name: string;
  organization_id: string | null;
  tenant_id: string;
  location_path: string;
  project_name: string;
  project_rid: string | null;
  creator_id: string;
  creator_name: string;
  last_edited_by: string;
  last_modified_at: Date | string;
  organization_count: number;
  logo_url: string | null;
  resource_restrictions: RestrictionLevel;
  operation_restrictions: RestrictionLevel;
  marking_restrictions: RestrictionLevel;
  permission_mode: PermissionMode;
  application_types: string[] | null;
  grant_types: string[] | null;
  created_at: Date | string;
  deleted_at: Date | string | null;
  row_version: number | string;
  identity_state: 'provisioning' | 'ready' | 'delete_pending' | 'error';
  identity_error: string | null;
}

export interface DeveloperApplicationDto {
  id: string;
  uuid: string;
  name: string;
  description: string;
  clientId: string;
  clientType: ClientType;
  organizationName: string;
  locationPath: string;
  projectName: string;
  projectRid: string | null;
  creatorName: string;
  creatorId: string;
  lastEditedBy: string;
  lastModifiedAt: string;
  organizationCount: number;
  favorite: boolean;
  logoUrl: string | null;
  resourceRestrictions: RestrictionLevel;
  operationRestrictions: RestrictionLevel;
  markingRestrictions: RestrictionLevel;
  permissionMode: PermissionMode;
  applicationTypes: string[];
  grantTypes: string[];
  tenantId: string;
  rowVersion: number;
  identityState: 'provisioning' | 'ready' | 'delete_pending' | 'error';
  clientSecret?: string;
}

export interface CreateApplicationInput {
  name: string;
  description?: string;
  clientType?: ClientType;
  applicationTypes?: string[];
  permissionMode?: PermissionMode;
  organizationName?: string;
  locationPath?: string;
  projectName?: string;
  projectRid?: string | null;
  redirectUris?: string[];
  resourceScopes?: string[];
  creatorId: string;
  creatorName: string;
  tenantId: string;
  /** Optional idempotency key (header) for safe client retries */
  idempotencyKey?: string;
}

const ALLOWED_APPLICATION_TYPES = new Set(['client-facing', 'backend-service']);

function requireKeycloakForTpa(): boolean {
  // Production always requires a real OAuth client. Dev can opt in via env.
  if (process.env.NODE_ENV === 'production') return true;
  return process.env.TELLUS_REQUIRE_KEYCLOAK_FOR_TPA === '1';
}

function normalizeRedirectUris(uris: string[] | undefined): string[] {
  if (!uris?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of uris) {
    const uri = (raw ?? '').trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    try {
      const u = new URL(uri);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new AppError(`Invalid redirect URI protocol: ${uri}`, 400, 'VALIDATION_ERROR');
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(`Invalid redirect URI: ${uri}`, 400, 'VALIDATION_ERROR');
    }
    out.push(uri);
  }
  if (out.length > 100) {
    throw new AppError('At most 100 redirect URLs are allowed', 400, 'VALIDATION_ERROR');
  }
  return out;
}

function normalizeApplicationTypes(types: string[] | undefined): string[] {
  const list = (types ?? []).map((t) => t.trim()).filter(Boolean);
  for (const t of list) {
    if (!ALLOWED_APPLICATION_TYPES.has(t)) {
      throw new AppError(`Unknown application type: ${t}`, 400, 'VALIDATION_ERROR');
    }
  }
  // Dedupe preserving order
  return [...new Set(list)];
}

function deriveClientTypeFromTypes(
  applicationTypes: string[],
  explicit?: ClientType,
): ClientType {
  if (explicit === 'public' || explicit === 'confidential') return explicit;
  // Backend service → confidential (service account); client-facing only → public
  if (applicationTypes.includes('backend-service')) return 'confidential';
  return 'public';
}

export interface ListApplicationsQuery {
  q?: string;
  filter?: 'all' | 'mine' | 'favorites' | 'recents';
  userId: string;
  tenantId: string | null;
  roles: string[];
  limit?: number;
}

export type OntologyResourceKind =
  | 'object_type'
  | 'action_type'
  | 'function'
  | 'interface';

export interface OntologyResourceDto {
  id: string;
  kind: OntologyResourceKind;
  apiName: string;
  displayName: string;
  icon: Record<string, unknown>;
  status: string;
  parentApiName: string | null;
  hasNoResources: boolean;
  sortOrder: number;
  metadata: Record<string, unknown>;
}

export interface PlatformSdkDto {
  scopes: Array<{ scope: string; enabled: boolean }>;
  projectGrants: Array<{
    projectId: string;
    projectName: string;
    projectRid: string | null;
    description: string;
    iconClass: string;
    href: string | null;
  }>;
}

export interface ProjectCatalogItem {
  id: string;
  name: string;
  description: string;
  href: string | null;
  projectRid: string | null;
  iconClass: string;
}

/** Catalog of Platform SDK operation scopes (matches FE PlatformSdkPage). */
export const PLATFORM_SCOPE_CATALOG: Array<{ scope: string; group: string; label: string }> = [
  { scope: 'api:use-ontologies-read', group: 'Ontologies API', label: 'Ontologies read permission' },
  { scope: 'api:use-ontologies-write', group: 'Ontologies API', label: 'Ontologies write permission' },
  { scope: 'api:use-mediasets-read', group: 'Media sets API', label: 'Media sets read permission' },
  { scope: 'api:use-mediasets-write', group: 'Media sets API', label: 'Media sets write permission' },
  { scope: 'api:use-mediasets-transform', group: 'Media sets API', label: 'Media sets transform permission' },
  { scope: 'api:use-aip-agents-read', group: 'AIP Chatbots API', label: 'AIP Chatbots read permission' },
  { scope: 'api:use-aip-agents-write', group: 'AIP Chatbots API', label: 'AIP Chatbots write permission' },
  { scope: 'api:use-admin-read', group: 'Admin API', label: 'Admin read permission' },
  { scope: 'api:use-admin-write', group: 'Admin API', label: 'Admin write permission' },
  { scope: 'api:use-audit-read', group: 'Audit API', label: 'Audit read permission' },
  { scope: 'api:use-datasets-read', group: 'Datasets API', label: 'Datasets read permission' },
  { scope: 'api:use-datasets-write', group: 'Datasets API', label: 'Datasets write permission' },
  { scope: 'api:use-filesystem-read', group: 'Filesystem API', label: 'Filesystem read permission' },
  { scope: 'api:use-filesystem-write', group: 'Filesystem API', label: 'Filesystem write permission' },
  { scope: 'api:use-sql-queries-read', group: 'SQL Queries API', label: 'SQL queries read permission' },
  { scope: 'api:use-sql-queries-execute', group: 'SQL Queries API', label: 'SQL queries execute permission' },
  { scope: 'api:use-ontology-mcp-read', group: 'Ontology MCP API', label: 'Ontology MCP read permission' },
  { scope: 'api:use-connectivity-read', group: 'Connectivity API', label: 'Connectivity read permission' },
  { scope: 'api:use-connectivity-write', group: 'Connectivity API', label: 'Connectivity write permission' },
  { scope: 'api:use-connectivity-execute', group: 'Connectivity API', label: 'Connectivity execute permission' },
  { scope: 'api:use-orchestration-read', group: 'Orchestration API', label: 'Orchestration read permission' },
  { scope: 'api:use-orchestration-write', group: 'Orchestration API', label: 'Orchestration write permission' },
  { scope: 'api:use-streams-read', group: 'Streams API', label: 'Streams read permission' },
  { scope: 'api:use-streams-write', group: 'Streams API', label: 'Streams write permission' },
  { scope: 'api:use-notepad-export', group: 'Notepad API', label: 'Notepad export permission' },
  { scope: 'api:use-notepad-write', group: 'Notepad API', label: 'Notepad write permission' },
  { scope: 'api:use-models-read', group: 'Models API', label: 'Models read permission' },
  { scope: 'api:use-models-write', group: 'Models API', label: 'Models write permission' },
  { scope: 'api:use-models-execute', group: 'Models API', label: 'Models execute permission' },
  { scope: 'api:use-language-models-execute', group: 'Language Models API', label: 'Language models run inference permission' },
  { scope: 'api:use-checkpoints-read', group: 'Checkpoints API', label: 'Checkpoints read permission' },
  { scope: 'api:use-comments-read', group: 'Comments API', label: 'Comments read permission' },
  { scope: 'api:use-data-health-read', group: 'Data Health API', label: 'Data health read permission' },
  { scope: 'api:use-data-health-write', group: 'Data Health API', label: 'Data health write permission' },
];

const DEFAULT_PROJECT_CATALOG: ProjectCatalogItem[] = [
  {
    id: 'hello-world',
    name: 'Hello world',
    description: 'Learn about the platform',
    href: null,
    projectRid: 'ri.compass.main.folder.967806cc-581e-4345-a362-d42d8672cf4b',
    iconClass: 'resource-icon__project__mypxcb',
  },
  {
    id: 'aip-now-ontology',
    name: 'AIP Now Ontology',
    description:
      'The AIP Now Ontology is a starter pack that includes a comprehensive Ontology populated with various data sources and objects, based on real-world concepts from the airline industry.',
    href: null,
    projectRid: 'ri.compass.main.folder.4e3ad46c-6702-45f5-94a6-75e2aeeef0cb',
    iconClass: 'resource-icon__marketplace-project__mypxcb',
  },
];

function iso(v: Date | string): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(v).toISOString();
}

function makeRid(uuid: string): string {
  return `${APP_RID_PREFIX}${uuid}`;
}

function makeClientId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function toDto(row: DeveloperApplicationRow, favorite: boolean, clientSecret?: string): DeveloperApplicationDto {
  const dto: DeveloperApplicationDto = {
    id: row.rid,
    uuid: row.id,
    name: row.name,
    description: row.description ?? '',
    clientId: row.client_id,
    clientType: row.client_type,
    organizationName: row.organization_name,
    locationPath: row.location_path ?? '',
    projectName: row.project_name ?? '',
    projectRid: row.project_rid,
    creatorName: row.creator_name,
    creatorId: row.creator_id,
    lastEditedBy: row.last_edited_by,
    lastModifiedAt: iso(row.last_modified_at),
    organizationCount: row.organization_count ?? 1,
    favorite,
    logoUrl: row.logo_url,
    resourceRestrictions: row.resource_restrictions,
    operationRestrictions: row.operation_restrictions,
    markingRestrictions: row.marking_restrictions,
    permissionMode: row.permission_mode,
    applicationTypes: row.application_types ?? [],
    grantTypes: row.grant_types ?? [],
    tenantId: row.tenant_id,
    rowVersion: Number(row.row_version ?? 1),
    identityState: row.identity_state ?? 'ready',
  };
  if (clientSecret) dto.clientSecret = clientSecret;
  return dto;
}

function parseApplicationKey(applicationId: string): { rid?: string; uuid?: string } {
  let decoded = applicationId;
  try {
    decoded = decodeURIComponent(applicationId);
  } catch {
    decoded = applicationId;
  }
  if (decoded.startsWith(APP_RID_PREFIX)) {
    return { rid: decoded, uuid: decoded.slice(APP_RID_PREFIX.length) };
  }
  // bare uuid
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) {
    return { uuid: decoded, rid: makeRid(decoded) };
  }
  return { rid: decoded };
}

export class DeveloperConsoleService {
  constructor(private readonly knex: Knex) {}

  private async tableReady(): Promise<boolean> {
    const row = await this.knex.raw(
      `SELECT to_regclass('public.third_party_applications') IS NOT NULL AS exists`,
    );
    return Boolean(row?.rows?.[0]?.exists);
  }

  private async requireTable(): Promise<void> {
    if (!(await this.tableReady())) {
      throw new AppError(
        'Developer Console schema not migrated (third_party_applications missing)',
        503,
        'SCHEMA_NOT_READY',
      );
    }
  }

  async listApplications(query: ListApplicationsQuery): Promise<DeveloperApplicationDto[]> {
    await this.requireTable();
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);

    let q = this.knex<DeveloperApplicationRow>('third_party_applications as a')
      .select('a.*')
      .select(
        this.knex.raw(
          `EXISTS (
            SELECT 1 FROM tpa_favorites f
            WHERE f.application_id = a.id AND f.user_id = ?
          ) AS is_favorite`,
          [query.userId],
        ),
      )
      .whereNull('a.deleted_at')
      .orderBy('a.last_modified_at', 'desc')
      .limit(limit);

    const actor: DeveloperConsoleActor = {
      userId: query.userId,
      userName: query.userId,
      tenantId: query.tenantId,
      roles: query.roles,
    };
    if (!isDeveloperConsoleSuperadmin(actor)) {
      if (query.tenantId) q = q.andWhere('a.tenant_id', query.tenantId);
      q = q.andWhere(function authorized() {
        this.where('a.creator_id', query.userId).orWhereExists(function member() {
          this.select(this.client.raw('1'))
            .from('tpa_application_members as m')
            .whereRaw('m.application_id = a.id')
            .andWhere('m.principal_id', query.userId);
        });
      });
    }

    if (query.filter === 'mine') {
      // Production: only the authenticated principal's apps (by stable id).
      q = q.andWhere('a.creator_id', query.userId);
    }
    if (query.filter === 'favorites') {
      q = q.whereExists(function fav() {
        this.select(this.client.raw('1'))
          .from('tpa_favorites as f')
          .whereRaw('f.application_id = a.id')
          .andWhere('f.user_id', query.userId);
      });
    }
    if (query.filter === 'recents') {
      q = q.limit(Math.min(limit, 5));
    }
    if (query.q?.trim()) {
      const like = `%${query.q.trim().toLowerCase()}%`;
      q = q.andWhere(function search() {
        this.whereRaw('lower(a.name) like ?', [like])
          .orWhereRaw('lower(a.description) like ?', [like])
          .orWhereRaw('lower(a.location_path) like ?', [like])
          .orWhereRaw('lower(a.creator_name) like ?', [like]);
      });
    }

    const rows = (await q) as Array<DeveloperApplicationRow & { is_favorite: boolean | string }>;
    return rows.map((r) => toDto(r, r.is_favorite === true || r.is_favorite === 't' || r.is_favorite === 'true'));
  }

  async getApplication(applicationId: string, userId: string): Promise<DeveloperApplicationDto> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    const fav = await this.knex('tpa_favorites')
      .where({ application_id: row.id, user_id: userId })
      .first();
    return toDto(row, Boolean(fav));
  }

  private async findRow(applicationId: string): Promise<DeveloperApplicationRow | undefined> {
    const key = parseApplicationKey(applicationId);
    const q = this.knex<DeveloperApplicationRow>('third_party_applications').whereNull('deleted_at');
    if (key.uuid) {
      const byId = await q.clone().where({ id: key.uuid }).first();
      if (byId) return byId;
    }
    if (key.rid) {
      const byRid = await q.clone().where({ rid: key.rid }).first();
      if (byRid) return byRid;
    }
    // name fallback (route sometimes used short names in prototypes)
    return q.clone().where({ name: applicationId }).first();
  }

  async createApplication(input: CreateApplicationInput): Promise<DeveloperApplicationDto> {
    await this.requireTable();
    const name = (input.name ?? '').trim();
    if (!name) throw new AppError('Name is required', 400, 'VALIDATION_ERROR');
    if (name.length > 255) {
      throw new AppError('Name must be at most 255 characters', 400, 'VALIDATION_ERROR');
    }

    const applicationTypes = normalizeApplicationTypes(
      input.applicationTypes?.length ? input.applicationTypes : ['client-facing'],
    );
    if (applicationTypes.length === 0) {
      throw new AppError('Select at least one application type', 400, 'VALIDATION_ERROR');
    }

    const scopes = [...new Set((input.resourceScopes ?? []).map((s) => s.trim()).filter(Boolean))];
    if (scopes.length > 1000) {
      throw new AppError('SCOPE_LIMIT_EXCEEDED', 400, 'SCOPE_LIMIT_EXCEEDED');
    }

    const redirectUris = normalizeRedirectUris(input.redirectUris);
    const clientType = deriveClientTypeFromTypes(applicationTypes, input.clientType);
    const permissionMode: PermissionMode = input.permissionMode ?? 'user';
    const tenantId = input.tenantId.trim();
    if (!tenantId) {
      throw new AppError('Authenticated tenant is required', 400, 'TENANT_REQUIRED');
    }
    const organizationName = (input.organizationName ?? 'bihire').trim() || 'bihire';
    const projectName = (input.projectName ?? 'Hello world').trim() || 'Hello world';
    const locationPath =
      (input.locationPath ?? '').trim() || `/${organizationName}/${projectName}`;

    const idempotencyKey = input.idempotencyKey?.trim();
    const requestHash = idempotencyRequestHash({
      name,
      description: (input.description ?? '').trim(),
      clientType,
      applicationTypes,
      permissionMode,
      organizationName,
      locationPath,
      projectName,
      projectRid: input.projectRid ?? null,
      redirectUris,
      resourceScopes: scopes,
    });

    if (idempotencyKey) {
      const inserted = await this.knex('tpa_idempotency_keys')
        .insert({
          tenant_id: tenantId,
          principal_id: input.creatorId,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          state: 'in_progress',
        })
        .onConflict(['tenant_id', 'principal_id', 'idempotency_key'])
        .ignore()
        .returning('idempotency_key');

      if (inserted.length === 0) {
        const existing = await this.knex('tpa_idempotency_keys')
          .where({
            tenant_id: tenantId,
            principal_id: input.creatorId,
            idempotency_key: idempotencyKey,
          })
          .first();
        if (!existing || existing.request_hash !== requestHash) {
          throw new AppError(
            'Idempotency key was already used with a different request',
            409,
            'IDEMPOTENCY_KEY_REUSED',
          );
        }
        if (
          existing.state === 'completed' &&
          existing.response_ciphertext &&
          existing.wrapped_dek &&
          existing.kms_adapter &&
          existing.kms_key_id
        ) {
          return decryptIdempotencyResponse<DeveloperApplicationDto>(tenantId, existing);
        }
        const stale = Date.now() - new Date(existing.updated_at).getTime() > 5 * 60_000;
        if (existing.state === 'in_progress' && !stale) {
          throw new AppError(
            'An application create request with this idempotency key is still in progress',
            409,
            'IDEMPOTENCY_IN_PROGRESS',
          );
        }
        await this.knex('tpa_idempotency_keys')
          .where({
            tenant_id: tenantId,
            principal_id: input.creatorId,
            idempotency_key: idempotencyKey,
          })
          .update({ state: 'in_progress', error_code: null, updated_at: new Date() });
      }
    }

    try {

    // Soft uniqueness: same creator cannot re-create the same display name while active
    const nameClash = await this.knex<DeveloperApplicationRow>('third_party_applications')
      .whereNull('deleted_at')
      .andWhere({ tenant_id: tenantId, creator_id: input.creatorId })
      .andWhereRaw('lower(name) = lower(?)', [name])
      .first();
    if (nameClash) {
      throw new AppError(
        `You already have an application named "${name}"`,
        409,
        'APPLICATION_NAME_CONFLICT',
      );
    }

    const uuid = crypto.randomUUID();
    const rid = makeRid(uuid);
    const clientId = makeClientId();
    const now = new Date();

    let keycloakClientUuid: string | null = null;
    let clientSecret: string | undefined;
    let kcProvisioned = false;

    try {
      const kc = getKeycloakAdminService();
      const created = await kc.createClient({
        clientId,
        name,
        publicClient: clientType === 'public',
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: clientType === 'confidential',
        redirectUris,
      });
      if (!created?.id) {
        throw new AppError(
          'OAuth client provisioning returned no client id',
          502,
          'OAUTH_CLIENT_PROVISION_FAILED',
        );
      }
      keycloakClientUuid = created.id;
      kcProvisioned = true;
      if (clientType === 'confidential') {
        clientSecret = await kc.getClientSecret(created.id);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (requireKeycloakForTpa()) {
        throw new AppError(
          'Failed to provision OAuth client in identity provider',
          502,
          'OAUTH_CLIENT_PROVISION_FAILED',
        );
      }
      // Dev-only fallback when Keycloak is unavailable
      if (clientType === 'confidential') {
        clientSecret = `plntr:${crypto.randomBytes(27).toString('base64url')}`;
      }
    }

    const grantTypes =
      clientType === 'confidential'
        ? ['authorization_code', 'client_credentials']
        : ['authorization_code'];

    try {
      await this.knex.transaction(async (trx) => {
        await trx('third_party_applications').insert({
          id: uuid,
          rid,
          name,
          description: (input.description ?? '').trim(),
          client_id: clientId,
          client_type: clientType,
          keycloak_client_uuid: keycloakClientUuid,
          tenant_id: tenantId,
          organization_name: organizationName,
          location_path: locationPath,
          project_name: projectName,
          project_rid: input.projectRid ?? null,
          creator_id: input.creatorId,
          creator_name: input.creatorName,
          last_edited_by: input.creatorName,
          last_modified_at: now,
          organization_count: 1,
          permission_mode: permissionMode,
          application_types: applicationTypes,
          grant_types: grantTypes,
          identity_state: keycloakClientUuid ? 'ready' : 'error',
          identity_error: keycloakClientUuid ? null : 'Identity provider client was not provisioned',
        });

        await trx('tpa_application_members').insert({
          application_id: uuid,
          tenant_id: tenantId,
          principal_id: input.creatorId,
          role: 'owner',
          granted_by: input.creatorId,
        });

        if (redirectUris.length) {
          await trx('tpa_redirect_uris').insert(
            redirectUris.map((uri) => ({
              application_id: uuid,
              uri,
            })),
          );
        }

        const scopesToInsert =
          scopes.length > 0 ? scopes : ['api:use-ontologies-read'];
        await trx('tpa_operation_scopes').insert(
          scopesToInsert.map((scope) => ({
            application_id: uuid,
            scope,
            enabled: true,
          })),
        );

        await trx('tpa_audit_events').insert({
          tenant_id: tenantId,
          application_id: uuid,
          actor_id: input.creatorId,
          actor_name: input.creatorName,
          action: 'application.create',
          result: 'SUCCESS',
          details: {
            rid,
            clientType,
            permissionMode,
            applicationTypes,
          },
        });
      });
    } catch (err) {
      // Compensate: remove Keycloak client if DB write failed after provision
      if (kcProvisioned && keycloakClientUuid) {
        try {
          await getKeycloakAdminService().deleteClient(keycloakClientUuid);
        } catch {
          // best-effort cleanup
        }
      }
      if (err instanceof AppError) throw err;
      // Unique violation on client_id / rid
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        throw new AppError('Application already exists', 409, 'CONFLICT');
      }
      throw new AppError('Failed to persist application', 500, 'CREATE_FAILED');
    }

    const row = await this.findRow(rid);
    if (!row) throw new AppError('Failed to create application', 500, 'CREATE_FAILED');
    const response = toDto(row, false, clientSecret);
    if (idempotencyKey) {
      const encrypted = await encryptIdempotencyResponse(tenantId, response);
      await this.knex('tpa_idempotency_keys')
        .where({
          tenant_id: tenantId,
          principal_id: input.creatorId,
          idempotency_key: idempotencyKey,
        })
        .update({
          state: 'completed',
          application_id: row.id,
          response_ciphertext: encrypted.responseCiphertext,
          wrapped_dek: encrypted.wrappedDek,
          kms_adapter: encrypted.kmsAdapter,
          kms_key_id: encrypted.kmsKeyId,
          updated_at: new Date(),
        });
    }
    return response;
    } catch (err) {
      if (idempotencyKey) {
        await this.knex('tpa_idempotency_keys')
          .where({
            tenant_id: tenantId,
            principal_id: input.creatorId,
            idempotency_key: idempotencyKey,
          })
          .update({
            state: 'failed',
            error_code: err instanceof AppError ? err.code : 'CREATE_FAILED',
            updated_at: new Date(),
          });
      }
      throw err;
    }
  }

  async patchApplication(
    applicationId: string,
    userId: string,
    userName: string,
    patch: Partial<{
      name: string;
      description: string;
      organizationName: string;
      locationPath: string;
      projectName: string;
      projectRid: string | null;
      logoUrl: string | null;
    }>,
    expectedVersion?: number,
  ): Promise<DeveloperApplicationDto> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');

    const updates: Record<string, unknown> = {
      last_edited_by: userName,
      last_modified_at: new Date(),
    };
    if (patch.name !== undefined) updates.name = patch.name.trim() || row.name;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.organizationName !== undefined) updates.organization_name = patch.organizationName;
    if (patch.locationPath !== undefined) updates.location_path = patch.locationPath;
    if (patch.projectName !== undefined) updates.project_name = patch.projectName;
    if (patch.projectRid !== undefined) updates.project_rid = patch.projectRid;
    if (patch.logoUrl !== undefined) updates.logo_url = patch.logoUrl;

    updates.row_version = this.knex.raw('row_version + 1');
    await this.knex.transaction(async (trx) => {
      let query = trx('third_party_applications').where({ id: row.id });
      if (expectedVersion !== undefined) query = query.andWhere({ row_version: expectedVersion });
      const updated = await query.update(updates);
      if (updated !== 1) {
        throw new AppError('Application was modified by another request', 412, 'PRECONDITION_FAILED');
      }
      await trx('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: userId,
        actor_name: userName,
        action: 'application.update',
        result: 'SUCCESS',
        details: { fields: Object.keys(patch), previousVersion: Number(row.row_version) },
      });
    });
    return this.getApplication(row.rid, userId);
  }

  async deleteApplication(
    applicationId: string,
    actor: DeveloperConsoleActor,
    expectedVersion?: number,
  ): Promise<void> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');

    let identityDeleteError: string | null = null;
    if (row.keycloak_client_uuid) {
      try {
        await getKeycloakAdminService().deleteClient(row.keycloak_client_uuid);
      } catch (err) {
        identityDeleteError = err instanceof Error ? err.message : String(err);
      }
    }

    await this.knex.transaction(async (trx) => {
      let query = trx('third_party_applications').where({ id: row.id });
      if (expectedVersion !== undefined) query = query.andWhere({ row_version: expectedVersion });
      const updated = await query.update({
        deleted_at: new Date(),
        last_modified_at: new Date(),
        row_version: trx.raw('row_version + 1'),
        identity_state: identityDeleteError ? 'delete_pending' : 'ready',
        identity_error: identityDeleteError,
      });
      if (updated !== 1) {
        throw new AppError('Application was modified by another request', 412, 'PRECONDITION_FAILED');
      }
      if (identityDeleteError) {
        await trx('tpa_reconciliation_jobs').insert({
          tenant_id: row.tenant_id,
          application_id: row.id,
          job_type: 'identity_delete',
          payload: { keycloakClientUuid: row.keycloak_client_uuid },
          last_error: identityDeleteError,
        });
      }
      await trx('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: actor.userId,
        actor_name: actor.userName,
        action: 'application.delete',
        result: 'SUCCESS',
        request_id: actor.requestId,
        details: { identityReconciliationRequired: Boolean(identityDeleteError) },
      });
    });
  }

  async toggleFavorite(applicationId: string, userId: string): Promise<DeveloperApplicationDto> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');

    const existing = await this.knex('tpa_favorites')
      .where({ application_id: row.id, user_id: userId })
      .first();

    if (existing) {
      await this.knex('tpa_favorites').where({ application_id: row.id, user_id: userId }).del();
    } else {
      await this.knex('tpa_favorites').insert({ application_id: row.id, user_id: userId });
    }
    return this.getApplication(row.rid, userId);
  }

  async listApplicationMembers(applicationId: string) {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    const members = await this.knex('tpa_application_members')
      .where({ application_id: row.id, tenant_id: row.tenant_id })
      .orderByRaw("CASE role WHEN 'owner' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END")
      .orderBy('principal_id');
    return members.map((member: {
      principal_id: string;
      role: string;
      granted_by: string;
      created_at: Date | string;
      updated_at: Date | string;
    }) => ({
      principalId: member.principal_id,
      role: member.role,
      grantedBy: member.granted_by,
      createdAt: iso(member.created_at),
      updatedAt: iso(member.updated_at),
    }));
  }

  async putApplicationMembers(
    applicationId: string,
    actor: DeveloperConsoleActor,
    members: Array<{ principalId: string; role: 'viewer' | 'editor' | 'owner' }>,
    expectedVersion?: number,
  ) {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    const deduped = new Map(members.map((member) => [member.principalId, member]));
    deduped.set(row.creator_id, { principalId: row.creator_id, role: 'owner' });

    await this.knex.transaction(async (trx) => {
      await trx('tpa_application_members').where({ application_id: row.id }).del();
      await trx('tpa_application_members').insert(
        [...deduped.values()].map((member) => ({
          application_id: row.id,
          tenant_id: row.tenant_id,
          principal_id: member.principalId,
          role: member.role,
          granted_by: actor.userId,
        })),
      );
      let update = trx('third_party_applications').where({ id: row.id });
      if (expectedVersion !== undefined) update = update.andWhere({ row_version: expectedVersion });
      const updated = await update.update({
        row_version: trx.raw('row_version + 1'),
        last_modified_at: new Date(),
        last_edited_by: actor.userName,
      });
      if (updated !== 1) {
        throw new AppError('Application was modified by another request', 412, 'PRECONDITION_FAILED');
      }
      await trx('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: actor.userId,
        actor_name: actor.userName,
        action: 'application.members.replace',
        result: 'SUCCESS',
        request_id: actor.requestId,
        details: { members: [...deduped.values()] },
      });
    });
    return this.listApplicationMembers(applicationId);
  }

  async listApplicationAudit(applicationId: string, requestedLimit?: number) {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    const limit = Math.min(Math.max(requestedLimit ?? 100, 1), 500);
    const events = await this.knex('tpa_audit_events')
      .where({ application_id: row.id, tenant_id: row.tenant_id })
      .orderBy('id', 'desc')
      .limit(limit);
    return events.map((event: {
      event_id: string;
      actor_id: string;
      actor_name: string;
      action: string;
      result: string;
      request_id: string | null;
      details: Record<string, unknown>;
      created_at: Date | string;
    }) => ({
      eventId: event.event_id,
      actorId: event.actor_id,
      actorName: event.actor_name,
      action: event.action,
      result: event.result,
      requestId: event.request_id,
      details: event.details ?? {},
      createdAt: iso(event.created_at),
    }));
  }

  async getOauth(applicationId: string, userId: string) {
    const app = await this.getApplication(applicationId, userId);
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    const uris = await this.knex('tpa_redirect_uris').where({ application_id: row.id }).select('uri');
    return {
      application: app,
      redirectUris: uris.map((u: { uri: string }) => u.uri),
      resourceRestrictions: app.resourceRestrictions,
      operationRestrictions: app.operationRestrictions,
      markingRestrictions: app.markingRestrictions,
      clientType: app.clientType,
      grantTypes: app.grantTypes,
      permissionMode: app.permissionMode,
    };
  }

  async putOauth(
    applicationId: string,
    userId: string,
    userName: string,
    body: {
      redirectUris?: string[];
      resourceRestrictions?: RestrictionLevel;
      operationRestrictions?: RestrictionLevel;
      markingRestrictions?: RestrictionLevel;
    },
    expectedVersion?: number,
  ) {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');

    // P0 semantic parity (gap-analysis §4.2): when resource/operation
    // restrictions are switched from `restricted` → `unrestricted`, Palantir
    // DELETE the existing project/operation configuration and warns loudly,
    // because unrestricted mode trusts the client with everything previously
    // gated. We clear the corresponding rows server-side here so the FE
    // only needs to confirm intent.
    const clearedConfig: { resourceRestrictions?: number; projectGrants?: number; operationScopes?: number } = {};
    await this.knex.transaction(async (trx) => {
      if (body.redirectUris) {
        await trx('tpa_redirect_uris').where({ application_id: row.id }).del();
        if (body.redirectUris.length) {
          await trx('tpa_redirect_uris').insert(
            body.redirectUris.map((uri) => ({ application_id: row.id, uri })),
          );
        }
      }
      const goingUnrestricted = (level: RestrictionLevel | undefined, prior: string | undefined) =>
        level === 'unrestricted' && prior === 'restricted';
      if (goingUnrestricted(body.resourceRestrictions, row.resource_restrictions)) {
        // Resource restriction removed → drop Ontology SDK resource selections.
        const deleted = await trx('tpa_ontology_resources').where({ application_id: row.id }).del();
        if (deleted > 0) clearedConfig.resourceRestrictions = deleted;
      }
      if (goingUnrestricted(body.operationRestrictions, row.operation_restrictions)) {
        const projectGrantsSchema = await trx.raw(
          `SELECT to_regclass('public.tpa_project_grants') IS NOT NULL AS exists`,
        );
        const opScopesSchema = await trx.raw(
          `SELECT to_regclass('public.tpa_operation_scopes') IS NOT NULL AS exists`,
        );
        if (opScopesSchema?.rows?.[0]?.exists) {
          const droppedScopes = await trx('tpa_operation_scopes')
            .where({ application_id: row.id })
            .del();
          if (droppedScopes > 0) clearedConfig.operationScopes = droppedScopes;
        }
        if (projectGrantsSchema?.rows?.[0]?.exists) {
          const droppedProjects = await trx('tpa_project_grants')
            .where({ application_id: row.id })
            .del();
          if (droppedProjects > 0) clearedConfig.projectGrants = droppedProjects;
        }
      }
      const updates: Record<string, unknown> = {
        last_edited_by: userName,
        last_modified_at: new Date(),
        row_version: trx.raw('row_version + 1'),
      };
      if (body.resourceRestrictions) updates.resource_restrictions = body.resourceRestrictions;
      if (body.operationRestrictions) updates.operation_restrictions = body.operationRestrictions;
      if (body.markingRestrictions) updates.marking_restrictions = body.markingRestrictions;
      let query = trx('third_party_applications').where({ id: row.id });
      if (expectedVersion !== undefined) query = query.andWhere({ row_version: expectedVersion });
      const updated = await query.update(updates);
      if (updated !== 1) {
        throw new AppError('Application was modified by another request', 412, 'PRECONDITION_FAILED');
      }
      await trx('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: userId,
        actor_name: userName,
        action: 'oauth.update',
        result: 'SUCCESS',
        details: {
          redirectUriCount: body.redirectUris?.length,
          resourceRestrictions: body.resourceRestrictions,
          operationRestrictions: body.operationRestrictions,
          markingRestrictions: body.markingRestrictions,
          clearedConfig,
        },
      });
    });

    return this.getOauth(applicationId, userId);
  }

  async rotateSecret(
    applicationId: string,
    actor: DeveloperConsoleActor,
    expectedVersion?: number,
  ): Promise<{ clientId: string; clientSecret: string }> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    if (row.client_type !== 'confidential') {
      throw new AppError('Public clients have no secret', 400, 'PUBLIC_CLIENT');
    }
    if (!row.keycloak_client_uuid) {
      throw new AppError(
        'Application is not linked to an identity-provider client',
        409,
        'IDENTITY_CLIENT_NOT_PROVISIONED',
      );
    }
    let secret: string;
    try {
      secret = await getKeycloakAdminService().regenerateClientSecret(row.keycloak_client_uuid);
    } catch (err) {
      await this.knex('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: actor.userId,
        actor_name: actor.userName,
        action: 'oauth.secret.rotate',
        result: 'FAILURE',
        request_id: actor.requestId,
        details: { error: err instanceof Error ? err.message : String(err) },
      });
      throw new AppError('Identity provider secret rotation failed', 502, 'SECRET_ROTATION_FAILED');
    }

    await this.knex.transaction(async (trx) => {
      let query = trx('third_party_applications').where({ id: row.id });
      if (expectedVersion !== undefined) query = query.andWhere({ row_version: expectedVersion });
      const updated = await query.update({
        row_version: trx.raw('row_version + 1'),
        last_modified_at: new Date(),
        last_edited_by: actor.userName,
        identity_state: 'ready',
        identity_error: null,
      });
      if (updated !== 1) {
        throw new AppError('Application was modified by another request', 412, 'PRECONDITION_FAILED');
      }
      await trx('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: actor.userId,
        actor_name: actor.userName,
        action: 'oauth.secret.rotate',
        result: 'SUCCESS',
        request_id: actor.requestId,
        details: { clientId: row.client_id, previousVersion: Number(row.row_version) },
      });
    });
    return { clientId: row.client_id, clientSecret: secret };
  }

  private async sdkVersionsTableReady(): Promise<boolean> {
    const row = await this.knex.raw(
      `SELECT to_regclass('public.tpa_sdk_versions') IS NOT NULL AS exists`,
    );
    return Boolean(row?.rows?.[0]?.exists);
  }

  private packageNameFor(appName: string): string {
    const slug = (appName || 'app')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'app';
    return `@${slug}/sdk`;
  }

  private async listSdkVersions(
    applicationUuid: string,
  ): Promise<Array<{ version: string; status: string; packageName: string; createdAt: string | null; createdBy: string }>> {
    if (!(await this.sdkVersionsTableReady())) return [];
    const versions = await this.knex('tpa_sdk_versions')
      .where({ application_id: applicationUuid })
      .orderBy('created_at', 'desc');
    return versions.map(
      (v: {
        version: string;
        status: string;
        package_name: string;
        created_at: Date | string;
        created_by: string;
      }) => ({
        version: v.version,
        status: v.status,
        packageName: v.package_name,
        createdAt: iso(v.created_at),
        createdBy: v.created_by,
      }),
    );
  }

  async getOntologySdk(applicationId: string): Promise<{
    resources: OntologyResourceDto[];
    versions: Array<{
      version: string;
      status: string;
      packageName?: string;
      createdAt: string | null;
      createdBy?: string;
    }>;
    packageName: string;
    ontologyId: string | null;
    ontologyDisplayName: string | null;
    catalogTotals: {
      objectTypes: number;
      actionTypes: number;
      functions: number;
      interfaces: number;
    };
  }> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');

    const resources = await this.knex('tpa_ontology_resources')
      .where({ application_id: row.id })
      .orderBy(['kind', 'sort_order']);

    const versions = await this.listSdkVersions(row.id);
    const catalog = await this.listOntologyCatalog({ pageSize: 1 });

    const baseSnapshot = resources.map(
      (r: { kind: string; api_name: string; display_name: string; status: string }) => ({
        kind: r.kind,
        apiName: r.api_name,
        displayName: r.display_name,
        status: r.status,
      }),
    );
    const enriched = baseSnapshot.length
      ? await this.enrichResourcesFromOntology(baseSnapshot, catalog.ontologyId)
      : [];
    const enrichedByKey = new Map(enriched.map((e) => [`${e.kind}:${e.apiName}`, e]));

    return {
      resources: resources.map(
        (r: {
          id: string;
          kind: OntologyResourceDto['kind'];
          api_name: string;
          display_name: string;
          icon_json: Record<string, unknown>;
          status: string;
          parent_api_name: string | null;
          has_no_resources: boolean;
          sort_order: number;
          metadata: Record<string, unknown>;
        }) => {
          const om = enrichedByKey.get(`${r.kind}:${r.api_name}`);
          const metadata: Record<string, unknown> = { ...(r.metadata ?? {}) };
          if (om?.properties?.length) {
            metadata.propertyCount = om.properties.length;
            metadata.primaryKey = om.primaryKey ?? null;
          }
          if (om?.parameters?.length) {
            metadata.parameterCount = om.parameters.length;
          }
          if (catalog.ontologyId) metadata.ontologyId = catalog.ontologyId;
          return {
            id: r.id,
            kind: r.kind,
            apiName: r.api_name,
            displayName: om?.displayName ?? r.display_name,
            icon: r.icon_json ?? {},
            status: om?.status ?? r.status,
            parentApiName: r.parent_api_name,
            hasNoResources: r.has_no_resources,
            sortOrder: r.sort_order,
            metadata,
          };
        },
      ),
      versions,
      packageName: this.packageNameFor(row.name),
      ontologyId: catalog.ontologyId,
      ontologyDisplayName: catalog.ontologyDisplayName,
      catalogTotals: catalog.totals,
    };
  }

  private tsIdent(apiName: string): string {
    const s = apiName.replace(/[^A-Za-z0-9_]/g, '_');
    return /^[A-Za-z_]/.test(s) ? s : `_${s}`;
  }

  private mapBaseTypeToTs(base: string, isArray?: boolean): string {
    const b = (base || 'string').toLowerCase();
    let t = 'string';
    if (b === 'integer' || b === 'long' || b === 'double' || b === 'float' || b === 'number') {
      t = 'number';
    } else if (b === 'boolean' || b === 'bool') {
      t = 'boolean';
    } else if (b === 'date' || b === 'timestamp' || b === 'datetime') {
      t = 'string'; // ISO date string
    } else if (b === 'geopoint' || b === 'attachment' || b === 'media') {
      t = 'unknown';
    }
    return isArray ? `${t}[]` : t;
  }

  /**
   * Enrich selected resources with full OM schema (properties / action params).
   * Mirrors Foundry OSDK codegen inputs from Ontology Manager.
   */
  private async enrichResourcesFromOntology(
    resources: Array<{ kind: string; apiName: string; displayName: string; status?: string }>,
    ontologyId: string | null,
  ): Promise<
    Array<{
      kind: string;
      apiName: string;
      displayName: string;
      status?: string;
      properties?: Array<{
        apiName: string;
        displayName: string;
        baseType: string;
        required: boolean;
        isArray: boolean;
        tsType: string;
      }>;
      parameters?: Array<{
        apiName: string;
        displayName: string;
        type: string;
        required: boolean;
        tsType: string;
      }>;
      primaryKey?: string | null;
    }>
  > {
    const out: Array<{
      kind: string;
      apiName: string;
      displayName: string;
      status?: string;
      properties?: Array<{
        apiName: string;
        displayName: string;
        baseType: string;
        required: boolean;
        isArray: boolean;
        tsType: string;
      }>;
      parameters?: Array<{
        apiName: string;
        displayName: string;
        type: string;
        required: boolean;
        tsType: string;
      }>;
      primaryKey?: string | null;
    }> = [];

    for (const r of resources) {
      const entry: (typeof out)[0] = {
        kind: r.kind,
        apiName: r.apiName,
        displayName: r.displayName,
        status: r.status,
      };

      if (r.kind === 'object_type') {
        try {
          const otQuery = this.knex('object_type').where({ api_name: r.apiName });
          if (ontologyId && String(ontologyId).includes('-')) {
            otQuery.andWhere({ ontology_id: ontologyId });
          }
          const ot = await otQuery.first();
          if (ot) {
            entry.displayName = ot.display_name ?? r.displayName;
            entry.status = ot.status ?? r.status;
            const props = await this.knex('property')
              .where({ object_type_id: ot.object_type_id })
              .orderBy('ordinal', 'asc');
            const primaryKeyProperty = props.find(
              (p: { property_id?: string }) =>
                ot.primary_key_property_id != null &&
                String(p.property_id) === String(ot.primary_key_property_id),
            );
            entry.properties = props.map(
              (p: {
                property_id: string;
                api_name: string;
                display_name: string;
                base_type: string;
                is_required: boolean;
                is_array: boolean;
              }) => ({
                apiName: p.api_name,
                displayName: p.display_name ?? p.api_name,
                baseType: p.base_type ?? 'string',
                required: Boolean(p.is_required),
                isArray: Boolean(p.is_array),
                tsType: this.mapBaseTypeToTs(p.base_type, p.is_array),
              }),
            );
            // Ontology Manager is authoritative for the primary key. The
            // fallback only supports older rows created before that FK was
            // populated.
            entry.primaryKey =
              primaryKeyProperty?.api_name ??
              entry.properties.find((p) => p.required)?.apiName ??
              entry.properties[0]?.apiName ??
              null;
          }
        } catch {
          // leave without properties
        }
      }

      if (r.kind === 'action_type') {
        try {
          const actQuery = this.knex('action_type').where({ api_name: r.apiName });
          if (ontologyId && String(ontologyId).includes('-')) {
            actQuery.andWhere({ ontology_id: ontologyId });
          }
          const act = await actQuery.first();
          if (act) {
            entry.displayName = act.display_name ?? r.displayName;
            const params = Array.isArray(act.parameters) ? act.parameters : [];
            entry.parameters = params.map(
              (p: {
                apiName?: string;
                api_name?: string;
                displayName?: string;
                display_name?: string;
                type?: string;
                required?: boolean;
              }) => {
                const apiName = String(p.apiName ?? p.api_name ?? 'param');
                const type = String(p.type ?? 'string');
                return {
                  apiName,
                  displayName: String(p.displayName ?? p.display_name ?? apiName),
                  type,
                  required: Boolean(p.required),
                  tsType: this.mapBaseTypeToTs(type, false),
                };
              },
            );
          }
        } catch {
          // leave without params
        }
      }

      if (r.kind === 'interface') {
        try {
          const ifQuery = this.knex('interface').where({ api_name: r.apiName });
          if (ontologyId && String(ontologyId).includes('-')) {
            ifQuery.andWhere({ ontology_id: ontologyId });
          }
          const iface = await ifQuery.first();
          if (iface) {
            entry.displayName = iface.display_name ?? r.displayName;
            entry.status = iface.status ?? r.status;
          }
        } catch {
          // leave as-is
        }
      }

      if (r.kind === 'function') {
        try {
          const fnQuery = this.knex('ontology_function').where({ api_name: r.apiName });
          if (ontologyId && String(ontologyId).includes('-')) {
            fnQuery.andWhere({ ontology_id: ontologyId });
          }
          const fn = await fnQuery.first();
          if (fn) {
            entry.displayName = fn.display_name ?? r.displayName;
            entry.status = fn.status ?? r.status;
          }
        } catch {
          // leave as-is
        }
      }

      out.push(entry);
    }
    return out;
  }

  private buildOsdkRuntimeSource(ontologyId: string | null): string {
    return `export interface TellusOsdkRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
  expectedVersion?: number;
}

export interface TellusOsdkClientConfig {
  baseUrl: string;
  accessToken?: string;
  getAccessToken?: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retries?: number;
}

export interface TellusOsdkClient {
  objects: {
    list<T = unknown>(objectType: string, query?: Record<string, string | number>, options?: TellusOsdkRequestOptions): Promise<T>;
    get<T = unknown>(objectType: string, primaryKey: string, options?: TellusOsdkRequestOptions): Promise<T>;
    search<T = unknown>(objectType: string, query: unknown, options?: TellusOsdkRequestOptions): Promise<T>;
    aggregate<T = unknown>(objectType: string, query: unknown, options?: TellusOsdkRequestOptions): Promise<T>;
    traverse<T = unknown>(objectType: string, primaryKey: string, linkApiName: string, query?: unknown, options?: TellusOsdkRequestOptions): Promise<T>;
  };
  actions: {
    apply<T = unknown>(actionApiName: string, parameters: unknown, options?: TellusOsdkRequestOptions): Promise<T>;
  };
  functions: {
    invoke<T = unknown>(functionApiName: string, parameters: unknown, options?: TellusOsdkRequestOptions): Promise<T>;
  };
}

export class TellusOsdkError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "TellusOsdkError";
  }
}

function encode(value: string): string { return encodeURIComponent(value); }

export function createTellusOsdkClient(config: TellusOsdkClientConfig): TellusOsdkClient {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("A Fetch API implementation is required");
  const baseUrl = config.baseUrl.replace(/\\/$/, "");
  const timeoutMs = Math.max(100, config.timeoutMs ?? 30_000);
  const maxRetries = Math.min(Math.max(config.retries ?? 2, 0), 5);

  async function request<T>(method: string, path: string, body?: unknown, options: TellusOsdkRequestOptions = {}): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("OSDK request timed out")), timeoutMs);
      const abort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const token = config.getAccessToken ? await config.getAccessToken() : config.accessToken;
        const response = await fetchImpl(baseUrl + path, {
          method,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(token ? { Authorization: "Bearer " + token } : {}),
            ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
            ...(options.expectedVersion !== undefined ? { "If-Match": '"v' + options.expectedVersion + '"' } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        const payload = text ? JSON.parse(text) : undefined;
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(100 * 2 ** attempt, 2_000)));
            continue;
          }
          throw new TellusOsdkError(
            payload?.message ?? "Tellus request failed",
            response.status,
            payload?.errorCode ?? payload?.error?.code ?? "REQUEST_FAILED",
            payload?.details ?? payload?.error,
          );
        }
        return (payload?.data ?? payload) as T;
      } catch (error) {
        lastError = error;
        if (error instanceof TellusOsdkError || attempt >= maxRetries || options.signal?.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(100 * 2 ** attempt, 2_000)));
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      }
    }
    throw lastError;
  }

  return {
    objects: {
      list: <T>(objectType: string, query: Record<string, string | number> = {}, options?: TellusOsdkRequestOptions) => {
        const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
        return request<T>("GET", "/api/v1/objects/" + encode(objectType) + (params.size ? "?" + params : ""), undefined, options);
      },
      get: <T>(objectType: string, primaryKey: string, options?: TellusOsdkRequestOptions) =>
        request<T>("GET", "/api/v1/objects/" + encode(objectType) + "/" + encode(primaryKey), undefined, options),
      search: <T>(objectType: string, query: unknown, options?: TellusOsdkRequestOptions) =>
        request<T>("POST", "/api/v1/objects/" + encode(objectType) + "/search", query, options),
      aggregate: <T>(objectType: string, query: unknown, options?: TellusOsdkRequestOptions) =>
        request<T>("POST", "/api/v1/objects/" + encode(objectType) + "/aggregate", query, options),
      traverse: <T>(objectType: string, primaryKey: string, linkApiName: string, query: unknown = {}, options?: TellusOsdkRequestOptions) =>
        request<T>("POST", "/api/v1/objects/" + encode(objectType) + "/" + encode(primaryKey) + "/searchAround/" + encode(linkApiName), query, options),
    },
    actions: {
      apply: <T>(actionApiName: string, parameters: unknown, options?: TellusOsdkRequestOptions) =>
        request<T>("POST", "/api/v1/ontology/" + encode(${JSON.stringify(ontologyId ?? 'default')}) + "/actions/" + encode(actionApiName) + "/apply", { parameters, ...(options?.expectedVersion === undefined ? {} : { $expectedVersion: options.expectedVersion }) }, options),
    },
    functions: {
      invoke: <T>(functionApiName: string, parameters: unknown, options?: TellusOsdkRequestOptions) =>
        request<T>("POST", "/api/v1/ontology/" + encode(${JSON.stringify(ontologyId ?? 'default')}) + "/functions/" + encode(functionApiName) + "/invoke", { parameters }, options),
    },
  };
}
`;
  }

  private buildOsdkPackageFiles(opts: {
    packageName: string;
    version: string;
    clientId: string;
    appName: string;
    ontologyId: string | null;
    resources: Array<{
      kind: string;
      apiName: string;
      displayName: string;
      status?: string;
      properties?: Array<{
        apiName: string;
        displayName: string;
        baseType: string;
        required: boolean;
        isArray: boolean;
        tsType: string;
      }>;
      parameters?: Array<{
        apiName: string;
        displayName: string;
        type: string;
        required: boolean;
        tsType: string;
      }>;
      primaryKey?: string | null;
    }>;
  }): Record<string, string> {
    const files: Record<string, string> = {};
    const objectExports: string[] = [];
    const actionExports: string[] = [];
    const interfaceExports: string[] = [];
    const functionExports: string[] = [];

    for (const r of opts.resources) {
      const ident = this.tsIdent(r.apiName);
      if (r.kind === 'object_type') {
        const props = r.properties ?? [];
        const primaryKeyType =
          props.find((p) => p.apiName === r.primaryKey)?.tsType ??
          'string | number';
        const propLines = props
          .map(
            (p) =>
              `  /** ${p.displayName}${p.required ? ' (required)' : ''} */\n  ${this.tsIdent(p.apiName)}${p.required ? '' : '?'}: ${p.tsType};`,
          )
          .join('\n');
        const propsMeta = JSON.stringify(
          props.map((p) => ({
            apiName: p.apiName,
            displayName: p.displayName,
            baseType: p.baseType,
            required: p.required,
            isArray: p.isArray,
          })),
          null,
          2,
        );
        const file = `/**
 * Object type: ${r.displayName}
 * apiName: ${r.apiName}
 * Generated from Ontology Manager for Foundry-compatible OSDK clients.
 */
export const ${ident} = {
  type: "object" as const,
  apiName: ${JSON.stringify(r.apiName)},
  displayName: ${JSON.stringify(r.displayName)},
  primaryKey: ${JSON.stringify(r.primaryKey ?? null)},
  properties: ${propsMeta},
} as const;

export type ${ident}Props = {
${propLines || '  // no properties defined in Ontology Manager'}
};

export type ${ident}Object = ${ident}Props & {
  $apiName: ${JSON.stringify(r.apiName)};
  $primaryKey: ${primaryKeyType};
};
`;
        files[`src/ontology/objects/${ident}.ts`] = file;
        objectExports.push(ident);
      } else if (r.kind === 'action_type') {
        const params = r.parameters ?? [];
        const paramLines = params
          .map(
            (p) =>
              `  /** ${p.displayName}${p.required ? ' (required)' : ''} */\n  ${this.tsIdent(p.apiName)}${p.required ? '' : '?'}: ${p.tsType};`,
          )
          .join('\n');
        const file = `/**
 * Action type: ${r.displayName}
 * apiName: ${r.apiName}
 */
export const ${ident} = {
  type: "action" as const,
  apiName: ${JSON.stringify(r.apiName)},
  displayName: ${JSON.stringify(r.displayName)},
  parameters: ${JSON.stringify(
    params.map((p) => ({
      apiName: p.apiName,
      displayName: p.displayName,
      type: p.type,
      required: p.required,
    })),
    null,
    2,
  )},
} as const;

export type ${ident}Params = {
${paramLines || '  // no parameters'}
};
`;
        files[`src/ontology/actions/${ident}.ts`] = file;
        actionExports.push(ident);
      } else {
        const directory = r.kind === 'interface' ? 'interfaces' : 'functions';
        const file = `/** ${r.kind}: ${r.displayName} */\nexport const ${ident} = { type: ${JSON.stringify(r.kind)}, apiName: ${JSON.stringify(r.apiName)}, displayName: ${JSON.stringify(r.displayName)} } as const;\n`;
        files[`src/ontology/${directory}/${ident}.ts`] = file;
        if (r.kind === 'interface') interfaceExports.push(ident);
        else functionExports.push(ident);
      }
    }

    const objectReexports = objectExports
      .map((id) => `export { ${id} } from "./ontology/objects/${id}.js";\nexport type { ${id}Props, ${id}Object } from "./ontology/objects/${id}.js";`)
      .join('\n');
    const actionReexports = actionExports
      .map((id) => `export { ${id} } from "./ontology/actions/${id}.js";\nexport type { ${id}Params } from "./ontology/actions/${id}.js";`)
      .join('\n');
    const interfaceReexports = interfaceExports
      .map((id) => `export { ${id} } from "./ontology/interfaces/${id}.js";`)
      .join('\n');
    const functionReexports = functionExports
      .map((id) => `export { ${id} } from "./ontology/functions/${id}.js";`)
      .join('\n');

    files['src/ontology/objects/index.ts'] =
      objectExports.map((id) => `export * from "./${id}.js";`).join('\n') +
      (objectExports.length ? '\n' : 'export {};\n');
    files['src/ontology/actions/index.ts'] =
      actionExports.map((id) => `export * from "./${id}.js";`).join('\n') +
      (actionExports.length ? '\n' : 'export {};\n');
    files['src/ontology/interfaces/index.ts'] =
      interfaceExports.map((id) => `export * from "./${id}.js";`).join('\n') +
      (interfaceExports.length ? '\n' : 'export {};\n');
    files['src/ontology/functions/index.ts'] =
      functionExports.map((id) => `export * from "./${id}.js";`).join('\n') +
      (functionExports.length ? '\n' : 'export {};\n');

    files['src/ontology/ontologyMetadata.ts'] = `/**
 * Ontology binding for this application SDK.
 */
export const ontologyMetadata = {
  ontologyApiName: "default",
  ontologyRid: ${JSON.stringify(opts.ontologyId)},
  objectTypes: ${JSON.stringify(objectExports)},
  actionTypes: ${JSON.stringify(actionExports)},
} as const;
`;

    files['src/index.ts'] = `/**
 * Auto-generated Ontology SDK for ${opts.appName}
 * Package: ${opts.packageName}@${opts.version}
 * Client ID: ${opts.clientId}
 * Ontology: ${opts.ontologyId ?? 'default'}
 *
 * Foundry-compatible layout:
 *   import { Taxpayer } from "${opts.packageName}";
 *   import type { TaxpayerObject } from "${opts.packageName}";
 */
export const $clientId = ${JSON.stringify(opts.clientId)} as const;
export const $packageName = ${JSON.stringify(opts.packageName)} as const;
export const $version = ${JSON.stringify(opts.version)} as const;
export const $ontologyId = ${JSON.stringify(opts.ontologyId)} as const;

export { ontologyMetadata } from "./ontology/ontologyMetadata.js";
export { createTellusOsdkClient, TellusOsdkError } from "./runtime/client.js";
export type { TellusOsdkClient, TellusOsdkClientConfig, TellusOsdkRequestOptions } from "./runtime/client.js";

${objectReexports}

${actionReexports}

${interfaceReexports}

${functionReexports}

export const $resources = ${JSON.stringify(
      opts.resources.map((r) => ({
        kind: r.kind,
        apiName: r.apiName,
        displayName: r.displayName,
        propertyCount: r.properties?.length ?? 0,
        parameterCount: r.parameters?.length ?? 0,
        primaryKey: r.primaryKey ?? null,
      })),
      null,
      2,
    )} as const;
	`;

    files['src/runtime/client.ts'] = this.buildOsdkRuntimeSource(opts.ontologyId);

    files['package.json'] = JSON.stringify(
      {
        name: opts.packageName,
        version: opts.version,
        private: false,
        license: 'UNLICENSED',
        type: 'module',
        main: './src/index.ts',
        types: './src/index.ts',
        exports: {
          '.': './src/index.ts',
          './ontology/objects/*': './src/ontology/objects/*',
          './ontology/actions/*': './src/ontology/actions/*',
          './ontology/interfaces/*': './src/ontology/interfaces/*',
          './ontology/functions/*': './src/ontology/functions/*',
        },
        tellus: {
          clientId: opts.clientId,
          ontologyId: opts.ontologyId,
          resourceCount: opts.resources.length,
          objectTypes: objectExports,
          actionTypes: actionExports,
          interfaces: interfaceExports,
          functions: functionExports,
        },
      },
      null,
      2,
    );

    files['README.md'] = `# ${opts.packageName}

Generated Ontology SDK for **${opts.appName}** (\`${opts.version}\`).

## Install (local / private registry)

\`\`\`bash
npm install ${opts.packageName}@${opts.version}
\`\`\`

## Usage

\`\`\`ts
import { $clientId, $ontologyId, $resources } from "${opts.packageName}";
${
  objectExports[0]
    ? `import { ${objectExports[0]} } from "${opts.packageName}";
import type { ${objectExports[0]}Object } from "${opts.packageName}";
// const obj: ${objectExports[0]}Object = await client(${objectExports[0]}).fetchOne(primaryKey);`
    : ''
}
\`\`\`

## Contents

- Object types: ${objectExports.length ? objectExports.join(', ') : '(none)'}
- Action types: ${actionExports.length ? actionExports.join(', ') : '(none)'}
- Interfaces: ${interfaceExports.length ? interfaceExports.join(', ') : '(none)'}
- Functions: ${functionExports.length ? functionExports.join(', ') : '(none)'}
- Client ID: \`${opts.clientId}\`
- Ontology: \`${opts.ontologyId ?? 'default'}\`
`;

    return files;
  }

  async generateSdkVersion(
    applicationId: string,
    userId: string,
    userName: string,
    expectedVersion?: number,
  ): Promise<{
    resources: OntologyResourceDto[];
    versions: Array<{
      version: string;
      status: string;
      packageName?: string;
      createdAt: string | null;
      createdBy?: string;
    }>;
    packageName: string;
  }> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');

    if (!(await this.sdkVersionsTableReady())) {
      throw new AppError(
        'SDK versions schema not migrated (tpa_sdk_versions missing)',
        503,
        'SCHEMA_NOT_READY',
      );
    }

    const resources = await this.knex('tpa_ontology_resources')
      .where({ application_id: row.id })
      .orderBy(['kind', 'sort_order']);
    if (!resources.length) {
      throw new AppError(
        'Add Ontology resources before generating an SDK version',
        400,
        'NO_RESOURCES',
      );
    }

    const catalog = await this.listOntologyCatalog();
    const packageName = this.packageNameFor(row.name);
    const baseSnapshot = resources.map(
      (r: { kind: string; api_name: string; display_name: string; status: string }) => ({
        kind: r.kind,
        apiName: r.api_name,
        displayName: r.display_name,
        status: r.status,
      }),
    );
    // Full Foundry-style codegen input: properties + action parameters from OM
    const enriched = await this.enrichResourcesFromOntology(
      baseSnapshot,
      catalog.ontologyId,
    );
    const generated = await this.knex.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
        `tpa-sdk-version:${row.id}`,
      ]);
      const existing = await trx('tpa_sdk_versions')
        .where({ application_id: row.id })
        .select('version');
      const nextMinor = existing.reduce((max: number, item: { version: string }) => {
        const match = /^0\.(\d+)\.0$/.exec(item.version);
        return match ? Math.max(max, Number(match[1]) + 1) : max;
      }, 0);
      const version = `0.${nextMinor}.0`;
      const packageFiles = this.buildOsdkPackageFiles({
        packageName,
        version,
        clientId: row.client_id,
        appName: row.name,
        ontologyId: catalog.ontologyId,
        resources: enriched,
      });
      const [sdkVersion] = await trx('tpa_sdk_versions').insert({
        application_id: row.id,
        version,
        status: 'generating',
        package_name: packageName,
        created_by: userName,
        metadata: JSON.stringify({
          resourceCount: resources.length,
          clientId: row.client_id,
          ontologyId: catalog.ontologyId,
          fileCount: Object.keys(packageFiles).length,
        }),
        package_files: JSON.stringify(packageFiles),
        resource_snapshot: JSON.stringify(enriched),
        ontology_id: catalog.ontologyId,
      }).returning('id');
      const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ packageName, version, resources: enriched }))
        .digest('hex');
      const [buildJob] = await trx('tpa_sdk_build_jobs').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        sdk_version_id: sdkVersion.id,
        state: 'running',
        request_hash: requestHash,
        attempt_count: 1,
        lease_owner: process.env.HOSTNAME ?? `api-${process.pid}`,
        lease_expires_at: trx.raw(`now() + interval '5 minutes'`),
        created_by: userName,
      }).returning('id');
      let update = trx('third_party_applications').where({ id: row.id });
      if (expectedVersion !== undefined) update = update.andWhere({ row_version: expectedVersion });
      const updated = await update.update({
        last_edited_by: userName,
        last_modified_at: new Date(),
        row_version: trx.raw('row_version + 1'),
      });
      if (updated !== 1) {
        throw new AppError('Application was modified by another request', 412, 'PRECONDITION_FAILED');
      }
      await trx('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: userId,
        actor_name: userName,
        action: 'sdk.version.generate',
        result: 'SUCCESS',
        details: { version, packageName, resourceCount: resources.length },
      });
      return {
        sdkVersionId: sdkVersion.id as string,
        buildJobId: buildJob.id as string,
        version,
        packageFiles,
      };
    });
    try {
      const artifact = await new DeveloperConsoleArtifactRegistry(this.knex).publish({
        tenantId: row.tenant_id,
        applicationId: row.id,
        applicationRid: row.rid,
        sdkVersionId: generated.sdkVersionId,
        packageName,
        version: generated.version,
        ontologyId: catalog.ontologyId,
        resourceSnapshot: enriched,
        sourceFiles: generated.packageFiles,
      });
      await this.knex('tpa_sdk_build_jobs').where({ id: generated.buildJobId }).update({
        state: 'published',
        lease_owner: null,
        lease_expires_at: null,
        updated_at: new Date(),
      });
      await this.knex('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: userId,
        actor_name: userName,
        action: 'sdk.artifact.publish',
        result: 'SUCCESS',
        details: {
          version: generated.version,
          digest: artifact.digest,
          size: artifact.tarball.length,
        },
      });
    } catch (err) {
      await this.knex('tpa_sdk_build_jobs').where({ id: generated.buildJobId }).update({
        state: 'failed',
        lease_owner: null,
        lease_expires_at: null,
        next_attempt_at: this.knex.raw(`now() + interval '1 minute'`),
        error_message: err instanceof Error ? err.message : String(err),
        updated_at: new Date(),
      });
      await this.knex('tpa_sdk_versions').where({ id: generated.sdkVersionId }).update({
        status: 'failed',
        metadata: this.knex.raw(`metadata || ?::jsonb`, [
          JSON.stringify({ publishError: err instanceof Error ? err.message : String(err) }),
        ]),
      });
      throw err;
    }
    await this.recordMetric(row.id, 'requests', 1, { op: 'generate_sdk_version' });

    return this.getOntologySdk(applicationId);
  }

  async getSdkVersionPackage(
    applicationId: string,
    version: string,
  ): Promise<{
    version: string;
    packageName: string;
    files: Record<string, string>;
    resourceSnapshot: unknown[];
  }> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    if (!(await this.sdkVersionsTableReady())) {
      throw new AppError('SDK versions schema not ready', 503, 'SCHEMA_NOT_READY');
    }
    const v = await this.knex('tpa_sdk_versions')
      .where({ application_id: row.id, version })
      .first();
    if (!v) throw new AppError('SDK version not found', 404, 'NOT_FOUND');

    const files =
      typeof v.package_files === 'string'
        ? (JSON.parse(v.package_files) as Record<string, string>)
        : ((v.package_files as Record<string, string>) ?? {});
    const rootIndex = files?.['src/index.ts'] ?? '';
    const hasLegacyBrokenExports =
      rootIndex.includes('from "./objects/') ||
      rootIndex.includes('from "./actions/') ||
      rootIndex.includes('from "./interfaces/') ||
      rootIndex.includes('from "./functions/');
    const hasLegacyFlatLayout =
      Object.keys(files ?? {}).length > 0 &&
      !files['src/ontology/ontologyMetadata.ts'];
    if (!Object.keys(files).length || hasLegacyBrokenExports || hasLegacyFlatLayout) {
      throw new AppError(
        'This legacy SDK version predates immutable artifact publication; generate a new version',
        410,
        'LEGACY_ARTIFACT_UNAVAILABLE',
      );
    }

    return {
      version: v.version,
      packageName: v.package_name,
      files,
      resourceSnapshot: (v.resource_snapshot as unknown[]) ?? [],
    };
  }

  async downloadSdkArtifact(
    applicationId: string,
    version: string,
  ): Promise<{ packageName: string; digest: string; tarball: Buffer }> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    return new DeveloperConsoleArtifactRegistry(this.knex).download(row.id, version);
  }

  async getSdkRegistryMetadata(
    applicationId: string,
    tarballBaseUrl: string,
  ): Promise<Record<string, unknown>> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    const versions = await this.knex('tpa_sdk_versions')
      .where({ application_id: row.id, status: 'ready' })
      .whereNotNull('artifact_digest')
      .whereNull('revoked_at')
      .orderBy('created_at', 'asc');
    if (!versions.length) {
      throw new AppError('No published SDK artifacts found', 404, 'ARTIFACT_NOT_FOUND');
    }
    const packageName = String(versions[0].package_name);
    const versionMetadata = Object.fromEntries(
      versions.map((item: Record<string, unknown>) => {
        const version = String(item.version);
        const digest = String(item.artifact_digest);
        return [
          version,
          {
            name: packageName,
            version,
            dist: {
              tarball: `${tarballBaseUrl}/${encodeURIComponent(version)}/tarball`,
              integrity: `sha256-${Buffer.from(digest, 'hex').toString('base64')}`,
            },
            tellus: {
              digest,
              size: Number(item.artifact_size_bytes ?? 0),
              manifest: item.artifact_manifest ?? {},
              publishedAt: item.published_at,
            },
          },
        ];
      }),
    );
    const latest = String(versions[versions.length - 1].version);
    return {
      name: packageName,
      'dist-tags': { latest },
      versions: versionMetadata,
    };
  }

  /**
   * Ontology resource catalog — reads the same tables as Ontology Manager
   * (object_type, action_type, ontology_function, interface).
   */
  async listOntologyCatalog(opts?: {
    pageSize?: number;
    q?: string;
  }): Promise<{
    ontologyId: string | null;
    ontologyDisplayName: string | null;
    objectTypes: Array<{
      apiName: string;
      displayName: string;
      status: string;
      icon: string | null;
      iconColor: string | null;
    }>;
    actionTypes: Array<{ apiName: string; displayName: string; status: string }>;
    functions: Array<{ apiName: string; displayName: string; status: string }>;
    interfaces: Array<{ apiName: string; displayName: string; status: string }>;
    totals: {
      objectTypes: number;
      actionTypes: number;
      functions: number;
      interfaces: number;
    };
  }> {
    const pageSize = Math.min(Math.max(opts?.pageSize ?? 500, 1), 2000);
    const q = (opts?.q ?? '').trim().toLowerCase();
    const empty = {
      ontologyId: null as string | null,
      ontologyDisplayName: null as string | null,
      objectTypes: [] as Array<{
        apiName: string;
        displayName: string;
        status: string;
        icon: string | null;
        iconColor: string | null;
      }>,
      actionTypes: [] as Array<{ apiName: string; displayName: string; status: string }>,
      functions: [] as Array<{ apiName: string; displayName: string; status: string }>,
      interfaces: [] as Array<{ apiName: string; displayName: string; status: string }>,
      totals: { objectTypes: 0, actionTypes: 0, functions: 0, interfaces: 0 },
    };

    try {
      // Prefer Tellus Ontology Manager uuid table ontology via object_type.ontology_id
      let ontologyId: string | null = null;
      let ontologyDisplayName: string | null = null;

      // Standard enterprise ontology id used by OM APIs
      const otHas = await this.knex.raw(
        `SELECT to_regclass('public.object_type') IS NOT NULL AS exists`,
      );
      if (otHas?.rows?.[0]?.exists) {
        const firstOt = await this.knex('object_type').select('ontology_id').first();
        if (firstOt?.ontology_id) {
          ontologyId = String(firstOt.ontology_id);
          ontologyDisplayName = 'Ontology';
        }
      }

      // Display name from ontologies (rid-based) if present
      try {
        const ont = await this.knex('ontologies').select('display_name', 'rid', 'api_name').first();
        if (ont) {
          ontologyDisplayName = String(ont.display_name ?? ont.api_name ?? 'Ontology');
          if (!ontologyId) ontologyId = String(ont.rid ?? ont.api_name);
        }
      } catch {
        // ignore
      }

      empty.ontologyId = ontologyId;
      empty.ontologyDisplayName = ontologyDisplayName;

      const filterQ = <T extends Record<string, unknown>>(rows: T[]): T[] => {
        if (!q) return rows;
        return rows.filter((r) => {
          const api = String(r.api_name ?? r.apiName ?? '').toLowerCase();
          const name = String(r.display_name ?? r.displayName ?? '').toLowerCase();
          return api.includes(q) || name.includes(q);
        });
      };

      // object_type (OM) — primary
      if (otHas?.rows?.[0]?.exists) {
        let query = this.knex('object_type').select(
          'api_name',
          'display_name',
          'status',
          'icon',
          'icon_color',
        );
        if (ontologyId && ontologyId.includes('-')) {
          query = query.where({ ontology_id: ontologyId });
        }
        const ots = await query.orderBy('display_name').limit(pageSize);
        const filtered = filterQ(ots as Array<Record<string, unknown>>);
        empty.objectTypes = filtered.map((r) => ({
          apiName: String(r.api_name),
          displayName: String(r.display_name ?? r.api_name),
          status: String(r.status ?? 'experimental'),
          icon: (r.icon as string | null) ?? null,
          iconColor: (r.icon_color as string | null) ?? null,
        }));
        const cnt = await this.knex('object_type').count<{ count: string }>('* as count').first();
        empty.totals.objectTypes = Number(cnt?.count ?? empty.objectTypes.length);
      }

      // action_type (OM)
      const atHas = await this.knex.raw(
        `SELECT to_regclass('public.action_type') IS NOT NULL AS exists`,
      );
      if (atHas?.rows?.[0]?.exists) {
        let query = this.knex('action_type').select('api_name', 'display_name');
        if (ontologyId && ontologyId.includes('-')) {
          query = query.where({ ontology_id: ontologyId });
        }
        const acts = await query.orderBy('display_name').limit(pageSize);
        empty.actionTypes = filterQ(acts as Array<Record<string, unknown>>).map((r) => ({
          apiName: String(r.api_name),
          displayName: String(r.display_name ?? r.api_name),
          status: 'experimental',
        }));
        const cnt = await this.knex('action_type').count<{ count: string }>('* as count').first();
        empty.totals.actionTypes = Number(cnt?.count ?? empty.actionTypes.length);
      }

      // ontology_function
      const fnHas = await this.knex.raw(
        `SELECT to_regclass('public.ontology_function') IS NOT NULL AS exists`,
      );
      if (fnHas?.rows?.[0]?.exists) {
        let query = this.knex('ontology_function').select('api_name', 'display_name');
        if (ontologyId && ontologyId.includes('-')) {
          query = query.where({ ontology_id: ontologyId });
        }
        const fns = await query.orderBy('display_name').limit(pageSize);
        empty.functions = filterQ(fns as Array<Record<string, unknown>>).map((r) => ({
          apiName: String(r.api_name),
          displayName: String(r.display_name ?? r.api_name),
          status: 'experimental',
        }));
        empty.totals.functions = empty.functions.length;
      }

      // interface
      const ifHas = await this.knex.raw(
        `SELECT to_regclass('public.interface') IS NOT NULL AS exists`,
      );
      if (ifHas?.rows?.[0]?.exists) {
        let query = this.knex('interface').select('api_name', 'display_name');
        if (ontologyId && ontologyId.includes('-')) {
          query = query.where({ ontology_id: ontologyId });
        }
        const ifs = await query.orderBy('display_name').limit(pageSize);
        empty.interfaces = filterQ(ifs as Array<Record<string, unknown>>).map((r) => ({
          apiName: String(r.api_name),
          displayName: String(r.display_name ?? r.api_name),
          status: 'experimental',
        }));
        empty.totals.interfaces = empty.interfaces.length;
      }

      return empty;
    } catch {
      return empty;
    }
  }

  async putOntologyResources(
    applicationId: string,
    userId: string,
    userName: string,
    resources: Array<{
      kind: OntologyResourceDto['kind'];
      apiName: string;
      displayName: string;
      icon?: Record<string, unknown>;
      status?: string;
      parentApiName?: string | null;
      hasNoResources?: boolean;
      sortOrder?: number;
      metadata?: Record<string, unknown>;
    }>,
    expectedVersion?: number,
  ) {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');

    if (resources.length > 2000) {
      throw new AppError('At most 2000 ontology resources allowed', 400, 'RESOURCE_LIMIT');
    }

    // Validate against live Ontology Manager catalog (Foundry-faithful)
    const catalog = await this.listOntologyCatalog({ pageSize: 2000 });
    const allowed = new Map<string, Set<string>>();
    allowed.set('object_type', new Set(catalog.objectTypes.map((r) => r.apiName)));
    allowed.set('action_type', new Set(catalog.actionTypes.map((r) => r.apiName)));
    allowed.set('function', new Set(catalog.functions.map((r) => r.apiName)));
    allowed.set('interface', new Set(catalog.interfaces.map((r) => r.apiName)));

    for (const r of resources) {
      const set = allowed.get(r.kind);
      // Only enforce when catalog for that kind is non-empty (empty = schema absent)
      if (set && set.size > 0 && !set.has(r.apiName)) {
        throw new AppError(
          `Unknown ontology ${r.kind} "${r.apiName}" — select resources from the Ontology catalog`,
          400,
          'ONTOLOGY_RESOURCE_NOT_FOUND',
        );
      }
    }

    await this.knex.transaction(async (trx) => {
      await trx('tpa_ontology_resources').where({ application_id: row.id }).del();
      if (resources.length) {
        await trx('tpa_ontology_resources').insert(
          resources.map((r, i) => ({
            application_id: row.id,
            kind: r.kind,
            api_name: r.apiName,
            display_name: r.displayName,
            icon_json: r.icon ?? {},
            status: r.status ?? 'experimental',
            parent_api_name: r.parentApiName ?? null,
            has_no_resources: r.hasNoResources ?? false,
            sort_order: r.sortOrder ?? i * 10,
            metadata: {
              ...(r.metadata ?? {}),
              ontologyId: catalog.ontologyId,
            },
          })),
        );
      }
      let query = trx('third_party_applications').where({ id: row.id });
      if (expectedVersion !== undefined) query = query.andWhere({ row_version: expectedVersion });
      const updated = await query.update({
        last_edited_by: userName,
        last_modified_at: new Date(),
        row_version: trx.raw('row_version + 1'),
      });
      if (updated !== 1) {
        throw new AppError('Application was modified by another request', 412, 'PRECONDITION_FAILED');
      }
      await trx('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: userId,
        actor_name: userName,
        action: 'ontology.resources.replace',
        result: 'SUCCESS',
        details: { resourceCount: resources.length, previousVersion: Number(row.row_version) },
      });
    });

    await this.recordMetric(row.id, 'requests', 1, { op: 'put_ontology_resources' });
    return this.getOntologySdk(applicationId);
  }

  async getPlatformSdk(applicationId: string): Promise<PlatformSdkDto & { catalog: typeof PLATFORM_SCOPE_CATALOG }> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');

    const scopes = await this.knex('tpa_operation_scopes').where({ application_id: row.id });
    const grants = await this.knex('tpa_project_grants').where({ application_id: row.id });

    // Merge catalog so UI can show all scopes with enabled flags
    const enabledMap = new Map(scopes.map((s: { scope: string; enabled: boolean }) => [s.scope, s.enabled]));
    const merged = PLATFORM_SCOPE_CATALOG.map((c) => ({
      scope: c.scope,
      enabled: enabledMap.get(c.scope) ?? false,
    }));
    // Include any custom scopes not in catalog
    for (const s of scopes) {
      if (!PLATFORM_SCOPE_CATALOG.some((c) => c.scope === s.scope)) {
        merged.push({ scope: s.scope, enabled: s.enabled });
      }
    }

    return {
      scopes: merged,
      projectGrants: grants.map(
        (g: {
          project_id: string;
          project_name: string;
          project_rid: string | null;
          description: string;
          icon_class: string;
          href: string | null;
        }) => ({
          projectId: g.project_id,
          projectName: g.project_name,
          projectRid: g.project_rid,
          description: g.description,
          iconClass: g.icon_class,
          href: g.href,
        }),
      ),
      catalog: PLATFORM_SCOPE_CATALOG,
    };
  }

  async putPlatformSdk(
    applicationId: string,
    userId: string,
    userName: string,
    body: {
      scopes?: Array<{ scope: string; enabled: boolean }>;
      projectGrants?: Array<{
        projectId: string;
        projectName: string;
        projectRid?: string | null;
        description?: string;
        iconClass?: string;
        href?: string | null;
      }>;
    },
    expectedVersion?: number,
  ) {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');

    const totalEnabled = (body.scopes ?? []).filter((s) => s.enabled).length;
    if (totalEnabled > 1000) {
      throw new AppError('SCOPE_LIMIT_EXCEEDED', 400, 'SCOPE_LIMIT_EXCEEDED');
    }

    await this.knex.transaction(async (trx) => {
      if (body.scopes) {
        await trx('tpa_operation_scopes').where({ application_id: row.id }).del();
        const toInsert = body.scopes.filter((s) => s.enabled);
        if (toInsert.length) {
          await trx('tpa_operation_scopes').insert(
            toInsert.map((s) => ({
              application_id: row.id,
              scope: s.scope,
              enabled: true,
            })),
          );
        }
      }
      if (body.projectGrants) {
        await trx('tpa_project_grants').where({ application_id: row.id }).del();
        if (body.projectGrants.length) {
          await trx('tpa_project_grants').insert(
            body.projectGrants.map((g) => ({
              application_id: row.id,
              project_id: g.projectId,
              project_name: g.projectName,
              project_rid: g.projectRid ?? null,
              description: g.description ?? '',
              icon_class: g.iconClass ?? 'resource-icon__project__mypxcb',
              href: g.href ?? null,
            })),
          );
        }
      }
      let query = trx('third_party_applications').where({ id: row.id });
      if (expectedVersion !== undefined) query = query.andWhere({ row_version: expectedVersion });
      const updated = await query.update({
        last_edited_by: userName,
        last_modified_at: new Date(),
        row_version: trx.raw('row_version + 1'),
      });
      if (updated !== 1) {
        throw new AppError('Application was modified by another request', 412, 'PRECONDITION_FAILED');
      }
      await trx('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: userId,
        actor_name: userName,
        action: 'platform.configuration.replace',
        result: 'SUCCESS',
        details: {
          enabledScopeCount: (body.scopes ?? []).filter((scope) => scope.enabled).length,
          projectGrantCount: body.projectGrants?.length ?? 0,
        },
      });
    });

    await this.recordMetric(row.id, 'requests', 1, { op: 'put_platform_sdk' });
    return this.getPlatformSdk(applicationId);
  }

  private async metricsTableReady(): Promise<boolean> {
    const row = await this.knex.raw(
      `SELECT to_regclass('public.tpa_metrics_points') IS NOT NULL AS exists`,
    );
    return Boolean(row?.rows?.[0]?.exists);
  }

  async recordMetric(
    applicationUuid: string,
    metric: 'requests' | 'errors' | 'latency_ms',
    value = 1,
    dimensions: Record<string, string> = {},
  ): Promise<void> {
    try {
      if (!(await this.metricsTableReady())) return;
      await this.knex('tpa_metrics_points').insert({
        application_id: applicationUuid,
        metric,
        value,
        dimensions,
        ts: new Date(),
      });
    } catch {
      // never fail product mutations on metrics
    }
  }

  async ingestMetrics(
    applicationId: string,
    points: Array<{
      metric?: 'requests' | 'errors' | 'latency_ms';
      value?: number;
      dimensions?: Record<string, string>;
      timestamp?: string;
    }>,
  ) {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    if (!(await this.metricsTableReady())) {
      throw new AppError('Metrics schema not migrated', 503, 'SCHEMA_NOT_READY');
    }
    if (!points.length) {
      throw new AppError('At least one metric point required', 400, 'VALIDATION_ERROR');
    }
    if (points.length > 5000) {
      throw new AppError('At most 5000 points per batch', 400, 'VALIDATION_ERROR');
    }
    await this.knex('tpa_metrics_points').insert(
      points.map((p) => ({
        application_id: row.id,
        metric: p.metric ?? 'requests',
        value: p.value ?? 1,
        dimensions: p.dimensions ?? {},
        ts: p.timestamp ? new Date(p.timestamp) : new Date(),
      })),
    );
    return { inserted: points.length };
  }

  async getMetrics(applicationId: string, query: { range?: string; groupBy?: string }) {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');

    const range = query.range ?? '1m';
    const rangeMs: Record<string, number> = {
      '1h': 3600_000,
      '24h': 86_400_000,
      '1d': 86_400_000,
      '7d': 7 * 86_400_000,
      '1m': 30 * 86_400_000,
      '6m': 180 * 86_400_000,
    };
    const since = new Date(Date.now() - (rangeMs[range] ?? rangeMs['1m']));

    if (!(await this.metricsTableReady())) {
      return {
        applicationId: row.rid,
        range,
        groupBy: query.groupBy ?? 'all',
        series: [] as Array<{ timestamp: string; value: number; dimensions?: Record<string, string> }>,
        totals: { requests: 0, errors: 0, latencyP50Ms: null as number | null },
        availableAfterHours: 24,
        message:
          'No metrics are available for the given time range and/or criteria. It can take around 24 hours for metrics to become available. Metrics are only available for OSDK and Platform APIs.',
      };
    }

    const points = await this.knex('tpa_metrics_points')
      .where({ application_id: row.id })
      .andWhere('ts', '>=', since)
      .orderBy('ts', 'asc')
      .limit(10_000);

    const series = points
      .filter((p: { metric: string }) => p.metric === 'requests')
      .map((p: { ts: Date | string; value: number; dimensions: Record<string, string> }) => ({
        timestamp: iso(p.ts),
        value: Number(p.value),
        dimensions: p.dimensions ?? {},
      }));

    const requests = points
      .filter((p: { metric: string }) => p.metric === 'requests')
      .reduce((a: number, p: { value: number }) => a + Number(p.value), 0);
    const errors = points
      .filter((p: { metric: string }) => p.metric === 'errors')
      .reduce((a: number, p: { value: number }) => a + Number(p.value), 0);
    const latencies = points
      .filter((p: { metric: string }) => p.metric === 'latency_ms')
      .map((p: { value: number }) => Number(p.value))
      .sort((a: number, b: number) => a - b);
    const latencyP50Ms =
      latencies.length === 0 ? null : latencies[Math.floor(latencies.length / 2)];

    const empty = series.length === 0;
    return {
      applicationId: row.rid,
      range,
      groupBy: query.groupBy ?? 'all',
      series,
      totals: { requests, errors, latencyP50Ms },
      availableAfterHours: empty ? 24 : 0,
      message: empty
        ? 'No metrics are available for the given time range and/or criteria. It can take around 24 hours for metrics to become available. Metrics are only available for OSDK and Platform APIs.'
        : '',
    };
  }

  async listServiceShares(applicationId: string) {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    const has = await this.knex.raw(
      `SELECT to_regclass('public.tpa_service_shares') IS NOT NULL AS exists`,
    );
    if (!has?.rows?.[0]?.exists) return [];
    const shares = await this.knex('tpa_service_shares')
      .where({ application_id: row.id })
      .orderBy('created_at', 'desc');
    return shares.map(
      (s: {
        id: string;
        resource_kind: string;
        resource_id: string;
        resource_name: string;
        access_level: string;
        created_by: string;
        created_at: Date | string;
      }) => ({
        id: s.id,
        resourceKind: s.resource_kind,
        resourceId: s.resource_id,
        resourceName: s.resource_name,
        accessLevel: s.access_level,
        createdBy: s.created_by,
        createdAt: iso(s.created_at),
      }),
    );
  }

  async putServiceShares(
    applicationId: string,
    userId: string,
    userName: string,
    shares: Array<{
      resourceKind: string;
      resourceId: string;
      resourceName?: string;
      accessLevel?: string;
    }>,
    expectedVersion?: number,
  ) {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    const has = await this.knex.raw(
      `SELECT to_regclass('public.tpa_service_shares') IS NOT NULL AS exists`,
    );
    if (!has?.rows?.[0]?.exists) {
      throw new AppError('Service shares schema not migrated', 503, 'SCHEMA_NOT_READY');
    }
    if (shares.length > 2000) {
      throw new AppError('At most 2000 shares', 400, 'VALIDATION_ERROR');
    }
    await this.knex.transaction(async (trx) => {
      await trx('tpa_service_shares').where({ application_id: row.id }).del();
      if (shares.length) {
        await trx('tpa_service_shares').insert(
          shares.map((s) => ({
            application_id: row.id,
            resource_kind: s.resourceKind,
            resource_id: s.resourceId,
            resource_name: s.resourceName ?? s.resourceId,
            access_level: s.accessLevel ?? 'viewer',
            created_by: userName,
          })),
        );
      }
      let update = trx('third_party_applications').where({ id: row.id });
      if (expectedVersion !== undefined) update = update.andWhere({ row_version: expectedVersion });
      const updated = await update.update({
        last_edited_by: userName,
        last_modified_at: new Date(),
        row_version: trx.raw('row_version + 1'),
      });
      if (updated !== 1) {
        throw new AppError('Application was modified by another request', 412, 'PRECONDITION_FAILED');
      }
      await trx('tpa_reconciliation_jobs').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        job_type: 'share_apply',
        payload: { shares },
      });
      await trx('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: userId,
        actor_name: userName,
        action: 'shares.replace',
        result: 'SUCCESS',
        details: { shareCount: shares.length },
      });
    });
    return this.listServiceShares(applicationId);
  }

  // ----- Long-lived scoped tokens (Sharing & tokens; gap-analysis §5) -----------

  private async tokensTableReady(): Promise<boolean> {
    const row = await this.knex.raw(
      `SELECT to_regclass('public.tpa_long_lived_tokens') IS NOT NULL AS exists`,
    );
    return Boolean(row?.rows?.[0]?.exists);
  }

  async listLongLivedTokens(applicationId: string) {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    if (!(await this.tokensTableReady())) return [];
    const tokens = await this.knex('tpa_long_lived_tokens')
      .where({ application_id: row.id })
      .whereNull('revoked_at')
      .orderBy('created_at', 'desc');
    return tokens.map(
      (t: {
        id: string;
        name: string;
        token_prefix: string;
        scopes: unknown;
        expires_at: Date | string | null;
        last_used_at: Date | string | null;
        created_by: string;
        created_at: Date | string;
      }) => ({
        id: t.id,
        name: t.name,
        tokenPrefix: t.token_prefix,
        scopes: Array.isArray(t.scopes) ? t.scopes : [],
        expiresAt: t.expires_at ? iso(t.expires_at) : null,
        lastUsedAt: t.last_used_at ? iso(t.last_used_at) : null,
        createdBy: t.created_by,
        createdAt: iso(t.created_at),
      }),
    );
  }

  async createLongLivedToken(
    applicationId: string,
    actor: DeveloperConsoleActor,
    input: { name: string; scopes?: string[]; expiresAt?: string | null },
    expectedVersion?: number,
  ): Promise<{ id: string; name: string; token: string; scopes: string[]; expiresAt: string | null; createdAt: string }> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    if (!(await this.tokensTableReady())) {
      throw new AppError('Token schema not migrated', 503, 'SCHEMA_NOT_READY');
    }
    const name = (input.name ?? '').trim();
    if (!name) throw new AppError('Token name is required', 400, 'VALIDATION_ERROR');
    if (name.length > 255) throw new AppError('Token name is too long', 400, 'VALIDATION_ERROR');
    const scopes = Array.isArray(input.scopes) ? input.scopes.slice(0, 1000) : [];
    const parsedExpiry = input.expiresAt ? new Date(input.expiresAt) : null;
    if (parsedExpiry && (Number.isNaN(parsedExpiry.getTime()) || parsedExpiry.getTime() < Date.now())) {
      throw new AppError('Expiry must be a future ISO timestamp', 400, 'VALIDATION_ERROR');
    }
    // Format: "plt_<32hex>_<8uuidHex>". Revealing only the hash + a random tail
    // keeps the plaintext unguessable while staying copy-pasteable for clients.
    const secret = crypto.randomBytes(32).toString('hex');
    const token = `plt_${secret}_${crypto.randomBytes(4).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const tokenPrefix = token.slice(0, 12);

    await this.knex.transaction(async (trx) => {
      await trx('tpa_long_lived_tokens').insert({
        application_id: row.id,
        name,
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        scopes: JSON.stringify(scopes),
        expires_at: parsedExpiry ? parsedExpiry.toISOString() : null,
        created_by: actor.userName,
      });
      let update = trx('third_party_applications').where({ id: row.id });
      if (expectedVersion !== undefined) update = update.andWhere({ row_version: expectedVersion });
      const updated = await update.update({
        row_version: trx.raw('row_version + 1'),
        last_modified_at: new Date(),
        last_edited_by: actor.userName,
      });
      if (updated !== 1) {
        throw new AppError('Application was modified by another request', 412, 'PRECONDITION_FAILED');
      }
      await trx('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: actor.userId,
        actor_name: actor.userName,
        action: 'tokens.create',
        result: 'SUCCESS',
        request_id: actor.requestId,
        details: { name, scopes, expiresAt: parsedExpiry ? parsedExpiry.toISOString() : null },
      });
    });
    return {
      id: crypto.randomUUID(),
      name,
      token,
      scopes,
      expiresAt: parsedExpiry ? parsedExpiry.toISOString() : null,
      createdAt: new Date().toISOString(),
    };
  }

  async revokeLongLivedToken(
    applicationId: string,
    actor: DeveloperConsoleActor,
    tokenId: string,
    expectedVersion?: number,
  ): Promise<void> {
    await this.requireTable();
    const row = await this.findRow(applicationId);
    if (!row) throw new AppError('Application not found', 404, 'NOT_FOUND');
    if (!(await this.tokensTableReady())) {
      throw new AppError('Token schema not migrated', 503, 'SCHEMA_NOT_READY');
    }
    await this.knex.transaction(async (trx) => {
      const result = await trx('tpa_long_lived_tokens')
        .where({ id: tokenId, application_id: row.id })
        .whereNull('revoked_at')
        .update({
          revoked_at: new Date(),
          revoked_by: actor.userName,
        });
      if (result === 0) {
        throw new AppError('Token not found or already revoked', 404, 'NOT_FOUND');
      }
      let update = trx('third_party_applications').where({ id: row.id });
      if (expectedVersion !== undefined) update = update.andWhere({ row_version: expectedVersion });
      const updated = await update.update({
        row_version: trx.raw('row_version + 1'),
        last_modified_at: new Date(),
        last_edited_by: actor.userName,
      });
      if (updated !== 1) {
        throw new AppError('Application was modified by another request', 412, 'PRECONDITION_FAILED');
      }
      await trx('tpa_audit_events').insert({
        tenant_id: row.tenant_id,
        application_id: row.id,
        actor_id: actor.userId,
        actor_name: actor.userName,
        action: 'tokens.revoke',
        result: 'SUCCESS',
        request_id: actor.requestId,
        details: { tokenId },
      });
    });
  }

  async listProjectCatalog(opts?: { pageSize?: number; q?: string }): Promise<ProjectCatalogItem[]> {
    const pageSize = Math.min(Math.max(opts?.pageSize ?? 500, 1), 2000);
    const q = (opts?.q ?? '').trim().toLowerCase();
    try {
      const has = await this.knex.raw(
        `SELECT to_regclass('public.projects') IS NOT NULL AS exists`,
      );
      if (has?.rows?.[0]?.exists) {
        let query = this.knex('projects').select('id', 'name', 'description').orderBy('name', 'asc');
        if (q) {
          query = query.whereRaw('lower(name) like ?', [`%${q}%`]);
        }
        const rows = await query.limit(pageSize);
        if (rows.length) {
          return rows.map(
            (r: { id: string; name: string; description: string | null }) => ({
              id: String(r.id),
              name: r.name,
              description: r.description ?? '',
              href: `/projects/${r.id}`,
              projectRid: `ri.compass.main.project.${r.id}`,
              iconClass: 'resource-icon__project__mypxcb',
            }),
          );
        }
      }
    } catch {
      // fall through to defaults
    }
    return DEFAULT_PROJECT_CATALOG;
  }
}

export function getDeveloperConsoleService(knex: Knex): DeveloperConsoleService {
  return new DeveloperConsoleService(knex);
}
