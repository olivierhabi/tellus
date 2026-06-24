// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §8 — cell-level markings (integration, real Postgres).
//
// Proves the CellMarkingService set/get round-trips against the live
// object_cell_marking table (migration 102) and that the persisted markings
// drive redaction correctly for callers with / without the marking, and for a
// markingBypass principal. Cleans up its stamped rows (the table has no
// append-only REVOKE).
//
// Skips gracefully when Postgres is unreachable.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import foundryDb from "../../../src/config/foundryDb";
import {
  CellMarkingService,
  redactCells,
} from "../../../src/services/security/cellMarkingService";

const STAMP = Date.now();
const OT = `CellTaxpayer_${STAMP}`;
const PK = `CELL-${STAMP}`;
const PK2 = `CELL2-${STAMP}`;

let dbUp = false;
const svc = new CellMarkingService();

beforeAll(async () => {
  try {
    await foundryDb.raw("SELECT 1");
    // The table must exist (migration 102). If it doesn't, treat as "no DB" so
    // the suite skips rather than failing a pre-102 schema.
    await foundryDb.raw("SELECT 1 FROM object_cell_marking LIMIT 1");
    dbUp = true;
  } catch (err) {
    console.warn(`[fg-§8-cell] Postgres/table unavailable: ${(err as Error).message}`);
  }
});

afterAll(async () => {
  if (!dbUp) return;
  await foundryDb
    .raw(`DELETE FROM object_cell_marking WHERE object_type_api_name = ?`, [OT])
    .catch(() => {});
});

describe("CellMarkingService — live", () => {
  it("set/get round-trips a cell marking", async () => {
    if (!dbUp) return;
    await svc.set({
      objectTypeApiName: OT,
      primaryKey: PK,
      propertyApiName: "salary",
      markings: ["SECRET"],
      setBy: "tester",
    });
    const cells = await svc.getForObject(OT, PK);
    expect(cells).toEqual({ salary: ["SECRET"] });
  });

  it("upsert overwrites the marking set (and tombstones to empty)", async () => {
    if (!dbUp) return;
    await svc.set({ objectTypeApiName: OT, primaryKey: PK, propertyApiName: "salary", markings: ["SECRET", "PII"] });
    expect((await svc.getForObject(OT, PK)).salary.sort()).toEqual(["PII", "SECRET"]);
    await svc.set({ objectTypeApiName: OT, primaryKey: PK, propertyApiName: "salary", markings: [] });
    expect((await svc.getForObject(OT, PK)).salary).toEqual([]);
    // restore for the redaction assertions below
    await svc.set({ objectTypeApiName: OT, primaryKey: PK, propertyApiName: "salary", markings: ["SECRET"] });
  });

  it("drives redaction: hidden for a caller without the marking, shown with it / bypass", async () => {
    if (!dbUp) return;
    const cells = await svc.getForObject(OT, PK);

    const without: Record<string, unknown> = { name: "Acme", salary: 100000 };
    expect(redactCells(without, cells, { userMarkings: ["PII"] })).toEqual(["salary"]);
    expect(without.salary).toBeNull();

    const withMark: Record<string, unknown> = { name: "Acme", salary: 100000 };
    expect(redactCells(withMark, cells, { userMarkings: ["SECRET"] })).toEqual([]);
    expect(withMark.salary).toBe(100000);

    const bypass: Record<string, unknown> = { name: "Acme", salary: 100000 };
    expect(redactCells(bypass, cells, { userMarkings: [], markingBypass: true })).toEqual([]);
    expect(bypass.salary).toBe(100000);
  });

  it("batch getForObjects returns a per-pk map", async () => {
    if (!dbUp) return;
    await svc.set({ objectTypeApiName: OT, primaryKey: PK2, propertyApiName: "ssn", markings: ["TOPSECRET"] });
    const map = await svc.getForObjects(OT, [PK, PK2]);
    expect(map[PK]?.salary).toEqual(["SECRET"]);
    expect(map[PK2]?.ssn).toEqual(["TOPSECRET"]);
  });
});
