import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { AppError } from '../../utils/foundryAppError';
import { getKmsAdapter, type WrappedDek } from '../../lib/kms';
import {
  decrypt,
  encrypt,
  generateDek,
} from '../connectivity/credentials/aesgcm';

export type ApplicationRole = 'viewer' | 'editor' | 'owner';
export type RequiredApplicationRole = 'read' | 'write' | 'admin';

export interface DeveloperConsoleActor {
  userId: string;
  userName: string;
  tenantId: string | null;
  roles: string[];
  requestId?: string;
}

export interface AuthorizedApplication {
  id: string;
  rid: string;
  name: string;
  tenant_id: string;
  creator_id: string;
  row_version: number | string;
  keycloak_client_uuid: string | null;
  client_type: 'public' | 'confidential';
  client_id: string;
  deleted_at: Date | string | null;
}

const ROLE_RANK: Record<ApplicationRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

const REQUIRED_RANK: Record<RequiredApplicationRole, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

export function isDeveloperConsoleSuperadmin(actor: DeveloperConsoleActor): boolean {
  return actor.roles.includes('tellus-superadmin');
}

function parseApplicationKey(applicationId: string): { rid?: string; uuid?: string; name?: string } {
  let decoded = applicationId;
  try {
    decoded = decodeURIComponent(applicationId);
  } catch {
    // Preserve the raw route value so malformed encoding becomes a not-found.
  }
  const prefix = 'ri.third-party-applications.main.application.';
  if (decoded.startsWith(prefix)) return { rid: decoded, uuid: decoded.slice(prefix.length) };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) {
    return { uuid: decoded, rid: `${prefix}${decoded}` };
  }
  return { name: decoded };
}

export async function authorizeDeveloperApplication(
  knex: Knex,
  applicationId: string,
  actor: DeveloperConsoleActor,
  required: RequiredApplicationRole,
): Promise<AuthorizedApplication> {
  const key = parseApplicationKey(applicationId);
  let query = knex<AuthorizedApplication>('third_party_applications').whereNull('deleted_at');
  if (key.uuid) query = query.andWhere({ id: key.uuid });
  else if (key.rid) query = query.andWhere({ rid: key.rid });
  else query = query.andWhere({ name: key.name ?? '' });
  const application = await query.first();

  // Always use not-found for tenant mismatch to avoid resource enumeration.
  if (!application || (actor.tenantId && application.tenant_id !== actor.tenantId)) {
    throw new AppError('Application not found', 404, 'NOT_FOUND');
  }
  if (isDeveloperConsoleSuperadmin(actor)) return application;

  let role: ApplicationRole | undefined;
  if (application.creator_id === actor.userId) {
    role = 'owner';
  } else {
    const membership = await knex('tpa_application_members')
      .where({ application_id: application.id, principal_id: actor.userId })
      .first('role', 'tenant_id');
    if (membership?.tenant_id === application.tenant_id) role = membership.role as ApplicationRole;
  }

  if (!role || ROLE_RANK[role] < REQUIRED_RANK[required]) {
    throw new AppError('Application not found', 404, 'NOT_FOUND');
  }
  return application;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function idempotencyRequestHash(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

export interface EncryptedResponse {
  responseCiphertext: Buffer;
  wrappedDek: Buffer;
  kmsAdapter: string;
  kmsKeyId: string;
}

export async function encryptIdempotencyResponse(
  tenantId: string,
  response: unknown,
): Promise<EncryptedResponse> {
  const plaintext = Buffer.from(JSON.stringify(response), 'utf8');
  const dek = generateDek();
  try {
    const wrapped = await getKmsAdapter().wrap(dek, { tenant: tenantId });
    const ciphertext = encrypt(plaintext, dek);
    return {
      responseCiphertext: Buffer.from(ciphertext),
      wrappedDek: Buffer.from(wrapped.ciphertext),
      kmsAdapter: wrapped.adapter,
      kmsKeyId: wrapped.keyId,
    };
  } finally {
    plaintext.fill(0);
    dek.fill(0);
  }
}

export async function decryptIdempotencyResponse<T>(
  tenantId: string,
  row: {
    response_ciphertext: Buffer | Uint8Array;
    wrapped_dek: Buffer | Uint8Array;
    kms_adapter: string;
    kms_key_id: string;
  },
): Promise<T> {
  const wrapped: WrappedDek = {
    ciphertext: new Uint8Array(row.wrapped_dek),
    adapter: row.kms_adapter,
    keyId: row.kms_key_id,
  };
  const dek = await getKmsAdapter().unwrap(wrapped, { tenant: tenantId });
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = decrypt(new Uint8Array(row.response_ciphertext), dek);
    return JSON.parse(Buffer.from(plaintext).toString('utf8')) as T;
  } finally {
    dek.fill(0);
    plaintext?.fill(0);
  }
}

export function parseIfMatch(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(?:W\/)?"?v?(\d+)"?$/i);
  if (!match) throw new AppError('Invalid If-Match header', 400, 'INVALID_ETAG');
  return Number(match[1]);
}

export function applicationEtag(version: number | string): string {
  return `"v${Number(version)}"`;
}
