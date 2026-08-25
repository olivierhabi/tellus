// ---------------------------------------------------------------------------
// STAGE 8a — real Kafka-engine topology spike.
//
// Proves the smallest complete topology:
//   Node/Kafka producer → Kafka broker → ClickHouse Kafka-engine table
//   → materialized view → versioned edge table.
//
// NO insertLinkRows at the CH boundary — the row must travel down the wire.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from "vitest";
import {
  ensureLinkIngestTopology,
  linkTableName,
  type LinkTypeDescriptor,
} from "../../src/services/searchAround/linkMaterializedView";
import { getClickHouseClient } from "../../src/services/searchAround/clickhouseClient";
import { publishRowsToTopic, linkCdcTopic, shutdownCdcLinkProducer } from "../../src/services/searchAround/cdcLinkProducer";

const tag = () => `sp${Math.random().toString(36).slice(2, 8)}`;

describe("Kafka-engine → MV → versioned edge table (REAL)", () => {
  afterAll(() => shutdownCdcLinkProducer());

  it("a rim-published CDC row appears in the serving table without any direct CH write", async () => {
    const desc: LinkTypeDescriptor = {
      sourceObjectType: `${tag()}s`,
      linkName: `${tag()}l`,
      targetObjectType: `${tag()}t`,
    };
    const ch = getClickHouseClient();
    // Full DDL chain in one shot: pre-creates the topic, the serving
    // ReplacingMergeTree, the Kafka engine table and the MV.
    await ensureLinkIngestTopology(desc, ch);

    const sent = await publishRowsToTopic(linkCdcTopic(desc.sourceObjectType, desc.linkName), [
      {
        source_pk: "S1",
        target_pk: "T1",
        link_props: {},
        markings: [],
        schema_version: "2.0.0",
        event_id: "topospike-1",
        event_ts_micros: Date.now() * 1000, // informational only (Stage 7)
        ontology_id: "spike-ont",
        link_type_api_name: desc.linkName,
        operation: "ADD",
        branch_id: "spike-branch",
        tenant_id: "",
        outbox_seq: 9001,
      },
    ]);
    expect(sent).toBe(1);

    // The MV is asynchronous — poll: the row must appear IN the serving
    // table as a side effect of Kafka-engine ingestion, never of CH writes.
    const deadline = Date.now() + 45_000;
    let rows: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      try {
        rows = await ch.exec<Record<string, unknown>>(
          `SELECT event_id, operation, deleted, event_version, outbox_seq
             FROM ${linkTableName(desc)} FORMAT JSONEachRow`,
        );
        if (rows.length > 0) break;
      } catch {
        /* table not yet materialized by engine startup */
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].event_id).toBe("topospike-1");
    expect(rows[0].operation).toBe("ADD");
    expect(Number(rows[0].deleted)).toBe(0);
    // Stage 7 contract: version comes from the sequence, not the clock.
    expect(Number(rows[0].event_version)).toBe(9001);
    expect(Number(rows[0].outbox_seq)).toBe(9001);
  });
});
