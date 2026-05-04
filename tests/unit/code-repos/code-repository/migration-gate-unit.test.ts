// tests/unit/code-repos/code-repository/migration-gate-unit.test.ts
//
// Unit tests for the boot-time migration gate.
//
// Covers every branch of `enforceMigrationGate` (off / strict-clean /
// strict-drift / auto-apply / auto-failure) plus the pure helpers
// (listForwardMigrations, diffPending, pickDefaultMode, resolveMode).
// Uses a temp directory for the migrations fixture and a stubbed Pool
// so no real Postgres is needed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  enforceMigrationGate,
  listForwardMigrations,
  listAppliedMigrations,
  diffPending,
  pickDefaultMode,
  resolveMode,
  MigrationDriftError,
  type MigrationGateMode,
} from "../../../../src/db/migrationGate";

// ---------------------------------------------------------------------------
// Stub Pool — only the surface enforceMigrationGate touches.
// ---------------------------------------------------------------------------

interface StubClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeStubClient(scriptedQueries: Array<unknown | Error>): StubClient {
  let i = 0;
  return {
    query: vi.fn(async (..._args: unknown[]) => {
      const next = scriptedQueries[i++];
      if (next instanceof Error) throw next;
      return next ?? { rows: [] };
    }),
    release: vi.fn(),
  };
}

interface StubPool {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}

function makeStubPool(opts: {
  ledger: string[];
  perApplyClientScript?: Array<Array<unknown | Error>>;
}): StubPool {
  const clientScripts = opts.perApplyClientScript ?? [];
  let connectCount = 0;
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT migration_name FROM schema_migrations_applied")) {
        return { rows: opts.ledger.map((m) => ({ migration_name: m })) };
      }
      throw new Error(`Unexpected pool.query: ${sql}`);
    }),
    connect: vi.fn(async () => {
      const script = clientScripts[connectCount++] ?? [];
      return makeStubClient(script);
    }),
  };
}

// ---------------------------------------------------------------------------
// Pure-helper tests — no Pool, no FS mock, just argument plumbing.
// ---------------------------------------------------------------------------

describe("migrationGate / pure helpers", () => {
  describe("diffPending", () => {
    it("returns disk migrations missing from applied set", () => {
      const onDisk = ["050.sql", "051.sql", "052.sql"];
      const applied = ["050.sql"];
      expect(diffPending(onDisk, applied)).toEqual(["051.sql", "052.sql"]);
    });

    it("preserves on-disk order", () => {
      const onDisk = ["a", "b", "c", "d"];
      const applied = ["c"];
      expect(diffPending(onDisk, applied)).toEqual(["a", "b", "d"]);
    });

    it("returns empty array when fully applied", () => {
      expect(diffPending(["a", "b"], ["b", "a"])).toEqual([]);
    });
  });

  describe("pickDefaultMode", () => {
    it("returns strict in production", () => {
      expect(pickDefaultMode({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("strict");
    });

    it("returns auto in development", () => {
      expect(pickDefaultMode({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe("auto");
    });

    it("returns auto when NODE_ENV unset", () => {
      expect(pickDefaultMode({} as NodeJS.ProcessEnv)).toBe("auto");
    });
  });

  describe("resolveMode", () => {
    it("explicit option wins over env", () => {
      const env = { TELLUS_MIGRATION_GATE: "off" } as NodeJS.ProcessEnv;
      expect(resolveMode("strict", env)).toBe("strict");
    });

    it("env wins over default when option absent", () => {
      const env = {
        NODE_ENV: "production",
        TELLUS_MIGRATION_GATE: "auto",
      } as NodeJS.ProcessEnv;
      expect(resolveMode(undefined, env)).toBe("auto");
    });

    it("falls back to NODE_ENV-keyed default when both option and env absent", () => {
      expect(resolveMode(undefined, { NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe("strict");
      expect(resolveMode(undefined, {} as NodeJS.ProcessEnv)).toBe("auto");
    });

    it("throws on invalid env value", () => {
      const env = { TELLUS_MIGRATION_GATE: "loose" } as NodeJS.ProcessEnv;
      expect(() => resolveMode(undefined, env)).toThrow(/Invalid TELLUS_MIGRATION_GATE='loose'/);
    });
  });
});

// ---------------------------------------------------------------------------
// Filesystem-backed listForwardMigrations — temp dir.
// ---------------------------------------------------------------------------

describe("migrationGate / listForwardMigrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists forward .sql files at or above minN, sorted", () => {
    fs.writeFileSync(path.join(dir, "032_old.sql"), "");
    fs.writeFileSync(path.join(dir, "033_a.sql"), "");
    fs.writeFileSync(path.join(dir, "034_b.sql"), "");
    fs.writeFileSync(path.join(dir, "050_c.sql"), "");
    expect(listForwardMigrations(dir, 33)).toEqual([
      "033_a.sql",
      "034_b.sql",
      "050_c.sql",
    ]);
  });

  it("excludes .down.sql, .ts, and non-numeric files", () => {
    fs.writeFileSync(path.join(dir, "033_a.sql"), "");
    fs.writeFileSync(path.join(dir, "033_a.down.sql"), "");
    fs.writeFileSync(path.join(dir, "033_a.ts"), "");
    fs.writeFileSync(path.join(dir, "README.md"), "");
    fs.writeFileSync(path.join(dir, "abc_x.sql"), "");
    expect(listForwardMigrations(dir, 33)).toEqual(["033_a.sql"]);
  });

  it("excludes files below minN", () => {
    fs.writeFileSync(path.join(dir, "020_x.sql"), "");
    fs.writeFileSync(path.join(dir, "032_x.sql"), "");
    fs.writeFileSync(path.join(dir, "033_x.sql"), "");
    expect(listForwardMigrations(dir, 33)).toEqual(["033_x.sql"]);
  });

  it("returns empty when directory does not exist", () => {
    expect(listForwardMigrations(path.join(dir, "nope"), 33)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listAppliedMigrations — pool stub.
// ---------------------------------------------------------------------------

describe("migrationGate / listAppliedMigrations", () => {
  it("returns sorted ledger rows", async () => {
    const pool = makeStubPool({ ledger: ["c.sql", "a.sql", "b.sql"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await listAppliedMigrations(pool as any);
    expect(result).toEqual(["a.sql", "b.sql", "c.sql"]);
  });
});

// ---------------------------------------------------------------------------
// enforceMigrationGate — full integration of pure + I/O paths.
// ---------------------------------------------------------------------------

describe("migrationGate / enforceMigrationGate", () => {
  let dir: string;
  let logs: Array<{ level: string; type: string; meta?: Record<string, unknown> }>;
  const captureLog = (
    level: "info" | "warn" | "error",
    type: string,
    meta?: Record<string, unknown>,
  ) => logs.push({ level, type, meta });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-enforce-"));
    logs = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mode=off: logs disabled and skips ledger query entirely", async () => {
    const pool = makeStubPool({ ledger: [] });
    const result = await enforceMigrationGate({
      pool: pool as never,
      migrationsDir: dir,
      mode: "off",
      log: captureLog,
    });
    expect(result.mode).toBe("off");
    expect(result.appliedBefore).toEqual([]);
    expect(result.pending).toEqual([]);
    expect(result.appliedDuringRun).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
    expect(logs[0].type).toBe("migration_gate.disabled");
  });

  it("mode=strict, no drift: returns clean result", async () => {
    fs.writeFileSync(path.join(dir, "033_a.sql"), "select 1;");
    fs.writeFileSync(path.join(dir, "034_b.sql"), "select 1;");
    const pool = makeStubPool({ ledger: ["033_a.sql", "034_b.sql"] });
    const result = await enforceMigrationGate({
      pool: pool as never,
      migrationsDir: dir,
      mode: "strict",
      log: captureLog,
    });
    expect(result.mode).toBe("strict");
    expect(result.pending).toEqual([]);
    expect(result.appliedBefore.sort()).toEqual(["033_a.sql", "034_b.sql"]);
    expect(logs.find((l) => l.type === "migration_gate.scan")).toBeDefined();
    expect(logs.find((l) => l.type === "migration_gate.drift_detected")).toBeUndefined();
  });

  it("mode=strict, with drift: throws MigrationDriftError listing pending migrations", async () => {
    fs.writeFileSync(path.join(dir, "033_a.sql"), "");
    fs.writeFileSync(path.join(dir, "034_b.sql"), "");
    fs.writeFileSync(path.join(dir, "035_c.sql"), "");
    const pool = makeStubPool({ ledger: ["033_a.sql"] });

    let caught: unknown;
    try {
      await enforceMigrationGate({
        pool: pool as never,
        migrationsDir: dir,
        mode: "strict",
        log: captureLog,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationDriftError);
    expect((caught as MigrationDriftError).pending).toEqual(["034_b.sql", "035_c.sql"]);
    expect(logs.find((l) => l.type === "migration_gate.drift_detected")).toBeDefined();
  });

  it("mode=auto: applies pending migrations in lexical order, records each in ledger", async () => {
    fs.writeFileSync(path.join(dir, "033_a.sql"), "select 1;");
    fs.writeFileSync(path.join(dir, "034_b.sql"), "select 2;");
    fs.writeFileSync(path.join(dir, "035_c.sql"), "select 3;");
    const pool = makeStubPool({
      ledger: ["033_a.sql"],
      perApplyClientScript: [
        // 034_b.sql apply: BEGIN, body, INSERT, COMMIT
        [{}, {}, {}, {}],
        // 035_c.sql apply: BEGIN, body, INSERT, COMMIT
        [{}, {}, {}, {}],
      ],
    });
    const result = await enforceMigrationGate({
      pool: pool as never,
      migrationsDir: dir,
      mode: "auto",
      log: captureLog,
    });
    expect(result.appliedDuringRun).toEqual(["034_b.sql", "035_c.sql"]);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(logs.filter((l) => l.type === "migration_gate.applied")).toHaveLength(2);
    expect(logs.find((l) => l.type === "migration_gate.auto_applied")?.meta?.count).toBe(2);
  });

  it("mode=auto: a failing migration aborts the run, leaves later migrations unattempted", async () => {
    fs.writeFileSync(path.join(dir, "033_a.sql"), "select 1;");
    fs.writeFileSync(path.join(dir, "034_b.sql"), "this will fail");
    fs.writeFileSync(path.join(dir, "035_c.sql"), "select 3;");
    const failure = new Error("syntax error in 034_b");
    const pool = makeStubPool({
      ledger: ["033_a.sql"],
      perApplyClientScript: [
        // 034_b.sql apply: BEGIN ok, body throws, then ROLLBACK
        [{}, failure, {}],
      ],
    });
    let caught: unknown;
    try {
      await enforceMigrationGate({
        pool: pool as never,
        migrationsDir: dir,
        mode: "auto",
        log: captureLog,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/syntax error in 034_b/);
    // Only the failing client was opened — 035 was never attempted.
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(logs.find((l) => l.type === "migration_gate.apply_failed")?.meta?.migration).toBe("034_b.sql");
  });

  it("resolves default mode from NODE_ENV when neither option nor env is set", async () => {
    fs.writeFileSync(path.join(dir, "033_a.sql"), "");
    const pool = makeStubPool({ ledger: ["033_a.sql"] });
    const prevEnv = process.env.NODE_ENV;
    const prevGate = process.env.TELLUS_MIGRATION_GATE;
    delete process.env.TELLUS_MIGRATION_GATE;
    try {
      process.env.NODE_ENV = "production";
      const result = await enforceMigrationGate({
        pool: pool as never,
        migrationsDir: dir,
        log: captureLog,
      });
      expect(result.mode).toBe("strict");
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
      if (prevGate !== undefined) process.env.TELLUS_MIGRATION_GATE = prevGate;
    }
  });

  it("env TELLUS_MIGRATION_GATE overrides NODE_ENV-derived default", async () => {
    fs.writeFileSync(path.join(dir, "033_a.sql"), "");
    fs.writeFileSync(path.join(dir, "034_b.sql"), "select 1;");
    const pool = makeStubPool({
      ledger: ["033_a.sql"],
      perApplyClientScript: [[{}, {}, {}, {}]],
    });
    const prevEnv = process.env.NODE_ENV;
    const prevGate = process.env.TELLUS_MIGRATION_GATE;
    process.env.NODE_ENV = "production";
    process.env.TELLUS_MIGRATION_GATE = "auto";
    try {
      const result = await enforceMigrationGate({
        pool: pool as never,
        migrationsDir: dir,
        log: captureLog,
      });
      expect(result.mode).toBe("auto");
      expect(result.appliedDuringRun).toEqual(["034_b.sql"]);
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
      if (prevGate === undefined) delete process.env.TELLUS_MIGRATION_GATE;
      else process.env.TELLUS_MIGRATION_GATE = prevGate;
    }
  });
});

// ---------------------------------------------------------------------------
// MigrationDriftError shape — operators grep this in production logs.
// ---------------------------------------------------------------------------

describe("MigrationDriftError", () => {
  it("name === MigrationDriftError, exposes pending list", () => {
    const err = new MigrationDriftError(["052_x.sql", "054_y.sql"]);
    expect(err.name).toBe("MigrationDriftError");
    expect(err.pending).toEqual(["052_x.sql", "054_y.sql"]);
    expect(err.message).toContain("052_x.sql");
    expect(err.message).toContain("054_y.sql");
    expect(err.message).toContain("npm run migrate");
  });
});
