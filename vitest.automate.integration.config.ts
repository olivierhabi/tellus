import { defineConfig } from "vitest/config";
import path from "path";

// Focused Automate integration tests use the real local PostgreSQL service
// while isolating every record by generated automation IDs. They deliberately
// avoid the repository-wide seed/globalSetup, which mutates shared fixtures.
export default defineConfig({
  test: {
    root: path.resolve(__dirname),
    globals: true,
    include: ["tests/integration/automate/**/*-integration.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      PGHOST: process.env.PGHOST ?? "localhost",
      PGPORT: process.env.PGPORT ?? "5432",
      PGDATABASE: process.env.PGDATABASE ?? "tellus_db",
      PGUSER: process.env.PGUSER ?? "tellus",
      PGPASSWORD: process.env.PGPASSWORD ?? "tellus123",
    },
  },
});
