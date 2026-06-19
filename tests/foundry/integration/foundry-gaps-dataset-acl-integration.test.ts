// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §6 — per-dataset ACLs (integration, real Postgres).
//
// Mirrors the PB-B7 pipeline-RBAC integration test for the dataset surface:
//   * grant/list/revoke round-trip on dataset_acl
//   * effectiveRole resolution: dataset_acl direct grant → project_members
//     fallback (via foundry_datasets.folder_id → folders.project_id)
//   * project role acts as a FLOOR; a higher dataset grant raises it
//   * seedOwner makes the creator an owner
//
// Skips gracefully when Postgres is unreachable.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import foundryDb from "../../../src/config/foundryDb";
import {
  DatasetAclService,
  datasetRoleSatisfies,
} from "../../../src/services/datasetAcl";

const STAMP = Date.now();
let dbUp = false;
let ownerId = "";
let viewerId = "";
let outsiderId = "";
let projectId = "";
let folderId = "";
let datasetId = "";
let acl: DatasetAclService;

beforeAll(async () => {
  try {
    await foundryDb.raw("SELECT 1");
    dbUp = true;
  } catch (err) {
    console.warn(`[fg-§6-acl] Postgres unreachable: ${(err as Error).message}`);
    return;
  }

  const mkUser = async (tag: string) => {
    const [u] = await foundryDb("users")
      .insert({
        email: `fg6-${tag}-${STAMP}@tellus.local`,
        password_hash: "x",
        display_name: `${tag} ${STAMP}`,
      })
      .returning("*");
    return u.id as string;
  };
  ownerId = await mkUser("owner");
  viewerId = await mkUser("viewer");
  outsiderId = await mkUser("outsider");

  const [project] = await foundryDb("projects")
    .insert({ name: `fg6-${STAMP}`, owner_id: ownerId })
    .returning("*");
  projectId = project.id;

  const [folder] = await foundryDb("folders")
    .insert({
      name: `fg6-folder-${STAMP}`,
      project_id: projectId,
      path: `fg6_${STAMP}`, // single ltree label → depth 0
      depth: 0,
    })
    .returning("*");
  folderId = folder.id;

  const [dataset] = await foundryDb("foundry_datasets")
    .insert({
      name: `fg6-ds-${STAMP}`,
      folder_id: folderId,
      file_path: `/tmp/fg6-${STAMP}.csv`,
      status: "ready",
      format: "csv",
    })
    .returning("*");
  datasetId = dataset.id;

  // owner is a project 'owner'; viewer is a project 'viewer'; outsider has no
  // project membership at all.
  await foundryDb("project_members").insert([
    { project_id: projectId, user_id: ownerId, role: "owner" },
    { project_id: projectId, user_id: viewerId, role: "viewer" },
  ]);

  acl = new DatasetAclService(foundryDb);
});

afterAll(async () => {
  if (!dbUp) return;
  await foundryDb("dataset_acl").where({ dataset_id: datasetId }).del().catch(() => {});
  await foundryDb("foundry_datasets").where({ id: datasetId }).del().catch(() => {});
  await foundryDb("folders").where({ id: folderId }).del().catch(() => {});
  await foundryDb("project_members").where({ project_id: projectId }).del().catch(() => {});
  await foundryDb("projects").where({ id: projectId }).del().catch(() => {});
  await foundryDb("users").whereIn("id", [ownerId, viewerId, outsiderId]).del().catch(() => {});
  await foundryDb.destroy();
});

describe("DatasetAclService (FOUNDRY-GAPS §6)", () => {
  it("resolves the project_members role as a fallback floor", async () => {
    if (!dbUp) return;
    expect(await acl.effectiveRole(datasetId, ownerId)).toBe("owner");
    expect(await acl.effectiveRole(datasetId, viewerId)).toBe("viewer");
  });

  it("returns null for a principal with no membership and no grant", async () => {
    if (!dbUp) return;
    expect(await acl.effectiveRole(datasetId, outsiderId)).toBeNull();
  });

  it("grant/list/revoke round-trips, and a direct grant overrides the floor", async () => {
    if (!dbUp) return;
    // Raise the project-'viewer' to dataset-'editor'.
    const row = await acl.grant({
      datasetId,
      principalId: viewerId,
      principalType: "user",
      role: "editor",
      grantedBy: ownerId,
    });
    expect(row.role).toBe("editor");
    expect(await acl.effectiveRole(datasetId, viewerId)).toBe("editor");

    const list = await acl.list(datasetId);
    expect(list.some((r) => r.principal_id === viewerId && r.role === "editor")).toBe(true);

    // A grant LOWER than the project floor must not reduce the effective role
    // (grants are additive — the floor wins).
    await acl.grant({ datasetId, principalId: viewerId, principalType: "user", role: "viewer", grantedBy: ownerId });
    expect(await acl.effectiveRole(datasetId, viewerId)).toBe("viewer"); // floor == grant == viewer

    const revoked = await acl.revoke({ datasetId, principalId: viewerId, principalType: "user" });
    expect(revoked.removed).toBe(true);
    // Back to the project floor.
    expect(await acl.effectiveRole(datasetId, viewerId)).toBe("viewer");
  });

  it("grants an outsider access only via an explicit dataset grant", async () => {
    if (!dbUp) return;
    expect(await acl.effectiveRole(datasetId, outsiderId)).toBeNull();
    await acl.grant({ datasetId, principalId: outsiderId, principalType: "user", role: "viewer", grantedBy: ownerId });
    expect(await acl.effectiveRole(datasetId, outsiderId)).toBe("viewer");
    await acl.revoke({ datasetId, principalId: outsiderId, principalType: "user" });
    expect(await acl.effectiveRole(datasetId, outsiderId)).toBeNull();
  });

  it("seedOwner makes the creator an owner (idempotent)", async () => {
    if (!dbUp) return;
    await acl.seedOwner(datasetId, outsiderId);
    await acl.seedOwner(datasetId, outsiderId); // idempotent
    expect(await acl.effectiveRole(datasetId, outsiderId)).toBe("owner");
    await acl.revoke({ datasetId, principalId: outsiderId, principalType: "user" });
  });

  it("datasetRoleSatisfies enforces owner > editor > viewer", () => {
    expect(datasetRoleSatisfies("owner", "viewer")).toBe(true);
    expect(datasetRoleSatisfies("editor", "editor")).toBe(true);
    expect(datasetRoleSatisfies("viewer", "editor")).toBe(false);
  });
});
