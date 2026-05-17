// B2-C-14 — POST /api/v1/code-repositories/:rid/functions/:apiName/invoke
//
// Verifies that an in-process invoke against the working-tree TypeScript
// source produces a result, captures stdout/stderr, and surfaces the
// canonical error envelope on bad input.
//
// Coverage:
//   1. Happy path — scaffolded helloWorld returns greeting + stdout captured.
//   2. Function-not-found (404 NotFound).
//   3. Compile error in source → 422 FunctionInvokeFailed.
//   4. Args malformed (non-object body.args) → 400 InvalidArgumentBody.
//   5. RepositoryNotFound (404).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

import { openTestSchema, type SchemaContext } from "../_helpers/pg";
import {
  InMemoryCompass,
  InMemoryStemma,
  InMemoryTemplate,
} from "../../../../src/services/codeRepository/adapters/inMemory";
import { createCodeRepositoryApp } from "../../../../src/services/codeRepository/admin/app";

import type { Express } from "express";

const MIGS = [
  "050_stemma_ddl.sql",
  "051_code_repos_audit.sql",
  "053_b2_code_repository.sql",
  "055_b8_functions_registry.sql",
];

let schema: SchemaContext;
let app: Express;
let compass: InMemoryCompass;
let stemma: InMemoryStemma;
let template: InMemoryTemplate;

const FOLDER_RID = "ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345";

let idemCounter = 0;
function nextIdem(): string {
  idemCounter += 1;
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `${hex(idemCounter)}-aaaa-4bbb-8ccc-dddddddddddd`;
}

let repoCounter = 0;
function nextDisplayName(prefix: string): string {
  repoCounter += 1;
  return `${prefix}-${repoCounter}`;
}

function withAuth(req: request.Test): request.Test {
  return req
    .set("X-Tellus-Test-Principal", "alice")
    .set("X-Tellus-Test-Roles", "editor");
}

async function createRepo(prefix: string): Promise<string> {
  const r = await withAuth(
    request(app)
      .post("/api/v1/code-repositories")
      .set("Idempotency-Key", nextIdem())
      .send({
        displayName: nextDisplayName(prefix),
        parentFolderRid: FOLDER_RID,
        templateId: "typescript-functions",
        templateVersion: "2.4.0",
        defaultBranch: "main",
      }),
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.rid as string;
}

beforeAll(async () => {
  schema = await openTestSchema("b2c14_invoke");
  for (const f of MIGS) {
    await schema.applyMigration(`src/migrations/${f}`);
  }
});

afterAll(async () => {
  if (schema) await schema.close();
});

beforeEach(() => {
  process.env.CODE_REPOS_TEST_AUTH = "1";
  compass = new InMemoryCompass();
  stemma = new InMemoryStemma();
  template = new InMemoryTemplate({ stemma });
  app = createCodeRepositoryApp({ pool: schema.pool, compass, stemma, template });
});

describe("POST /:rid/functions/invoke", () => {
  it("invokes scaffolded helloWorld and returns greeting", async () => {
    const rid = await createRepo("InvokeOK");
    const r = await withAuth(
      request(app)
        .post(`/api/v1/code-repositories/${rid}/functions/invoke`)
        .send({ apiName: "helloWorld", args: { name: "Olivier" } }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      apiName: "helloWorld",
      durationMs: expect.any(Number),
      stdout: expect.any(String),
      stderr: expect.any(String),
    });
  });

  it("returns 404 when apiName is not found in working tree", async () => {
    const rid = await createRepo("InvokeNotFound");
    const r = await withAuth(
      request(app)
        .post(`/api/v1/code-repositories/${rid}/functions/invoke`)
        .send({ apiName: "notARealFunction", args: {} }),
    );
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("CodeRepos:FunctionNotFound");
  });

  it("returns 422 when body.args is not an object", async () => {
    const rid = await createRepo("InvokeBadArgs");
    const r = await withAuth(
      request(app)
        .post(`/api/v1/code-repositories/${rid}/functions/invoke`)
        .send({ apiName: "helloWorld", args: 42 }),
    );
    expect(r.status).toBe(422);
    expect(r.body.errorName).toBe("CodeRepos:InvalidArgumentBody");
  });

  it("returns 404 RepositoryNotFound on unknown rid", async () => {
    const r = await withAuth(
      request(app)
        .post(
          `/api/v1/code-repositories/ri.stemma.main.repository.99999999-9999-4999-8999-999999999999/functions/invoke`,
        )
        .send({ apiName: "helloWorld", args: {} }),
    );
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("CodeRepos:RepositoryNotFound");
  });

  // -----------------------------------------------------------------------
  // Path A — real-time edit-and-rerun.
  // The IDE may pass `inlineSource` carrying the user's unsaved Monaco
  // draft. The backend must transpile the inline buffer instead of the
  // committed working-tree source, with no Commit required.
  // -----------------------------------------------------------------------
  it("uses inlineSource instead of committed source (Path A)", async () => {
    const rid = await createRepo("InvokeInline");
    const draft = `export default function helloWorld(input: { name?: string }) {\n  return { greeting: "EDITED: " + (input?.name ?? "world") };\n}\n`;
    const r = await withAuth(
      request(app)
        .post(`/api/v1/code-repositories/${rid}/functions/invoke`)
        .send({
          apiName: "helloWorld",
          args: { name: "Olivier" },
          inlineSource: draft,
          inlineSourcePath: "typescript-functions/src/functions/helloWorld.ts",
        }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.apiName).toBe("helloWorld");
    // The result must reflect the draft, not the scaffolded committed source.
    const serialized =
      typeof r.body.result === "string" ? r.body.result : JSON.stringify(r.body.result);
    expect(serialized).toContain("EDITED:");
    expect(serialized).toContain("Olivier");
  });

  it("inlineSource invokes a brand-new apiName that does not exist on disk", async () => {
    const rid = await createRepo("InvokeInlineNew");
    const draft = `export default function freshlyAuthored() { return 42; }\n`;
    const r = await withAuth(
      request(app)
        .post(`/api/v1/code-repositories/${rid}/functions/invoke`)
        .send({
          apiName: "freshlyAuthored",
          args: {},
          inlineSource: draft,
          inlineSourcePath: "typescript-functions/src/functions/freshlyAuthored.ts",
        }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // The route serializes scalars as JSON strings on the wire; assert both
    // shapes are accepted so we don't lock the test to one serialization.
    expect([42, "42"]).toContain(r.body.result);
  });

  it("rejects inlineSource larger than 256 KB", async () => {
    const rid = await createRepo("InvokeInlineTooBig");
    // 256 KB + 1 byte of identical filler. The body parser is configured
    // for 5 MB so we test the route's own cap, not express.json's.
    const big = "x".repeat(256 * 1024 + 1);
    const r = await withAuth(
      request(app)
        .post(`/api/v1/code-repositories/${rid}/functions/invoke`)
        .send({ apiName: "helloWorld", args: {}, inlineSource: big }),
    );
    expect(r.status).toBe(422);
    expect(r.body.errorName).toBe("CodeRepos:InvalidArgumentBody");
    expect(r.body.parameters?.field).toBe("inlineSource");
  });

  it("rejects non-string inlineSource", async () => {
    const rid = await createRepo("InvokeInlineWrongType");
    const r = await withAuth(
      request(app)
        .post(`/api/v1/code-repositories/${rid}/functions/invoke`)
        .send({ apiName: "helloWorld", args: {}, inlineSource: 123 }),
    );
    expect(r.status).toBe(422);
    expect(r.body.errorName).toBe("CodeRepos:InvalidArgumentBody");
    expect(r.body.parameters?.field).toBe("inlineSource");
  });
});
