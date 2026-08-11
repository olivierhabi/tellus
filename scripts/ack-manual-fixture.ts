// ---------------------------------------------------------------------------
// Manual-verification fixture for the linkIndexAck HTTP contract.
// Idempotent: creates (once, in tellus_db) isolated object/link/action types
// plus OpenSearch docs, so the /apply curl scenarios can run repeatedly.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { query } from "../src/db";
import { deriveMainBranchId } from "../src/services/branchContext";
import { client as osClient } from "../src/services/opensearch/client";
import { getIndexName } from "../src/services/opensearch/indexMappingGenerator";
import {
  ensureLinkTable,
  type LinkTypeDescriptor,
} from "../src/services/searchAround/linkMaterializedView";

export const ONT = "00000000-0000-0000-0000-000000000001";
export const FIX = {
  ontologyId: ONT,
  branchId: deriveMainBranchId(ONT),
  sourceOtApiName: "AckManualSrc",
  targetOtApiName: "AckManualTgt",
  linkApiName: "ackManualOwnedBy",
  actionApiName: "ackmanual-link-adder",
};
export const DESCRIPTOR: LinkTypeDescriptor = {
  sourceObjectType: FIX.sourceOtApiName,
  linkName: FIX.linkApiName,
  targetObjectType: FIX.targetOtApiName,
};

export async function ensureAckManualFixture(): Promise<void> {
  const srcId = randomUUID();
  const tgtId = randomUUID();
  await query(
    `INSERT INTO object_type (object_type_id, ontology_id, api_name, display_name, version)
     VALUES ($1, $2, $3, $3, 1), ($4, $2, $5, $5, 1)
     ON CONFLICT (ontology_id, api_name) DO NOTHING`,
    [srcId, ONT, FIX.sourceOtApiName, tgtId, FIX.targetOtApiName],
  );
  const ids = await query(
    `SELECT api_name, object_type_id FROM object_type
      WHERE ontology_id = $1 AND api_name IN ($2, $3)`,
    [ONT, FIX.sourceOtApiName, FIX.targetOtApiName],
  );
  const idOf = (api: string) =>
    ids.rows.find((r) => r.api_name === api)?.object_type_id as string;
  await query(
    `INSERT INTO link_type
       (ontology_id, api_name, display_name, cardinality,
        source_object_type, target_object_type)
     VALUES ($1, $2, $2, 'MANY_TO_MANY', $3, $4)
     ON CONFLICT (ontology_id, api_name) DO NOTHING`,
    [ONT, FIX.linkApiName, idOf(FIX.sourceOtApiName), idOf(FIX.targetOtApiName)],
  );
  for (const [ot, pk] of [
    [FIX.sourceOtApiName, "m-s-1"], [FIX.sourceOtApiName, "m-s-2"],
    [FIX.targetOtApiName, "m-t-1"], [FIX.targetOtApiName, "m-t-2"],
  ] as const) {
    await osClient.index({
      id: pk,
      index: getIndexName(ot),
      body: { __pk: pk, __objectType: ot, __ontology: ONT, kind: "ack-manual" },
      refresh: "wait_for",
    });
  }
  await ensureLinkTable(DESCRIPTOR);
  await query(
    `INSERT INTO action_type
       (ontology_id, api_name, display_name, parameters, rules,
        is_enabled, created_by, semantics_version, execution_mode, delete_policy)
     VALUES ($1, $2, $2, $3::jsonb, $4::jsonb, true, 'ack-manual', 1, 'declarative', 'legacy_unchecked')
     ON CONFLICT (ontology_id, api_name) DO NOTHING`,
    [
      ONT,
      FIX.actionApiName,
      JSON.stringify([
        { apiName: "sourcePk", displayName: "Source PK", type: "string", required: true },
        { apiName: "targetPk", displayName: "Target PK", type: "string", required: true },
      ]),
      JSON.stringify([
        {
          type: "addLink",
          linkType: FIX.linkApiName,
          sourceObject: { source: "parameter", param: "sourcePk" },
          targetObject: { source: "parameter", param: "targetPk" },
        },
      ]),
    ],
  );
  console.log("[ack-manual] fixture ready:", FIX);
}

async function main() {
  await ensureAckManualFixture();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
