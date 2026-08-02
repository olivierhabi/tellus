import { client } from "./src/services/opensearch/client";
import { getIndexName } from "./src/services/opensearch/indexMappingGenerator";
const OT = "s5_0pgd";
const idx = getIndexName(OT);
(async () => {
  console.log("idx:", idx);
  const r = await client.get({ index: idx, id: "pk-1" });
  console.log("get:", JSON.stringify((r as { body?: unknown }).body).slice(0, 400));
})().catch((e) => console.error("ERR:", e.message)).finally(() => process.exit(0));
