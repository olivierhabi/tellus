// ---------------------------------------------------------------------------
// Foundry parity — a deployed output dataset lands in the pipeline's folder.
//
// Doc (pipeline-builder/outputs-add-dataset-output): "After the first build of
// your pipeline, your dataset output will be created in the same folder as your
// pipeline." Pipeline Builder exposes no free-text path for an output, so
// placement must be INHERITED at deploy time.
//
// The defect these pin: both `foundry_datasets` INSERT sites in
// deploymentService set `project_id` and left `folder_id` NULL. Because
// `datasetService.listProjectRootDatasets` defines the project root as
// `folder_id IS NULL`, every deployed output surfaced at the root regardless of
// where its pipeline lived.
//
// The resolver is exercised against a stub knex (no PG needed) so the real
// query shape — which table, which columns, the project scoping — is asserted,
// not just the presence of a string in the source. The two INSERT call sites
// are then pinned by a source guard, since reaching them for real requires a
// full materializing deploy (covered by the manual browser/API run).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import { DeploymentService } from "../../../src/services/deploymentService";

const PIPELINE = "11111111-1111-1111-1111-111111111111";
const PROJECT = "22222222-2222-2222-2222-222222222222";
const FOLDER = "33333333-3333-3333-3333-333333333333";

type Query = { table: string; where: Record<string, unknown> };

/**
 * Minimal knex stub: records every `table(...).where(...).first(...)` and
 * replies from a per-table fixture. Enough for the resolver, which only reads.
 */
function stubKnex(rows: {
  pipelines?: Record<string, unknown> | undefined;
  folders?: Record<string, unknown> | undefined;
}) {
  const calls: Query[] = [];
  const knex = (table: string) => ({
    where(where: Record<string, unknown>) {
      calls.push({ table, where });
      return {
        first: async () => rows[table as "pipelines" | "folders"],
      };
    },
  });
  return { knex, calls };
}

/** Reach the private resolver without loosening its visibility in src. */
function resolver(knex: unknown) {
  const svc = new DeploymentService(
    knex as never,
    {} as never,
  ) as unknown as {
    resolveOutputFolderId(p: string, proj: string): Promise<string | null>;
  };
  return (pipelineId: string, projectId: string) =>
    svc.resolveOutputFolderId(pipelineId, projectId);
}

describe("output dataset folder inheritance", () => {
  it("inherits the pipeline's folder so the output is not stranded at the project root", async () => {
    const { knex, calls } = stubKnex({
      pipelines: { folder_id: FOLDER },
      folders: { id: FOLDER },
    });

    await expect(resolver(knex)(PIPELINE, PROJECT)).resolves.toBe(FOLDER);

    // Reads the pipeline row by id, then validates the folder within the
    // deploying project — not by folder id alone.
    expect(calls).toEqual([
      { table: "pipelines", where: { id: PIPELINE } },
      { table: "folders", where: { id: FOLDER, project_id: PROJECT } },
    ]);
  });

  it("returns null for a pipeline at the project root, preserving root placement", async () => {
    const { knex, calls } = stubKnex({ pipelines: { folder_id: null } });

    await expect(resolver(knex)(PIPELINE, PROJECT)).resolves.toBeNull();
    // No folder lookup — nothing to validate.
    expect(calls).toHaveLength(1);
  });

  it("falls back to the root when the pipeline's folder belongs to another project", async () => {
    // `foundry_datasets.folder_id` FKs to `folders`, whose own `project_id` is
    // what the file tree lists by. A cross-project folder would satisfy the FK
    // yet make the output invisible in this project — so it must not be
    // inherited.
    const { knex } = stubKnex({
      pipelines: { folder_id: FOLDER },
      folders: undefined,
    });

    await expect(resolver(knex)(PIPELINE, PROJECT)).resolves.toBeNull();
  });

  it("falls back to the root when the pipeline row is gone", async () => {
    const { knex } = stubKnex({ pipelines: undefined });
    await expect(resolver(knex)(PIPELINE, PROJECT)).resolves.toBeNull();
  });
});

describe("both INSERT sites inherit, both UPDATE sites do not", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/services/deploymentService.ts"),
    "utf-8",
  );

  it("calls the resolver at the engine/Iceberg and legacy INSERT sites", () => {
    // Two insert paths exist (engine/Iceberg + legacy CSV/parquet). A fix that
    // lands on only one leaves half the deploys stranded at the root.
    const calls = source.match(/resolveOutputFolderId\(/g) ?? [];
    // 1 declaration + 2 call sites.
    expect(calls).toHaveLength(3);
    expect(source).toMatch(
      /const outputFolderId = await this\.resolveOutputFolderId\(\s*args\.pipelineId,\s*args\.projectId,?\s*\)/s,
    );
    expect(source).toMatch(
      /const outputFolderId = await this\.resolveOutputFolderId\(pipelineId, projectId\)/,
    );
    // Both INSERT sites place the dataset in the resolved folder.
    for (const m of source.matchAll(
      /\.insert\(\{[\s\S]{0,1400}?folder_id: outputFolderId[\s\S]{0,200}?\}\)/g,
    )) {
      expect(m[0]).toMatch(/foundry_datasets|datasetPatch|project_id/);
    }
    expect(
      source.match(/folder_id: outputFolderId/g) ?? [],
    ).toHaveLength(2);
  });

  it("leaves folder_id out of the existing-dataset UPDATE patches", () => {
    // Redeploy must not drag a dataset the user has since moved back into the
    // pipeline's folder. The UPDATE branches are keyed on the immutable
    // `outputDatasetId`, so placement is the user's from then on.
    const patch = source.slice(
      source.indexOf("const datasetPatch = {"),
      source.indexOf("if (existingDatasetId) {"),
    );
    expect(patch.length).toBeGreaterThan(0);
    expect(patch).not.toMatch(/folder_id/);

    for (const m of source.matchAll(
      /\.where\(\{ id: existingDatasetId \}\)\s*\.update\(([\s\S]{0,900}?)\);/g,
    )) {
      expect(m[1]).not.toMatch(/folder_id/);
    }
  });
});
