// ---------------------------------------------------------------------------
// Test-stack bootstrap — runs once per vitest integration invocation BEFORE
// any destructive seed. Gives the integration lane its OWN environment:
//
//   * database   : $PGDATABASE (default tellus_tests), created if missing
//   * migrations : the canonical 4-pass (migrate → foundry → auth → migrate)
//   * DB seal    : deployment_environment sealed to TELLUS_ENVIRONMENT_ID
//   * Temporal   : lane namespace + funnel lineage search attributes
//   * MinIO      : lane bucket ($S3_BUCKET)
//
// Everything is idempotent; a warm lane costs only the no-op checks.
// This file may ONLY configure a test/verify environment — call sites pass
// buildProof() from the destructive guard AFTER sealing, and every later
// destructive helper re-verifies through assertDestructiveTestEnvironment.
// ---------------------------------------------------------------------------

import path from "path";
import { spawnSync } from "child_process";
import pg from "pg";

import { requiredTestSecret } from "./testEnvFile";
import { resolveEnvironmentIdentity } from "../src/config/environmentIdentity";
import {
  sealTestDatabaseEnvironment,
} from "../src/services/testing/destructiveTestGuard";

const ROOT = path.resolve(__dirname, "..");

function sh(cmd: string, args: string[], label: string): void {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env: {
      // Minimum contract for the migrators: they read PG* from env (they do
      // NOT load dotenv).
      PGHOST: "localhost",
      PGPORT: "5432",
      PGUSER: "tellus",
      // No baked-in literals: env first (CI), then .env.test / .env.test.example.
      PGPASSWORD: requiredTestSecret("PGPASSWORD"),
      ...process.env,
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (r.error) {
    throw new Error(`[test-stack bootstrap] ${label} spawn error: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(
      `[test-stack bootstrap] ${label} failed (exit ${r.status}):\n` +
        `stdout: ${(r.stdout ?? "").slice(-900)}\nstderr: ${(r.stderr ?? "").slice(-900)}`,
    );
  }
}

async function ensureDatabase(): Promise<void> {
  const target = process.env.PGDATABASE ?? "tellus_tests";
  const admin = new pg.Pool({
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "tellus",
    password: requiredTestSecret("PGPASSWORD"),
    database: "postgres",
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    const exists = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [target],
    );
    if (exists.rowCount === 0) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(target)) {
        throw new Error(`refusing to create DB with non-identifier name '${target}'`);
      }
      await admin.query(`CREATE DATABASE "${target}"`);
      console.log(`[test-stack bootstrap] created database ${target}`);
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
}

function ensureMigrations(): void {
  console.log("[test-stack bootstrap] applying migrations (main → foundry → auth → main)…");
  sh("pnpm", ["exec", "tsx", "src/migrate.ts"], "migrate (1)");
  sh("pnpm", ["exec", "tsx", "src/foundryMigrate.ts"], "migrate:foundry");
  sh("pnpm", ["exec", "tsx", "src/migrateAuth.ts"], "migrate:auth");
  sh("pnpm", ["exec", "tsx", "src/migrate.ts"], "migrate (2)");
}

async function ensureSeal(): Promise<void> {
  const envId = (process.env.TELLUS_ENVIRONMENT_ID ?? "").trim();
  if (!envId) {
    throw new Error("[test-stack bootstrap] TELLUS_ENVIRONMENT_ID must be set before sealing");
  }
  await sealTestDatabaseEnvironment(envId);
  console.log(`[test-stack bootstrap] database sealed as '${envId}'`);
}

async function ensureTemporalNamespace(): Promise<void> {
  let identity;
  try {
    identity = resolveEnvironmentIdentity(process.env);
  } catch (err) {
    console.warn(
      `[test-stack bootstrap] temporal identity unresolved — skipping namespace provisioning: ${(err as Error).message}`,
    );
    return;
  }
  const { Connection } = await import("@temporalio/client");
  let connection;
  try {
    connection = await Connection.connect({ address: identity.temporalAddress });
  } catch (err) {
    console.warn(
      `[test-stack bootstrap] temporal unreachable at ${identity.temporalAddress} — skipping namespace provisioning: ${(err as Error).message}`,
    );
    return;
  }
  try {
    const ns = identity.temporalNamespace;
    let exists = true;
    try {
      await connection.workflowService.describeNamespace({ namespace: ns });
    } catch {
      exists = false;
    }
    if (!exists) {
      const retentionDays = Number(process.env.TEMPORAL_NAMESPACE_RETENTION_DAYS ?? 3);
      await connection.workflowService.registerNamespace({
        namespace: ns,
        workflowExecutionRetentionPeriod: {
          seconds: (retentionDays * 86400) as never,
        },
      });
      console.log(`[test-stack bootstrap] created temporal namespace ${ns}`);
    }
    const INDEXED_VALUE_TYPE_KEYWORD = 2;
    const searchAttributes: Record<string, number> = {
      TellusEnvironmentId: INDEXED_VALUE_TYPE_KEYWORD,
      TellusOntologyRid: INDEXED_VALUE_TYPE_KEYWORD,
      TellusObjectTypeRid: INDEXED_VALUE_TYPE_KEYWORD,
      TellusWorkerBuildId: INDEXED_VALUE_TYPE_KEYWORD,
    };
    try {
      await connection.operatorService.addSearchAttributes({
        namespace: ns,
        searchAttributes,
      } as never);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!/already|exist/i.test(msg)) {
        console.warn(
          `[test-stack bootstrap] search-attribute registration (best-effort) failed: ${msg}`,
        );
      }
    }
  } finally {
    await connection.close();
  }
}

export interface TestStackBootstrapResult {
  database: string;
  environmentId: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
}

export async function bootstrapTestStack(): Promise<TestStackBootstrapResult> {
  await ensureDatabase();
  ensureMigrations();
  await ensureSeal();
  await ensureTemporalNamespace();
  const identity = resolveEnvironmentIdentity(process.env);
  return {
    database: process.env.PGDATABASE ?? "tellus_tests",
    environmentId: identity.environmentId,
    temporalNamespace: identity.temporalNamespace,
    temporalTaskQueue: identity.temporalTaskQueue,
  };
}
