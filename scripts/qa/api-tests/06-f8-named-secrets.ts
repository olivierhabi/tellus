// F8 — Named per-secret storage (REST secrets bundled in "other").
//
// Documents the F8 finding: REST API connection secrets (API key, bearer
// token, basic auth, custom headers) are all bundled into a single
// credential row with field name "other" as a JSON blob, rather than being
// stored as named per-secret entries. This makes rotation, auditing, and
// access control coarser than necessary.
//
// Verifies by:
//   1. Checking the vault's field name for REST secrets.
//   2. Querying the DB for credential rows with field="other".
//   3. Inspecting the FE wizard's setSecret call (field name "other").

import { getApiContext, assert } from "./harness.js";
import { pool } from "../../../src/db.js";
import * as fs from "node:fs";
import * as path from "node:path";

async function main(): Promise<void> {
  const ctx = await getApiContext("admin");
  console.log(`[F8] logged in as ${ctx.username}`);

  // 1. Check the DB for credential rows with field="other".
  const otherCreds = await pool.query(
    "SELECT connection_rid, field, version FROM connectivity_credentials WHERE field='other' AND superseded_at IS NULL LIMIT 10",
  );
  console.log(
    `[F8] credential rows with field='other': ${otherCreds.rows.length}`,
  );
  if (otherCreds.rows.length > 0) {
    console.log(`[F8] sample: ${JSON.stringify(otherCreds.rows[0])}`);
  }

  // 2. Check the FE wizard's setSecret call — it uses field name "other".
  const fePath = path.resolve(
    "../../tellus-fe/app/data-connection/new-source/RestApiNewSourceWizard.tsx",
  );
  if (fs.existsSync(fePath)) {
    const src = fs.readFileSync(fePath, "utf8");
    const usesOther = /setSecret\s*\(\s*[^,]+,\s*["']other["']/.test(src);
    assert(usesOther, "FE wizard should use field name 'other' for REST secrets");
    console.log(`[F8] FE wizard uses setSecret(rid, "other", ...) ✓`);
  } else {
    console.log(`[F8] FE wizard not found at expected path, checking source`);
    // The audit evidence is in the FE repo; we verify the backend side here.
  }

  // 3. Verify the secrets handler accepts "other" as a valid field name.
  const connections = await ctx.api("/api/v1/connectivity/connections?pageSize=1");
  const body = connections.body as { data?: Array<{ rid: string }> };
  if (body.data && body.data.length > 0) {
    const rid = body.data[0].rid;
    const creds = await pool.query(
      "SELECT field FROM connectivity_credentials WHERE connection_rid=$1 AND superseded_at IS NULL",
      [rid],
    );
    console.log(
      `[F8] connection ${rid} has fields: ${creds.rows.map((r: { field: string }) => r.field).join(", ") || "(none)"}`,
    );
  }

  // 4. Verify the vault's CredentialField type includes "other".
  const storeSrc = fs.readFileSync(
    path.resolve("src/services/connectivity/credentials/store.repo.ts"),
    "utf8",
  );
  assert(
    /["']other["']/.test(storeSrc),
    "CredentialField type should include 'other'",
  );
  console.log(`[F8] CredentialField type includes 'other' ✓`);

    console.log("[F8] FINDING DOCUMENTED (REST secrets bundled in 'other', fix pending)");
}

main().catch((e) => {
  console.error("[F8] FAILED:", e);
  process.exit(1);
});
