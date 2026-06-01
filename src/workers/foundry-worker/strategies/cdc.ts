// ---------------------------------------------------------------------------
// B7 — CDC strategy (foundry-worker bridge).
//
// The dedicated long-running CDC consumer lives in src/workers/cdc-worker.
// When a build is dispatched with strategy='cdc', the foundry-worker performs
// the *bootstrap*: it validates the source supports logical replication and
// ensures the replication slot + publication exist, then emits a handoff
// event. The streaming itself is owned by the cdc-worker (slot manager +
// pgoutput decoder), which is scheduled out-of-band so a short-lived build
// process never blocks on an unbounded change stream.
// ---------------------------------------------------------------------------

import { Client } from "pg";
import type { JobSpec } from "../../../services/orchestration/runners/runtime-adapter";
import type { CredentialFetchResult } from "../credential-fetch";

function send(buildRid: string, kind: string, data?: object): void {
  if (process.send) {
    process.send({ buildRid, ts: new Date().toISOString(), kind, data });
  }
}

interface CdcPayload {
  config: {
    schema: string;
    table: string;
    slotName?: string;
    publicationName?: string;
  };
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
}

export async function runCdc(
  spec: JobSpec,
  creds: CredentialFetchResult,
): Promise<void> {
  const cfg = spec.payload as unknown as CdcPayload;
  const slotName =
    cfg.config.slotName ?? `tellus_${cfg.config.schema}_${cfg.config.table}`.slice(0, 63);
  const publicationName =
    cfg.config.publicationName ??
    `tellus_pub_${cfg.config.schema}_${cfg.config.table}`.slice(0, 63);

  const client = new Client({
    host: cfg.pgHost,
    port: cfg.pgPort,
    database: cfg.pgDatabase,
    user: creds.fields.user,
    password: creds.fields.password,
    ssl: creds.fields.serverCaPem
      ? { ca: creds.fields.serverCaPem, rejectUnauthorized: true }
      : false,
  });
  await client.connect();
  try {
    send(spec.buildRid, "progress", { phase: "cdc-preflight" });

    // 1) wal_level must be 'logical' for logical replication slots.
    const wal = await client.query<{ wal_level: string }>("SHOW wal_level");
    const walLevel = wal.rows[0]?.wal_level;
    if (walLevel !== "logical") {
      throw new Error(
        `source wal_level=${walLevel ?? "unknown"}; logical replication requires wal_level=logical`,
      );
    }

    // 2) Ensure publication exists for the target table (idempotent).
    const pubExists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = $1) AS exists`,
      [publicationName],
    );
    if (!pubExists.rows[0]?.exists) {
      await client.query(
        `CREATE PUBLICATION ${quoteIdent(publicationName)} FOR TABLE ${quoteIdent(
          cfg.config.schema,
        )}.${quoteIdent(cfg.config.table)}`,
      );
      send(spec.buildRid, "progress", { phase: "publication-created", publicationName });
    }

    // 3) Ensure logical replication slot exists (idempotent, pgoutput plugin).
    const slotExists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_replication_slots WHERE slot_name = $1
       ) AS exists`,
      [slotName],
    );
    if (!slotExists.rows[0]?.exists) {
      await client.query(
        `SELECT pg_create_logical_replication_slot($1, 'pgoutput')`,
        [slotName],
      );
      send(spec.buildRid, "progress", { phase: "slot-created", slotName });
    }

    // 4) Handoff to the dedicated cdc-worker. The slot + publication now
    // exist, so the streaming consumer can attach and resume from the
    // slot's confirmed_flush_lsn.
    send(spec.buildRid, "progress", {
      phase: "cdc-handoff",
      slotName,
      publicationName,
      message:
        "CDC bootstrap complete; streaming owned by cdc-worker (slot manager).",
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Minimal SQL identifier quoting (defense-in-depth; names are validated upstream). */
function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
