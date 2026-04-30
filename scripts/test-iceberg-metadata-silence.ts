// Verify the Iceberg metadata retry tracking path is SILENT when the
// migration-016 columns are absent. Pre-fix: every snapshot commit
// produced a "column metadata_emitted_at does not exist" pg error in
// the server log — caught by `.catch()` but only after the pool logger
// wrote it. Post-fix: a cached `information_schema` probe keeps the
// emission path quiet until the migration is applied.
import "dotenv/config";
import { query } from "../src/db";
import {
  commitSnapshot,
  createTable,
  retryPendingIcebergMetadata,
  __resetMetadataTrackingCacheForTesting,
} from "../src/services/funnel/icebergCatalog";

(async () => {
  // 1. Drop the tracking columns to simulate a pre-migration-016 DB.
  for (const col of ["metadata_emitted_at", "metadata_emit_attempts", "metadata_last_error"]) {
    await query(`ALTER TABLE funnel_snapshot DROP COLUMN IF EXISTS ${col}`).catch(() => {});
  }
  __resetMetadataTrackingCacheForTesting();

  // 2. Capture every console.warn / console.error during the call.
  const warnings: string[] = [];
  const errors: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));

  try {
    // Exercise the retry path — should detect missing columns and
    // return immediately without issuing the blind UPDATE.
    const result = await retryPendingIcebergMetadata();

    // Also drive a commitSnapshot — this is the path the user's log
    // showed spamming `column "metadata_emitted_at" does not exist`
    // every save. With the probe in place, commitSnapshot's fire-and-
    // forget emitter should skip the tracking UPDATE silently.
    const table = await createTable({
      namespace: `_funnel.MetadataSilenceProbe_${process.pid}.changelog`,
      tableName: `probe-${Date.now()}`,
      schema: { id: "string" },
      location: "s3://probe/metadata-silence-test",
    });
    await commitSnapshot({
      tableId: table.dataset_table_id,
      operation: "append",
      manifest: [
        { file_path: "s3://probe/data/x.parquet", file_size_bytes: 0, row_count: 0, operation: "added" },
      ],
      summary: { probe: true },
    });
    // Fire-and-forget emitter is invoked via `void`; wait a tick so it
    // gets scheduled on the loop before we snapshot warnings/errors.
    await new Promise((r) => setTimeout(r, 150));
    console.warn = origWarn;
    console.error = origError;

    const offendingPgErrors = errors.filter((e) =>
      /column .metadata_emitted_at.*does not exist/i.test(e)
    );
    const offendingWarnings = warnings.filter((w) =>
      /column .metadata_emitted_at.*does not exist/i.test(w)
    );

    const report = {
      retryResult: result,
      pgErrorSpam: offendingPgErrors.length,
      warnSpam: offendingWarnings.length,
      totalConsoleOutput: warnings.length + errors.length,
    };
    console.log(JSON.stringify(report, null, 2));

    const pass =
      report.retryResult.retried === 0 &&
      report.retryResult.succeeded === 0 &&
      report.pgErrorSpam === 0 &&
      report.warnSpam === 0;

    // 3. Restore columns so subsequent runs aren't left in a broken state.
    const fs = await import("fs");
    const sql = fs.readFileSync(
      new URL("../src/migrations/016_iceberg_metadata_retry.sql", import.meta.url),
      "utf8"
    );
    await query(sql);
    __resetMetadataTrackingCacheForTesting();

    console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
    process.exit(pass ? 0 : 1);
  } catch (err) {
    console.warn = origWarn;
    console.error = origError;
    process.stderr.write(`CRASH: ${(err as Error)?.stack ?? err}\n`);
    process.exit(2);
  }
})();
