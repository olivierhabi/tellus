// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §8 — unified provenance traversal (integration, real Postgres).
//
// Proves the ProvenanceService SQL is correct against the LIVE schema: it seeds
// one object instance's footprint across all four streams —
//   * dataset_lineage  (upstream + downstream of the backing foundry_dataset)
//   * action_audit_log  (one real-chain READ row with a declared purpose +
//                        one real-chain WRITE row whose affected_objects names
//                        the instance)
//   * cbac_decision_log (an allow + a deny on the writing action type)
//   * access_purpose    (the catalogue entry for the declared purpose)
// — then asserts getObjectProvenance() correlates them all on the instance.
//
// Audit rows are written through the REAL hash-chain writer
// (logStandaloneFailureAudit), so the chain stays valid; they are append-only
// by REVOKE, so cleanup leaves the two stamped rows behind (harmless — every
// run uses a unique object type + primary key). Everything else is torn down.
//
// Skips gracefully when Postgres is unreachable.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import foundryDb from "../../../src/config/foundryDb";
import { ProvenanceService } from "../../../src/services/security/provenanceService";
import { logStandaloneFailureAudit } from "../../../src/models/actionAuditLog";

const STAMP = Date.now();
const OT = `ProvTaxpayer_${STAMP}`;
const PK = `PROV-${STAMP}`;
const PURPOSE = `prov-purpose-${STAMP}`;
const WRITE_ACTION = `provCreate_${STAMP}`;

let dbUp = false;
let ontologyId = "";
let objectTypeId = "";
let dsSelf = "";
let dsUp = "";
let dsDown = "";

const svc = new ProvenanceService();

beforeAll(async () => {
  try {
    await foundryDb.raw("SELECT 1");
    dbUp = true;
  } catch (err) {
    console.warn(`[fg-§8-provenance] Postgres unreachable: ${(err as Error).message}`);
    return;
  }

  // This deployment enforces a single-enterprise-ontology singleton
  // (uq_ontology_singleton, migration 100) — reuse the existing row rather than
  // inserting one. The object type api_name is stamped, so it stays unique.
  ontologyId = (await foundryDb.raw(`SELECT ontology_id FROM ontology LIMIT 1`)).rows[0].ontology_id;

  objectTypeId = (
    await foundryDb.raw(
      `INSERT INTO object_type (ontology_id, api_name, display_name) VALUES (?,?,?) RETURNING object_type_id`,
      [ontologyId, OT, OT],
    )
  ).rows[0].object_type_id;

  const mkDataset = async (name: string): Promise<string> =>
    (
      await foundryDb.raw(`INSERT INTO foundry_datasets (name, file_path) VALUES (?,?) RETURNING id`, [
        name,
        `/seed/${name}`,
      ])
    ).rows[0].id;
  dsSelf = await mkDataset(`prov_self_${STAMP}`);
  dsUp = await mkDataset(`prov_up_${STAMP}`);
  dsDown = await mkDataset(`prov_down_${STAMP}`);

  // Object type's backing dataset → dsSelf.
  await foundryDb.raw(
    `INSERT INTO backing_datasource
       (object_type_id, foundry_dataset_id, dataset_name, file_path, column_mapping, primary_key_column)
     VALUES (?,?,?,?,?::jsonb,?)`,
    [objectTypeId, dsSelf, `prov_self_${STAMP}`, `/seed/prov_self_${STAMP}`, "{}", "id"],
  );

  // dsSelf derived FROM dsUp; dsDown derived FROM dsSelf.
  await foundryDb.raw(
    `INSERT INTO dataset_lineage (downstream_dataset_id, upstream_dataset_id, edge_type)
     VALUES (?,?, 'pipeline_output'), (?,?, 'pipeline_output')`,
    [dsSelf, dsUp, dsDown, dsSelf],
  );

  await foundryDb.raw(
    `INSERT INTO access_purpose (ontology_id, api_name, display_name, allowed_categories)
     VALUES (?,?,?, ARRAY['object.read']::text[])`,
    [ontologyId, PURPOSE, "Prov Purpose"],
  );

  const mkDecision = (subject: string, kind: string, decision: string, reason: string) =>
    foundryDb.raw(
      `INSERT INTO cbac_decision_log
         (subject, subject_kind, resource_kind, resource_id, ontology_id, decision, reason)
       VALUES (?,?, 'action_type', ?, ?, ?, ?)`,
      [subject, kind, WRITE_ACTION, ontologyId, decision, reason],
    );
  await mkDecision("etl-service", "service", "allow", "allowlist match");
  await mkDecision("mallory", "user", "deny", "markings_insufficient");

  // A real-chain WRITE row naming the instance in affected_objects.
  await logStandaloneFailureAudit({
    action_type_api_name: WRITE_ACTION,
    action_type_display_name: "Prov Create",
    execution_id: randomUUID(),
    parameters: { ontology_id: ontologyId },
    affected_objects: [{ objectType: OT, primaryKey: PK, operation: "create" }],
    affected_object_count: 1,
    result: "success",
    failure_type: null,
    error_message: null,
    duration_ms: 5,
    executed_by: "etl-service",
    source_ip: null,
    branch_id: null,
    metadata: {},
  });

  // A real-chain READ row of the instance, with a declared purpose (§8 gate).
  await logStandaloneFailureAudit({
    action_type_api_name: "__read.object.read",
    action_type_display_name: "Read Audit: object.read",
    execution_id: randomUUID(),
    parameters: {
      ontology_id: ontologyId,
      object_type: OT,
      primary_key: PK,
      route: `/api/v1/ontology/${ontologyId}/objects/${OT}/${PK}`,
    },
    affected_objects: [],
    affected_object_count: 1,
    result: "success",
    failure_type: null,
    error_message: null,
    duration_ms: 3,
    executed_by: "alice",
    source_ip: "10.0.0.1",
    branch_id: null,
    metadata: { purpose: PURPOSE },
  });
}, 60_000);

afterAll(async () => {
  if (!dbUp) return;
  // action_audit_log / cbac_decision_log are append-only by REVOKE for PUBLIC,
  // but the test runs as the table owner. We deliberately KEEP the two audit
  // rows (deleting them would truncate the live hash chain); they are uniquely
  // stamped. cbac rows have no chain, so we remove them.
  await foundryDb.raw(`DELETE FROM cbac_decision_log WHERE resource_id = ?`, [WRITE_ACTION]).catch(() => {});
  await foundryDb.raw(`DELETE FROM access_purpose WHERE ontology_id = ?`, [ontologyId]).catch(() => {});
  await foundryDb
    .raw(`DELETE FROM dataset_lineage WHERE downstream_dataset_id = ANY(?) OR upstream_dataset_id = ANY(?)`, [
      [dsSelf, dsUp, dsDown],
      [dsSelf, dsUp, dsDown],
    ])
    .catch(() => {});
  await foundryDb.raw(`DELETE FROM backing_datasource WHERE object_type_id = ?`, [objectTypeId]).catch(() => {});
  await foundryDb.raw(`DELETE FROM foundry_datasets WHERE id = ANY(?)`, [[dsSelf, dsUp, dsDown]]).catch(() => {});
  await foundryDb.raw(`DELETE FROM object_type WHERE object_type_id = ?`, [objectTypeId]).catch(() => {});
  // The ontology row is the shared singleton — never delete it.
});

describe("ProvenanceService — live traversal", () => {
  it("correlates lineage + read + write + cbac + purpose for one object instance", async () => {
    if (!dbUp) {
      console.warn("[fg-§8-provenance] skipped (no DB)");
      return;
    }

    const p = await svc.getObjectProvenance({
      ontologyId,
      objectTypeApiName: OT,
      primaryKey: PK,
    });

    // -- reads ------------------------------------------------------------
    expect(p.reads.length).toBeGreaterThanOrEqual(1);
    const read = p.reads.find((r) => r.by === "alice");
    expect(read).toBeTruthy();
    expect(read!.category).toBe("object.read");
    expect(read!.purpose).toBe(PURPOSE);

    // -- writes -----------------------------------------------------------
    expect(p.writes.length).toBeGreaterThanOrEqual(1);
    const write = p.writes.find((w) => w.action === WRITE_ACTION);
    expect(write).toBeTruthy();
    expect(write!.operation).toBe("create");
    expect(write!.by).toBe("etl-service");

    // -- access decisions correlated to the writing action ---------------
    expect(p.accessDecisions.length).toBe(2);
    expect(p.accessDecisions.map((d) => d.decision).sort()).toEqual(["allow", "deny"]);

    // -- lineage of the backing dataset ----------------------------------
    expect(p.lineage.dataset?.name).toBe(`prov_self_${STAMP}`);
    expect(p.lineage.upstream.map((n) => n.name)).toContain(`prov_up_${STAMP}`);
    expect(p.lineage.downstream.map((n) => n.name)).toContain(`prov_down_${STAMP}`);

    // -- purposes observed (active in catalogue) -------------------------
    const purpose = p.purposes.find((x) => x.apiName === PURPOSE);
    expect(purpose).toBeTruthy();
    expect(purpose!.active).toBe(true);
    expect(purpose!.reads).toBeGreaterThanOrEqual(1);

    // -- summary ----------------------------------------------------------
    expect(p.summary.totalReads).toBeGreaterThanOrEqual(1);
    expect(p.summary.totalWrites).toBeGreaterThanOrEqual(1);
    expect(p.summary.denials).toBe(1);
    expect(p.summary.distinctReaders).toBeGreaterThanOrEqual(1);
    expect(p.notes).toEqual([]);
  });
});
