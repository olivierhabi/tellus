import { getClickHouseClient } from "../src/services/searchAround/clickhouseClient";
import { ensureLinkTable, insertLinkRows } from "../src/services/searchAround/linkMaterializedView";
const main = async () => {
  console.log("ENV db:", process.env.CLICKHOUSE_DATABASE);
  const desc = { sourceObjectType: "probeS", linkName: "probeL", targetObjectType: "probeT" };
  const c = getClickHouseClient();
  await ensureLinkTable(desc, c);
  const tables = await c.exec<{ name: string; database: string }>(`SELECT name, database FROM system.tables WHERE name LIKE 'link_probe%'`);
  console.log(JSON.stringify({ envDb: process.env.CLICKHOUSE_DATABASE, tables }, null, 1));
};
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
