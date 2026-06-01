// ---------------------------------------------------------------------------
// B7 — pgoutput decoder wrapping pg-logical-replication (spec §B7 line 353).
//
// Connects via the replication protocol; subscribes the specified slot to
// pgoutput; emits parsed `(source, op, before, after)` tuples to a callback.
// BEGIN/END markers preserved when config.provideTransactionMetadata=true.
//
// pg-logical-replication is a peer-dep that may be absent (unit-test
// profile). Fall back to a noop decoder so unit tests can wire the
// downstream pipeline.
// ---------------------------------------------------------------------------

import type { CanonicalEvent, SourceRef } from "./canonical-format";

export interface DecoderConfig {
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  user: string;
  password: string;
  slotName: string;
  publicationName: string;
  /** Whether to emit BEGIN/END as 'b'/'e' events. */
  emitTxMarkers: boolean;
  onEvent: (e: CanonicalEvent) => void | Promise<void>;
}

export interface DecoderHandle {
  stop(): Promise<void>;
}

export async function startDecoder(cfg: DecoderConfig): Promise<DecoderHandle> {
  let module: any = null;
  try {
    module = await import("pg-logical-replication");
  } catch {
    // Noop decoder for unit tests.
    return { async stop() {} };
  }

  const { LogicalReplicationService, PgoutputPlugin } = module;
  const service = new LogicalReplicationService(
    {
      host: cfg.pgHost,
      port: cfg.pgPort,
      database: cfg.pgDatabase,
      user: cfg.user,
      password: cfg.password,
      replication: "database",
    },
    {
      acknowledge: { auto: false },
    },
  );
  const plugin = new PgoutputPlugin({
    protoVersion: 2,
    publicationNames: [cfg.publicationName],
  });

  // Map relation OIDs to source refs (pgoutput keeps a relation cache).
  const relMap = new Map<number, { source: SourceRef; pkCols: string[] }>();
  const { toCanonical } = await import("./canonical-format");

  service.on("data", async (_lsn: string, log: any) => {
    try {
      if (log.tag === "relation") {
        relMap.set(log.relationOid ?? log.relation_oid ?? log.relationId, {
          source: { schema: log.schema, table: log.name ?? log.relationName },
          pkCols: (log.keyColumns ?? [])
            .map((k: any) => k.name ?? k)
            .filter(Boolean),
        });
        return;
      }
      if (log.tag === "begin" && cfg.emitTxMarkers) {
        await cfg.onEvent(toCanonical(
          { schema: "", table: "" },
          "b",
          null,
          null,
          [],
          undefined,
          undefined,
          log.xid,
        ));
        return;
      }
      if (log.tag === "commit" && cfg.emitTxMarkers) {
        await cfg.onEvent(toCanonical(
          { schema: "", table: "" },
          "e",
          null,
          null,
          [],
          log.commitLsn,
          undefined,
        ));
        return;
      }
      if (log.tag === "insert" || log.tag === "update" || log.tag === "delete") {
        const rel = relMap.get(log.relationOid ?? log.relation_oid);
        if (!rel) return;
        const op =
          log.tag === "insert" ? "c" : log.tag === "update" ? "u" : "d";
        await cfg.onEvent(
          toCanonical(
            rel.source,
            op,
            (log.old ?? log.beforeKey ?? null) as Record<string, unknown> | null,
            (log.new ?? null) as Record<string, unknown> | null,
            rel.pkCols,
            _lsn,
            Date.now(),
          ),
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[cdc-worker.decode] failed", (err as Error).message);
    }
  });

  // Fire and forget; the service exits when stop() is called.
  service.subscribe(plugin, cfg.slotName).catch((err: Error) => {
    // eslint-disable-next-line no-console
    console.error("[cdc-worker.subscribe] failed", err.message);
  });

  return {
    async stop() {
      await service.stop().catch(() => undefined);
    },
  };
}
