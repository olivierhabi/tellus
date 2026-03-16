import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgresql://', {
    message: 'DATABASE_URL must start with postgresql://',
  }),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_FILE_SIZE_MB: z.coerce.number().min(1).max(500).default(50),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  JWT_SECRET: z.string().min(32, {
    message: 'JWT_SECRET must be at least 32 characters long',
  }),
});

export type EnvConfig = z.infer<typeof envSchema>;

function validateEnvironment(): EnvConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error(
      'Environment validation failed:',
      result.error.format()
    );
    process.exit(1);
  }

  return result.data;
}

export const env = validateEnvironment();
