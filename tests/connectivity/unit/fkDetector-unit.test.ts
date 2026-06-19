/**
 * B10 — FK detector unit tests.
 */
import { describe, it, expect } from "vitest";
import { deriveLinkTypes } from "../../../src/services/ontology-bindings/fk-detector";

describe("deriveLinkTypes", () => {
  const lookup = (table: string) => {
    if (table === "orders") return { object_type_rid: "ri.ontology.main.objecttype.order", pk_property: "id" };
    if (table === "customers") return { object_type_rid: "ri.ontology.main.objecttype.customer", pk_property: "id" };
    return null;
  };

  it("derives N:1 for non-unique FK", () => {
    const links = deriveLinkTypes([{
      source_table: "orders", source_columns: ["customer_id"], source_columns_unique: false,
      target_table: "customers", target_columns: ["id"],
    }], lookup);
    expect(links).toHaveLength(1);
    expect(links[0].cardinality).toBe("N:1");
    expect(links[0].source_property).toBe("customer_id");
    expect(links[0].target_property).toBe("id");
    expect(links[0].derived_from_fk).toBe(true);
  });

  it("derives 1:1 for unique FK", () => {
    const links = deriveLinkTypes([{
      source_table: "orders", source_columns: ["customer_id"], source_columns_unique: true,
      target_table: "customers", target_columns: ["id"],
    }], lookup);
    expect(links[0].cardinality).toBe("1:1");
  });

  it("skips FK referencing unbound tables", () => {
    const links = deriveLinkTypes([{
      source_table: "orders", source_columns: ["foo"], source_columns_unique: false,
      target_table: "unknown", target_columns: ["bar"],
    }], lookup);
    expect(links).toHaveLength(0);
  });

  it("skips composite FKs (current implementation)", () => {
    const links = deriveLinkTypes([{
      source_table: "orders", source_columns: ["a", "b"], source_columns_unique: false,
      target_table: "customers", target_columns: ["x", "y"],
    }], lookup);
    expect(links).toHaveLength(0);
  });
});
