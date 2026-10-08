// ---------------------------------------------------------------------------
// Foundry parity — resource names are unique within a folder.
//
// Doc (api/datasets-v2-resources/datasets/create-dataset): the Create Dataset
// endpoint fails with
//
//   ResourceNameAlreadyExists → 409 CONFLICT
//   "The provided resource name is already in use by another resource in the
//    same folder."  (parameters: parentFolderRid, displayName)
//
// These tests exercise `assertFolderNameAvailable` against a stub knex —
// asserting the actual query shape (table, folder/project scoping, self
// exclusion) — and pin the guard's presence at every `foundry_datasets`
// create/rename call site via source guards.
//
// Acceptance criteria (from the audit):
//   - creating a second "Fraud Signal" in the same folder fails with 409
//   - the same name in a DIFFERENT folder succeeds
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import { AppError } from "../../../src/utils/foundryAppError";
import {
  assertFolderNameAvailable,
  findFolderNameConflict,
} from "../../../src/services/datasets/folderNameGuard";

const PROJECT = "22222222-2222-2222-2222-222222222222";
const FOLDER = "33333333-3333-3333-3333-333333333333";
const OTHER_DATASET = "cdb81fc0-7f8e-4ee4-b2cb-3d17e61de155";
const SELF = "de965e8b-0626-4ebe-86c6-5cd4487f78cc";

interface Call {
  table: string;
  wheres: Record<string, unknown>[];
  nullCols: string[];
  nots: Record<string, unknown>[];
}

/**
 * Minimal chainable knex stub. `.first()` consumes the next queued response;
 * every constraint is recorded so the test asserts the QUERY SHAPE, not just
 * the outcome.
 */
function stubKnex(queue: unknown[]) {
  const calls: Call[] = [];
  const knex = (table: string) => {
    const rec: Call = { table, wheres: [], nullCols: [], nots: [] };
    calls.push(rec);
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.where = (w: Record<string, unknown>) => {
      rec.wheres.push(w);
      return chain;
    };
    chain.whereNull = (c: string) => {
      rec.nullCols.push(c);
      return chain;
    };
    chain.whereNot = (w: Record<string, unknown>) => {
      rec.nots.push(w);
      return chain;
    };
    chain.first = async () => queue.shift();
    return chain;
  };
  return { knex, calls };
}

describe("assertFolderNameAvailable", () => {
  it("passes when the folder has no conflicting resource", async () => {
    const { knex } = stubKnex([undefined, undefined, undefined]);
    await expect(
      assertFolderNameAvailable(knex as never, {
        name: "Fraud Signal",
        folderId: FOLDER,
        projectId: PROJECT,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a second dataset with the same name in the SAME folder (409)", async () => {
    // Sibling dataset found, then the folder lookup for the message.
    const { knex } = stubKnex([
      { id: OTHER_DATASET, name: "Fraud Signal" },
      { name: "Fraud Pipeline" },
    ]);
    let err: AppError | undefined;
    try {
      await assertFolderNameAvailable(knex as never, {
        name: "Fraud Signal",
        folderId: FOLDER,
        projectId: PROJECT,
      });
    } catch (e) {
      err = e as AppError;
    }

    expect(err).toBeInstanceOf(AppError);
    expect(err!.statusCode).toBe(409);
    expect(err!.code).toBe("RESOURCE_NAME_ALREADY_EXISTS");
    expect(err!.errorName).toBe("ResourceNameAlreadyExists");
    // Payload names the folder and the conflicting resource.
    expect(err!.parameters).toMatchObject({
      parentFolderId: FOLDER,
      displayName: "Fraud Signal",
      conflictingResourceId: OTHER_DATASET,
      conflictingResourceType: "dataset",
    });
    expect(err!.message).toContain("Fraud Signal");
    expect(err!.message).toContain(OTHER_DATASET);
    expect(err!.message).toContain('folder "Fraud Pipeline"');
  });

  it("scopes the dataset check to the TARGET folder (same name elsewhere is fine)", async () => {
    const { knex, calls } = stubKnex([undefined, undefined, undefined]);
    await assertFolderNameAvailable(knex as never, {
      name: "Fraud Signal",
      folderId: FOLDER,
      projectId: PROJECT,
    });
    // The dataset sibling check constrains by folder_id — a "Fraud Signal" in
    // another folder is invisible to this query by construction.
    expect(calls[0]).toMatchObject({
      table: "foundry_datasets",
      wheres: [{ name: "Fraud Signal" }, { folder_id: FOLDER }],
    });
    expect(calls[0]!.nullCols).toHaveLength(0);
  });

  it("matches root-level datasets by project_id with folder_id IS NULL", async () => {
    const { knex, calls } = stubKnex([undefined, undefined, undefined]);
    await assertFolderNameAvailable(knex as never, {
      name: "X",
      folderId: null,
      projectId: PROJECT,
    });
    expect(calls[0]).toMatchObject({ table: "foundry_datasets" });
    expect(calls[0]!.nullCols).toContain("folder_id");
    expect(calls[0]!.wheres).toContainEqual({ project_id: PROJECT });
  });

  it("excludes the dataset being renamed/moved from its own check", async () => {
    const { knex, calls } = stubKnex([undefined, undefined, undefined]);
    await assertFolderNameAvailable(knex as never, {
      name: "Fraud Signal",
      folderId: FOLDER,
      projectId: PROJECT,
      excludeDatasetId: SELF,
    });
    expect(calls[0]!.nots).toContainEqual({ id: SELF });
  });

  it("blocks on a conflicting sibling FOLDER or PIPELINE, not just datasets", async () => {
    const c1 = stubKnex([undefined, { id: "f-conflict", name: "X" }]);
    const r1 = await findFolderNameConflict(c1.knex as never, {
      name: "X",
      folderId: FOLDER,
      projectId: PROJECT,
    });
    expect(r1).toMatchObject({ resourceType: "folder", resourceId: "f-conflict" });

    const c2 = stubKnex([undefined, undefined, { id: "p-conflict", name: "X" }]);
    const r2 = await findFolderNameConflict(c2.knex as never, {
      name: "X",
      folderId: FOLDER,
      projectId: PROJECT,
    });
    expect(r2).toMatchObject({ resourceType: "pipeline", resourceId: "p-conflict" });
  });
});

describe("guard is wired into every create/rename path", () => {
  const src = (rel: string) =>
    readFileSync(resolve(__dirname, "../../../src", rel), "utf-8");

  it("upload flow guards before inserting into foundry_datasets", () => {
    const s = src("services/foundryUploadService.ts");
    expect(s).toContain("assertFolderNameAvailable(trx,");
    // Guard runs before the insert in the same loop.
    const guardIdx = s.indexOf("assertFolderNameAvailable(trx,");
    const insertIdx = s.indexOf("trx('foundry_datasets')", guardIdx);
    expect(insertIdx).toBeGreaterThan(guardIdx);
  });

  it("rename/move (updateDataset) guards; duplicateDataset uses the atomic registrar", () => {
    const s = src("services/datasetService.ts");
    // updateDataset keeps the friendly pre-check (unique index is the backstop).
    const matches = s.match(/assertFolderNameAvailable\(this\.knex,/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // duplicateDataset goes through registerDataset (incident 3ec397d5) and
    // keeps refuse-on-conflict semantics.
    expect(s).toMatch(/registerDataset\(this\.knex, \{[\s\S]*?adoptIf: async \(\) => false/);
  });

  it("registerDataset is DB-atomic and keeps the rename pre-check", () => {
    const s = src("services/datasets/datasetRegistration.ts");
    expect(s).toContain("ON CONFLICT (project_id, folder_id, name) DO NOTHING");
    expect(s).toMatch(/findFolderNameConflict\(trx, \{[\s\S]*?excludeDatasetId: boundId/);
  });

  it("kafka stream source guards the project-root insert", () => {
    const s = src("services/pipelineService.ts");
    expect(s).toMatch(
      /assertFolderNameAvailable\(trx, \{[\s\S]*?folderId: null[\s\S]*?\}\)/,
    );
  });

  it("every deploy output registration goes through the atomic registrar", () => {
    // Incident 3ec397d5: the SELECT-then-INSERT guard (assertFolderNameAvailable
    // + insert) raced across executors. All deploy writers (DuckDB engine,
    // Iceberg engine, legacy) now call registerDataset(), which enforces the
    // name rule via INSERT ... ON CONFLICT and the rename pre-check.
    const s = src("services/deploymentService.ts");
    const calls = s.match(/registerDataset\(this\.knex, \{/g) ?? [];
    expect(calls).toHaveLength(3);
    expect(s).not.toMatch(/assertFolderNameAvailable\(/);
    expect(s).not.toMatch(/knex\(['"]foundry_datasets['"]\)\s*\.insert\(/);
    // Renames revalidate the existing binding inside the registrar.
    const rebinds = s.match(/resolveBoundId: \(\) => this\.resolveBoundDatasetId\(/g) ?? [];
    expect(rebinds.length).toBe(3);
  });

  it("the non-throwing sync registry refuses name conflicts", () => {
    const s = src("services/datasets/synced-dataset-registry.ts");
    expect(s).toContain('reason: "name_conflict"');
  });

  it("the HTTP envelope carries the Foundry parameters map", () => {
    const s = src("middleware/errorHandler.ts");
    expect(s).toContain("parameters: fErr.parameters ?? {}");
    expect(s).toContain('errorName: fErr.errorName ?? "AuthenticationError"');
  });
});
