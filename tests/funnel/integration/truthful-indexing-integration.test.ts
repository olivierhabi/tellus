// ---------------------------------------------------------------------------
// LANE test — truthful indexing acknowledgement (real PG).
//
// Proves, against the real datastore, that NO stamping of
// `applied_to_index_at` (or `indexed`) happens when the serving index
// (Quickwit) cannot confirm the batch. The Redis overlay is retained
// because the sweeper keys off that stamp — failure is irreversible
// otherwise, so this gate must stay green.
// ---------------------------------------------------------------------------

import { afterAll, describe, expect, it } from "vitest";
import { query } from "../../../src/db";
import { runIndexingActivityProxy } from "../../../src/services/funnel/temporal/activities";
import { LANE } from "../../laneEnv";

const STAMP = Date.now();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT_API_NAME = `TruthAckProbe${STAMP}`;
const EDIT_ID = "99999999-8888-7777-6666-555555555501";

describe("truthful indexing acknowledgement (real PG, Quickwit DOWN)", () => {
  afterAll(async () => {
    await query(`DELETE FROM ontology_edit WHERE edit_id = $1`, [EDIT_ID]);
  });

  it("pending edit survives a run without being stamped; indexed stays false", async () => {
    // Seed a pending edit the same way applyEdits does.
    const branch = await query(
      `SELECT branch_id FROM ontology_branch
        WHERE ontology_id = $1 AND name = 'main' LIMIT 1`,
      [ONTOLOGY_ID],
    );
    const branchId = branch.rows[0].branch_id as string;
    await query(
      `INSERT INTO ontology_edit
         (edit_id, object_type_api_name, primary_key, operation, property_values,
          link_edits, action_type_api_name, execution_id, executed_by,
          edit_strategy, ontology_id, branch_id)
       VALUES ($1, $2, $3, 'create', '{}'::jsonb, '[]'::jsonb, $4, $5, 'test',
               'user_edit_wins', $6, $7)`,
      [
        EDIT_ID,
        OT_API_NAME,
        `pk-${STAMP}`,
        "probe-action-type",
        "00000000-0000-0000-0000-0000000000ff",
        ONTOLOGY_ID,
        branchId,
      ],
    );

    // Quickwit is intentionally NOT running in this lane; the probe must
    // fail so the activity must take the truthful-defer branch. Guard the
    // env so nothing else overrides it.
    const prevQw = process.env.QUICKWIT_URL;
    process.env.QUICKWIT_URL = "http://127.0.0.1:1";
    try {
      const out = await runIndexingActivityProxy({
        ontologyId: ONTOLOGY_ID,
        objectTypeApiName: OT_API_NAME,
        environmentId: LANE.TELLUS_ENVIRONMENT_ID,
        mergedSnapshotId: "probe-snapshot",
        mergedRowCount: 1,
      } as never);
      expect(out.quickwit).toBe(false);
      expect(out.editsIndexed).toBe(0);
      expect(out.publishedSplitIds).toEqual([]);
    } finally {
      if (prevQw === undefined) delete process.env.QUICKWIT_URL;
      else process.env.QUICKWIT_URL = prevQw;
    }

    const r = await query(
      `SELECT applied_to_index_at, indexed FROM ontology_edit WHERE edit_id = $1`,
      [EDIT_ID],
    );
    expect(r.rows[0].applied_to_index_at).toBe(null);
    expect(r.rows[0].indexed).toBe(false);
  });
});
