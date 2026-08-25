// ---------------------------------------------------------------------------
// Consumer stand-in pump for the linkIndexAck manual verification.
//
// Mirrors tests/funnel/integration/link-index-ack-integration.test.ts:
// drains the link CDC outbox to Kafka (real broker acceptance) and maps the
// PUBLISHED payload into the serving edge table via insertLinkRows — the
// SAME row shape kafkaIngestDdl's MV v3 passthrough produces. Runs until
// stopped (Ctrl-C) or --seconds elapses.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { query } from "../src/db";
import { drainLinkOutboxOnce } from "../src/services/searchAround/linkCdcOutbox";
import { shutdownCdcLinkProducer } from "../src/services/searchAround/cdcLinkProducer";
import {
  insertLinkRows,
  type LinkTypeDescriptor,
} from "../src/services/searchAround/linkMaterializedView";

const LINK_TYPE = process.argv[2] ?? "ackManualOwnedBy";
const SECONDS = Number(process.argv[3] ?? 60);

const DESCRIPTOR: LinkTypeDescriptor = {
  sourceObjectType: "AckManualSrc",
  linkName: "ackManualOwnedBy",
  targetObjectType: "AckManualTgt",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const stopAt = Date.now() + SECONDS * 1000;
  const ingested = new Set<string>();
  console.log(`[ack-pump] running for ${SECONDS}s (linkType=${LINK_TYPE})`);
  while (Date.now() < stopAt) {
    try {
      await drainLinkOutboxOnce(100);
      const rows = await query(
        `SELECT payload FROM link_cdc_outbox
          WHERE link_type_api_name = $1 AND published_at IS NOT NULL`,
        [LINK_TYPE],
      );
      for (const { payload: p } of rows.rows) {
        if (ingested.has(p.event_id)) continue; // at-least-once guard
        try {
          await insertLinkRows(DESCRIPTOR, [
            {
              source_pk: p.source_pk,
              target_pk: p.target_pk,
              operation: p.operation,
              event_id: p.event_id,
              event_version: Number(p.event_ts_micros),
              outbox_seq: Number(p.outbox_seq),
              ontology_id: p.ontology_id,
              branch_id: p.branch_id,
              tenant_id: p.tenant_id,
            },
          ]);
        } catch (err) {
          console.warn(`[ack-pump] insert failed (will retry): ${(err as Error).message}`);
          continue; // NOT marked — retried next iteration
        }
        ingested.add(p.event_id); // marked ONLY after a landed insert
        console.log(`[ack-pump] ingested event ${p.event_id} (seq ${p.outbox_seq})`);
      }
    } catch (err) {
      console.warn(`[ack-pump] ${(err as Error).message}`);
    }
    await sleep(150);
  }
  await shutdownCdcLinkProducer();
  console.log("[ack-pump] stopped");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
