// ---------------------------------------------------------------------------
// Inline-edit batch planning — unit tests (Pillar 3).
// Pure: no DB, no IO. Covers happy path, validation failures, same-object
// conflicts, and coalescing of multi-property edits on one object.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { planInlineEditBatch, type InlineEditRequest } from "../../../src/actions/inlineEditBatch";

function pkMap(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

describe("planInlineEditBatch", () => {
  // --- Happy path ---
  it("passes a single valid edit", () => {
    const plan = planInlineEditBatch(
      [{ propertyApiName: "status", primaryKey: "pk1", value: "Open", actionApiName: "modifyTicket" }],
      pkMap([["modifyTicket", "ticket"]]),
    );
    expect(plan.allValid).toBe(true);
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0].parameters).toEqual({ ticket: "pk1", status: "Open" });
    expect(plan.conflicts).toEqual([]);
  });

  it("passes multiple edits on different objects", () => {
    const plan = planInlineEditBatch(
      [
        { propertyApiName: "status", primaryKey: "pk1", value: "Open", actionApiName: "modifyTicket" },
        { propertyApiName: "priority", primaryKey: "pk2", value: "High", actionApiName: "modifyTicket" },
      ],
      pkMap([["modifyTicket", "ticket"]]),
    );
    expect(plan.allValid).toBe(true);
    expect(plan.edits).toHaveLength(2);
  });

  // --- Coalescing ---
  it("coalesces multi-property edits on the same object through the same action", () => {
    const plan = planInlineEditBatch(
      [
        { propertyApiName: "status", primaryKey: "pk1", value: "Open", actionApiName: "modifyTicket" },
        { propertyApiName: "priority", primaryKey: "pk1", value: "High", actionApiName: "modifyTicket" },
      ],
      pkMap([["modifyTicket", "ticket"]]),
    );
    expect(plan.allValid).toBe(true);
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0].parameters).toEqual({ ticket: "pk1", status: "Open", priority: "High" });
    expect(plan.edits[0].sourceIndices).toEqual([0, 1]);
  });

  it("coalesces three property edits on the same object into one action application", () => {
    const plan = planInlineEditBatch(
      [
        { propertyApiName: "status", primaryKey: "pk1", value: "Open", actionApiName: "modifyTicket" },
        { propertyApiName: "priority", primaryKey: "pk1", value: "High", actionApiName: "modifyTicket" },
        { propertyApiName: "assignee", primaryKey: "pk1", value: "Alice", actionApiName: "modifyTicket" },
      ],
      pkMap([["modifyTicket", "ticket"]]),
    );
    expect(plan.allValid).toBe(true);
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0].parameters).toEqual({
      ticket: "pk1",
      status: "Open",
      priority: "High",
      assignee: "Alice",
    });
  });

  it("does NOT coalesce edits on the same object through different actions", () => {
    const plan = planInlineEditBatch(
      [
        { propertyApiName: "status", primaryKey: "pk1", value: "Open", actionApiName: "modifyTicket" },
        { propertyApiName: "note", primaryKey: "pk1", value: "x", actionApiName: "modifyTicketNote" },
      ],
      pkMap([["modifyTicket", "ticket"], ["modifyTicketNote", "ticket"]]),
    );
    expect(plan.allValid).toBe(false);
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.conflicts[0]).toMatch(/different actions/);
  });

  // --- Same-object conflicts ---
  it("rejects conflicting values to the same property on the same object", () => {
    const plan = planInlineEditBatch(
      [
        { propertyApiName: "status", primaryKey: "pk1", value: "Open", actionApiName: "modifyTicket" },
        { propertyApiName: "status", primaryKey: "pk1", value: "Closed", actionApiName: "modifyTicket" },
      ],
      pkMap([["modifyTicket", "ticket"]]),
    );
    expect(plan.allValid).toBe(false);
    expect(plan.conflicts.some((c) => c.includes("conflicting values"))).toBe(true);
  });

  it("allows identical edits to the same property (idempotent)", () => {
    const plan = planInlineEditBatch(
      [
        { propertyApiName: "status", primaryKey: "pk1", value: "Open", actionApiName: "modifyTicket" },
        { propertyApiName: "status", primaryKey: "pk1", value: "Open", actionApiName: "modifyTicket" },
      ],
      pkMap([["modifyTicket", "ticket"]]),
    );
    expect(plan.allValid).toBe(true);
    expect(plan.edits).toHaveLength(1);
  });

  // --- Validation failures ---
  it("rejects a request missing propertyApiName", () => {
    const plan = planInlineEditBatch(
      [{ propertyApiName: "", primaryKey: "pk1", value: "Open", actionApiName: "modifyTicket" } as InlineEditRequest],
      pkMap([["modifyTicket", "ticket"]]),
    );
    expect(plan.allValid).toBe(false);
    expect(plan.results[0].error).toMatch(/propertyApiName/);
  });

  it("rejects a request missing primaryKey", () => {
    const plan = planInlineEditBatch(
      [{ propertyApiName: "status", primaryKey: "", value: "Open", actionApiName: "modifyTicket" } as InlineEditRequest],
      pkMap([["modifyTicket", "ticket"]]),
    );
    expect(plan.allValid).toBe(false);
    expect(plan.results[0].error).toMatch(/primaryKey/);
  });

  it("rejects a request with an unknown action (no PK param mapping)", () => {
    const plan = planInlineEditBatch(
      [{ propertyApiName: "status", primaryKey: "pk1", value: "Open", actionApiName: "unknownAction" }],
      pkMap([["modifyTicket", "ticket"]]),
    );
    expect(plan.allValid).toBe(false);
    expect(plan.results[0].error).toMatch(/No PK parameter/);
  });

  it("allows null values (clearing a property)", () => {
    const plan = planInlineEditBatch(
      [{ propertyApiName: "status", primaryKey: "pk1", value: null, actionApiName: "modifyTicket" }],
      pkMap([["modifyTicket", "ticket"]]),
    );
    expect(plan.allValid).toBe(true);
    expect(plan.edits[0].parameters).toEqual({ ticket: "pk1", status: null });
  });

  it("rejects undefined values (missing value)", () => {
    const plan = planInlineEditBatch(
      [{ propertyApiName: "status", primaryKey: "pk1", value: undefined, actionApiName: "modifyTicket" } as InlineEditRequest],
      pkMap([["modifyTicket", "ticket"]]),
    );
    expect(plan.allValid).toBe(false);
    expect(plan.results[0].error).toMatch(/value/);
  });

  it("returns empty edits and allValid=false if ANY request is invalid", () => {
    const plan = planInlineEditBatch(
      [
        { propertyApiName: "status", primaryKey: "pk1", value: "Open", actionApiName: "modifyTicket" },
        { propertyApiName: "", primaryKey: "pk2", value: "High", actionApiName: "modifyTicket" } as InlineEditRequest,
      ],
      pkMap([["modifyTicket", "ticket"]]),
    );
    expect(plan.allValid).toBe(false);
    expect(plan.edits).toEqual([]);
  });
});
