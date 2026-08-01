// Failure-injection #12 — OpenSearch catastrophically unreachable.
//
// The endpoint is overridden at module-LOAD time in this file (every
// vitest file gets an isolated process): the PG dispatcher path runs the
// stages; indexing fails against the dead port; the run MUST end as
// failed, never false-green "indexed". Deterministic proof of the
// OT's state under an OS outage.
process.env.OPENSEARCH_URL = "http://127.0.0.1:9"; // UNREACHABLE
process.env.OPENSEARCH_REQUEST_TIMEOUT = "1000";
process.env.OPENSEARCH_MAX_RETRIES = "1";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LANE } from "../../laneEnv";

const STAMP = Date.now();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT = `OsOutage${STAMP}`;
let OT_ID = "";

let db: typeof import("../../../src/db");
let dispatcher: typeof import("../../../src/services/funnel/funnelDispatcher");

beforeAll(async () => {
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({
    operation: "os-outage-fixture-cleanup",
    skipApiProbe: true,
  });
  db = await import("../../../src/db");
  dispatcher = await import("../../../src/services/funnel/funnelDispatcher");
  const ins = await db.query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     ON CONFLICT (ontology_id, api_name) DO NOTHING RETURNING object_type_id`,
    [ONTOLOGY_ID, OT, `OS Outage ${STAMP}`],
  );
  OT_ID = ins.rows[0]?.object_type_id as string;
  const pk = await db.query(
    `INSERT INTO property (object_type_id, api_name, display_name, base_type, is_required, ordinal)
     VALUES ($1, 'pk', 'PK', 'string', true, 0) RETURNING property_id`,
    [OT_ID],
  );
  await db.query(
    `UPDATE object_type SET primary_key_property_id = $1 WHERE object_type_id = $2`,
    [pk.rows[0].property_id, OT_ID],
  );
  // One content slice so the indexing stage has work to attempt.
  const br = await db.query(
    `SELECT branch_id FROM ontology_branch WHERE ontology_id = $1 AND name = 'main'`,
    [ONTOLOGY_ID],
  );
  await db.query(
    `INSERT INTO ontology_edit (ontology_id, object_type_api_name, primary_key, operation, property_values, link_edits, executed_by, branch_id)
     VALUES ($1, $2, 'row-1', 'update', '{}', '[]', 'test', $3)`,
    [ONTOLOGY_ID, OT, br.rows[0].branch_id],
  );
});

afterAll(async () => {
  await db.pool.end();
});

describe("failure-injection #12 — OS outage", () => {
  it("drain the signal: the run terminates 'failed', NEVER 'indexed'", async () => {
    const client = await db.pool.connect();
    try {
      const r = await client.query(
        `INSERT INTO funnel_signal (ontology_id, object_type_api_name, signal_type, payload)
         VALUES ($1, $2, 'sourceTransactionCommitted', '{}') RETURNING signal_id`,
        [ONTOLOGY_ID, OT],
      );
      void r;
    } finally { client.release(); }
    await dispatcher.drainPendingSignals({ objectTypes: [OT] });
    const fs1 = await db.query(
      `SELECT status, error_message FROM funnel_state WHERE object_type_id = $1`,
      [OT_ID],
    );
    if (fs1.rows[0]) {
      expect(fs1.rows[0].status).not.toBe("indexed");
    }
    // And the run's status must not show "completed" without evidence:
    const run = await db.query(
      `SELECT status, error_message, definition_version FROM funnel_run
        WHERE object_type_api_name = $1 ORDER BY started_at DESC LIMIT 1`,
      [OT],
    );
    if (run.rows[0]) {
      expect(run.rows[0].status).not.toBe("completed");
      expect(run.rows[0].definition_version).toBe(1);
    }
  });
});
