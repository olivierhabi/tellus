// Quiver — UUIDv7 RID utilities (G-01, B1 C-02).
//
// Each test is named with `T-XX C-YY: <observable behavior>` so a reader
// can trace test → task → contract.

import { describe, it, expect } from "vitest";
import {
  isQuiverRid,
  isUuidV7,
  newQuiverRid,
  parseQuiverRid,
} from "../../../src/services/quiver/rids";

describe("Quiver RIDs (G-01 / B1 C-02)", () => {
  it("G-01: newQuiverRid emits ri.tellus-quiver.main.<type>.<uuid7>", () => {
    const rid = newQuiverRid("analysis");
    expect(rid).toMatch(
      /^ri\.tellus-quiver\.main\.analysis\.[0-9a-f-]{36}$/u,
    );
  });

  it("G-01: emitted UUID is v7 (version nibble 7, variant bits 10)", () => {
    for (let i = 0; i < 100; i++) {
      const rid = newQuiverRid("analysis");
      const parsed = parseQuiverRid(rid);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe("analysis");
      expect(isUuidV7(parsed!.uuid)).toBe(true);
    }
  });

  it("G-01: rejects UUIDv4 — version nibble 4 is not v7", () => {
    const v4 =
      "ri.tellus-quiver.main.analysis.b3a3a4d2-4f8e-4f7a-9c12-1234567890ab";
    expect(isQuiverRid(v4)).toBe(false);
    expect(parseQuiverRid(v4)).toBeNull();
  });

  it("G-01: rejects bare uuid (missing ri prefix)", () => {
    expect(isQuiverRid("018f6c2d-7000-7abc-8def-1234567890ab")).toBe(false);
  });

  it("B1 C-02: type-narrowed isQuiverRid('rid', 'analysis') excludes other types", () => {
    const dashboardRid = newQuiverRid("dashboard");
    expect(isQuiverRid(dashboardRid, "analysis")).toBe(false);
    expect(isQuiverRid(dashboardRid, "dashboard")).toBe(true);
  });

  it("G-01: time-ordered — successive RIDs produce non-decreasing 48-bit prefixes", () => {
    const rids: string[] = [];
    for (let i = 0; i < 20; i++) rids.push(newQuiverRid("analysis"));
    const prefixes = rids.map((r) => parseQuiverRid(r)!.uuid.slice(0, 13));
    const sorted = [...prefixes].sort();
    expect(prefixes).toEqual(sorted);
  });
});
