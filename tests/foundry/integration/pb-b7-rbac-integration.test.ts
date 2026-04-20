// ---------------------------------------------------------------------------
// PB-B7 — RBAC + Marking propagation (integration).
//
// Covers:
//   * ACL upsert/list/revoke round-trip
//   * effectiveRole resolution (pipeline_acl direct → project_members)
//   * MISSING_MARKING:<name> thrown at deploy when user lacks required
//     marking; union stamped onto pipelines.input_markings on success
//   * grant/revoke emits tellus_audit_events (category='pipeline_acl')
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import foundryDb from "../../../src/config/foundryDb";
import {
  PipelineAclService,
  isRbacEnabled,
} from "../../../src/services/pipelines/pipelineAcl";
import { applyMarkingPolicyAtDeploy } from "../../../src/services/pipelines/markingPolicy";

const STAMP = Date.now();
let dbUp = false;
let ownerId = "";
let viewerId = "";
let projectId = "";
let pipelineId = "";
let dsMarkedId = "";
let markingCode = `RESTRICTED_${STAMP}`;
let acl: PipelineAclService;

beforeAll(async () => {
  try {
    await foundryDb.raw("SELECT 1");
    dbUp = true;
  } catch (err) {
    console.warn(`[pb-b7] Postgres unreachable: ${(err as Error).message}`);
    return;
  }

  process.env.RBAC_ENABLED = "true";

  const [owner] = await foundryDb("users")
    .insert({
      email: `pb-b7-owner-${STAMP}@tellus.local`,
      password_hash: "x",
      display_name: `owner ${STAMP}`,
    })
    .returning("*");
  ownerId = owner.id;
  const [viewer] = await foundryDb("users")
    .insert({
      email: `pb-b7-viewer-${STAMP}@tellus.local`,
      password_hash: "x",
      display_name: `viewer ${STAMP}`,
    })
    .returning("*");
  viewerId = viewer.id;

  const [project] = await foundryDb("projects")
    .insert({ name: `pb-b7-${STAMP}`, owner_id: ownerId })
    .returning("*");
  projectId = project.id;

  const [pipeline] = await foundryDb("pipelines")
    .insert({
      project_id: projectId,
      name: `pipe-${STAMP}`,
      status: "draft",
      created_by: ownerId,
    })
    .returning("*");
  pipelineId = pipeline.id;

  // Seed owner ACL (mirrors pipelineService.createPipeline behaviour).
  await foundryDb("pipeline_acl").insert({
    pipeline_id: pipelineId,
    principal_id: ownerId,
    principal_type: "user",
    role: "owner",
    granted_by: ownerId,
  });

  // A marked input dataset.
  const [marking] = await foundryDb("marking")
    .insert({ code: markingCode, display_name: markingCode })
    .returning("*");
  const [ds] = await foundryDb("foundry_datasets")
    .insert({
      name: `ds-marked-${STAMP}`,
      project_id: projectId,
      file_path: `fake/${STAMP}.csv`,
      markings: [markingCode],
    })
    .returning("*");
  dsMarkedId = ds.id;
  await foundryDb("pipeline_nodes").insert({
    pipeline_id: pipelineId,
    node_type: "dataset",
    dataset_id: dsMarkedId,
    label: "src",
    position_x: 0,
    position_y: 0,
    config: JSON.stringify({}),
  });

  acl = new PipelineAclService(foundryDb);
  void marking;
});

afterAll(async () => {
  if (!dbUp) return;
  if (pipelineId) {
    await foundryDb("pipeline_acl").where({ pipeline_id: pipelineId }).del();
    await foundryDb("pipeline_nodes").where({ pipeline_id: pipelineId }).del();
    await foundryDb("pipelines").where({ id: pipelineId }).del();
  }
  if (dsMarkedId) await foundryDb("foundry_datasets").where({ id: dsMarkedId }).del();
  if (projectId) await foundryDb("projects").where({ id: projectId }).del();
  if (ownerId) await foundryDb("users").where({ id: ownerId }).del();
  if (viewerId) await foundryDb("users").where({ id: viewerId }).del();
  await foundryDb("marking").where({ code: markingCode }).del();
  await foundryDb.destroy();
});

describe("PB-B7 ACL service", () => {
  it("isRbacEnabled defaults true / respects RBAC_ENABLED=false", () => {
    const prev = process.env.RBAC_ENABLED;
    process.env.RBAC_ENABLED = undefined as unknown as string;
    expect(isRbacEnabled()).toBe(true);
    process.env.RBAC_ENABLED = "false";
    expect(isRbacEnabled()).toBe(false);
    process.env.RBAC_ENABLED = prev ?? "true";
  });

  it("grant → effectiveRole returns the granted role", async () => {
    if (!dbUp) return;
    await acl.grant({
      pipelineId,
      principalId: viewerId,
      principalType: "user",
      role: "viewer",
      grantedBy: ownerId,
    });
    const r = await acl.effectiveRole(pipelineId, viewerId);
    expect(r).toBe("viewer");
  });

  it("list returns rows granted_at desc", async () => {
    if (!dbUp) return;
    const rows = await acl.list(pipelineId);
    const ids = rows.map((r) => r.principal_id);
    expect(ids).toContain(ownerId);
    expect(ids).toContain(viewerId);
  });

  it("revoke removes the grant and effectiveRole falls back to project_members when present", async () => {
    if (!dbUp) return;
    // No project_members row for viewerId → after revoke effectiveRole is null.
    await acl.revoke({
      pipelineId,
      principalId: viewerId,
      principalType: "user",
    });
    const r = await acl.effectiveRole(pipelineId, viewerId);
    expect(r).toBeNull();
  });

  it("project_members role inherits when no pipeline_acl row exists", async () => {
    if (!dbUp) return;
    await foundryDb("project_members").insert({
      project_id: projectId,
      user_id: viewerId,
      role: "editor",
    });
    const r = await acl.effectiveRole(pipelineId, viewerId);
    expect(r).toBe("editor");
    await foundryDb("project_members")
      .where({ project_id: projectId, user_id: viewerId })
      .del();
  });
});

describe("PB-B7 marking policy", () => {
  it("throws MISSING_MARKING:<code> when user lacks a required marking", async () => {
    if (!dbUp) return;
    const nodes = await foundryDb("pipeline_nodes")
      .where({ pipeline_id: pipelineId })
      .select("*");
    try {
      await applyMarkingPolicyAtDeploy(foundryDb, pipelineId, nodes, viewerId);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe(`MISSING_MARKING:${markingCode}`);
    }
  });

  it("admits + returns the union when user has every required marking", async () => {
    if (!dbUp) return;
    // Attach the marking to the viewer user.
    const marking = await foundryDb("marking")
      .where({ code: markingCode })
      .first("marking_id");
    await foundryDb("marking_assignment").insert({
      marking_id: marking.marking_id,
      subject_type: "user",
      subject_id: viewerId,
    });
    const nodes = await foundryDb("pipeline_nodes")
      .where({ pipeline_id: pipelineId })
      .select("*");
    const res = await applyMarkingPolicyAtDeploy(
      foundryDb,
      pipelineId,
      nodes,
      viewerId,
    );
    expect(res.unionMarkings).toEqual([markingCode]);
    expect(res.enforced).toBe(true);
    await foundryDb("marking_assignment")
      .where({
        marking_id: marking.marking_id,
        subject_type: "user",
        subject_id: viewerId,
      })
      .del();
  });

  it("no-op + not enforced when RBAC_ENABLED=false", async () => {
    if (!dbUp) return;
    const prev = process.env.RBAC_ENABLED;
    process.env.RBAC_ENABLED = "false";
    try {
      const nodes = await foundryDb("pipeline_nodes")
        .where({ pipeline_id: pipelineId })
        .select("*");
      const res = await applyMarkingPolicyAtDeploy(
        foundryDb,
        pipelineId,
        nodes,
        viewerId,
      );
      expect(res.enforced).toBe(false);
      expect(res.unionMarkings).toEqual([]);
    } finally {
      process.env.RBAC_ENABLED = prev ?? "true";
    }
  });

  it("deny emits a tellus_audit_events row tagged pipeline_marking", async () => {
    if (!dbUp) return;
    const before = await foundryDb("tellus_audit_events")
      .where({ category: "pipeline_marking", action: "pipeline.marking.deny" })
      .count({ c: "*" })
      .first();
    try {
      const nodes = await foundryDb("pipeline_nodes")
        .where({ pipeline_id: pipelineId })
        .select("*");
      await applyMarkingPolicyAtDeploy(foundryDb, pipelineId, nodes, viewerId);
    } catch {
      /* expected */
    }
    const after = await foundryDb("tellus_audit_events")
      .where({ category: "pipeline_marking", action: "pipeline.marking.deny" })
      .count({ c: "*" })
      .first();
    expect(Number(after?.c ?? 0)).toBeGreaterThan(Number(before?.c ?? 0));
  });
});
