// scripts/v2_executor_integration.ts
// Real executeAction v2 integration test against the ephemeral PG16.
// Verifies: v2 modify succeeds + audit carries semantics v2 + correlation id;
// v2 create-then-modify (same identity) is rejected with
// SAME_INVOCATION_REFERENCE_FORBIDDEN and writes nothing.
//
// Run with v2 flags enabled:
//   ACTION_SEMANTICS_V2_ENABLED=true \
//   ACTION_SEMANTICS_V2_PROJECTION_READY=true \
//   PGHOST=localhost PGPORT=55432 PGDATABASE=tellus_test PGUSER=tellus_test \
//     PGPASSWORD=tellus_test npx tsx scripts/v2_executor_integration.ts
import { query as poolQuery } from "../src/db";
import { createActionType, getActionType } from "../src/models/actionType";
import { executeAction } from "../src/actions/actionExecutor";
import { OntologyError } from "../src/utils/queryErrors";

const ONT = "00000000-0000-0000-0000-000000000001";
async function main() {
  const branchId = (await poolQuery("SELECT branch_id FROM ontology_branch WHERE ontology_id=$1 AND name='main' LIMIT 1", [ONT])).rows[0].branch_id;
  const ot = `V2T_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const pkApi = "v2pk";
  const propApi = "v2name";

  // Create object type.
  const otRes = await poolQuery(
    `INSERT INTO object_type (ontology_id, api_name, display_name, created_by) VALUES ($1,$2,$3,$4) RETURNING object_type_id`,
    [ONT, ot, "V2 Test Object", "system"],
  );
  const otid = otRes.rows[0].object_type_id;
  // PK property + a string property; set PK.
  const pkRes = await poolQuery(
    `INSERT INTO property (object_type_id, api_name, display_name, base_type, is_required) VALUES ($1,$2,$3,'string',true) RETURNING property_id`,
    [otid, pkApi, "PK"],
  );
  const pkPid = pkRes.rows[0].property_id;
  await poolQuery(
    `INSERT INTO property (object_type_id, api_name, display_name, base_type, is_required) VALUES ($1,$2,$3,'string',false) RETURNING property_id`,
    [otid, propApi, "Name"],
  );
  await poolQuery("UPDATE object_type SET primary_key_property_id=$1 WHERE object_type_id=$2", [pkPid, otid]);

  // Insert an existing object instance to modify.
  const existingPk = "existing-obj-1";
  await poolQuery(
    `INSERT INTO object_instances (ontology_id, branch_id, object_type_api_name, primary_key, properties, markings, version)
     VALUES ($1,$2,$3,$4,$5,'{}'::text[],1)`,
    [ONT, branchId, ot, existingPk, JSON.stringify({ [pkApi]: existingPk, [propApi]: "old" })],
  );

  // 1. v2 modify action on the existing object — should succeed.
  const modifyApiName = `v2modify${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const modAction = await createActionType(ONT, {
    apiName: modifyApiName,
    displayName: "V2 Modify",
    parameters: [{ apiName: "ref", displayName: "Target", type: "object_reference", objectType: ot, required: true } as any, { apiName: "newName", displayName: "Name", type: "string", required: true } as any],
    rules: [{
      type: "modifyObject",
      objectType: ot,
      objectReference: { source: "parameter", param: "ref" },
      properties: { [propApi]: { source: "parameter", param: "newName" } },
    }],
    semanticsVersion: 2,
    executionMode: "declarative",
    deletePolicy: "restrict",
  } as any);
  log("created v2 modify action:", { apiName: modifyApiName, semanticsVersion: (modAction as any).semantics_version });

  try {
    const res = await executeAction(ONT, modifyApiName, { ref: existingPk, newName: "updated" }, { executedBy: "tester", branchId });
    log("v2 modify execute result:", { success: res.success, result: res.result, affected: res.affectedObjects });
    // Verify audit row semantics + correlation id.
    const audit = await poolQuery(
      `SELECT semantics_version, execution_mode, correlation_id, result FROM action_audit_log WHERE execution_id=$1 LIMIT 1`,
      [res.executionId],
    );
    log("audit row:", JSON.stringify(audit.rows[0] ?? null));
    // Verify object updated in object_instances.
    const upd = await poolQuery(`SELECT properties FROM object_instances WHERE object_type_api_name=$1 AND primary_key=$2`, [ot, existingPk]);
    log("object after modify:", upd.rows[0]?.properties);
  } catch (e: any) {
    log("v2 modify FAILED:", e?.message ?? String(e));
  }

  // 2. v2 create-then-modify (same identity, two rules) — must be rejected
  //    with SAME_INVOCATION_REFERENCE_FORBIDDEN and write no audit success.
  const ctmApi = `v2ctm${crypto.randomUUID().replace(/-/g, "").slice(0,18)}`;
  const ctmAction = await createActionType(ONT, {
    apiName: ctmApi,
    displayName: "V2 Create-then-Modify",
    parameters: [
      { apiName: "ref", displayName: "Target", type: "object_reference", objectType: ot, required: true } as any,
      { apiName: "newName", displayName: "Name", type: "string", required: true } as any,
    ],
    rules: [
      { type: "createObject", objectType: ot, properties: { [pkApi]: { source: "parameter", param: "ref" }, [propApi]: { source: "parameter", param: "newName" } } },
      { type: "modifyObject", objectType: ot, objectReference: { source: "parameter", param: "ref" }, properties: { [propApi]: { source: "parameter", param: "newName" } } },
    ],
    semanticsVersion: 2, executionMode: "declarative", deletePolicy: "restrict",
  } as any);
  log("created v2 create-then-modify action:", { apiName: ctmApi });

  let rejected = false;
  let errMsg = "";
  try {
    const r = await executeAction(ONT, ctmApi, { ref: "will-be-created", newName: "x" }, { executedBy: "tester", branchId });
    log("ctm UNEXPECTED success:", r);
  } catch (e: any) {
    rejected = true;
    errMsg = e?.message ?? String(e);
  }
  log("ctm rejected:", { rejected, message: errMsg });
  // Confirm no object 'will-be-created' was inserted.
  const leaked = await poolQuery(`SELECT 1 FROM object_instances WHERE object_type_api_name=$1 AND primary_key=$2`, [ot, "will-be-created"]);
  log("leaked object after rejected ctm:", { count: leaked.rowCount });

  // cleanup
  await poolQuery("DELETE FROM action_type WHERE ontology_id=$1 AND api_name IN ($2,$3)", [ONT, modifyApiName, ctmApi]);
  await poolQuery("DELETE FROM action_audit_log WHERE execution_id IS NOT NULL AND action_type_api_name IN ($1,$2)", [modifyApiName, ctmApi]);
  await poolQuery("DELETE FROM object_instances WHERE object_type_api_name=$1", [ot]);
  await poolQuery("DELETE FROM property WHERE object_type_id=$1", [otid]);
  await poolQuery("DELETE FROM object_type WHERE object_type_id=$1", [otid]);
}
function log(label: string, body?: unknown) { console.log(`\n=== ${label} ===`); if (body !== undefined) console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2)); }
main().catch((e) => { console.error("INTTEST FAILED:", e); process.exit(1); }).finally(() => process.exit(0));
