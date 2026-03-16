import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    sequence: {
      concurrent: false,
    },
    include: [
      'tests/**/*-unit.test.ts',
      'tests/**/*-integration.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/config/knexfile.ts', 'src/migrations/**', 'src/seeds/**'],
    },
    env: {
      DATABASE_URL: 'postgresql://tellus:tellus123@localhost:5432/foundry',
      PORT: '3001',
      NODE_ENV: 'test',
      UPLOAD_DIR: './test-uploads',
      MAX_FILE_SIZE_MB: '50',
      FRONTEND_URL: 'http://localhost:3000',
      JWT_SECRET: 'test-secret-key-at-least-32-characters-long-for-testing',
    },
  },
});
