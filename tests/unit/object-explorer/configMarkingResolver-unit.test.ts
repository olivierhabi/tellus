// ---------------------------------------------------------------------------
// T-08 — configMarkingResolver unit tests.
//
// Covers contracts:
//   C-110 collectConfigRefs walks {objectType, apiName, from} top-level
//          and array forms, plus nested {field, property} keys scoped
//          to the most-recent objectType seen.
//   C-111 resolveRequiredMarkings unions object_type.marking_required
//          and property.marking_required across all collected refs.
//   C-112 unknown api_names are silently dropped (over-collection
//          tolerance) and do NOT surface as missing-table errors.
//   C-113 empty / null / non-object configs return [] without I/O.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

// `vi.mock` is hoisted above any top-level `const`. Use `vi.hoisted` so
// the mock fn is available to the hoisted factory without a TDZ error.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../src/db", () => ({
  default: { query: queryMock },
  query: (sql: string, args: unknown[]) => queryMock(sql, args),
}));

import {
  collectConfigRefs,
  resolveRequiredMarkings,
} from "../../../src/services/explorations/configMarkingResolver";

describe("T-08 collectConfigRefs (C-110)", () => {
  it("T-08 C-110a: top-level objectType collected", () => {
    const refs = collectConfigRefs({ objectType: "Trip" });
    expect([...refs.objectTypes]).toEqual(["Trip"]);
    expect(refs.propertiesByOt.size).toBe(0);
  });

  it("T-08 C-110b: nested {field} under objectType is scoped to that OT", () => {
    const refs = collectConfigRefs({
      objectType: "Trip",
      filter: { field: "ssn", op: "eq", value: "x" },
    });
    expect([...refs.objectTypes]).toEqual(["Trip"]);
    expect([...(refs.propertiesByOt.get("Trip") ?? [])]).toEqual(["ssn"]);
  });

  it("T-08 C-110c: array of objectTypes collected", () => {
    const refs = collectConfigRefs({ from: ["Trip", "Driver"] });
    expect(new Set(refs.objectTypes)).toEqual(new Set(["Trip", "Driver"]));
  });

  it("T-08 C-110d: deeply-nested filter trees collect every named field", () => {
    const refs = collectConfigRefs({
      objectType: "Trip",
      where: {
        and: [
          { field: "status", eq: "active" },
          { or: [{ field: "fare_dollars", gt: 100 }] },
        ],
      },
    });
    const props = refs.propertiesByOt.get("Trip");
    expect(props).toBeDefined();
    expect(new Set(props!)).toEqual(new Set(["status", "fare_dollars"]));
  });

  it("T-08 C-110e: non-string under conventional key is silently ignored", () => {
    const refs = collectConfigRefs({ objectType: 42, field: 99 });
    expect(refs.objectTypes.size).toBe(0);
    expect(refs.propertiesByOt.size).toBe(0);
  });
});

describe("T-08 resolveRequiredMarkings (C-111..C-113)", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("T-08 C-113a: null config → [] with no DB I/O", async () => {
    const out = await resolveRequiredMarkings(null);
    expect(out).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("T-08 C-113b: empty object → [] with no DB I/O", async () => {
    const out = await resolveRequiredMarkings({});
    expect(out).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("T-08 C-111a: union of object-type markings + property markings is sorted and deduped", async () => {
    queryMock.mockImplementation(async (sql: string, args: any[]) => {
      if (/FROM object_type/.test(sql)) {
        return {
          rows: [
            {
              api_name: "Trip",
              object_type_id: "ot-trip",
              marking_required: ["TS"],
            },
            {
              api_name: "Driver",
              object_type_id: "ot-driver",
              marking_required: ["SECRET"],
            },
          ],
        };
      }
      if (/FROM property/.test(sql)) {
        // Args: [object_type_id, [property_names]]
        if (args[0] === "ot-trip") {
          return { rows: [{ marking_required: ["SECRET"] }] };
        }
        if (args[0] === "ot-driver") {
          return { rows: [{ marking_required: ["NOFORN"] }] };
        }
      }
      return { rows: [] };
    });
    const out = await resolveRequiredMarkings({
      objectType: "Trip",
      where: { field: "ssn" },
      from: ["Driver"],
      filter2: { objectType: "Driver", field: "license" },
    });
    // Sorted, deduped union: TS, SECRET (from both Trip and Trip.ssn),
    // NOFORN (from Driver.license).
    expect(out).toEqual(["NOFORN", "SECRET", "TS"]);
  });

  it("T-08 C-112: unknown object-type api_name is silently dropped", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM object_type/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const out = await resolveRequiredMarkings({
      objectType: "DefinitelyNotAType",
      where: { field: "anything" },
    });
    expect(out).toEqual([]);
    // The property-pass query MUST NOT be issued because the otIdByName
    // lookup is empty — over-collected names die at the pre-property
    // gate.
    const propQueries = queryMock.mock.calls.filter((c: any[]) =>
      /FROM property/.test(c[0]),
    );
    expect(propQueries.length).toBe(0);
  });

  it("T-08 C-111b: marking_required = null on row is treated as no markings", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM object_type/.test(sql)) {
        return {
          rows: [
            { api_name: "Trip", object_type_id: "ot-trip", marking_required: null },
          ],
        };
      }
      if (/FROM property/.test(sql)) {
        return { rows: [{ marking_required: null }] };
      }
      return { rows: [] };
    });
    const out = await resolveRequiredMarkings({
      objectType: "Trip",
      where: { field: "x" },
    });
    expect(out).toEqual([]);
  });
});
