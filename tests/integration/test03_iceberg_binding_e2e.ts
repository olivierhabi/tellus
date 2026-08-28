// ---------------------------------------------------------------------------
// Integration Test: Iceberg Backing Datasource — 179 Contract E2E
//
// Verifies that after migration 179 widens the backing_datasource file_format
// CHECK to include iceberg, repaired bindings persist correctly and the
// indexing pipeline reads them through the proper Iceberg path.
//
// Covers:
//  1. PG CHECK constraints accept iceberg
//  2. Repaired backing_datasource rows store correct values (SQL verification)
//  3. Force-reindex completes with correct count
//  4. OpenSearch documents are present and queryable
//  5. Negative test: bare UUID file_path → rejected by validation layer
//
// Run: npx tsx tests/integration/test03_iceberg_binding_e2e.ts
// ---------------------------------------------------------------------------

const BASE = process.env.API_BASE || (process.env.TEST_BASE_URL ?? "http://localhost:3000");

const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const ORDERS_OBJECT_TYPE = "OlivierOrders876";
const DISTRICTS_OBJECT_TYPE = "OlivierDistricts484787";

let passed = 0;
let failed = 0;
const started = Date.now();

function assert(condition: boolean, label: string, detail?: string) {
  const ms = Date.now() - started;
  if (condition) {
    console.log(`  ${label}: PASS (${ms}ms)`);
    passed++;
  } else {
    console.error(`  ${label}: FAIL (${ms}ms)${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function api(method: string, urlPath: string, body?: unknown) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body
      ? {
          "Content-Type": "application/json",
          "X-Tellus-Test-Auth": "admin:ontology-admin",
        }
      : { "X-Tellus-Test-Auth": "admin:ontology-admin" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload: unknown = null;
  try { payload = JSON.parse(text); } catch { payload = text; }
  return { status: res.status, body: payload as Record<string, unknown> };
}

async function psql(sql: string): Promise<Record<string, unknown>[]> {
  const { spawn } = await import("child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec", "-i", "tellus-postgres-1",
        "psql", "-U", "tellus", "-d", "tellus_db",
        "-t", "-A", "-F", "\t", "-c", sql,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code: number) => {
      if (code !== 0) return reject(new Error(`psql exit ${code}: ${stderr}`));
      const rows = stdout
        .split("\n")
        .filter((l: string) => l.trim())
        .map((l: string) => l.split("\t"));
      resolve(rows as unknown as Record<string, unknown>[]);
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

async function osSearch(indexPattern: string) {
  const res = await fetch(
    `http://localhost:9200/${encodeURIComponent(indexPattern)}/_search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size: 1 }),
    },
  );
  return res.json() as Promise<Record<string, unknown>>;
}

async function main() {
  console.log("=== Integration Test: Iceberg Binding 179 Contract E2E ===\n");

  // -------------------------------------------------------------------
  // 1. PG CHECK constraint accepts iceberg
  // -------------------------------------------------------------------
  console.log("1. PG CHECK constraints");

  const constraints = await psql(
    `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conname IN ('backing_datasource_file_format_check','foundry_datasets_format_check')
       ORDER BY conname`,
  );

  assert(constraints.length === 2, "both format constraints exist");

  for (const row of constraints) {
    const def = String(row[1]);
    assert(
      def.toLowerCase().includes("iceberg"),
      `${row[0]} includes iceberg`,
    );
  }

  // -------------------------------------------------------------------
  // 2. Repaired binding rows carry correct values
  // -------------------------------------------------------------------
  console.log("\n2. Repaired binding rows");

  // Orders — iceberg
  const ordersRs = await psql(
    `SELECT file_format,
            SPLIT_PART(file_path, '#foundry-dataset:', 1) AS stripped_path
       FROM backing_datasource
      WHERE object_type_id = (
        SELECT object_type_id FROM object_type WHERE api_name = '${ORDERS_OBJECT_TYPE}'
      )`,
  );
  assert(ordersRs.length === 1, "OlivierOrders876 has binding row");

  if (ordersRs.length === 1) {
    assert(
      String(ordersRs[0][0]) === "iceberg",
      "OlivierOrders876 file_format = iceberg",
    );
    const stripped = String(ordersRs[0][1]);
    assert(
      stripped.startsWith("iceberg://"),
      `OlivierOrders876 stripped path is iceberg:// URI`,
      `got: ${stripped.slice(0, 80)}`,
    );
  }

  // Districts — canonical CSV key (not bare UUID)
  const districtsRs = await psql(
    `SELECT file_format,
            SPLIT_PART(file_path, '#foundry-dataset:', 1) AS stripped_path
       FROM backing_datasource
      WHERE object_type_id = (
        SELECT object_type_id FROM object_type WHERE api_name = '${DISTRICTS_OBJECT_TYPE}'
      )`,
  );
  assert(districtsRs.length === 1, "OlivierDistricts484787 has binding row");

  if (districtsRs.length === 1) {
    assert(
      String(districtsRs[0][0]) === "csv",
      "OlivierDistricts484787 file_format = csv",
    );
    const stripped = String(districtsRs[0][1]);
    const isBareUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        stripped,
      );
    assert(
      stripped.includes("/") && !isBareUuid,
      "OlivierDistricts484787 stripped path is valid object key (not bare UUID)",
      `stripped=${stripped.slice(0, 80)}`,
    );
  }

  // -------------------------------------------------------------------
  // 3. Force-reindex: iceberg object type reindexes successfully
  // -------------------------------------------------------------------
  console.log("\n3. Force reindex");

  const reindex = await api(
    "POST",
    `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/${ORDERS_OBJECT_TYPE}/reindex?force=true`,
    {},
  );
  assert(reindex.status === 200, "force reindex accepted");
  if (reindex.status === 200) {
    const status = reindex.body?.status;
    assert(status === "completed", "reindex completed");
    const count = Number(
      (reindex.body?.result as Record<string, unknown>)?.totalObjectsIndexed,
    );
    assert(count > 0, "totalObjectsIndexed > 0", `count=${count}`);
  }

  // -------------------------------------------------------------------
  // 4. OpenSearch documents present and queryable
  // -------------------------------------------------------------------
  console.log("\n4. OpenSearch documents");

  const osRes = await osSearch("ontology-olivierorders876*");
  const hits = (osRes?.hits as Record<string, unknown>)?.total as
    | { value?: number }
    | number
    | undefined;
  const hitCount = typeof hits === "number" ? hits : hits?.value ?? 0;
  assert(hitCount > 0, "OpenSearch documents present", `count=${hitCount}`);

  const firstHit = (
    (osRes?.hits as Record<string, unknown>)?.hits as unknown[]
  )?.[0] as Record<string, unknown> | undefined;
  const source = firstHit?._source as Record<string, unknown> | undefined;
  assert(!!source?.__pk, "document has __pk field");
  assert(!!source?.__rid, "document has __rid field");

  // -------------------------------------------------------------------
  // 5. Negative test: bare UUID → rejected by datasourcePathValidation
  //    (Covered by regression-177 unit tests; here confirmed live)
  // -------------------------------------------------------------------
  console.log("\n5. Negative test: bare UUID rejection");

  const { assertCanonicalFoundryPath } = await import(
    "../../src/services/datasourcePathValidation"
  );
  try {
    assertCanonicalFoundryPath("6fc1da39-3797-4c20-bf7d-a4b367403c27");
    assert(false, "bare UUID rejected by assertCanonicalFoundryPath");
  } catch (err) {
    assert(
      /bare uuid/i.test((err as Error).message),
      "bare UUID → throw with 'bare UUID' message",
      `msg=${(err as Error).message.slice(0, 120)}`,
    );
  }

  // -------------------------------------------------------------------
  console.log(
    `\n=== Integration Test Complete: passed=${passed} failed=${failed} total=${passed + failed} ===`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});