/**
 * responseFormatter.rid.test.ts — P0-1 senior-review closure.
 *
 * Locks the canonical Foundry RID shape (`ri.ontology.main.<kind>.<id>`)
 * for object types and link types. Pre-fix, `formatObjectType` emitted
 * `ri.ontology.<ontologyUuid>.object-type.<id>` — inconsistent with every
 * other tellus service. These assertions prevent regression.
 */
import { describe, expect, it } from "vitest";

import {
  formatLinkTypeRid,
  formatObjectType,
  formatObjectTypeRid,
} from "../../../src/utils/responseFormatter";

describe("responseFormatter RID shape", () => {
  it("object-type RID uses ri.ontology.main.<kind>.<id> form", () => {
    const rid = formatObjectTypeRid("abc-123");
    expect(rid).toMatch(/^ri\.ontology\.main\.object-type\.[A-Za-z0-9_-]+$/);
    expect(rid).not.toMatch(/^ri\.ontology\.[0-9a-f-]{36}\./);
  });

  it("link-type RID uses ri.ontology.main.link-type.<id> form", () => {
    const rid = formatLinkTypeRid("abc-123");
    expect(rid).toMatch(/^ri\.ontology\.main\.link-type\.[A-Za-z0-9_-]+$/);
  });

  it("rejects empty id", () => {
    expect(() => formatObjectTypeRid("")).toThrow();
  });

  it("rejects whitespace id", () => {
    expect(() => formatObjectTypeRid("  ")).toThrow();
  });

  it("formatObjectType emits canonical RID, never the legacy ontology-UUID form", () => {
    const formatted = formatObjectType({
      object_type_id: "f80a55b0-4fde-4bfe-bfa8-87912e7e3c57",
      ontology_id: "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb",
      api_name: "GenaPatient",
      display_name: "Gena Patient",
    }) as { objectType: { rid: string | null } };
    expect(formatted.objectType.rid).toBe(
      "ri.ontology.main.object-type.f80a55b0-4fde-4bfe-bfa8-87912e7e3c57",
    );
    expect(formatted.objectType.rid).not.toMatch(/^ri\.ontology\.[0-9a-f-]{36}\./);
  });

  it("link-type RID rejects empty and whitespace ids", () => {
    expect(() => formatLinkTypeRid("")).toThrow();
    expect(() => formatLinkTypeRid("\t  \n")).toThrow();
  });
});
