// ---------------------------------------------------------------------------
// AI edit-function contract test (Phase 3).
//
// For EVERY model in the SUPPORTED EDIT-GENERATION model set (the
// authoritative allowlist in editFunctionGenerationModels.ts — NOT
// every model in the engine's general-purpose catalog), this test:
//   1. requests a REAL edit-function generation through the production
//      proxy path (bare express app mounting the real
//      createCodeAssistantRouter → real AiEngineClient → live engine →
//      live model). No fixtures, no mocked model output.
//   2. publishes the generated file through the SAME versioned
//      release/registry path as real functions (FunctionsPublishService
//      + FakeStemma + schema-isolated Postgres).
//   3. asserts the registry stored function_kind = 'edit' — classified by
//      the SHARED Phase 2 classifier inside the publish pipeline
//      (inspectPublishedFunction). This test introduces no classifier.
//   4. runs basic sandbox execution of the published source
//      (runSandboxedWithSdk + buildOntologySdk, composed exactly as
//      functionWorker.ts composes them).
//
// GATING (mirrors the FE's REAL_ENGINE=1 pattern):
//   AI_CONTRACT_TEST=1     — required; the suite is describe.skip without it.
//   TELOS_AIE_AGENT_URL    — engine base URL (default http://127.0.0.1:5000).
//   AI_CONTRACT_MODELS     — optional comma-separated NARROWING of the
//                            matrix (must be a subset of the allowlist;
//                            non-allowlisted entries are filtered out).
//
// Secret hygiene: this file never reads or logs credential env vars. LLM
// credentials live only in the engine's own environment. Diagnostics are
// truncated to keep generated content bounded in CI logs.
// ---------------------------------------------------------------------------

import express from "express";
import type { Pool } from "pg";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createCodeAssistantRouter } from "../../../../src/routes/codeAssistant";
import {
  EDIT_FUNCTION_GENERATION_MODELS,
  supportsEditFunctionGeneration,
} from "../../../../src/services/aiEngine/editFunctionGenerationModels";
import { FunctionsPublishService } from "../../../../src/services/functionsPublish/service";
import type {
  StemmaAdapter,
  StemmaListTreeArgs,
  StemmaListTreeOutcome,
  StemmaReadBlobArgs,
  StemmaReadBlobOutcome,
  StemmaTreeEntry,
} from "../../../../src/services/codeRepository/adapters/types";
import {
  awaitSandboxPromise,
  runSandboxedWithSdk,
} from "../../../../src/services/functionRuntime";
import { buildOntologySdk } from "../../../../src/services/functions/ontologyRuntime";
import type { OntologySnapshot } from "../../../../src/services/functions/ontologyRuntime";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";

const ENABLED = process.env.AI_CONTRACT_TEST === "1";
const ENGINE_URL =
  process.env.TELOS_AIE_AGENT_URL ?? "http://127.0.0.1:5000";
const BRANCH_HEAD = "abcdef0123456789";
const OBJECT_TYPE = "ContractOrder";
const FN_NAME = "applyPercentIncrease";
const FN_PATH = `typescript-functions/src/functions/${FN_NAME}.ts`;
const MAX_ATTEMPTS = 2;
const GENERATION_TIMEOUT_MS = 900_000;
const MAX_LOG_CHARS = 600;

// SUPPORTED EDIT-GENERATION MODELS. The engine's /api/models catalog is
// general-purpose — a model being listed there does NOT mean it is
// enabled for edit-function generation. The matrix is exactly the
// allowlist owned by the edit-generation feature
// (editFunctionGenerationModels.ts), narrowed by the live catalog in
// test #1. glm-5.2 is excluded by policy: this deployment's provider
// account has no entitlement for it (AccessDenied.Unpurchased) — it is
// never selected, invoked, or reported as a blocker.
//
// AI_CONTRACT_MODELS may NARROW the matrix (comma-separated subset of
// the allowlist) for local debugging; it can never widen it — every
// entry passes through supportsEditFunctionGeneration.
const CONTRACT_MODELS = (
  process.env.AI_CONTRACT_MODELS
    ? process.env.AI_CONTRACT_MODELS.split(",")
    : EDIT_FUNCTION_GENERATION_MODELS.map((m) => m.key)
)
  .map((m) => m.trim())
  .filter(Boolean)
  .filter((key) => supportsEditFunctionGeneration(key));

function truncate(value: string): string {
  return value.length > MAX_LOG_CHARS
    ? `${value.slice(0, MAX_LOG_CHARS)}…(truncated)`
    : value;
}

// ---------------------------------------------------------------------------
// Real generation through the production proxy path.
// ---------------------------------------------------------------------------

interface FileProposal {
  path: string;
  content: string;
  op?: string;
}

function buildApp(): express.Express {
  process.env.CODE_ASSISTANT_TEST_AUTH = "1"; // request-time read
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // The REAL router with the REAL (default) AiEngineClient — no injection.
  app.use("/api/v1/code-assistant", createCodeAssistantRouter());
  // Minimal error surface mirroring the server's AppError handling.
  app.use(
    (
      err: { statusCode?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.statusCode ?? 500).json({ error: err.message });
    },
  );
  return app;
}

async function requestEditFunction(
  app: express.Express,
  model: string,
  feedback?: string,
): Promise<{ proposal: FileProposal; responseText: string }> {
  const requirements = [
    `Create a new TypeScript v2 Ontology EDIT Function for the \`${OBJECT_TYPE}\` object type (properties: \`status\` string, \`total\` number).`,
    ``,
    `Hard requirements:`,
    `1. File path: \`${FN_PATH}\`; the default-exported function MUST be named \`${FN_NAME}\` (identical to the file stem).`,
    `2. Imports exactly: \`import { Client, Osdk } from "@osdk/client";\`, \`import { createEditBatch, Edits } from "@osdk/functions";\`, \`import { ${OBJECT_TYPE} } from "@ontology/sdk";\``,
    `3. Signature exactly: \`export default function ${FN_NAME}(client: Client, order: Osdk.Instance<${OBJECT_TYPE}>, percent: number): Edits.Object<${OBJECT_TYPE}>[]\` — every parameter and the return type explicitly typed; the function MUST be synchronous (no async, no Promise).`,
    `4. Body exactly this pattern: \`const batch = createEditBatch<Edits.Object<${OBJECT_TYPE}>>(client); batch.update(order, { total: order.total * (1 + percent / 100) }); return batch.getEdits();\` — the object parameter \`order\` arrives as a hydrated object with \`$apiName\`/\`$primaryKey\` and its properties; pass IT (not a string key) to batch.update.`,
    `5. You MUST call the \`propose_file\` tool with the complete file content (op="add"). Do not only paste code in prose.`,
  ].join("\n");

  const message = feedback
    ? `${requirements}\n\nThe previous file FAILED publication with this error:\n${truncate(feedback)}\nFix ONLY the reported problem and call propose_file again with the full corrected file.`
    : requirements;

  const res = await request(app)
    .post("/api/v1/code-assistant/typescript-v2")
    .set("X-Tellus-Test-Principal", "ai-contract/READER")
    .send({ message, model, mode: "generate", stream: false });

  if (res.status !== 200) {
    // Surface the engine's own error message (proxied as {error}), never
    // just the HTTP status — a provider failure must be diagnosable.
    const detail =
      typeof res.body?.error === "string" ? res.body.error : `HTTP ${res.status}`;
    throw new Error(`generation failed: ${truncate(detail)}`);
  }

  const data = res.body?.data as
    | { response?: unknown; file_proposal?: unknown; _metadata?: unknown }
    | undefined;
  const proposal = data?.file_proposal as FileProposal | undefined;
  const responseText = typeof data?.response === "string" ? data.response : "";
  if (!proposal || typeof proposal.content !== "string" || !proposal.path) {
    throw new Error(
      `model returned no file_proposal. response: ${truncate(responseText)}`,
    );
  }
  return { proposal, responseText };
}

// ---------------------------------------------------------------------------
// Publish through the real versioned release/registry path (FakeStemma).
// ---------------------------------------------------------------------------

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

async function applyPublishMigrations(ctx: SchemaContext): Promise<void> {
  await ctx.applyMigration("src/migrations/054_b6_jemma.sql");
  await ctx.applyMigration("src/migrations/055_b8_functions_registry.sql");
  await ctx.applyMigration("src/migrations/116_functions_publish_jobs.sql");
  await ctx.applyMigration("src/migrations/118_functions_publish_retrigger.sql");
  await ctx.applyMigration("src/migrations/137_functions_publish_retry.sql");
  await ctx.applyMigration("src/migrations/139_function_kind.sql");
}

async function waitForTerminal(pool: Pool, rid: string, timeoutMs = 60_000): Promise<string> {
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

async function publishFailureDetail(pool: Pool, runRid: string): Promise<string> {
  try {
    const result = await pool.query<{ detail: string }>(
      `SELECT coalesce(string_agg(coalesce(error_message, stage || ': ' || state), ' | '), 'no detail') AS detail
         FROM jemma_run_stage WHERE run_rid = $1`,
      [runRid],
    );
    return truncate(result.rows[0]?.detail ?? "unknown");
  } catch {
    return "publish failed (stage detail unavailable)";
  }
}

// ---------------------------------------------------------------------------
// Sandbox execution — composed exactly as functionWorker.ts composes it.
// ---------------------------------------------------------------------------

function transpileForSandbox(apiName: string, source: string): string {
  // Identical to functionActionExecutor.transpileFunction.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts = require("typescript") as typeof import("typescript");
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      isolatedModules: true,
    },
    fileName: `${apiName}.ts`,
  });
  return (
    out.outputText +
    `\nif (typeof module !== "undefined") {` +
    ` module.exports = ` +
    `(typeof exports[${JSON.stringify(apiName)}] === "function" ? exports[${JSON.stringify(apiName)}]` +
    ` : (typeof exports.default === "function" ? exports.default : module.exports));` +
    `}\n`
  );
}

function testSnapshot(): OntologySnapshot {
  const order = {
    $apiName: OBJECT_TYPE,
    $primaryKey: "o-1",
    $title: "Order o-1",
    status: "open",
    total: 200,
  };
  return {
    byType: new Map([[OBJECT_TYPE, new Map([["o-1", order]])]]),
    ontologyId: "ai-contract-test",
    objectCount: 1,
    objectTypes: [OBJECT_TYPE],
    importedTypes: [OBJECT_TYPE],
  };
}

async function executeInSandbox(
  apiName: string,
  source: string,
): Promise<{ status: string; errorMessage?: string; edits: Array<{ objectType?: unknown }> }> {
  const transpiled = transpileForSandbox(apiName, source);
  const { sdk, getEdits } = buildOntologySdk(testSnapshot());
  // Input mirrors the Action runtime's hydration: object-reference
  // parameters arrive as full object instances, scalars as-is.
  const hydratedOrder = testSnapshot().byType.get(OBJECT_TYPE)!.get("o-1")!;
  let result = runSandboxedWithSdk(
    transpiled,
    { order: hydratedOrder, percent: 10 },
    {
      Objects: sdk.Objects,
      Edits: sdk.Edits,
      createEditBatch: sdk.createEditBatch,
      __ontologyTypes: sdk.objectTypeDescriptors,
    },
  );
  if (result.pendingPromise) {
    const settled = await awaitSandboxPromise(result.pendingPromise);
    result = { ...result, output: settled.output, status: settled.status, errorMessage: settled.errorMessage, pendingPromise: undefined };
  }
  // Edits may be collected via the SDK batch (createEditBatch / Edits.*) or
  // returned as the function's return value.
  const collected = result.status === "ok" ? getEdits() : [];
  const returned = Array.isArray(result.output) ? (result.output as Array<{ objectType?: unknown }>) : [];
  return { status: result.status, errorMessage: result.errorMessage, edits: collected.length > 0 ? collected : returned };
}

// ---------------------------------------------------------------------------
// The contract suite.
// ---------------------------------------------------------------------------

const describeContract = ENABLED ? describe : describe.skip;

describeContract("AI edit-function contract (Phase 3, real models)", () => {
  it("every supported edit-generation model exists in the live engine catalog", async () => {
    const res = await fetch(`${ENGINE_URL}/api/models`);
    expect(res.ok, `engine catalog reachable at ${ENGINE_URL}`).toBe(true);
    const body = (await res.json()) as { models?: Array<{ key: string }> };
    const live = new Set((body.models ?? []).map((m) => m.key));
    // Drift guard: a SUPPORTED edit-generation model that disappears
    // from the engine's catalog fails the suite. The reverse (a new
    // general-catalog model) is NOT drift — edit-generation coverage
    // only changes when the allowlist changes.
    for (const model of CONTRACT_MODELS) {
      expect(
        live.has(model),
        `supported edit-generation model '${model}' missing from live engine catalog ${JSON.stringify([...live])}`,
      ).toBe(true);
    }
    // The matrix must never include a non-allowlisted model (e.g.
    // glm-5.2, which this deployment's provider account cannot serve).
    for (const model of CONTRACT_MODELS) {
      expect(supportsEditFunctionGeneration(model)).toBe(true);
    }
  }, 30_000);

  for (const model of CONTRACT_MODELS) {
    it(`model ${model}: generated edit function publishes as function_kind='edit' and executes`, async () => {
      const app = buildApp();
      const ctx: SchemaContext = await openTestSchema(
        `ai_contract_${model.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`,
      );
      const stemma = new FakeStemma();
      const service = new FunctionsPublishService({ pool: ctx.pool, stemma });
      const repoRid = `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`;

      try {
        await applyPublishMigrations(ctx);

        let lastError: string | undefined;
        let published = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !published; attempt += 1) {
          // Step 1 — REAL generation from the production model. A
          // generation failure (engine timeout, missing proposal) feeds
          // the retry loop the same way a publish failure does.
          let proposal: FileProposal;
          try {
            proposal = (await requestEditFunction(app, model, lastError)).proposal;
          } catch (err) {
            lastError = `generation: ${truncate(err instanceof Error ? err.message : String(err))}`;
            console.log(`[ai-contract] ${model} attempt ${attempt}: ${lastError}`);
            continue;
          }

          // Step 2 — publish through the real versioned release/registry path.
          stemma.files.set(FN_PATH, proposal.content);
          const enqueued = await service.enqueue({
            repositoryRid: repoRid,
            branch: "main",
            defaultBranch: "main",
            semver: `1.0.${attempt - 1}`,
            message: null,
            triggeredBy: randomUUID(),
            idempotencyKey: randomUUID(),
          });
          const state = await waitForTerminal(ctx.pool, enqueued.runRid);
          if (state !== "SUCCEEDED") {
            lastError = await publishFailureDetail(ctx.pool, enqueued.runRid);
            console.log(`[ai-contract] ${model} attempt ${attempt}: publish ${state}: ${lastError}`);
            continue;
          }
          console.log(`[ai-contract] ${model} attempt ${attempt}: publish SUCCEEDED`);
          published = true;
        }

        expect(
          published,
          `generated function must publish after ${MAX_ATTEMPTS} attempt(s); last error: ${lastError ?? "none"}`,
        ).toBe(true);

        // Step 3 — registry contract: the SHARED Phase 2 classifier (run
        // inside the publish pipeline) stored function_kind = 'edit',
        // atomically with the signature.
        const rows = await ctx.query<{
          api_name: string;
          function_kind: string | null;
          signature: { parameters?: unknown[]; output?: string } | null;
          manifest_json: { sources?: Record<string, string> };
        }>(
          `SELECT f.api_name, v.function_kind, v.signature, fv.manifest_json
             FROM function_registry_function_version v
             JOIN function_registry_function f ON f.rid = v.function_rid
             JOIN function_version fv ON fv.rid = v.release_version_rid
            WHERE f.repository_rid = $1
            ORDER BY v.semver DESC
            LIMIT 1`,
          [repoRid],
        );
        expect(rows.rowCount).toBe(1);
        const row = rows.rows[0];
        expect(row.function_kind, "registry functionKind must be 'edit'").toBe("edit");
        expect(row.signature?.parameters?.length, "signature stored atomically").toBeGreaterThanOrEqual(2);

        // Step 4 — basic sandbox execution of the PUBLISHED source.
        const publishedSource = row.manifest_json?.sources?.[row.api_name];
        expect(typeof publishedSource, "published source present in release manifest").toBe("string");
        const execution = await executeInSandbox(row.api_name, publishedSource!);
        expect(
          execution.status,
          `sandbox execution must succeed: ${truncate(execution.errorMessage ?? "no error detail")}`,
        ).toBe("ok");
        expect(
          execution.edits.length,
          "edit function must produce at least one edit",
        ).toBeGreaterThanOrEqual(1);
        expect(
          execution.edits.some((e) => String(e.objectType) === OBJECT_TYPE),
          `an edit must target ${OBJECT_TYPE}`,
        ).toBe(true);
      } finally {
        service.stop();
        await ctx.close();
      }
    }, GENERATION_TIMEOUT_MS);
  }
});
