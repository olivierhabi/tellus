/**
 * systemSettingsService.ts
 * ------------------------
 * Typed accessor for the `system_settings` JSONB store. The service is
 * used by:
 *
 *   • /api/v1/auth/login          → reads `require_passkey_enrollment`
 *     to decide whether to gate password-only sessions into the
 *     mandatory-passkey enrollment handshake.
 *
 *   • /api/v1/auth/admin/settings → read + write by the superadmin
 *     console. Every write is audited.
 *
 * Reads are backed by an in-process 5-second TTL cache so the hot path
 * in /login doesn't thrash the DB — operator changes propagate within
 * 5 seconds without needing a pub/sub fanout.
 */

import type { Knex } from 'knex';
import { AppError } from '../utils/foundryAppError';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SystemSettingRow {
  key: string;
  value: JsonValue;
  description: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

/**
 * Closed enum of known settings. Add entries here AND in the DB seed
 * in migrateAuth.ts. Adding a setting outside this union is a linter
 * / code-review failure — we want every feature flag to be surfaced
 * in the superadmin UI, not silently created in a migration.
 */
export type KnownSettingKey = 'require_passkey_enrollment';

export const KNOWN_SETTINGS: ReadonlyArray<KnownSettingKey> = [
  'require_passkey_enrollment',
];

interface CacheEntry {
  value: JsonValue;
  expiresAt: number;
}
const CACHE_TTL_MS = 5_000;

export class SystemSettingsService {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly knex: Knex) {}

  async get<T extends JsonValue = JsonValue>(
    key: KnownSettingKey,
    fallback: T,
  ): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as T;
    }
    const row = await this.knex('system_settings')
      .where({ key })
      .first<{ value: JsonValue } | undefined>();
    // node-pg returns JSONB as already-parsed objects, but some drivers
    // return strings. Normalize so callers get a JSON value either way.
    let value: JsonValue;
    if (row == null) {
      value = fallback;
    } else if (typeof row.value === 'string') {
      try {
        value = JSON.parse(row.value) as JsonValue;
      } catch {
        value = fallback;
      }
    } else {
      value = row.value as JsonValue;
    }
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value as T;
  }

  async getAll(): Promise<SystemSettingRow[]> {
    const rows = await this.knex('system_settings').select<
      Array<{
        key: string;
        value: JsonValue;
        description: string | null;
        updated_by: string | null;
        updated_at: Date;
      }>
    >('key', 'value', 'description', 'updated_by', 'updated_at')
      .orderBy('key');
    return rows.map((r) => ({
      key: r.key,
      value: typeof r.value === 'string' ? safeJsonParse(r.value) : r.value,
      description: r.description,
      updatedBy: r.updated_by,
      updatedAt: new Date(r.updated_at),
    }));
  }

  async set(
    key: KnownSettingKey,
    value: JsonValue,
    updatedBy: string,
  ): Promise<SystemSettingRow> {
    if (!KNOWN_SETTINGS.includes(key)) {
      throw new AppError(`Unknown setting: ${key}`, 400, 'UNKNOWN_SETTING');
    }
    await this.knex('system_settings')
      .insert({
        key,
        value: JSON.stringify(value),
        updated_by: updatedBy,
        updated_at: new Date(),
      })
      .onConflict('key')
      .merge({
        value: JSON.stringify(value),
        updated_by: updatedBy,
        updated_at: new Date(),
      });
    // Bust the cache immediately so the next /login reads the new
    // value — otherwise the operator would see a 5-second delay after
    // flipping the switch, which feels broken.
    this.cache.delete(key);
    const row = await this.knex('system_settings')
      .where({ key })
      .first<{
        key: string;
        value: JsonValue;
        description: string | null;
        updated_by: string | null;
        updated_at: Date;
      }>();
    if (!row) throw new AppError('Setting disappeared after upsert', 500, 'INTERNAL_ERROR');
    return {
      key: row.key,
      value: typeof row.value === 'string' ? safeJsonParse(row.value) : row.value,
      description: row.description,
      updatedBy: row.updated_by,
      updatedAt: new Date(row.updated_at),
    };
  }
}

function safeJsonParse(s: string): JsonValue {
  try {
    return JSON.parse(s) as JsonValue;
  } catch {
    return null;
  }
}

let _singleton: SystemSettingsService | null = null;
export function getSystemSettingsService(knex: Knex): SystemSettingsService {
  if (!_singleton) _singleton = new SystemSettingsService(knex);
  return _singleton;
}
