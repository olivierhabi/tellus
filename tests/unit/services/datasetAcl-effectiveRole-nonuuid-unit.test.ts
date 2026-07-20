// ---------------------------------------------------------------------------
// datasetAcl-effectiveRole-nonuuid-unit.test.ts — Fix B regression.
//
// effectiveRole must NOT throw (and must NOT issue a user-grant or
// project_members query) when the userId is not a UUID — a dev/email
// principal, or a malformed JWT sub. Both `dataset_acl.principal_id` and
// `project_members.user_id` are UUID columns; querying them with a non-UUID
// would throw "invalid input syntax for type uuid" and surface (via the P0
// authz seam) as a check-error fail-closed deny instead of a clean
// null = "no grant". The guard treats a non-UUID userId as "no direct grant /
// no project membership" so the deny is a clean insufficient-role, not a crash.
//
// Run: npx vitest run --config vitest.unit.config.ts <this-file>
// ---------------------------------------------------------------------------
import { describe, it, expect, vi } from "vitest";
import type { Knex } from "knex";

// foundryDb (the default knex) loads at module import and requireSecret()s
// PGPASSWORD. We never use the default (the ctor is passed a mock knex), so
// stub it so importing datasetAcl doesn't touch foundryDb.
vi.mock("../../../src/config/foundryDb.js", () => ({ default: {}, __esModule: true }));

import { DatasetAclService } from "../../../src/services/datasetAcl";

/** A knex stub that records every table touched and resolves terminal calls
 * (pluck/first) to empty/undefined so effectiveRole proceeds down its chain. */
function recordingKnex(record: string[]): Knex {
  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  chain.where = () => chain;
  chain.andWhere = () => chain;
  chain.join = () => chain;
  chain.orderBy = () => chain;
  chain.pluck = async () => [] as string[];
  chain.first = async () => undefined;
  const knex = (table: string) => { record.push(table); return chain; };
  return knex as unknown as Knex;
}

const DATASET = "c3a54ed5-19a3-4394-a66b-7e8b0d5dee95";
const EMAIL = "cypress-admin@tellus.local";
const UUID_USER = "8f02d2de-6353-4195-bf94-bc7626484bd0";

describe("effectiveRole — non-UUID userId guard (Fix B)", () => {
  it("returns null + queries NOTHING for an email (non-UUID) userId", async () => {
    const calls: string[] = [];
    const svc = new DatasetAclService(recordingKnex(calls));
    const role = await svc.effectiveRole(DATASET, EMAIL, []);
    expect(role).toBeNull();
    // No user-grant query (dataset_acl) + no project_members fallback
    // (foundry_datasets join + project_members) — both are UUID-keyed; a
    // non-UUID userId can't match, so neither query is issued (no throw).
    expect(calls).toEqual([]);
  });

  it("does issue the user-grant query (dataset_acl) for a UUID userId", async () => {
    const calls: string[] = [];
    const svc = new DatasetAclService(recordingKnex(calls));
    await svc.effectiveRole(DATASET, UUID_USER, []);
    expect(calls).toContain("dataset_acl");
  });
});
