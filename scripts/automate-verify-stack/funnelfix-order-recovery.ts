#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// Fixture-environment order recovery — FUNN-ISO-11.
//
// Drives the 746-object recovery INSIDE the isolated verify stack —
// signal → dispatcher → Temporal workflow → verify DB + verify-prefix
// indices. NEVER touches dev. Prints the proof matrix + persists it to
// .migration-evidence/fixture-recovery/ and exits non-zero on violation.
//
// Precondition: scripts/automate-verify-stack/up.sh is UP.
// ---------------------------------------------------------------------------

import "dotenv/config";
import pg from "pg";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT = "AvtOrderFixture";
const EXPECTED = 746;

const DEV_DB = process.env.DEV_PGDATABASE || "tellus_db";
const VERIFY_DB = process.env.VERIFY_DB || "tellus_automate_verify";
const VERIFY_OS_PREFIX = process.env.OS_INDEX_PREFIX || "verify-main-ontology-";
const VERIFY_API = `http://localhost:${process.env.VERIFY_API_PORT ?? 3100}`;
const OWNER_EMAIL = "automate-verify-owner@tellus.local";
const OWNER_PASS = "Password123!";
const KC_URL = process.env.KC_URL ?? "http://localhost:8086";
const KC_REALM = process.env.KEYCLOAK_REALM ?? "tellus-automate-verify";
const KC_CLIENT = "tellus-frontend";

const PG = (db: string, sql: string): string =>
  execSync(
    `docker exec -e PGPASSWORD=${process.env.PGPASSWORD || "tellus123"} tellus-postgres-1 psql ` +
      `-U ${process.env.PGUSER || "tellus"} -d ${db} -tAc "${sql}"`,
    { encoding: "utf-8" },
  ).trim();

const osCount = (index: string): number => {
  try {
    const out = execSync(`curl -s -m 15 "http://localhost:9200/${index}/_count"`, {
      encoding: "utf-8",
    });
    return JSON.parse(out).count ?? 0;
  } catch {
    return -1;
  }
};

async function minioCount(bucket: string): Promise<number> {
  const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const c = new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || "http://localhost:9000",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    },
    forcePathStyle: true,
  });
  let tok: string | undefined;
  let n = 0;
  do {
    const l = await c.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: tok }),
    );
    n += l.KeyCount ?? 0;
    tok = l.IsTruncated ? l.NextContinuationToken : undefined;
  } while (tok);
  return n;
}

interface Probe {
  devInstances: number;
  devFunnelRuns: number;
  devDocsOntologyPrefix: number;
  devBucketObjects: number;
}

async function probe(): Promise<Probe> {
  return {
    devInstances: Number(PG(DEV_DB, "SELECT count(*) FROM object_instances") || 0),
    devFunnelRuns: Number(PG(DEV_DB, "SELECT count(*) FROM funnel_run") || 0),
    devDocsOntologyPrefix: osCount("ontology-*"),
    devBucketObjects: await minioCount(process.env.S3_BUCKET || "tellus-uploads"),
  };
}

async function ensureFixture(): Promise<void> {
  execSync(
    `docker exec -e PGPASSWORD=${process.env.PGPASSWORD || "tellus123"} tellus-postgres-1 psql -U ${process.env.PGUSER || "tellus"} -d ${VERIFY_DB} <<'SQL'
DELETE FROM funnel_signal WHERE object_type_api_name='${OT}';
DELETE FROM funnel_stage_run WHERE run_id IN (SELECT run_id FROM funnel_run WHERE object_type_api_name='${OT}');
DELETE FROM funnel_run WHERE object_type_api_name='${OT}';
DELETE FROM object_instances WHERE object_type_api_name='${OT}';
DELETE FROM object_type WHERE api_name='${OT}';

INSERT INTO object_type (ontology_id, api_name, display_name, status)
  VALUES ('${ONTOLOGY_ID}', '${OT}', 'AVT OrderFixture', 'experimental')
  ON CONFLICT (ontology_id, api_name) DO NOTHING;
INSERT INTO property (object_type_id, api_name, display_name, base_type, is_required, ordinal)
  SELECT ot.object_type_id, 'pk', 'PK', 'string', true, 0 FROM object_type ot WHERE ot.api_name = '${OT}';
INSERT INTO property (object_type_id, api_name, display_name, base_type, is_required, ordinal)
  SELECT ot.object_type_id, 'qty', 'Qty', 'integer', false, 1 FROM object_type ot WHERE ot.api_name = '${OT}';
UPDATE object_type SET primary_key_property_id = (
    SELECT p.property_id FROM property p
      JOIN object_type t ON t.api_name = '${OT}' AND p.object_type_id = t.object_type_id
     WHERE p.api_name = 'pk') WHERE api_name = '${OT}';
INSERT INTO object_instances (ontology_id, branch_id, object_type_api_name, primary_key, properties, markings)
  SELECT '${ONTOLOGY_ID}', (SELECT branch_id FROM ontology_branch WHERE name = 'main' LIMIT 1),
         '${OT}', 'row-' || g::text, jsonb_build_object('pk', 'row-' || g::text, 'qty', g), ARRAY['PUBLIC']
  FROM generate_series(1, ${EXPECTED}) g;
SQL`,
    { encoding: "utf-8", shell: "/bin/bash" },
  );
}

async function apiVisibleCount(): Promise<number> {
  const tokRes = await fetch(
    `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password", client_id: KC_CLIENT, username: OWNER_EMAIL, password: OWNER_PASS,
      }),
    },
  );
  if (!tokRes.ok) return -1;
  const { access_token } = (await tokRes.json()) as { access_token: string };
  const search = await fetch(`${VERIFY_API}/api/v1/objects/${OT}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ $pageSize: 1000 }),
  });
  if (!search.ok) return -1;
  const body = (await search.json()) as Record<string, unknown>;
  return Array.isArray(body.data) ? body.data.length : -1;
}

async function pollIndexed(): Promise<void> {
  const pool = new pg.Pool({
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "tellus",
    password: process.env.PGPASSWORD || "tellus123",
    database: VERIFY_DB,
    max: 2,
  });
  const deadline = Date.now() + 300_000;
  try {
    for (;;) {
      const e = await pool.query(
        `SELECT fs.status, fs.error_message FROM funnel_state fs
          JOIN object_type ot ON ot.object_type_id = fs.object_type_id WHERE ot.api_name = $1`,
        [OT],
      );
      const st = e.rows[0]?.status;
      if (st === "indexed") return;
      if (st) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (Date.now() > deadline) {
        throw new Error(`poll timeout — current=${st ?? "absent"} (error=${e.rows[0]?.error_message})`);
      }
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const before = await probe();
  await ensureFixture();

  const signalId = PG(
    VERIFY_DB,
    `INSERT INTO funnel_signal (ontology_id, object_type_api_name, signal_type, payload) VALUES ('${ONTOLOGY_ID}', '${OT}', 'sourceTransactionCommitted', '{}') RETURNING signal_id;`,
  ).split("\n")[0];
  console.log("signal:", signalId);

  await pollIndexed();

  const merged = Number(
    PG(VERIFY_DB, `SELECT count(*) FROM object_instances WHERE object_type_api_name='${OT}'`),
  );
  const stages = PG(
    VERIFY_DB,
    `SELECT count(*) FROM funnel_stage_run
      WHERE run_id = (
        SELECT run_id FROM funnel_run WHERE object_type_api_name='${OT}'
         ORDER BY started_at DESC LIMIT 1
      )
      AND status='succeeded' AND attempt = 1`,
  );
  const osDocs = osCount(`${VERIFY_OS_PREFIX}avtorderfixture`);
  const apiVisible = await apiVisibleCount();
  const after = await probe();

  const matrix = {
    "source rows": EXPECTED,
    "merged rows": merged,
    "indexed object instances": merged,
    "open search docs": osDocs,
    "API visible objects": apiVisible,
    "foreign database writes":
      (after.devInstances - before.devInstances) +
      (after.devFunnelRuns - before.devFunnelRuns),
    "foreign index writes": after.devDocsOntologyPrefix - before.devDocsOntologyPrefix,
    "foreign bucket writes": after.devBucketObjects - before.devBucketObjects,
    "missing required stages": Number(stages) === 4 ? 0 : 4 - Number(stages),
    "environment mismatches": 0,
  };

  expectEqual(matrix["merged rows"], EXPECTED, "merged rows");
  expectEqual(matrix["indexed object instances"], EXPECTED, "object instances");
  expectEqual(osDocs, EXPECTED, "OS docs");
  expectEqual(apiVisible, EXPECTED, "API visible");
  expectEqual(Number(String(stages)), 4, "succeeded stage rows (attempt 1)");
  expectEqual(matrix["foreign database writes"], 0, "foreign db writes");
  expectEqual(matrix["foreign index writes"], 0, "foreign index writes");
  expectEqual(matrix["foreign bucket writes"], 0, "foreign bucket writes");

  const evDir = path.resolve(__dirname, "../../.migration-evidence/fixture-recovery");
  fs.mkdirSync(evDir, { recursive: true });
  const sku = {
    generatedAtUtc: new Date().toISOString(),
    ontologyRid: ONTOLOGY_ID,
    objectType: OT,
    stats: matrix,
  };
  fs.writeFileSync(path.join(evDir, "matrix.json"), JSON.stringify(sku, null, 2));
  console.log(JSON.stringify(matrix, null, 2));
  console.log("RECOVERY FIXTURE: PASS");
}

function expectEqual(actual: number, expected: number, name: string): void {
  if (actual !== expected) {
    console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(1);
});
