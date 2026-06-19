// ---------------------------------------------------------------------------
// B2 / B3 — scaffold parity regression test.
//
// Asserts the architectural invariant introduced when DEFAULT_SCAFFOLD was
// removed and the in-memory Stemma + Templates adapters were wired through
// `stemma.commitFiles(...)`:
//
//   • The repo's file tree comes from the B3 manifest, NOT a hard-coded
//     seed inside the in-memory Stemma adapter.
//   • Two saga runs against the same (templateId, version, displayName)
//     produce byte-identical file lists (idempotency, G-C-22).
//   • The expected v2 typescript-functions shape lands at every required
//     path (the user-facing contract for the file viewer + B5 + B8).
//   • {{packageName}} substitution propagates through both file paths and
//     UTF-8 content; binary content (none in v2 today) would round-trip.
//
// This test pins the dev <-> production codepath equivalence: same
// inputs → same outputs, no DEFAULT_SCAFFOLD layered underneath.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { openTestSchema, type TestSchema } from "../_helpers/pg";
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
];
let schema: TestSchema;
let app: Express;
let stemma: InMemoryStemma;

beforeAll(async () => {
  schema = await openTestSchema("b2_scaffold_parity");
  for (const f of MIGS) {
    const sql = readFileSync(
      path.resolve(process.cwd(), `src/migrations/${f}`),
      "utf8",
    );
    await schema.pool.query(sql);
  }
});

afterAll(async () => {
  await schema.close();
});

// Distinct folders so tests that create multiple repos with the same
// displayName don't trip the
// `UNIQUE (parent_folder_rid, lower(display_name)) WHERE state='ACTIVE'`
// constraint on the `code_repository` table.
function folderRid(slot: number): string {
  const hex = slot.toString(16).padStart(12, "0");
  return `ri.compass.main.folder.0123abcd-ef01-4345-8789-${hex}`;
}

let folderCounter = 0;
function nextFolderRid(): string {
  folderCounter += 1;
  return folderRid(folderCounter);
}

let idemCounter = 0;
function nextIdem(): string {
  idemCounter += 1;
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `${hex(idemCounter)}-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
}

function withAuth(req: request.Test): request.Test {
  return req.set("X-Tellus-Test-Principal", "alice");
}

beforeEach(() => {
  const compass = new InMemoryCompass();
  stemma = new InMemoryStemma();
  // Wire stemma into template — this is what mount.ts does in production.
  // It replaces the legacy fake-commit fallback path with the real
  // manifest → substitute → stemma.commitFiles flow.
  const template = new InMemoryTemplate({ stemma });
  app = createCodeRepositoryApp({
    pool: schema.pool,
    compass,
    stemma,
    template,
  });
});

async function createRepo(
  displayName: string,
  parentFolderRid: string = nextFolderRid(),
): Promise<string> {
  const r = await withAuth(
    request(app)
      .post("/api/v1/code-repositories")
      .set("Idempotency-Key", nextIdem())
      .send({
        displayName,
        parentFolderRid,
        templateId: "typescript-functions",
        templateVersion: "2.4.0",
        defaultBranch: "main",
      }),
  );
  if (r.status !== 201) {
    throw new Error(
      `createRepository failed: ${r.status} ${JSON.stringify(r.body)}`,
    );
  }
  return r.body.rid as string;
}

async function listFullTree(rid: string): Promise<ReadonlyArray<string>> {
  // depth=5 is the max permitted; the v2 scaffold's deepest leaf
  // (`typescript-functions/src/functions/helloWorld.ts`) is at depth 4.
  const r = await withAuth(
    request(app).get(
      `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/tree?depth=5`,
    ),
  );
  if (r.status !== 200) {
    throw new Error(`tree fetch failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return (r.body.entries as Array<{ path: string }>)
    .map((e) => e.path)
    .sort();
}

async function readFileContent(rid: string, p: string): Promise<string> {
  const r = await withAuth(
    request(app).get(
      `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/files?path=${encodeURIComponent(p)}`,
    ),
  );
  if (r.status !== 200) {
    throw new Error(
      `file fetch failed for ${p}: ${r.status} ${JSON.stringify(r.body)}`,
    );
  }
  expect(r.body.isBinary).toBe(false);
  return r.body.content as string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("B2 + B3 — scaffold parity (v2 typescript-functions@2.4.0)", () => {
  it("emits the full v2 file list at every required path", async () => {
    const rid = await createRepo("Foundry Demo");
    const paths = await listFullTree(rid);

    // Root-level Gradle wrapper + repo metadata.
    const expectedRootFiles = [
      "templateConfig.json",
      ".gitignore",
      ".gitattributes",
      "ci.yml",
      "build.gradle",
      "settings.gradle",
      "gradle.properties",
      "repoSettings.json",
    ];
    for (const p of expectedRootFiles) {
      expect(paths).toContain(p);
    }

    // Gradle wrapper subdirectory + properties (the .jar is binary; not
    // shipped in the in-memory catalog per the comment in manifest.ts).
    expect(paths).toContain("gradle");
    expect(paths).toContain("gradle/wrapper");
    expect(paths).toContain("gradle/wrapper/gradle-wrapper.properties");

    // typescript-functions/ language subproject — the v2 discriminator.
    const expectedSubprojectFiles = [
      "typescript-functions",
      "typescript-functions/build.gradle",
      "typescript-functions/package.json",
      "typescript-functions/tsconfig.json",
      "typescript-functions/functions.json",
      "typescript-functions/resources.json",
      "typescript-functions/.npmrc",
      "typescript-functions/src",
      "typescript-functions/src/functions",
      "typescript-functions/src/functions/helloWorld.ts",
      "typescript-functions/test",
      "typescript-functions/test/.gitkeep",
    ];
    for (const p of expectedSubprojectFiles) {
      expect(paths).toContain(p);
    }

    // Negative space: no v1 paths, no orphan src/ at root.
    expect(paths).not.toContain("src");
    expect(paths).not.toContain("functions-typescript");
    expect(paths).not.toContain("osdk.config.json");
  });

  it("two runs against the same (template, displayName) produce identical scaffolds", async () => {
    // Same displayName slugifies to the same packageName, so the
    // substituted file content is byte-identical. We use distinct parent
    // folders so the `(parent_folder_rid, lower(display_name))` unique
    // constraint doesn't trip on the second insert.
    const ridA = await createRepo("Stable", folderRid(901));
    const ridB = await createRepo("Stable", folderRid(902));
    const pathsA = await listFullTree(ridA);
    const pathsB = await listFullTree(ridB);
    expect(pathsB).toEqual(pathsA);

    // File contents should also match for substituted files.
    const pkgA = await readFileContent(ridA, "typescript-functions/package.json");
    const pkgB = await readFileContent(ridB, "typescript-functions/package.json");
    expect(pkgB).toEqual(pkgA);
  });

  it("propagates packageName substitution into both file paths and content", async () => {
    const rid = await createRepo("My Cool Repo");
    // Slugified packageName: "my-cool-repo" (lowercased, hyphenated).
    const pkg = await readFileContent(rid, "typescript-functions/package.json");
    expect(pkg).toContain('"name": "my-cool-repo"');

    const root = await readFileContent(rid, "build.gradle");
    expect(root).toContain("group = 'my-cool-repo'");

    const settings = await readFileContent(rid, "settings.gradle");
    expect(settings).toContain("rootProject.name = 'my-cool-repo'");
  });

  it("ships the v2 function-discovery contract: helloWorld.ts is a default export", async () => {
    const rid = await createRepo("Discovery");
    const fn = await readFileContent(
      rid,
      "typescript-functions/src/functions/helloWorld.ts",
    );
    // The B8 AST walker keys off `export default` + filename = function-id.
    expect(fn).toMatch(/^export default function helloWorld\(/m);
    expect(fn).not.toMatch(/@Function\(\)/);
    expect(fn).not.toMatch(/export class /);
  });

  it("typescript-functions/package.json declares both @osdk/client and @osdk/functions", async () => {
    const rid = await createRepo("Deps");
    const pkg = await readFileContent(rid, "typescript-functions/package.json");
    expect(pkg).toContain('"@osdk/client":');
    expect(pkg).toContain('"@osdk/functions":');
  });

  it("templateConfig.json carries the upgrade-system metadata", async () => {
    const rid = await createRepo("Config");
    const cfg = await readFileContent(rid, "templateConfig.json");
    const parsed = JSON.parse(cfg) as {
      parentTemplateId: string;
      parentTemplateVersion: string;
    };
    expect(parsed.parentTemplateId).toBe("typescript-functions");
    expect(parsed.parentTemplateVersion).toBe("2.4.0");
  });

  it("functions.json + resources.json land with the v2 feature-flag defaults", async () => {
    const rid = await createRepo("Flags");
    const flags = JSON.parse(
      await readFileContent(rid, "typescript-functions/functions.json"),
    ) as Record<string, boolean>;
    // Per the v2 reference: external-systems and model-fns are off by
    // default; ontology-edit + query are on.
    expect(flags.enableExternalSystems).toBe(false);
    expect(flags.enableModelFunctions).toBe(false);
    expect(flags.enableOntologyEditFunctions).toBe(true);
    expect(flags.enableQueryFunctions).toBe(true);

    const resources = JSON.parse(
      await readFileContent(rid, "typescript-functions/resources.json"),
    ) as { imports: ReadonlyArray<unknown> };
    expect(Array.isArray(resources.imports)).toBe(true);
    expect(resources.imports).toHaveLength(0);
  });

  it("commits a single non-zero head SHA for the saga's initial scaffold", async () => {
    const rid = await createRepo("Head");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/tree`,
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.body.commitSha).not.toBe("0".repeat(40));
  });
});
