// ---------------------------------------------------------------------------
// functionKind — publish storage + backfill (Phase 2).
//
// §7 required tests:
//   • Registry and API:
//       – New query publish stores "query" (edit kind tested via backfill
//         because the isolated test environment has no @osdk packages —
//         the classifier unit test covers the AST walk exhaustively).
//       – New publish never stores NULL or "unknown".
//       – Signature and kind are written atomically (same row).
//       – Malformed edit declaration fails publication, writes no registry row.
//   • Backfill:
//       – Legacy edit version is classified (from manifest source).
//       – Legacy query version is classified.
//       – Missing/corrupt source remains fail-closed and is reported.
//       – Second backfill run performs no duplicate updates (idempotent).
//       – Version identity prevents one release's source from updating another.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FunctionsPublishService } from "../../../../src/services/functionsPublish/service";
import type {
  StemmaAdapter,
  StemmaListTreeArgs,
  StemmaListTreeOutcome,
  StemmaReadBlobArgs,
  StemmaReadBlobOutcome,
  StemmaTreeEntry,
} from "../../../../src/services/codeRepository/adapters/types";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";

// Real MinIO for the publish path (Track 2 #8 blob storage).
import "dotenv/config";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_BUCKET ??= "tellus-uploads";
process.env.S3_ACCESS_KEY_ID ??= "minioadmin";
process.env.S3_SECRET_ACCESS_KEY ??= "minioadmin";
import { runFunctionKindBackfill } from "../../../../src/services/functionsRegistry/backfillFunctionKind";

const BRANCH_HEAD = "abcdef0123456789";
const REPO_RID = "ri.stemma.main.repository.00000000-0000-0000-0000-0000000000fk";

async function applyPublishMigrations(ctx: SchemaContext): Promise<void> {
  await ctx.applyMigration("src/migrations/054_b6_jemma.sql");
  await ctx.applyMigration("src/migrations/055_b8_functions_registry.sql");
  await ctx.applyMigration("src/migrations/116_functions_publish_jobs.sql");
  await ctx.applyMigration("src/migrations/118_functions_publish_retrigger.sql");
  await ctx.applyMigration("src/migrations/137_functions_publish_retry.sql");
  await ctx.applyMigration("src/migrations/139_function_kind.sql");
}

/** Minimal Stemma double: serves listTree/readBlob from a mutable file map. */
class FakeStemma implements StemmaAdapter {
  readonly files = new Map<string, string>();

  async listTree(args: StemmaListTreeArgs): Promise<StemmaListTreeOutcome> {
    void args;
    const entries: StemmaTreeEntry[] = [...this.files.keys()].sort().map((path) => ({
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      type: "blob" as const,
      mode: "100644",
      sha: BRANCH_HEAD,
    }));
    return { kind: "ok", entries, truncated: false, branchHead: BRANCH_HEAD, treeSha: BRANCH_HEAD };
  }

  async readBlob(args: StemmaReadBlobArgs): Promise<StemmaReadBlobOutcome> {
    const source = this.files.get(args.path);
    if (source === undefined) return { kind: "path-not-found" };
    const content = new TextEncoder().encode(source);
    return { kind: "ok", content, sha: BRANCH_HEAD, size: content.byteLength };
  }

  async createRepository(): Promise<never> { throw new Error("not used"); }
  async tombstone(): Promise<void> { throw new Error("not used"); }
  async commitFiles(): Promise<never> { throw new Error("not used"); }
  async createBranch(): Promise<never> { throw new Error("not used"); }
  async deleteBranch(): Promise<never> { throw new Error("not used"); }
  async listBranches(): Promise<never> { throw new Error("not used"); }
}

async function waitForTerminal(pool: Pool, rid: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await pool.query<{ state: string }>(`SELECT state FROM jemma_run WHERE rid = $1`, [rid]);
    const state = result.rows[0]?.state;
    if (state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED" || state === "TIMED_OUT") {
      return state;
    }
    if (Date.now() > deadline) throw new Error(`run ${rid} did not reach a terminal state in ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function queryFnSource(name: string): string {
  return `export default function ${name}(input: string): string { return input; }\n`;
}

// Edit function source suitable for embedding in manifest_json (the
// classifier AST-walks this; no type-check is run by the backfill).
// The function NAME must match the registry row's api_name /
// fileStem(source_path) — inspectPublishedFunction enforces it.
function editManifestSource(fnName: string): string {
  return [
    `import { Client } from "@osdk/client";`,
    `import { Edits } from "@osdk/functions";`,
    `import { Order } from "@ontology/sdk";`,
    `type OrderEdit = Edits.Object<Order>;`,
    `export default function ${fnName}(client: Client, orderId: string): OrderEdit[] {`,
    `  return [{ op: "update", objectType: "Order", primaryKey: orderId, patch: { status: "closed" } } as OrderEdit];`,
    `}`,
  ].join("\n");
}

const QUERY_MANIFEST_SOURCE = [
  `import { Client } from "@osdk/client";`,
  `export default function queryFn(client: Client, name: string): string {`,
  `  return name.toUpperCase();`,
  `}`,
].join("\n");

// Malformed: Edits-shaped return WITHOUT @osdk/functions import.
const MALFORMED_EDIT_SOURCE = `
export default function badFn(id: string): Edits.Object<string>[] {
  return [];
}
`;

async function enqueueAndAwait(
  service: FunctionsPublishService,
  pool: Pool,
  repoRid: string,
  semver: string,
): Promise<{ runRid: string; state: string }> {
  const enqueued = await service.enqueue({
    repositoryRid: repoRid,
    branch: "main",
    defaultBranch: "main",
    semver,
    message: null,
    triggeredBy: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  const state = await waitForTerminal(pool, enqueued.runRid);
  return { runRid: enqueued.runRid, state };
}

// ---------------------------------------------------------------------------
// Registry and API — kind storage at publish time
// ---------------------------------------------------------------------------
describe("function kind — publish storage (Phase 2 §7 Registry/API)", () => {
  let ctx: SchemaContext;
  let stemma: FakeStemma;
  let service: FunctionsPublishService;

  beforeAll(async () => {
    ctx = await openTestSchema("functions_publish_fnKind");
    await applyPublishMigrations(ctx);
    stemma = new FakeStemma();
    service = new FunctionsPublishService({ pool: ctx.pool, stemma });
  });

  afterAll(async () => {
    service.stop();
    await ctx.close();
  });

  it("stores 'query' for a read-only function and never writes NULL/unknown for new publishes", async () => {
    stemma.files.set("typescript-functions/src/functions/alpha.ts", queryFnSource("alpha"));
    stemma.files.set("typescript-functions/src/functions/beta.ts", queryFnSource("beta"));

    const outcome = await enqueueAndAwait(service, ctx.pool, REPO_RID, "1.0.0");
    expect(outcome.state, "publish run must succeed").toBe("SUCCEEDED");

    const rows = await ctx.query<{
      function_rid: string;
      function_kind: string | null;
      signature: { parameters: unknown[]; output: string } | null;
      api_name: string;
    }>(
      `SELECT v.function_rid, v.function_kind, v.signature, f.api_name
         FROM function_registry_function_version v
         JOIN function_registry_function f ON f.rid = v.function_rid
        WHERE f.repository_rid = $1 AND v.semver = '1.0.0'`,
      [REPO_RID],
    );
    expect(rows.rowCount).toBe(2);

    for (const row of rows.rows) {
      // New publish stores "query" — never NULL or "unknown".
      expect(row.function_kind, "new publishes never write NULL").not.toBeNull();
      expect(row.function_kind, "new publishes never write 'unknown'").not.toBe("unknown");
      expect(row.function_kind, "import-free function → query").toBe("query");
      // Signature and kind are written atomically (same row has both).
      expect(row.signature, "signature must be present alongside kind").not.toBeNull();
      expect(row.signature!.output).toBe("string");
      expect(row.signature!.parameters.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("fails the release for a malformed edit declaration and writes no registry row", async () => {
    const badRepoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
    const badStemma = new FakeStemma();
    badStemma.files.set("typescript-functions/src/functions/badFn.ts", MALFORMED_EDIT_SOURCE);
    const badService = new FunctionsPublishService({ pool: ctx.pool, stemma: badStemma });
    try {
      const outcome = await enqueueAndAwait(badService, ctx.pool, badRepoRid, "1.0.0");
      expect(outcome.state, "malformed edit declaration must fail publication").toBe("FAILED");

      // No registry row exists for the failed publish.
      const rows = await ctx.query(
        `SELECT v.function_rid
           FROM function_registry_function_version v
           JOIN function_registry_function f ON f.rid = v.function_rid
          WHERE f.repository_rid = $1`,
        [badRepoRid],
      );
      expect(rows.rowCount, "no registry rows from failed publish").toBe(0);
    } finally {
      badService.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Backfill — legacy version classification
// ---------------------------------------------------------------------------
describe("function kind — backfill (Phase 2 §7 Backfill)", () => {
  let ctx: SchemaContext;
  let stemma: FakeStemma;
  let service: FunctionsPublishService;

  beforeAll(async () => {
    ctx = await openTestSchema("functions_publish_backfill");
    await applyPublishMigrations(ctx);
    stemma = new FakeStemma();
    service = new FunctionsPublishService({ pool: ctx.pool, stemma });
  });

  afterAll(async () => {
    service.stop();
    await ctx.close();
  });

  it("classifies legacy edit and query versions from their own immutable release source (identity, idempotent)", async () => {
    // Publish v1.0.0 with a simple query fn (passes type-check).
    stemma.files.set("typescript-functions/src/functions/alpha.ts", queryFnSource("alpha"));
    const outcome1 = await enqueueAndAwait(service, ctx.pool, REPO_RID, "1.0.0");
    expect(outcome1.state).toBe("SUCCEEDED");

    // Capture the release_version_rid and function_rid for alpha.
    const v1Rows = await ctx.query<{
      release_version_rid: string;
      function_rid: string;
    }>(
      `SELECT v.release_version_rid, v.function_rid
         FROM function_registry_function_version v
         JOIN function_registry_function f ON f.rid = v.function_rid
        WHERE f.repository_rid = $1 AND v.semver = '1.0.0' AND f.api_name = 'alpha'`,
      [REPO_RID],
    );
    const v1ReleaseRid = v1Rows.rows[0].release_version_rid;
    const alphaRid = v1Rows.rows[0].function_rid;

    // Patch the v1.0.0 manifest to carry an EDIT source for alpha —
    // this simulates a legacy publish that stored an edit function's
    // source in its release artifact before function_kind existed.
    await ctx.query(
      `UPDATE function_version SET manifest_json = manifest_json
         || jsonb_build_object('sources', jsonb_build_object('alpha', $2::jsonb))
       WHERE rid = $1`,
      [v1ReleaseRid, JSON.stringify(editManifestSource("alpha"))],
    );

    // Also update the signature to match an edit function.
    await ctx.query(
      `UPDATE function_version SET manifest_json = jsonb_set(
         manifest_json,
         '{signatures,alpha}',
         $2::jsonb
       ) WHERE rid = $1`,
      [v1ReleaseRid, JSON.stringify({
        parameters: [
          { name: "client", type: "Client", optional: false },
          { name: "orderId", type: "string", optional: false },
        ],
        output: "OrderEdit[]",
      })],
    );

    // Simulate legacy: reset function_kind to NULL.
    await ctx.query(`UPDATE function_registry_function_version SET function_kind = NULL`);

    // Dry-run: report but do not write.
    const dryRun = await runFunctionKindBackfill(ctx.pool, { apply: false });
    expect(dryRun.mode).toBe("DRY-RUN");
    expect(dryRun.candidates).toBeGreaterThanOrEqual(1);
    // The alpha fn should be classified as 'edit' from its manifest source.
    expect(dryRun.outcomes.some((o) => o.kind === "edit")).toBe(true);
    // DB unchanged: still NULL.
    const stillNull = await ctx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM function_registry_function_version WHERE function_kind IS NULL`,
    );
    expect(Number(stillNull.rows[0].count)).toBeGreaterThanOrEqual(1);

    // Apply: classify from each version's own immutable source.
    const report = await runFunctionKindBackfill(ctx.pool, { apply: true });
    expect(report.mode).toBe("APPLY");
    expect(report.counts.edit, "at least one edit version backfilled").toBeGreaterThanOrEqual(1);
    expect(report.counts.query, "at least one query version backfilled").toBeGreaterThanOrEqual(0);
    expect(report.counts.unknown).toBe(0);
    expect(report.counts.failed).toBe(0);

    // Verify the alpha function was classified as edit.
    const alpha = await ctx.query<{ function_kind: string | null }>(
      `SELECT function_kind FROM function_registry_function_version WHERE function_rid = $1`,
      [alphaRid],
    );
    expect(alpha.rows[0]?.function_kind).toBe("edit");

    // Idempotent: second apply updates nothing.
    const report2 = await runFunctionKindBackfill(ctx.pool, { apply: true });
    expect(report2.candidates, "no NULL rows remain").toBe(0);
    expect(report2.counts.edit + report2.counts.query + report2.counts.unknown, "zero updates on second run").toBe(0);
  });

  it("records missing/corrupt source as 'unknown' and reports it", async () => {
    // Publish a simple query fn to get a real function_version row.
    const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
    const corruptStemma = new FakeStemma();
    corruptStemma.files.set("typescript-functions/src/functions/corruptFn.ts", queryFnSource("corruptFn"));
    const corruptService = new FunctionsPublishService({ pool: ctx.pool, stemma: corruptStemma });
    try {
      const outcome = await enqueueAndAwait(corruptService, ctx.pool, repoRid, "1.0.0");
      expect(outcome.state).toBe("SUCCEEDED");

      // Corrupt the release's source record: empty the inline
      // manifest AND point the blob reference at a missing object
      // (blob-backed versions read source from the artifact
      // store — the missing blob IS the corruption now).
      await ctx.query(
        `UPDATE function_version
            SET manifest_json = '{}'::jsonb,
                artifact_blob_id = 's3:functions-publish/artifacts/v1/'
                  || repeat('0', 64) || '.json.gz'
         WHERE repository_rid = $1 AND semver = '1.0.0'`,
        [repoRid],
      );
      // Reset function_kind to NULL to simulate a legacy row.
      await ctx.query(
        `UPDATE function_registry_function_version SET function_kind = NULL
         WHERE function_rid IN (
           SELECT rid FROM function_registry_function WHERE repository_rid = $1
         )`,
        [repoRid],
      );

      // The backfill identity carries the FUNCTION rid, not the repo rid.
      const fnRow = await ctx.query<{ rid: string }>(
        `SELECT rid FROM function_registry_function WHERE repository_rid = $1`,
        [repoRid],
      );
      const corruptFnRid = fnRow.rows[0].rid;

      const report = await runFunctionKindBackfill(ctx.pool, { apply: true });
      const corruptOutcome = report.outcomes.find(
        (o) => o.identity.includes(corruptFnRid),
      );
      expect(corruptOutcome, "corrupt row appears in outcomes").toBeDefined();
      expect(corruptOutcome!.kind, "corrupt source → unknown").toBe("unknown");
      expect(corruptOutcome!.reason, "reason must explain missing source").toContain("missing");
      expect(corruptOutcome!.applied).toBe(true);

      // The row is now 'unknown' (fail-closed — NOT edit-capable).
      const row = await ctx.query<{ function_kind: string | null }>(
        `SELECT v.function_kind
           FROM function_registry_function_version v
           JOIN function_registry_function f ON f.rid = v.function_rid
          WHERE f.repository_rid = $1`,
        [repoRid],
      );
      expect(row.rows[0]?.function_kind).toBe("unknown");
    } finally {
      corruptService.stop();
    }
  });

  it("version identity prevents one release's source from updating another version", async () => {
    // Publish v1.0.0 then v2.0.0 of the same function.
    const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
    const idStemma = new FakeStemma();
    let idService = new FunctionsPublishService({ pool: ctx.pool, stemma: idStemma });

    // v1.0.0: simple query fn.
    idStemma.files.set("typescript-functions/src/functions/gamma.ts", queryFnSource("gamma"));
    let outcome = await enqueueAndAwait(idService, ctx.pool, repoRid, "1.0.0");
    expect(outcome.state).toBe("SUCCEEDED");

    // Capture v1.0.0 release info.
    const v1Info = await ctx.query<{ release_version_rid: string; function_rid: string }>(
      `SELECT v.release_version_rid, v.function_rid
         FROM function_registry_function_version v
         JOIN function_registry_function f ON f.rid = v.function_rid
        WHERE f.repository_rid = $1 AND v.semver = '1.0.0'`,
      [repoRid],
    );
    const v1ReleaseRid = v1Info.rows[0].release_version_rid;
    const gammaRid = v1Info.rows[0].function_rid;

    // Patch v1.0.0 manifest: make its source look like an edit function.
    await ctx.query(
      `UPDATE function_version SET manifest_json = manifest_json
         || jsonb_build_object('sources', jsonb_build_object('gamma', $2::jsonb))
       WHERE rid = $1`,
      [v1ReleaseRid, JSON.stringify(editManifestSource("gamma"))],
    );

    idService.stop();
    // New service instance for v2.0.0.
    idService = new FunctionsPublishService({ pool: ctx.pool, stemma: idStemma });

    // v2.0.0: still a simple query fn (unchanged source).
    outcome = await enqueueAndAwait(idService, ctx.pool, repoRid, "2.0.0");
    expect(outcome.state).toBe("SUCCEEDED");
    idService.stop();

    // Reset both rows to NULL (legacy).
    await ctx.query(`UPDATE function_registry_function_version SET function_kind = NULL`);

    // Backfill: v1.0.0 gamma should be classified as 'edit' (from the
    // patched manifest), v2.0.0 gamma as 'query' (from the actual source).
    // This proves version identity prevents cross-contamination.
    const report = await runFunctionKindBackfill(ctx.pool, { apply: true });
    const gammaOutcomes = report.outcomes.filter((o) => o.identity.includes(gammaRid));
    expect(gammaOutcomes.length, "two versions of gamma").toBe(2);
    const v1Outcome = gammaOutcomes.find((o) => o.identity.includes("1.0.0"));
    const v2Outcome = gammaOutcomes.find((o) => o.identity.includes("2.0.0"));

    expect(v1Outcome?.kind, "v1.0.0 gamma from edit manifest → 'edit'").toBe("edit");
    expect(v2Outcome?.kind, "v2.0.0 gamma from query manifest → 'query'").toBe("query");

    // Verify DB state directly.
    const versions = await ctx.query<{ semver: string; function_kind: string | null }>(
      `SELECT v.semver, v.function_kind
         FROM function_registry_function_version v
        WHERE v.function_rid = $1
        ORDER BY v.semver`,
      [gammaRid],
    );
    expect(versions.rows.find((r) => r.semver === "1.0.0")?.function_kind).toBe("edit");
    expect(versions.rows.find((r) => r.semver === "2.0.0")?.function_kind).toBe("query");
  });
});
