// B2-C-13 — GET /api/v1/code-repositories/:rid/functions integration tests.
//
// Verifies that the code-repositories admin shim returns the canonical set of
// AVAILABLE published functions for a repository on the given branch (defaulting
// to the repository's `default_branch` when `?branch=` is omitted), with the
// highest-semver row per apiName.
//
// Coverage:
//   1. Empty repo (no published versions) → 200 with data:[].
//   2. Single AVAILABLE version → row surfaces with stable field shape.
//   3. Multiple semvers on same apiName → highest wins per apiName.
//   4. Multiple apiNames → sorted (api_name ASC) for determinism.
//   5. Branch filter → only matching-branch rows surface.
//   6. Default-branch fallback when ?branch= is omitted.
//   7. YANKED versions excluded; AVAILABLE-preview included with isPreview=true.
//   8. 404 RepositoryNotFound on unknown rid (CBAC: never 403).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createHash, randomUUID } from "node:crypto";

import { openTestSchema, type TestSchema } from "../_helpers/pg";
import {
  InMemoryCompass,
  InMemoryStemma,
  InMemoryTemplate,
} from "../../../../src/services/codeRepository/adapters/inMemory";
import { createCodeRepositoryApp } from "../../../../src/services/codeRepository/admin/app";
import { publishVersion } from "../../../../src/services/functionsRegistry/store";

import type { Express } from "express";

const MIGS = [
  "050_stemma_ddl.sql",
  "051_code_repos_audit.sql",
  "053_b2_code_repository.sql",
  "055_b8_functions_registry.sql",
];

let schema: TestSchema;
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

function createBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    displayName: "FunctionsTest",
    parentFolderRid: FOLDER_RID,
    templateId: "typescript-functions",
    templateVersion: "2.4.0",
    defaultBranch: "main",
    ...overrides,
  };
}

async function createRepo(prefix: string, overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
  const displayName = nextDisplayName(prefix);
  const r = await withAuth(
    request(app)
      .post("/api/v1/code-repositories")
      .set("Idempotency-Key", nextIdem())
      .send(createBody({ displayName, ...overrides })),
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.rid as string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function mintVersionRid(): string {
  return `ri.functions.main.function-version.${randomUUID()}`;
}

async function seedPublish(opts: {
  rid: string;
  apiName: string;
  branch: string;
  semver: string;
  isPreview?: boolean;
  artifactSeed?: string;
}): Promise<void> {
  const out = await publishVersion(schema.pool, {
    rid: mintVersionRid(),
    repositoryRid: opts.rid,
    branch: opts.branch,
    isPreview: opts.isPreview ?? false,
    semver: opts.semver,
    commitSha: sha256("commit-" + (opts.artifactSeed ?? opts.semver)).slice(0, 40),
    runtime: "NODE_20",
    artifactBlobId: "blob-" + (opts.artifactSeed ?? opts.semver),
    artifactSha256: sha256(opts.artifactSeed ?? opts.semver),
    artifactBytes: 1234,
    manifest: { exports: [opts.apiName] },
  });
  expect(out.outcome).toBe("inserted");
}

beforeAll(async () => {
  schema = await openTestSchema("b2c13_functions");
  for (const f of MIGS) {
    await schema.applyMigration(`src/migrations/${f}`);
  }
});

afterAll(async () => {
  if (schema) await schema.close();
});

// Each freshly-scaffolded `typescript-functions` repo includes a
// `src/functions/helloWorld.ts` blob (template manifest, B3). The
// GET /:rid/functions route surfaces that via the working-tree discovery
// path. Tests that assert specific published rows filter this out so
// the per-feature assertions stay focused; a dedicated test covers
// helloWorld's surfacing as `source: "working_tree"`.
type FunctionRow = {
  apiName: string;
  semver: string | null;
  branch: string;
  isPreview: boolean;
  runtime: "NODE_20" | "PY_311";
  versionRid: string | null;
  commitSha: string | null;
  publishedAt: string | null;
  source: "published" | "working_tree";
  path: string | null;
};

function published(data: FunctionRow[]): FunctionRow[] {
  return data.filter((r) => r.source === "published");
}

beforeEach(() => {
  process.env.CODE_REPOS_TEST_AUTH = "1";
  compass = new InMemoryCompass();
  stemma = new InMemoryStemma();
  template = new InMemoryTemplate({ stemma });
  app = createCodeRepositoryApp({
    pool: schema.pool,
    compass,
    stemma,
    template,
  });
});

describe("B2-C-13 — GET /api/v1/code-repositories/:rid/functions (integration)", () => {
  it("returns 200 with the scaffolded working-tree helloWorld for a repo with no published versions", async () => {
    const rid = await createRepo("empty");
    const res = await withAuth(request(app).get(`/api/v1/code-repositories/${rid}/functions`));
    expect(res.status).toBe(200);
    // typescript-functions scaffold ships src/functions/helloWorld.ts.
    expect(published(res.body.data)).toEqual([]);
    expect(res.body.branch).toBe("main");
    expect(res.body.data.map((r: FunctionRow) => r.apiName)).toContain("helloWorld");
  });

  it("surfaces the scaffolded helloWorld as source=working_tree with nullable version fields", async () => {
    const rid = await createRepo("hello-world-scaffold");
    const res = await withAuth(request(app).get(`/api/v1/code-repositories/${rid}/functions`));
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: FunctionRow) => r.apiName === "helloWorld");
    expect(row).toBeDefined();
    expect(row.source).toBe("working_tree");
    expect(row.runtime).toBe("NODE_20");
    expect(row.branch).toBe("main");
    expect(row.isPreview).toBe(true);
    expect(row.versionRid).toBeNull();
    expect(row.semver).toBeNull();
    expect(row.commitSha).toBeNull();
    expect(row.publishedAt).toBeNull();
    expect(row.path).toBe("typescript-functions/src/functions/helloWorld.ts");
  });

  it("returns the single AVAILABLE version with the expected field shape (published takes priority)", async () => {
    const rid = await createRepo("single");
    await seedPublish({ rid, apiName: "calculateDso", branch: "main", semver: "1.0.0" });
    const res = await withAuth(request(app).get(`/api/v1/code-repositories/${rid}/functions`));
    expect(res.status).toBe(200);
    const pub = published(res.body.data);
    expect(pub).toHaveLength(1);
    const row = pub[0];
    expect(row.apiName).toBe("calculateDso");
    expect(row.semver).toBe("1.0.0");
    expect(row.branch).toBe("main");
    expect(row.isPreview).toBe(false);
    expect(row.runtime).toBe("NODE_20");
    expect(row.versionRid).toMatch(/^ri\.functions\.main\.function-version\./);
    expect(row.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof row.publishedAt).toBe("string");
  });

  it("collapses multiple semvers to highest-per-apiName", async () => {
    const rid = await createRepo("multi-semver");
    await seedPublish({ rid, apiName: "fnA", branch: "main", semver: "1.0.0", artifactSeed: "a-100" });
    await seedPublish({ rid, apiName: "fnA", branch: "main", semver: "1.1.0", artifactSeed: "a-110" });
    await seedPublish({ rid, apiName: "fnA", branch: "main", semver: "2.0.0", artifactSeed: "a-200" });
    await seedPublish({ rid, apiName: "fnA", branch: "main", semver: "1.5.3", artifactSeed: "a-153" });
    const res = await withAuth(request(app).get(`/api/v1/code-repositories/${rid}/functions`));
    expect(res.status).toBe(200);
    const pub = published(res.body.data);
    expect(pub).toHaveLength(1);
    expect(pub[0].apiName).toBe("fnA");
    expect(pub[0].semver).toBe("2.0.0");
  });

  it("returns multiple apiNames sorted by api_name ASC for determinism (incl. working-tree)", async () => {
    const rid = await createRepo("multi-api");
    await seedPublish({ rid, apiName: "zzz", branch: "main", semver: "1.0.0", artifactSeed: "z1" });
    await seedPublish({ rid, apiName: "aaa", branch: "main", semver: "1.0.1", artifactSeed: "a1" });
    await seedPublish({ rid, apiName: "mmm", branch: "main", semver: "1.0.2", artifactSeed: "m1" });
    const res = await withAuth(request(app).get(`/api/v1/code-repositories/${rid}/functions`));
    expect(res.status).toBe(200);
    // Published + working-tree merged and sorted; helloWorld from the scaffold
    // appears between "aaa" and "mmm".
    expect(res.body.data.map((r: FunctionRow) => r.apiName)).toEqual([
      "aaa",
      "helloWorld",
      "mmm",
      "zzz",
    ]);
  });

  it("filters by branch — only matching-branch versions surface", async () => {
    const rid = await createRepo("branch-filter");
    await seedPublish({ rid, apiName: "fn", branch: "main", semver: "1.0.0", artifactSeed: "main-1" });
    await seedPublish({ rid, apiName: "fn", branch: "feature/x", semver: "2.0.0", artifactSeed: "feat-2" });
    const onMain = await withAuth(
      request(app).get(`/api/v1/code-repositories/${rid}/functions?branch=main`),
    );
    expect(published(onMain.body.data)).toHaveLength(1);
    expect(published(onMain.body.data)[0].semver).toBe("1.0.0");
    expect(onMain.body.branch).toBe("main");

    const onFeat = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${rid}/functions?branch=${encodeURIComponent("feature/x")}`,
      ),
    );
    // feature/x doesn't exist on Stemma (we only seeded a function_version
    // row, not a branch HEAD), so working-tree discovery silently returns
    // nothing. The published row is still present.
    expect(published(onFeat.body.data)).toHaveLength(1);
    expect(published(onFeat.body.data)[0].semver).toBe("2.0.0");
    expect(onFeat.body.branch).toBe("feature/x");
  });

  it("falls back to repo default_branch when ?branch= is omitted", async () => {
    const rid = await createRepo("default-branch", { defaultBranch: "develop" });
    await seedPublish({ rid, apiName: "fn", branch: "develop", semver: "1.0.0", artifactSeed: "dev-1" });
    await seedPublish({ rid, apiName: "fn", branch: "main", semver: "9.0.0", artifactSeed: "main-9" });
    const res = await withAuth(request(app).get(`/api/v1/code-repositories/${rid}/functions`));
    expect(res.body.branch).toBe("develop");
    expect(published(res.body.data)).toHaveLength(1);
    expect(published(res.body.data)[0].semver).toBe("1.0.0");
  });

  it("excludes YANKED versions; includes AVAILABLE preview", async () => {
    const rid = await createRepo("yanked-vs-preview");
    await seedPublish({ rid, apiName: "stable", branch: "main", semver: "1.0.0", artifactSeed: "s1" });
    await seedPublish({
      rid,
      apiName: "preview",
      branch: "main",
      semver: "0.1.0",
      isPreview: true,
      artifactSeed: "p1",
    });
    // Distinct semver since function_version has UQ(repository_rid, branch, semver).
    await seedPublish({ rid, apiName: "yanked", branch: "main", semver: "1.0.1", artifactSeed: "y1" });
    // Transition the third row to YANKED. function_version has no api_name column;
    // it stores exports inside manifest_json. Match via JSONB.
    await schema.pool.query(
      `UPDATE function_version
          SET state='YANKED',
              yanked_at=now(),
              yank_reason='test'
        WHERE repository_rid=$1
          AND manifest_json @> '{"exports":["yanked"]}'::jsonb`,
      [rid],
    );

    const res = await withAuth(request(app).get(`/api/v1/code-repositories/${rid}/functions`));
    const names = published(res.body.data).map((r) => r.apiName);
    expect(names).toEqual(["preview", "stable"]);
    const previewRow = published(res.body.data).find((r) => r.apiName === "preview");
    expect(previewRow?.isPreview).toBe(true);
  });

  it("surfaces BOTH the published and working-tree rows for the same apiName", async () => {
    // Published and working-tree are distinct surfaces: the Published tab runs
    // the released artifact (v1.0.0); the Live Preview tab runs the current
    // in-tree file (which may differ from what was released). Masking the
    // working-tree row behind the published one leaves Live Preview empty even
    // though the file exists — the bug users hit after Tag & Release. The
    // discovery endpoint therefore returns one row per (apiName, source).
    const rid = await createRepo("publish-and-working-tree");
    await seedPublish({
      rid,
      apiName: "helloWorld",
      branch: "main",
      semver: "1.0.0",
      artifactSeed: "hw-1",
    });
    const res = await withAuth(request(app).get(`/api/v1/code-repositories/${rid}/functions`));
    const helloRows = res.body.data.filter((r: FunctionRow) => r.apiName === "helloWorld");
    expect(helloRows).toHaveLength(2);
    const bySource = new Map(helloRows.map((r: FunctionRow) => [r.source, r]));
    expect(bySource.has("published")).toBe(true);
    expect(bySource.has("working_tree")).toBe(true);
    expect((bySource.get("published") as FunctionRow).semver).toBe("1.0.0");
    expect((bySource.get("working_tree") as FunctionRow).semver).toBeNull();
  });

  it("returns 404 RepositoryNotFound for an unknown rid", async () => {
    const fakeRid = `ri.stemma.main.repository.${randomUUID()}`;
    const res = await withAuth(request(app).get(`/api/v1/code-repositories/${fakeRid}/functions`));
    expect(res.status).toBe(404);
    expect(res.body.errorName).toBe("CodeRepos:RepositoryNotFound");
  });
});
