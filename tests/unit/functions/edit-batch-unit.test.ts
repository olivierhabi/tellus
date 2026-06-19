// ---------------------------------------------------------------------------
// createEditBatch — Foundry TypeScript Functions v2 Ontology-edits API.
// Verifies the batch operations, the object/PK/interface ref forms, and the
// edit-collapsing semantics described at
// https://www.palantir.com/docs/foundry/functions/typescript-v2-ontology-edits
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { createEditBatchImpl } from "../../../src/services/functions/ontologyRuntime";

describe("createEditBatch — operations & ref forms", () => {
  it("create by type string and by descriptor; $primaryKey honoured", () => {
    const b = createEditBatchImpl();
    b.create("Ticket", { $primaryKey: 12, title: "A" });
    b.create({ apiName: "Ticket" }, { $primaryKey: 13, title: "B" });
    const e = b.getEdits();
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ op: "create", objectType: "Ticket", primaryKey: "12", properties: { title: "A" } });
    expect(e[1]).toMatchObject({ op: "create", objectType: "Ticket", primaryKey: "13" });
  });

  it("interface create records the underlying object type via $objectType", () => {
    const b = createEditBatchImpl();
    b.create("Person", { $objectType: "Employee", $primaryKey: 1, firstName: "John" });
    const e = b.getEdits();
    expect(e[0]).toMatchObject({ op: "create", objectType: "Employee", interfaceType: "Person", properties: { firstName: "John" } });
  });

  it("update by object instance and by { $apiName, $primaryKey }", () => {
    const b = createEditBatchImpl();
    b.update({ $apiName: "Employee", $primaryKey: 23 } as never, { lastName: "Smith" });
    b.update({ $apiName: "Person", $primaryKey: 9, firstName: "x" } as never, { firstName: "Y" });
    const e = b.getEdits();
    expect(e[0]).toMatchObject({ op: "update", objectType: "Employee", primaryKey: "23", patch: { lastName: "Smith" } });
    expect(e[1]).toMatchObject({ op: "update", objectType: "Person", primaryKey: "9", patch: { firstName: "Y" } });
  });

  it("update(obj1, obj2) copies the source object's declared properties (copy-all)", () => {
    const b = createEditBatchImpl();
    const src = { $apiName: "Employee", $primaryKey: 2, firstName: "A", lastName: "B" } as never;
    b.update({ $apiName: "Employee", $primaryKey: 1 } as never, src);
    expect(b.getEdits()[0]).toMatchObject({ op: "update", objectType: "Employee", primaryKey: "1", patch: { firstName: "A", lastName: "B" } });
  });

  it("delete by instance or by primary key", () => {
    const b = createEditBatchImpl();
    b.delete({ $apiName: "Ticket", $primaryKey: 12 } as never);
    expect(b.getEdits()[0]).toMatchObject({ op: "delete", objectType: "Ticket", primaryKey: "12" });
  });

  it("link / unlink over a link name", () => {
    const b = createEditBatchImpl();
    b.link({ $apiName: "Employee", $primaryKey: 23 } as never, "assignedTickets", { $apiName: "Ticket", $primaryKey: 12 } as never);
    const e = b.getEdits();
    expect(e[0]).toMatchObject({ op: "link", linkType: "assignedTickets", sourcePrimaryKey: "23", targetPrimaryKey: "12" });
  });

  it("invalid references throw", () => {
    const b = createEditBatchImpl();
    expect(() => b.update({} as never, { x: 1 })).toThrow();
    expect(() => b.create(123 as never, {})).toThrow();
  });
});

describe("createEditBatch — edit collapsing (minimal set)", () => {
  it("create then update collapse into a single create with merged props", () => {
    const b = createEditBatchImpl();
    b.create("Ticket", { $primaryKey: 1, title: "A", status: "open" });
    b.update({ $apiName: "Ticket", $primaryKey: 1 } as never, { status: "closed" });
    const e = b.getEdits();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ op: "create", objectType: "Ticket", primaryKey: "1", properties: { title: "A", status: "closed" } });
  });

  it("create then delete cancel out (no edit)", () => {
    const b = createEditBatchImpl();
    b.create("Ticket", { $primaryKey: 1 });
    b.delete({ $apiName: "Ticket", $primaryKey: 1 } as never);
    expect(b.getEdits()).toHaveLength(0);
  });

  it("two updates merge into one", () => {
    const b = createEditBatchImpl();
    b.update({ $apiName: "Ticket", $primaryKey: 1 } as never, { a: 1 });
    b.update({ $apiName: "Ticket", $primaryKey: 1 } as never, { b: 2 });
    const e = b.getEdits();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ op: "update", patch: { a: 1, b: 2 } });
  });

  it("link then unlink (same triple) collapses to the last (unlink)", () => {
    const b = createEditBatchImpl();
    const s = { $apiName: "Employee", $primaryKey: 1 } as never;
    const t = { $apiName: "Ticket", $primaryKey: 2 } as never;
    b.link(s, "tickets", t);
    b.unlink(s, "tickets", t);
    const e = b.getEdits();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ op: "unlink" });
  });
});
