// NOTE: JWT_SECRET is no longer used anywhere in the tellus backend —
// the legacy HS256 flow in src/routes/auth.ts + src/services/authService.ts
// was retired in Phase 3 of ontology/tellus-auth.md. Every JWT the
// backend now handles is issued by Keycloak (RS256) and verified via
// JWKS in tellusAuthService. Keep this file focused on the env vars
// that are actually consumed by the live code.
//
// F-P4-24: S3 credential fallbacks `|| 'minioadmin'` removed. The well-
// known MinIO root credential must never be a silent default; a missing
// S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY now fails boot via
// requireSecret in the call sites that actually need the credential.
// foundryEnv continues to expose the non-sensitive S3 knobs only.

import { envWithDefault, requireSecret } from '../utils/requireEnv';

function parseIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[foundryEnv] Invalid ${key}="${raw}", using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Lazy getters for S3 credentials — resolved on first access so test
 * setup, container init, or Kubernetes CSI secret mounts have a chance
 * to set the env var before the module is imported elsewhere.
 * Throws `MissingEnvError` at read time (NOT at module-load time) if
 * the env var is unset.
 */
export const foundryEnv = {
  MAX_FILE_SIZE_MB: parseIntEnv('MAX_FILE_SIZE_MB', 50),
  FRONTEND_URL: envWithDefault('FRONTEND_URL', 'http://localhost:3000'),
  NODE_ENV: envWithDefault('NODE_ENV', 'development'),
  PORT: parseIntEnv('PORT', 3000),

  // MinIO / S3 object storage — host/port/bucket are config, credentials are secrets.
  S3_ENDPOINT: envWithDefault('S3_ENDPOINT', 'http://localhost:9000'),
  S3_REGION: envWithDefault('S3_REGION', 'us-east-1'),
  S3_BUCKET: envWithDefault('S3_BUCKET', 'tellus-uploads'),
  get S3_ACCESS_KEY_ID(): string {
    return requireSecret('S3_ACCESS_KEY_ID', 'S3/MinIO access key required.');
  },
  get S3_SECRET_ACCESS_KEY(): string {
    return requireSecret('S3_SECRET_ACCESS_KEY', 'S3/MinIO secret key required.');
  },
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE !== 'false',
};
