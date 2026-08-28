// ---------------------------------------------------------------------------
// Contract Test: Dataset Format Domain Drift Guard
//
// Reads DATASET_FORMATS (src/domain/datasetFormats.ts), migration 179 DDL
// (up + down), foundryMigrate test constraints, and the live PG CHECK — all
// four must target the same set.  Any drift exits non-zero with a diff.
//
// This is a STANDALONE script (no vitest) to avoid the DB bootstrap that
// collides on already-applied types/constraints in the shared dev container.
//
// Run: npx tsx tests/integration/test04_dataset_formats_contract.ts
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const DOMAIN_FILE = path.resolve(__dirname, "../../src/domain/datasetFormats.ts");
const MIG_179_UP = path.resolve(
  __dirname,
  "../../src/migrations/179_align_datasource_format_contract.sql",
);
const MIG_179_DOWN = path.resolve(
  __dirname,
  "../../src/migrations/179_align_datasource_format_contract.down.sql",
);
const FOUNDRY_MIGRATE = path.resolve(__dirname, "../../src/foundryMigrate.ts");

function extractFormats(source: string, constraintName: string): string[] {
  const escaped = constraintName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `${escaped}[^)]*\\(\\s*(?:file_)?format\\s+IN\\s*\\(([^)]+)\\)`,
    "i",
  );
  const m = source.match(re);
  if (!m)
    throw new Error(
      `CHECK constraint '${constraintName}' not found in source`,
    );
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^'/, "").replace(/'$/, ""));
}

let passed = 0;
let failed = 0;
const started = Date.now();

function assert(cond: boolean, label: string, detail?: string) {
  const ms = Date.now() - started;
  if (cond) {
    console.log(`  ${label}: PASS (${ms}ms)`);
    passed++;
  } else {
    console.error(`  ${label}: FAIL (${ms}ms)${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function sorted(a: string[]): string[] {
  return [...a].sort();
}

console.log("=== Dataset Format Contract Drift Guard ===\n");

// -------------------------------------------------------------------
// 1. Source files
// -------------------------------------------------------------------
const domainSrc = fs.readFileSync(DOMAIN_FILE, "utf-8");
const mig179up = fs.readFileSync(MIG_179_UP, "utf-8");
const mig179down = fs.readFileSync(MIG_179_DOWN, "utf-8");
const foundrySrc = fs.readFileSync(FOUNDRY_MIGRATE, "utf-8");

// -------------------------------------------------------------------
// 2. Parse expected value sets from each source
// -------------------------------------------------------------------

const domainFormats = domainSrc
  .split("\n")
  .filter((line) => line.includes('"') && line.includes(","))
  .map((line) => line.match(/"([a-z0-9]+)"\s*,?/i)?.[1])
  .filter(Boolean) as string[];

const upBacking = extractFormats(mig179up, "backing_datasource_file_format_check");
const upFoundry = extractFormats(mig179up, "foundry_datasets_format_check");
const downBacking = extractFormats(
  mig179down,
  "backing_datasource_file_format_check",
);
const downFoundry = extractFormats(
  mig179down,
  "foundry_datasets_format_check",
);
const fmFoundry = extractFormats(foundrySrc, "foundry_datasets_format_check");

// -------------------------------------------------------------------
// 3. Assertions
// -------------------------------------------------------------------

// 3a. Domain constant
assert(
  sorted(domainFormats).join(",") ===
    sorted(["csv", "json", "parquet", "iceberg", "stream"]).join(","),
  "DATASET_FORMATS constant",
  `got [${domainFormats}]`,
);

// 3b. 179 up matches domain
assert(
  sorted(upBacking).join(",") === sorted(domainFormats).join(","),
  "179 up backing_datasource_check = DATASET_FORMATS",
  `upBacking=[${upBacking}] domain=[${domainFormats}]`,
);

assert(
  sorted(upFoundry).join(",") === sorted(domainFormats).join(","),
  "179 up foundry_datasets_check = DATASET_FORMATS",
  `upFoundry=[${upFoundry}] domain=[${domainFormats}]`,
);

// 3c. foundryMigrate matches canonical (subset, sans json)
assert(
  sorted(fmFoundry).join(",") ===
    sorted(["csv", "parquet", "iceberg", "stream"]).join(","),
  "foundryMigrate foundry_datasets_check is canonical subset",
  `got=[${fmFoundry}]`,
);

// 3d. Every foundryMigrate format is accepted by 179 bindings
const upSet = new Set(upBacking);
const fmSet = new Set(fmFoundry);
const onlyInFM = [...fmSet].filter((f) => !upSet.has(f));
assert(
  onlyInFM.length === 0,
  "every foundryMigrate format accepted by binding CHECK (no drift)",
  `only-in-foundryMigrate: [${onlyInFM}]`,
);

// 3e. 179 down restores pre-179 contracts
assert(
  sorted(downBacking).join(",") === sorted(["csv", "json", "parquet"]).join(","),
  "179 down restores backing_datasource to pre-179",
  `got=[${downBacking}]`,
);

assert(
  sorted(downFoundry).join(",") ===
    sorted(["csv", "parquet", "iceberg", "stream"]).join(","),
  "179 down restores foundry_datasets to canonical",
  `got=[${downFoundry}]`,
);

// 3f. Revert-check: pre-179 cannot represent iceberg
assert(
  !(["csv", "json", "parquet"] as string[]).includes("iceberg"),
  "pre-179 backing_datasource CHECK rejects iceberg (revert-check)",
);

assert(
  upBacking.includes("iceberg"),
  "post-179 backing_datasource CHECK accepts iceberg",
);

// 3g. Down migration integrity guard
assert(
  /Cannot roll back.*backing_datasource contains iceberg/i.test(mig179down),
  "179 down blocks rollback when iceberg rows exist in backing_datasource",
);

assert(
  /Cannot roll back.*foundry_datasets contains json/i.test(mig179down),
  "179 down blocks rollback when json rows exist in foundry_datasets",
);

// -------------------------------------------------------------------
// 4. Live PG CHECK verification (requires running DB)
// -------------------------------------------------------------------

async function verifyLiveDb() {
  try {
    const pg = await new Promise<{
      stdout: string;
      stderr: string;
      code: number;
    }>((resolve) => {
      const child = spawn(
        "docker",
        [
          "exec",
          "-i",
          "tellus-postgres-1",
          "psql",
          "-U",
          "tellus",
          "-d",
          "tellus_db",
          "-t",
          "-A",
          "-c",
          `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
             WHERE conname IN ('backing_datasource_file_format_check','foundry_datasets_format_check')
             ORDER BY conname`,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (code: number) => resolve({ stdout, stderr, code }));
      child.stdin.end();
    });

    assert(pg.code === 0, "live PG CHECK query ok", pg.stderr.slice(0, 200));

    const lines = pg.stdout.split("\n").filter((l) => l.trim());
    assert(
      lines.length === 2,
      "both constraints present on live DB",
      `got ${lines.length} rows`,
    );

    for (const line of lines) {
      const [name, def] = line.split(/\|/, 2);
      const hasIceberg = /iceberg/i.test(def || "");
      assert(
        hasIceberg,
        `live PG ${name.trim()} includes iceberg`,
        `def=${def ? def.slice(0, 120) : "null"}`,
      );
    }
  } catch (err) {
    console.error("  Live PG check skipped:", (err as Error).message);
  }
}

// -------------------------------------------------------------------
// 5. Run
// -------------------------------------------------------------------

verifyLiveDb().then(() => {
  console.log(
    `\n=== Contract Test Complete: passed=${passed} failed=${failed} total=${passed + failed} ===`,
  );
  process.exit(failed > 0 ? 1 : 0);
});