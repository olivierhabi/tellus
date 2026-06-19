// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §8 — cell-level marking redaction (unit, no DB).
//
// redactCells is the security-critical predicate: a caller sees a cell iff they
// hold a SUPERSET of the cell's markings. Get the direction wrong and you leak.
// These exhaustively pin the behaviour (bypass, superset, subset, tombstone,
// already-stripped, custom sentinel).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { redactCells } from "../../../src/services/security/cellMarkingService";

describe("redactCells", () => {
  it("redacts a cell the caller does not fully satisfy (to null)", () => {
    const props: Record<string, unknown> = { name: "Acme", salary: 100000 };
    const redacted = redactCells(props, { salary: ["SECRET"] }, { userMarkings: ["PII"] });
    expect(redacted).toEqual(["salary"]);
    expect(props.salary).toBeNull();
    expect(props.name).toBe("Acme"); // untouched
  });

  it("keeps a cell when the caller holds a superset of its markings", () => {
    const props: Record<string, unknown> = { salary: 100000 };
    const redacted = redactCells(props, { salary: ["SECRET"] }, {
      userMarkings: ["SECRET", "PII"],
    });
    expect(redacted).toEqual([]);
    expect(props.salary).toBe(100000);
  });

  it("requires ALL markings of a multi-marking cell (subset is insufficient)", () => {
    const props: Record<string, unknown> = { ssn: "123" };
    const redacted = redactCells(props, { ssn: ["SECRET", "FVEY"] }, {
      userMarkings: ["SECRET"], // missing FVEY
    });
    expect(redacted).toEqual(["ssn"]);
    expect(props.ssn).toBeNull();
  });

  it("treats an empty marking set as a visible tombstone", () => {
    const props: Record<string, unknown> = { note: "ok" };
    const redacted = redactCells(props, { note: [] }, { userMarkings: [] });
    expect(redacted).toEqual([]);
    expect(props.note).toBe("ok");
  });

  it("redacts nothing for a markingBypass principal", () => {
    const props: Record<string, unknown> = { salary: 100000, ssn: "123" };
    const redacted = redactCells(props, { salary: ["SECRET"], ssn: ["SECRET"] }, {
      userMarkings: [],
      markingBypass: true,
    });
    expect(redacted).toEqual([]);
    expect(props.salary).toBe(100000);
    expect(props.ssn).toBe("123");
  });

  it("skips a property that is absent (already stripped at column level)", () => {
    const props: Record<string, unknown> = { name: "Acme" }; // salary already removed
    const redacted = redactCells(props, { salary: ["SECRET"] }, { userMarkings: [] });
    expect(redacted).toEqual([]);
    expect("salary" in props).toBe(false);
  });

  it("honours a custom redaction sentinel", () => {
    const props: Record<string, unknown> = { salary: 100000 };
    const redacted = redactCells(props, { salary: ["SECRET"] }, {
      userMarkings: [],
      redactWith: "•••",
    });
    expect(redacted).toEqual(["salary"]);
    expect(props.salary).toBe("•••");
  });
});
