// ---------------------------------------------------------------------------
// Track 2 item #8 — real artifact blob storage.
//
// Exercises the REAL S3/MinIO object store (docker-compose minio,
// localhost:9000) — no fake blob backend in the production lane.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  artifactKeyForDigest,
  createS3FunctionArtifactStore,
  FunctionArtifactError,
  FUNCTION_ARTIFACT_MAX_UNCOMPRESSED_BYTES,
  resolveFunctionSource,
  resolveFunctionSources,
  sweepOrphanedFunctionArtifacts,
  type FunctionArtifactStore,
} from "../../../../src/services/functionsRegistry/artifactStore";
import { FunctionsPublishService } from "../../../../src/services/functionsPublish/service";
import type {
  StemmaAdapter,
  StemmaListTreeArgs,
  StemmaListTreeOutcome,
  StemmaReadBlobArgs,
  StemmaReadBlobOutcome,
} from "../../../../src/services/codeRepository/adapters/types";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";

// Real MinIO from docker-compose — credentials come from the
// repo .env (same source the backend uses); the compose-file
// defaults (docker-compose.yml:386-387) are the fallback.
// Never fabricated in production code.
import "dotenv/config";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_BUCKET ??= "tellus-uploads";
process.env.S3_ACCESS_KEY_ID ??= "minioadmin";
process.env.S3_SECRET_ACCESS_KEY ??= "minioadmin";

const BRANCH_HEAD = "abcdef0123456789";

class FakeStemma implements StemmaAdapter {
  readonly files = new Map<string, string>([
    ["typescript-functions/src/functions/alpha.ts",
      "export default function alpha(input: string): string { return input; }\n"],
  ]);

  async listTree(args: StemmaListTreeArgs): Promise<StemmaListTreeOutcome> {
    void args;
    const entries = [...this.files.keys()].sort().map((path) => ({
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

  async createRepository(): Promise<never> { throw new Error("unused"); }
  async tombstone(): Promise<void> { throw new Error("unused"); }
  async commitFiles(): Promise<never> { throw new Error("unused"); }
  async createBranch(): Promise<never> { throw new Error("unused"); }
  async deleteBranch(): Promise<never> { throw new Error("unused"); }
  async listBranches(): Promise<never> { throw new Error("unused"); }
}

async function waitForTerminal(pool: Pool, rid: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await pool.query<{ state: string }>(`SELECT state FROM jemma_run WHERE rid = $1`, [rid]);
    const state = result.rows[0]?.state;
    if (state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED" || state === "TIMED_OUT") {
      return state;
    }
    if (Date.now() > deadline) throw new Error(`run ${rid} did not reach a terminal state`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("functions-publish artifact blob storage (item #8)", () => {
  let ctx: SchemaContext;
  let stemma: FakeStemma;
  let store: FunctionArtifactStore;
  let services: FunctionsPublishService[];

  beforeEach(async () => {
    ctx = await openTestSchema("functions_publish_art8");
    await ctx.applyMigration("src/migrations/054_b6_jemma.sql");
    await ctx.applyMigration("src/migrations/055_b8_functions_registry.sql");
    await ctx.applyMigration("src/migrations/116_functions_publish_jobs.sql");
    await ctx.applyMigration("src/migrations/118_functions_publish_retrigger.sql");
    await ctx.applyMigration("src/migrations/137_functions_publish_retry.sql");
    await ctx.applyMigration("src/migrations/139_function_kind.sql");
    await ctx.applyMigration("src/migrations/143_automate.sql");
await ctx.applyMigration("src/migrations/156_function_invocation_contract.sql");
    stemma = new FakeStemma();
    store = createS3FunctionArtifactStore();
    services = [];
  });

  afterEach(async () => {
    for (const service of services.splice(0)) await service.stop();
    await ctx.close();
  });

  async function publish(semver = "1.0.0"): Promise<{ runRid: string; repoRid: string; state: string }> {
    const service = new FunctionsPublishService({ pool: ctx.pool, stemma });
    services.push(service);
    const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;
    const enqueued = await service.enqueue({
      repositoryRid: repoRid, branch: "main", defaultBranch: "main",
      semver, message: null, triggeredBy: randomUUID(), idempotencyKey: randomUUID(),
    });
    return { runRid: enqueued.runRid, repoRid, state: await waitForTerminal(ctx.pool, enqueued.runRid) };
  }

  it("a new publish stores a real blob — no inline: id, no sources in the manifest", async () => {
    const outcome = await publish();
    expect(outcome.state).toBe("SUCCEEDED");

    const version = await ctx.query<{
      artifact_blob_id: string; artifact_sha256: string; manifest_json: Record<string, unknown>;
    }>(`SELECT artifact_blob_id, artifact_sha256, manifest_json
          FROM function_version WHERE repository_rid = $1`, [outcome.repoRid]);
    const row = version.rows[0];
    expect(row.artifact_blob_id.startsWith("s3:")).toBe(true);
    expect(row.artifact_blob_id.startsWith("inline:")).toBe(false);
    expect(row.artifact_blob_id).toContain(row.artifact_sha256);

    // Manifest carries compact metadata only.
    expect(row.manifest_json).not.toHaveProperty("sources");
    expect(JSON.stringify(row.manifest_json)).not.toContain("export default function alpha");
    expect(row.manifest_json.artifactFormat).toBe("functions-publish-bundle/v1");

    // The stored blob round-trips: digest verified, sources intact.
    const bundle = await store.getBundle(row.artifact_blob_id);
    expect(createHash("sha256").update(bundle).digest("hex")).toBe(row.artifact_sha256);
    const parsed = JSON.parse(bundle) as { sources: Record<string, string> };
    expect(parsed.sources.alpha).toContain("export default function alpha");
  }, 40_000);

  it("resolveFunctionSource serves the new blob-backed version", async () => {
    const outcome = await publish();
    expect(outcome.state).toBe("SUCCEEDED");
    const version = await ctx.query<{
      artifact_blob_id: string; manifest_json: Record<string, unknown>;
    }>(`SELECT artifact_blob_id, manifest_json FROM function_version WHERE repository_rid = $1`,
      [outcome.repoRid]);
    const source = await resolveFunctionSource(version.rows[0], "alpha", store);
    expect(source).toContain("export default function alpha");
  }, 40_000);

  it("same content uploaded twice deduplicates to one object", async () => {
    const bundle = JSON.stringify({ exports: ["a"], sources: { a: "x" }, signatures: {} });
    const digest = createHash("sha256").update(bundle).digest("hex");
    const first = await store.put({ digest, bundle });
    const second = await store.put({ digest, bundle });
    expect(first.blobId).toBe(second.blobId);
    expect(second.deduplicated).toBe(true);
    // Retrieval works through a FRESH store instance ("after restart").
    const freshStore = createS3FunctionArtifactStore();
    expect(await freshStore.getBundle(first.blobId)).toBe(bundle);
  });

  it("an oversized bundle is rejected deterministically", async () => {
    const bundle = "x".repeat(FUNCTION_ARTIFACT_MAX_UNCOMPRESSED_BYTES + 1);
    const digest = createHash("sha256").update(bundle).digest("hex");
    await expect(store.put({ digest, bundle })).rejects.toMatchObject({
      code: "ARTIFACT_TOO_LARGE",
    });
  });

  it("an oversized single source file fails the run deterministically", async () => {
    stemma.files.set(
      "typescript-functions/src/functions/big.ts",
      `export default function big(input: string): string { return "${"y".repeat(1100 * 1024)}" + input; }\n`,
    );
    const outcome = await publish();
    expect(outcome.state).toBe("FAILED");
    const logs = await ctx.query<{ message: string }>(
      `SELECT message FROM jemma_run_log WHERE run_rid = $1`, [outcome.runRid]);
    expect(logs.rows.map((row) => row.message).join("\n")).toContain("-byte limit");
    const versions = await ctx.query(
      `SELECT COUNT(*)::int AS n FROM function_version WHERE repository_rid = $1`, [outcome.repoRid]);
    expect(versions.rows[0].n).toBe(0);
  }, 40_000);

  it("historical inline: rows remain readable", async () => {
    const sources = { alpha: "export default function alpha(input: string): string { return input; }" };
    const resolved = await resolveFunctionSources({
      artifact_blob_id: "inline:0123456789abcdef",
      manifest_json: { sources },
    });
    expect(resolved).toEqual(sources);
    const single = await resolveFunctionSource(
      { artifact_blob_id: "inline:0123456789abcdef", manifest_json: { sources } },
      "alpha",
    );
    expect(single).toBe(sources.alpha);
  });

  it("a missing blob produces an actionable error", async () => {
    const digest = "0".repeat(64);
    await expect(store.getBundle(`s3:${artifactKeyForDigest(digest)}`))
      .rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
    await expect(store.getBundle(`s3:${artifactKeyForDigest(digest)}`))
      .rejects.toThrow(/missing from object storage/);
  });

  it("a corrupt blob (content/digest mismatch) is detected", async () => {
    // Store valid content, then overwrite-adjacent: upload a bundle
    // whose bytes do NOT hash to the key's digest.
    const bundle = JSON.stringify({ sources: { a: "real" } });
    const digest = createHash("sha256").update("different content").digest("hex");
    // Hand-craft an object at a digest key with mismatched content.
    const key = artifactKeyForDigest(digest);
    const { uploadObject, ensureBucket } = await import(
      "../../../../src/services/storageService");
    await ensureBucket();
    await uploadObject(key, gzipSync(Buffer.from(bundle)), "application/gzip", {
      sha256: digest, format: "functions-publish-bundle/v1",
    });
    await expect(store.getBundle(`s3:${key}`)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY",
    });
  });

  it("a blob id in an unknown format is rejected, never silently inlined", async () => {
    await expect(store.getBundle("inline:abc123")).rejects.toMatchObject({
      code: "ARTIFACT_UNREADABLE_FORMAT",
    });
  });

  it("the orphan sweep deletes unreferenced old blobs and keeps referenced ones", async () => {
    // Unreferenced blob.
    const orphanBundle = JSON.stringify({ sources: { o: "orphan" } });
    const orphanDigest = createHash("sha256").update(orphanBundle).digest("hex");
    const orphan = await store.put({ digest: orphanDigest, bundle: orphanBundle });

    // Referenced blob: a real publish.
    const outcome = await publish();
    expect(outcome.state).toBe("SUCCEEDED");
    const version = await ctx.query<{ artifact_blob_id: string }>(
      `SELECT artifact_blob_id FROM function_version WHERE repository_rid = $1`, [outcome.repoRid]);

    // Both objects are younger than the default 24h grace → nothing deleted.
    const young = await sweepOrphanedFunctionArtifacts(ctx.pool, { olderThanMs: 24 * 3600 * 1000 });
    expect(young.deleted).toBe(0);

    // With a zero grace window the orphan goes, the referenced stays.
    const swept = await sweepOrphanedFunctionArtifacts(ctx.pool, { olderThanMs: 0 });
    expect(swept.deleted).toBeGreaterThanOrEqual(1);
    // The referenced blob still reads fine.
    const bundle = await store.getBundle(version.rows[0].artifact_blob_id);
    expect(bundle).toContain("export default function alpha");
    // The orphan is gone.
    await expect(store.getBundle(orphan.blobId)).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
  }, 60_000);
});
