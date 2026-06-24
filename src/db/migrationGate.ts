// src/db/migrationGate.ts
//
// Boot-time migration gate.
//
// Detects drift between forward SQL migrations on disk
// (`src/migrations/NNN_*.sql`) and the `schema_migrations_applied`
// ledger.  Three modes (env: TELLUS_MIGRATION_GATE):
//
//   strict  Refuse to start if any forward migration is pending.
//           This is the production default — operators run
//           `npm run migrate` as a discrete deploy step (the same
//           contract that Apollo manifest deploys assume) and any
//           drift is treated as a deploy bug, not something the
//           runtime should silently paper over.
//   auto    Apply pending migrations at boot inside per-file
//           transactions, then start.  This is the dev default —
//           ergonomic for `tsx src/server.ts` reloads without
//           remembering the separate migrate step.
//   off     Log only; never fail, never apply.  Reserved for
//           one-off recovery scenarios where the operator is
//           applying migrations through a different channel
//           (e.g. running 051 by hand to fix a stuck schema).
//
// Default selection (`pickDefaultMode`) is `strict` when
// `NODE_ENV === "production"` and `auto` otherwise — same shape
// as the existing `autoCreate` toggle at `src/server.ts:1105`.
//
// Eligibility filter matches `src/migrate.ts:1962` (forward `.sql`
// files numbered ≥ 033) so the gate and the CLI runner agree on
// which migrations they own.  Files numbered ≤ 032 are handled
// inline by `src/migrate.ts` and are not gated here.
//
// Pinned by `tests/unit/code-repos/code-repository/migration-gate-unit.test.ts`.

import * as fs from "fs";
import * as path from "path";
import type { Pool } from "pg";

export type MigrationGateMode = "strict" | "auto" | "off";

export type MigrationGateLogger = (
  level: "info" | "warn" | "error",
  type: string,
  meta?: Record<string, unknown>,
) => void;

export interface MigrationGateOptions {
  pool: Pool;
  /** Defaults to <repo>/src/migrations relative to this file. */
  migrationsDir?: string;
  /**
   * Defaults to env(TELLUS_MIGRATION_GATE) ?? pickDefaultMode().
   * Explicit option always wins over env.
   */
  mode?: MigrationGateMode;
  /** Defaults to a structured-JSON console logger. */
  log?: MigrationGateLogger;
  /**
   * Lowest forward migration number this gate owns.  Anything
   * below is the bootstrap path (`src/migrate.ts` inline blocks).
   * Defaults to 33 to match `src/migrate.ts:1962`.
   */
  minMigrationNumber?: number;
}

export interface MigrationGateResult {
  mode: MigrationGateMode;
  /** Snapshot of the ledger before any apply step. */
  appliedBefore: string[];
  /** Forward migrations on disk minus the ledger snapshot. */
  pending: string[];
  /** Files this gate run actually applied (only populated in `auto` mode). */
  appliedDuringRun: string[];
  durationMs: number;
}

/**
 * Thrown by `enforceMigrationGate` in `strict` mode when one or
 * more forward migrations are present on disk but absent from the
 * `schema_migrations_applied` ledger.  Caller is expected to log
 * the error and `process.exit(1)`.
 */
export class MigrationDriftError extends Error {
  readonly pending: string[];
  constructor(pending: string[]) {
    super(
      `Migration gate (strict): ${pending.length} pending forward migration(s): ${pending.join(", ")}. ` +
        `Run \`npm run migrate\` before starting the server, or set TELLUS_MIGRATION_GATE=auto to apply at boot.`,
    );
    this.name = "MigrationDriftError";
    this.pending = pending;
  }
}

const FORWARD_SQL = /^\d{3}_.+\.sql$/;
const DOWN_SQL = /\.down\.sql$/;

/**
 * Returns the lexically-sorted list of forward migrations
 * (`NNN_*.sql`, no `.down.sql`) at or above `minN` in the given
 * directory.  Pure — no I/O beyond the directory listing — so
 * it can be unit-tested without a Pool.
 */
export function listForwardMigrations(dir: string, minN: number): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => FORWARD_SQL.test(f) && !DOWN_SQL.test(f))
    .filter((f) => parseInt(f.slice(0, 3), 10) >= minN)
    .sort();
}

/**
 * Returns lexically-sorted list of `migration_name` rows from the
 * ledger.  Caller is responsible for ensuring the ledger table
 * exists (the bootstrap path in `src/migrate.ts` creates it as
 * part of `032_migration_ledger.sql`).
 */
export async function listAppliedMigrations(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ migration_name: string }>(
    "SELECT migration_name FROM schema_migrations_applied",
  );
  return rows.map((r) => r.migration_name).sort();
}

/**
 * Set difference: `onDisk \ applied`, preserving `onDisk` order.
 * Pure — exported for unit tests.
 */
export function diffPending(onDisk: string[], applied: string[]): string[] {
  const set = new Set(applied);
  return onDisk.filter((f) => !set.has(f));
}

/**
 * Production-safe default: strict in production, auto everywhere
 * else.  Matches the `NODE_ENV !== "production"` toggle pattern
 * already used in this codebase.
 */
export function pickDefaultMode(env: NodeJS.ProcessEnv = process.env): MigrationGateMode {
  return env.NODE_ENV === "production" ? "strict" : "auto";
}

/**
 * Resolves the gate mode from (in priority order): explicit
 * option, `TELLUS_MIGRATION_GATE` env var, `pickDefaultMode()`.
 * Throws on invalid env value rather than silently falling back —
 * a misspelled env var should never silently downgrade the gate.
 */
export function resolveMode(
  explicit: MigrationGateMode | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MigrationGateMode {
  if (explicit) return explicit;
  const raw = env.TELLUS_MIGRATION_GATE;
  if (raw === undefined || raw === "") return pickDefaultMode(env);
  if (raw === "strict" || raw === "auto" || raw === "off") return raw;
  throw new Error(
    `Invalid TELLUS_MIGRATION_GATE='${raw}'. Allowed values: strict, auto, off.`,
  );
}

async function applyMigration(
  pool: Pool,
  dir: string,
  fname: string,
  log: MigrationGateLogger,
): Promise<void> {
  const fpath = path.join(dir, fname);
  const sql = fs.readFileSync(fpath, "utf-8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations_applied(migration_name, applied_at) VALUES ($1, now()) ON CONFLICT DO NOTHING",
      [fname],
    );
    await client.query("COMMIT");
    log("info", "migration_gate.applied", { migration: fname });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignored — the rollback failure is secondary to the apply failure */
    }
    log("error", "migration_gate.apply_failed", {
      migration: fname,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Boot-time entry point.  Call once before `app.listen(...)`.
 * On `strict` drift, throws `MigrationDriftError` — caller logs
 * and exits.  On `auto`, applies pending migrations in lexical
 * order in per-file transactions; any failure aborts the run
 * (subsequent migrations are NOT attempted, matching the
 * `src/migrate.ts` semantics).  On `off`, logs and returns.
 */
export async function enforceMigrationGate(
  opts: MigrationGateOptions,
): Promise<MigrationGateResult> {
  const startedAt = Date.now();
  const mode = resolveMode(opts.mode);
  const minN = opts.minMigrationNumber ?? 33;
  const dir =
    opts.migrationsDir ??
    path.join(__dirname, "..", "migrations");
  const log = opts.log ?? defaultLogger;

  if (mode === "off") {
    log("warn", "migration_gate.disabled", {
      reason: "TELLUS_MIGRATION_GATE=off",
    });
    return {
      mode,
      appliedBefore: [],
      pending: [],
      appliedDuringRun: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const onDisk = listForwardMigrations(dir, minN);
  const applied = await listAppliedMigrations(opts.pool);
  const pending = diffPending(onDisk, applied);

  log("info", "migration_gate.scan", {
    mode,
    onDiskCount: onDisk.length,
    appliedCount: applied.length,
    pendingCount: pending.length,
    pending,
  });

  if (pending.length === 0) {
    return {
      mode,
      appliedBefore: applied,
      pending: [],
      appliedDuringRun: [],
      durationMs: Date.now() - startedAt,
    };
  }

  if (mode === "strict") {
    log("error", "migration_gate.drift_detected", { pending });
    throw new MigrationDriftError(pending);
  }

  // mode === "auto"
  const appliedDuringRun: string[] = [];
  for (const fname of pending) {
    await applyMigration(opts.pool, dir, fname, log);
    appliedDuringRun.push(fname);
  }
  log("info", "migration_gate.auto_applied", {
    count: appliedDuringRun.length,
    migrations: appliedDuringRun,
  });

  return {
    mode,
    appliedBefore: applied,
    pending,
    appliedDuringRun,
    durationMs: Date.now() - startedAt,
  };
}

const defaultLogger: MigrationGateLogger = (level, type, meta) => {
  const line = JSON.stringify({
    type,
    level,
    timestamp: new Date().toISOString(),
    ...(meta ?? {}),
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
};
