// ---------------------------------------------------------------------------
// B3 unit tests — type mapping table (criterion 6, type-mapper fuzz baseline).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  mapOidToTellus,
} from "../../../src/services/connectivity/connectors/postgresql/type-mapping";

const SCALAR_CASES: Array<{ oid: number; name: string }> = [
  { oid: 16, name: "boolean" },
  { oid: 20, name: "int64" },
  { oid: 21, name: "int16" },
  { oid: 23, name: "int32" },
  { oid: 25, name: "string" },
  { oid: 17, name: "binary" },
  { oid: 700, name: "float32" },
  { oid: 701, name: "float64" },
  { oid: 1042, name: "string" },
  { oid: 1043, name: "string" },
  { oid: 1082, name: "date" },
  { oid: 1083, name: "time" },
  { oid: 1114, name: "timestamp" },
  { oid: 1184, name: "timestamp_tz" },
  { oid: 1186, name: "interval" },
  { oid: 2950, name: "uuid" },
  { oid: 114, name: "json" },
  { oid: 3802, name: "json" },
  { oid: 142, name: "xml" },
  { oid: 3910, name: "tstzrange" },
];

const ARRAY_CASES: Array<{ oid: number; elementName: string }> = [
  { oid: 1000, elementName: "boolean" },
  { oid: 1005, elementName: "int16" },
  { oid: 1007, elementName: "int32" },
  { oid: 1016, elementName: "int64" },
  { oid: 1009, elementName: "string" },
  { oid: 1015, elementName: "string" },
  { oid: 1021, elementName: "float32" },
  { oid: 1022, elementName: "float64" },
  { oid: 1182, elementName: "date" },
  { oid: 1183, elementName: "time" },
  { oid: 1115, elementName: "timestamp" },
  { oid: 1185, elementName: "timestamp_tz" },
  { oid: 1187, elementName: "interval" },
  { oid: 2951, elementName: "uuid" },
  { oid: 199, elementName: "json" },
  { oid: 3807, elementName: "json" },
  { oid: 143, elementName: "xml" },
  { oid: 3911, elementName: "tstzrange" },
  { oid: 1001, elementName: "binary" },
];

describe("PG OID -> Tellus type mapping", () => {
  for (const c of SCALAR_CASES) {
    it(`scalar OID ${c.oid} -> ${c.name}`, () => {
      const t = mapOidToTellus(c.oid);
      expect(t.name).toBe(c.name);
      expect(t.warn).toBeUndefined();
    });
  }

  for (const c of ARRAY_CASES) {
    it(`array OID ${c.oid} -> array<${c.elementName}>`, () => {
      const t = mapOidToTellus(c.oid);
      expect(t.name).toBe("array");
      expect(t.element?.name).toBe(c.elementName);
    });
  }

  it("numeric with typmod decodes precision/scale", () => {
    // typmod for numeric(10, 2) is ((10 << 16) | 2) + 4 = 655366.
    const typmod = ((10 << 16) | 2) + 4;
    const t = mapOidToTellus(1700, typmod);
    expect(t.name).toBe("decimal");
    expect(t.precision).toBe(10);
    expect(t.scale).toBe(2);
  });

  it("numeric without typmod defaults to (38, 9)", () => {
    const t = mapOidToTellus(1700, -1);
    expect(t).toMatchObject({ name: "decimal", precision: 38, scale: 9 });
  });

  it("numeric precision cap at 38", () => {
    const typmod = ((100 << 16) | 0) + 4;
    const t = mapOidToTellus(1700, typmod);
    expect(t.precision).toBe(38);
  });

  it("unknown OID falls back to string with WARN tag", () => {
    const t = mapOidToTellus(999_999);
    expect(t.name).toBe("string");
    expect(t.warn).toMatch(/unknown PG OID/);
  });
});
