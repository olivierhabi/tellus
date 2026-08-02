import { ensureLinkTable, insertLinkRows, linkTableName } from "../src/services/searchAround/linkMaterializedView";
import { getClickHouseClient } from "../src/services/searchAround/clickhouseClient";
const main = async () => {
  const desc = { sourceObjectType: "cntS", linkName: "cntL", targetObjectType: "cntT" };
  const c = getClickHouseClient();
  await ensureLinkTable(desc, c);
  await insertLinkRows(desc, [
    { source_pk: "X", target_pk: "Y", operation: "ADD", outbox_seq: 6001, event_id: "e1", tenant_id: "", ontology_id: "p-ont", branch_id: "p-branch" },
    { source_pk: "X", target_pk: "Y", operation: "ADD", outbox_seq: 6002, event_id: "e2", tenant_id: "", ontology_id: "p-ont", branch_id: "p-branch" },
  ]);
  const rows = await c.exec<Record<string, unknown>>(`SELECT source_pk, event_version, event_id FROM ${linkTableName(desc)}`);
  const n = await c.exec<{ n: string }>(`SELECT count() AS n FROM ${linkTableName(desc)}`);
  console.log(JSON.stringify({ rows, n }, null, 1));
};
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
