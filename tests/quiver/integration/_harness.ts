// Quiver integration test harness.
//
// Provides:
//   - quiverApp(): an Express app with quiver routes mounted, no full
//     server.ts boot (so we don't pull in OTel auto-instrumentation,
//     OpenSearch, Kafka, Temporal, etc.)
//   - applyQuiverMigrations(): runs migrations 062 + 063 idempotently
//     against the in-test Pool.
//   - cleanup helpers for between-test isolation.

import "dotenv/config";
import express, { type Express } from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../../../src/db";
import { buildQuiverRouter } from "../../../src/routes/quiver";
import {
  setAuditEmitter,
  resetAuditEmitter,
  type QuiverAuditEvent,
} from "../../../src/services/quiver/audit";
import { setCompassPort } from "../../../src/services/quiver/analysisService";

let migrationsApplied = false;

export async function applyQuiverMigrations(): Promise<void> {
  if (migrationsApplied) return;
  // Use the same migration directory the production code uses.
  const root = path.join(__dirname, "..", "..", "..", "src", "migrations");
  const up = (file: string): string =>
    readFileSync(path.join(root, file), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(up("062_b1_quiver_analysis.sql"));
    await client.query(up("063_b1_quiver_idempotency.sql"));
    await client.query(up("064_b4_quiver_versions.sql"));
    await client.query(up("065_b4_quiver_working_state.sql"));
    await client.query(up("066_b5_quiver_card_output_cache.sql"));
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  migrationsApplied = true;
}

export async function teardownQuiverTables(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "TRUNCATE quiver_analysis, quiver_idempotency_record, quiver_analysis_version, quiver_working_state, quiver_card_output_cache",
    );
  } finally {
    client.release();
  }
}

export async function dropQuiverMigrations(): Promise<void> {
  const root = path.join(__dirname, "..", "..", "..", "src", "migrations");
  const down = (file: string): string =>
    readFileSync(path.join(root, file), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(down("066_b5_quiver_card_output_cache.down.sql"));
    await client.query(down("065_b4_quiver_working_state.down.sql"));
    await client.query(down("064_b4_quiver_versions.down.sql"));
    await client.query(down("063_b1_quiver_idempotency.down.sql"));
    await client.query(down("062_b1_quiver_analysis.down.sql"));
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  migrationsApplied = false;
}

export function quiverApp(): Express {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  // Phase 5 enables every router; the test harness needs full surface.
  app.use("/quiver/api/v1", buildQuiverRouter({ phase: 5 }));
  return app;
}

export interface AuditCapture {
  events: QuiverAuditEvent[];
  reset(): void;
  detach(): void;
}

export function captureAudit(): AuditCapture {
  const events: QuiverAuditEvent[] = [];
  setAuditEmitter(async (e) => {
    events.push(e);
  });
  return {
    events,
    reset() {
      events.length = 0;
    },
    detach() {
      resetAuditEmitter();
    },
  };
}

export interface CompassSpy {
  authorizedReads: string[];
  registered: { rid: string; folder: string; branch: string }[];
  rejectFolder?: string;
  detach(): void;
}

export function fakeCompass(): CompassSpy {
  const spy: CompassSpy = {
    authorizedReads: [],
    registered: [],
    detach() {
      // restore default no-op port.
      setCompassPort({
        async assertEditorOnFolder() {},
        async registerAnalysis() {},
        async assertReadable() {},
      });
    },
  };
  setCompassPort({
    async assertEditorOnFolder({ folderRid }) {
      if (spy.rejectFolder && folderRid === spy.rejectFolder) {
        // Defer to the canonical error.
        const { parentFolderNotFound } = await import(
          "../../../src/services/quiver/errors"
        );
        throw parentFolderNotFound({ folderRid });
      }
    },
    async registerAnalysis({ rid, parentFolderRid, branch }) {
      spy.registered.push({ rid, folder: parentFolderRid, branch });
    },
    async assertReadable({ rid }) {
      spy.authorizedReads.push(rid);
    },
  });
  return spy;
}

export function quiverPostgresAvailable(): boolean {
  // Smoke check before integration tests; if PG isn't reachable, the
  // suite is skipped with a clear reason rather than hanging on connect.
  return Boolean(
    process.env.PG_HOST ||
      process.env.PGHOST ||
      process.env.DATABASE_URL ||
      process.env.PG_DSN ||
      process.env.PGPASSWORD ||
      true,
  );
}
