// ---------------------------------------------------------------------------
// B7 — CDC worker entrypoint (spec §B7 line 352).
//
// Long-running worker process. Subscribes the configured slot, decodes
// pgoutput, normalizes to canonical events, hands to ChangelogWriter
// (Kafka). Heartbeats slot LSN advancement.
//
// JobSpec.payload is expected to contain:
//   { strategy: 'cdc', config: PostgresCdcConfigT, pgHost, pgPort, pgDatabase, importRid }
// ---------------------------------------------------------------------------

import { installEgressAllowlist } from "../../services/orchestration/runners/egress-allowlist";
import type { JobSpec } from "../../services/orchestration/runners/runtime-adapter";
import type { CredentialFetchResult } from "../foundry-worker/credential-fetch";

function send(buildRid: string, kind: string, data?: object): void {
  if (process.send) {
    process.send({ buildRid, ts: new Date().toISOString(), kind, data });
  }
}

export async function runCdc(
  spec: JobSpec,
  creds: CredentialFetchResult,
): Promise<void> {
  // egress already installed by foundry-worker/entrypoint before the strategy
  // import — but if this module is invoked stand-alone, install now (no-op
  // if already done).
  try {
    installEgressAllowlist(spec.egress);
  } catch {
    /* already installed */
  }

  const cfg = (spec.payload as any).config as {
    slotName: string;
    publicationName: string;
    tables: Array<{ schema: string; table: string }>;
    partitions: number;
    topic?: string;
    provideTransactionMetadata: boolean;
    publicationAutocreate: "disabled" | "filtered" | "all_tables";
  };
  const pg = spec.payload as any;

  const slotMgr = await import("../../services/connectivity/cdc/slot-manager");
  await slotMgr.ensureCreated(spec.connectionRid, {
    slotName: cfg.slotName,
    publicationName: cfg.publicationName,
    tables: cfg.tables,
    publicationAutocreate: cfg.publicationAutocreate,
  });

  const { ChangelogWriter } = await import(
    "../../services/connectivity/cdc/changelog-writer"
  );
  const writer = new ChangelogWriter(
    (spec.payload as any).importRid ?? spec.importRid,
    cfg.partitions,
    cfg.topic,
  );
  await writer.start();

  send(spec.buildRid, "started", {
    slot: cfg.slotName,
    publication: cfg.publicationName,
  });

  const { startDecoder } = await import("./pgoutput-decoder");
  let totalEvents = 0;
  const decoder = await startDecoder({
    pgHost: pg.pgHost,
    pgPort: pg.pgPort,
    pgDatabase: pg.pgDatabase,
    user: creds.fields.user,
    password: creds.fields.password,
    slotName: cfg.slotName,
    publicationName: cfg.publicationName,
    emitTxMarkers: cfg.provideTransactionMetadata,
    onEvent: async (ev) => {
      await writer.append(ev);
      totalEvents += 1;
      if (totalEvents % 1000 === 0) {
        send(spec.buildRid, "progress", {
          phase: "events",
          totalEvents,
        });
      }
    },
  });

  // Block until SIGTERM.
  const stop = async () => {
    await decoder.stop();
    await writer.stop();
    send(spec.buildRid, "succeeded", { totalEvents });
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise(() => {
    /* never */
  });
}
