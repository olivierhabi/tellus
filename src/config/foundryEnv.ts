const DEFAULT_JWT_SECRET = 'default-dev-secret-at-least-32-characters';

if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET environment variable must be set in production');
    process.exit(1);
  } else {
    console.warn('[foundryEnv] WARNING: Using default JWT_SECRET — set JWT_SECRET env var for production');
  }
}

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

export const foundryEnv = {
  MAX_FILE_SIZE_MB: parseIntEnv('MAX_FILE_SIZE_MB', 50),
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  JWT_SECRET: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseIntEnv('PORT', 3000),

  // MinIO / S3 object storage
  S3_ENDPOINT: process.env.S3_ENDPOINT || 'http://localhost:9000',
  S3_REGION: process.env.S3_REGION || 'us-east-1',
  S3_BUCKET: process.env.S3_BUCKET || 'tellus-uploads',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID || 'minioadmin',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY || 'minioadmin',
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE !== 'false',
};
