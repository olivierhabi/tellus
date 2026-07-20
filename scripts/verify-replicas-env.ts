// Step 2c verification: confirm OS_INDEX_REPLICAS flows through the code path
// (generateIndexMapping -> settings -> a real OS index's _settings).
// Pass OS_INDEX_REPLICAS=2 via the SHELL env (not in-script — ES module imports
// are hoisted above in-script process.env writes, so DEFAULT_INDEX_SETTINGS
// would evaluate before the set). Generates the mapping for an existing OT,
// creates a throwaway test index with that mapping, reads back _settings,
// deletes it.
import "dotenv/config";
import { generateIndexMapping } from "../src/services/opensearch/indexMappingGenerator";
import { client } from "../src/services/opensearch/client";

async function main(): Promise<void> {
  const mr = await generateIndexMapping("OlivierOrder1");
  const body = mr.mapping as unknown as { settings?: { index?: Record<string, unknown> } & Record<string, unknown> };
  const settings = body.settings?.index ?? body.settings ?? {};
  console.log("OS_INDEX_REPLICAS env =", process.env.OS_INDEX_REPLICAS);
  console.log("generated mapping settings.number_of_replicas =", settings.number_of_replicas);
  console.log("generated mapping settings.number_of_shards   =", settings.number_of_shards);

  const testIndex = "ontology-test-replicas-verify";
  await client.indices.delete({ index: testIndex }).catch(() => { /* ignore if absent */ });
  await client.indices.create({ index: testIndex, body: body as Record<string, unknown> });
  const resp = (await client.indices.getSettings({ index: testIndex })) as unknown as {
    body: Record<string, { settings: { index: { number_of_replicas: string; number_of_shards: string } } }>;
  };
  const applied = resp.body[testIndex].settings.index;
  console.log("APPLIED on real index -> number_of_replicas =", applied.number_of_replicas, " number_of_shards =", applied.number_of_shards);
  await client.indices.delete({ index: testIndex });
  if (applied.number_of_replicas !== "2") {
    throw new Error(`FAIL: expected number_of_replicas=2, got ${applied.number_of_replicas}`);
  }
  console.log("PASS: OS_INDEX_REPLICAS=2 applied to a real index");
}

main().catch((e) => { console.error("FAIL:", (e as Error).message); process.exit(1); });
