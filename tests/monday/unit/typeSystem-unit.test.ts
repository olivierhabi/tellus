import { describe, it, expect } from "vitest";
import {
  TYPE_DEFINITIONS,
  VALID_BASE_TYPES,
  getOpenSearchMapping,
  validateValue,
  coerceFromString,
  isArrayType,
  getBaseTypeOfArray,
  runSelfTests,
} from "../../../src/utils/typeSystem";

describe("typeSystem — VALID_BASE_TYPES & TYPE_DEFINITIONS", () => {
  it("exposes exactly 23 base types", () => {
    expect(VALID_BASE_TYPES.length).toBe(23);
  });

  it("every type has opensearchMapping, validate, coerceFromString", () => {
    for (const name of VALID_BASE_TYPES) {
      const def = TYPE_DEFINITIONS[name];
      expect(def.opensearchMapping).toBeDefined();
      expect(typeof def.validate).toBe("function");
      expect(typeof def.coerceFromString).toBe("function");
    }
  });
});

describe("typeSystem — string", () => {
  const t = TYPE_DEFINITIONS.string;
  it("validate accepts null, undefined, string", () => {
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate(undefined).valid).toBe(true);
    expect(t.validate("hello").valid).toBe(true);
  });
  it("validate rejects non-string", () => {
    const r = t.validate(42);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/string/);
  });
  it("coerceFromString trims and returns null for empty", () => {
    expect(t.coerceFromString("  hi  ")).toBe("hi");
    expect(t.coerceFromString("   ")).toBeNull();
  });
});

describe("typeSystem — boolean", () => {
  const t = TYPE_DEFINITIONS.boolean;
  it("validate accepts null/undefined/boolean, rejects others", () => {
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate(undefined).valid).toBe(true);
    expect(t.validate(true).valid).toBe(true);
    expect(t.validate(false).valid).toBe(true);
    expect(t.validate("true").valid).toBe(false);
  });
  it("coerceFromString accepts true/1/yes (case-insensitive)", () => {
    expect(t.coerceFromString("TRUE")).toBe(true);
    expect(t.coerceFromString("1")).toBe(true);
    expect(t.coerceFromString("Yes")).toBe(true);
    expect(t.coerceFromString("false")).toBe(false);
    expect(t.coerceFromString("0")).toBe(false);
    expect(t.coerceFromString("NO")).toBe(false);
  });
  it("coerceFromString returns null for empty", () => {
    expect(t.coerceFromString("")).toBeNull();
  });
  it("coerceFromString throws for invalid", () => {
    expect(() => t.coerceFromString("maybe")).toThrow(/boolean/);
  });
});

describe("typeSystem — integer", () => {
  const t = TYPE_DEFINITIONS.integer;
  it("validate accepts null and integers in int32 range", () => {
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate(0).valid).toBe(true);
    expect(t.validate(2_147_483_647).valid).toBe(true);
    expect(t.validate(-2_147_483_648).valid).toBe(true);
  });
  it("validate rejects floats, strings, and out-of-range", () => {
    expect(t.validate(3.14).valid).toBe(false);
    expect(t.validate("7").valid).toBe(false);
    expect(t.validate(2_147_483_648).valid).toBe(false);
    expect(t.validate(-2_147_483_649).valid).toBe(false);
  });
  it("coerceFromString parses and ranges-checks", () => {
    expect(t.coerceFromString("42")).toBe(42);
    expect(t.coerceFromString(" -7 ")).toBe(-7);
    expect(t.coerceFromString("")).toBeNull();
    expect(() => t.coerceFromString("abc")).toThrow(/integer/);
    expect(() => t.coerceFromString("99999999999")).toThrow(/out of range/);
  });
});

describe("typeSystem — long", () => {
  const t = TYPE_DEFINITIONS.long;
  it("validate accepts integers, rejects non-integers", () => {
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate(12345).valid).toBe(true);
    expect(t.validate(1.5).valid).toBe(false);
    expect(t.validate("5").valid).toBe(false);
  });
  it("coerceFromString parses and warns on very large numbers", () => {
    expect(t.coerceFromString("1000")).toBe(1000);
    expect(t.coerceFromString("")).toBeNull();
    expect(() => t.coerceFromString("nope")).toThrow(/long/);
    // Long digit string triggers warn path
    expect(t.coerceFromString("1234567890123456")).toBe(1234567890123456);
  });
});

describe("typeSystem — double / float / decimal", () => {
  for (const typeName of ["double", "float", "decimal"] as const) {
    const t = TYPE_DEFINITIONS[typeName];
    it(`${typeName} validate accepts null + finite numbers, rejects others`, () => {
      expect(t.validate(null).valid).toBe(true);
      expect(t.validate(3.14).valid).toBe(true);
      expect(t.validate(Number.POSITIVE_INFINITY).valid).toBe(false);
      expect(t.validate("3.14").valid).toBe(false);
    });
    it(`${typeName} coerceFromString parses floats`, () => {
      expect(t.coerceFromString("3.14")).toBeCloseTo(3.14);
      expect(t.coerceFromString("")).toBeNull();
      expect(() => t.coerceFromString("abc")).toThrow();
    });
  }
});

describe("typeSystem — byte", () => {
  const t = TYPE_DEFINITIONS.byte;
  it("validate checks int8 range", () => {
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate(127).valid).toBe(true);
    expect(t.validate(-128).valid).toBe(true);
    expect(t.validate(128).valid).toBe(false);
    expect(t.validate(-129).valid).toBe(false);
    expect(t.validate(1.5).valid).toBe(false);
    expect(t.validate("5").valid).toBe(false);
  });
  it("coerceFromString ranges-checks", () => {
    expect(t.coerceFromString("10")).toBe(10);
    expect(t.coerceFromString("")).toBeNull();
    expect(() => t.coerceFromString("abc")).toThrow(/byte/);
    expect(() => t.coerceFromString("999")).toThrow(/out of range/);
  });
});

describe("typeSystem — short", () => {
  const t = TYPE_DEFINITIONS.short;
  it("validate checks int16 range", () => {
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate(32767).valid).toBe(true);
    expect(t.validate(-32768).valid).toBe(true);
    expect(t.validate(32768).valid).toBe(false);
    expect(t.validate(1.5).valid).toBe(false);
    expect(t.validate("5").valid).toBe(false);
  });
  it("coerceFromString ranges-checks", () => {
    expect(t.coerceFromString("1000")).toBe(1000);
    expect(t.coerceFromString("")).toBeNull();
    expect(() => t.coerceFromString("abc")).toThrow(/short/);
    expect(() => t.coerceFromString("99999")).toThrow(/out of range/);
  });
});

describe("typeSystem — date", () => {
  const t = TYPE_DEFINITIONS.date;
  it("validate accepts real YYYY-MM-DD, rejects invalid calendar dates", () => {
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate("2024-01-15").valid).toBe(true);
    expect(t.validate("2024-02-29").valid).toBe(true); // 2024 is a leap year
    expect(t.validate("2023-02-29").valid).toBe(false); // not a leap year
    expect(t.validate("2024-13-01").valid).toBe(false);
    expect(t.validate("2024-00-10").valid).toBe(false);
    expect(t.validate("2024-05-32").valid).toBe(false);
    expect(t.validate("2024-05-00").valid).toBe(false);
    expect(t.validate("not-a-date").valid).toBe(false);
    expect(t.validate(42).valid).toBe(false);
  });
  it("coerceFromString validates calendar date", () => {
    expect(t.coerceFromString("2024-01-15")).toBe("2024-01-15");
    expect(t.coerceFromString("")).toBeNull();
    expect(() => t.coerceFromString("2024-02-30")).toThrow(/calendar date/);
    expect(() => t.coerceFromString("2024/01/15")).toThrow(/calendar date/);
  });
});

describe("typeSystem — timestamp", () => {
  const t = TYPE_DEFINITIONS.timestamp;
  it("validate accepts valid Date strings", () => {
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate("2024-01-15T10:30:00Z").valid).toBe(true);
    expect(t.validate("not-a-ts").valid).toBe(false);
    expect(t.validate(5).valid).toBe(false);
  });
  it("coerceFromString returns ISO string", () => {
    const out = t.coerceFromString("2024-01-15T10:30:00Z");
    expect(typeof out).toBe("string");
    expect((out as string).startsWith("2024-01-15T10:30:00")).toBe(true);
    expect(t.coerceFromString("")).toBeNull();
    expect(() => t.coerceFromString("bogus")).toThrow(/timestamp/);
  });
});

describe("typeSystem — geopoint", () => {
  const t = TYPE_DEFINITIONS.geopoint;
  it("validate checks lat/lon and ranges", () => {
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate({ lat: 0, lon: 0 }).valid).toBe(true);
    expect(t.validate({ lat: 90, lon: 180 }).valid).toBe(true);
    expect(t.validate({ lat: -90, lon: -180 }).valid).toBe(true);
    expect(t.validate("hello").valid).toBe(false);
    expect(t.validate({ lat: "0", lon: 0 }).valid).toBe(false);
    expect(t.validate({ lat: 91, lon: 0 }).valid).toBe(false);
    expect(t.validate({ lat: 0, lon: 181 }).valid).toBe(false);
  });
  it("coerceFromString parses 'lat,lon' and validates ranges", () => {
    expect(t.coerceFromString("-1.94,29.87")).toEqual({ lat: -1.94, lon: 29.87 });
    expect(t.coerceFromString("")).toBeNull();
    expect(() => t.coerceFromString("bad")).toThrow(/lat,lon/);
    expect(() => t.coerceFromString("a,b")).toThrow(/non-numeric/);
    expect(() => t.coerceFromString("91,0")).toThrow(/lat/);
    expect(() => t.coerceFromString("0,181")).toThrow(/lon/);
  });
});

describe("typeSystem — geoshape", () => {
  const t = TYPE_DEFINITIONS.geoshape;
  it("validate requires GeoJSON with type", () => {
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate({ type: "Point", coordinates: [0, 0] }).valid).toBe(true);
    expect(t.validate({}).valid).toBe(false);
    expect(t.validate("not-an-object").valid).toBe(false);
  });
  it("coerceFromString parses JSON and checks type", () => {
    expect(t.coerceFromString('{"type":"Point","coordinates":[0,0]}'))
      .toEqual({ type: "Point", coordinates: [0, 0] });
    expect(t.coerceFromString("")).toBeNull();
    expect(() => t.coerceFromString("not-json")).toThrow(/invalid JSON/);
    expect(() => t.coerceFromString('{"x":1}')).toThrow(/'type'/);
  });
});

describe("typeSystem — struct", () => {
  const t = TYPE_DEFINITIONS.struct;
  const schema = [
    { fieldName: "name", fieldType: "string" },
    { fieldName: "age", fieldType: "integer" },
  ];
  it("validate accepts null/object, rejects non-object", () => {
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate({ name: "ann", age: 30 }).valid).toBe(true);
    expect(t.validate("hi").valid).toBe(false);
  });
  it("validate with schema checks nested field types", () => {
    expect(t.validate({ name: "ann", age: 30 }, schema).valid).toBe(true);
    expect(t.validate({ name: "ann", age: null }, schema).valid).toBe(true);
    expect(t.validate({ name: 5, age: 30 }, schema).valid).toBe(false);
    // unknown fieldType is tolerated (no validator lookup)
    expect(
      t.validate({ foo: 1 }, [{ fieldName: "foo", fieldType: "mystery" }]).valid,
    ).toBe(true);
  });
  it("coerceFromString parses JSON and applies schema validation", () => {
    expect(t.coerceFromString('{"name":"ann","age":30}', schema))
      .toEqual({ name: "ann", age: 30 });
    expect(t.coerceFromString("")).toBeNull();
    expect(() => t.coerceFromString("not-json")).toThrow(/invalid JSON/);
    expect(() => t.coerceFromString("null")).toThrow(/JSON object/);
    expect(() => t.coerceFromString('{"age":"abc"}', schema)).toThrow(/age/);
    // null fieldValue is skipped
    expect(t.coerceFromString('{"name":null}', schema)).toEqual({ name: null });
  });
});

describe("typeSystem — array types", () => {
  it("string_array validates and coerces pipe-delimited", () => {
    const t = TYPE_DEFINITIONS.string_array;
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate(["a", "b"]).valid).toBe(true);
    expect(t.validate("not-array").valid).toBe(false);
    expect(t.validate(["a", 1] as unknown[]).valid).toBe(false);
    expect(t.coerceFromString("a|b| c ")).toEqual(["a", "b", "c"]);
    expect(t.coerceFromString("")).toBeNull();
  });

  it("integer_array delegates to integer validator/coercer", () => {
    const t = TYPE_DEFINITIONS.integer_array;
    expect(t.validate([1, 2, 3]).valid).toBe(true);
    expect(t.validate([1, 1.5]).valid).toBe(false);
    expect(t.validate("x").valid).toBe(false);
    expect(t.coerceFromString("1|2|3")).toEqual([1, 2, 3]);
    expect(t.coerceFromString("")).toBeNull();
  });

  it("double_array delegates to double validator/coercer", () => {
    const t = TYPE_DEFINITIONS.double_array;
    expect(t.validate([1.1, 2.2]).valid).toBe(true);
    expect(t.validate([1.1, Number.POSITIVE_INFINITY]).valid).toBe(false);
    expect(t.validate("x").valid).toBe(false);
    expect(t.coerceFromString("1.5|2.5")).toEqual([1.5, 2.5]);
    expect(t.coerceFromString("")).toBeNull();
  });

  it("boolean_array delegates to boolean validator/coercer", () => {
    const t = TYPE_DEFINITIONS.boolean_array;
    expect(t.validate([true, false]).valid).toBe(true);
    expect(t.validate([true, "no"] as unknown[]).valid).toBe(false);
    expect(t.validate("x").valid).toBe(false);
    expect(t.coerceFromString("true|false|1")).toEqual([true, false, true]);
    expect(t.coerceFromString("")).toBeNull();
  });

  it("timestamp_array delegates to timestamp validator/coercer", () => {
    const t = TYPE_DEFINITIONS.timestamp_array;
    expect(t.validate(["2024-01-15T00:00:00Z"]).valid).toBe(true);
    expect(t.validate(["bogus"]).valid).toBe(false);
    expect(t.validate("x").valid).toBe(false);
    const out = t.coerceFromString("2024-01-15T00:00:00Z|2024-02-01T00:00:00Z");
    expect(Array.isArray(out)).toBe(true);
    expect(t.coerceFromString("")).toBeNull();
  });
});

describe("typeSystem — attachment / marking / media_reference / timeseries", () => {
  it("attachment validates and coerces as string", () => {
    const t = TYPE_DEFINITIONS.attachment;
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate("rid.foo").valid).toBe(true);
    expect(t.validate(5).valid).toBe(false);
    expect(t.coerceFromString("rid.foo")).toBe("rid.foo");
    expect(t.coerceFromString("")).toBeNull();
  });
  it("marking uppercases on coerce", () => {
    const t = TYPE_DEFINITIONS.marking;
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate("secret").valid).toBe(true);
    expect(t.validate(1).valid).toBe(false);
    expect(t.coerceFromString(" secret ")).toBe("SECRET");
    expect(t.coerceFromString("")).toBeNull();
  });
  it("media_reference validates object, coerces JSON", () => {
    const t = TYPE_DEFINITIONS.media_reference;
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate({ mediaRid: "m.1" }).valid).toBe(true);
    expect(t.validate("nope").valid).toBe(false);
    expect(t.coerceFromString('{"mediaRid":"m.1"}')).toEqual({ mediaRid: "m.1" });
    expect(t.coerceFromString("")).toBeNull();
    expect(() => t.coerceFromString("not-json")).toThrow(/invalid JSON/);
  });
  it("timeseries validates and coerces as string", () => {
    const t = TYPE_DEFINITIONS.timeseries;
    expect(t.validate(null).valid).toBe(true);
    expect(t.validate("ts.ref").valid).toBe(true);
    expect(t.validate(5).valid).toBe(false);
    expect(t.coerceFromString(" ts.ref ")).toBe("ts.ref");
    expect(t.coerceFromString("")).toBeNull();
  });
});

describe("typeSystem — top-level helpers", () => {
  it("getOpenSearchMapping returns a shallow clone for simple types", () => {
    const m = getOpenSearchMapping("boolean");
    expect(m).toEqual({ type: "boolean" });
    // mutation of the returned object shouldn't affect the definition
    (m as { extra?: boolean }).extra = true;
    expect(TYPE_DEFINITIONS.boolean.opensearchMapping).not.toHaveProperty("extra");
  });

  it("getOpenSearchMapping expands struct schema", () => {
    const m = getOpenSearchMapping("struct", [
      { fieldName: "name", fieldType: "string" },
      { fieldName: "age", fieldType: "integer" },
    ]);
    expect(m.type).toBe("object");
    const props = (m as { properties: Record<string, unknown> }).properties;
    expect(props.name).toBeDefined();
    expect(props.age).toEqual({ type: "integer" });
  });

  it("getOpenSearchMapping with empty struct schema falls through to default", () => {
    const m = getOpenSearchMapping("struct", []);
    expect(m).toEqual({ type: "object", properties: {} });
  });

  it("getOpenSearchMapping throws for unknown type", () => {
    expect(() => getOpenSearchMapping("mystery")).toThrow(/Unknown base type/);
  });

  it("validateValue delegates and reports unknown type", () => {
    expect(validateValue("string", "x").valid).toBe(true);
    const r = validateValue("mystery", "x");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Unknown base type/);
  });

  it("coerceFromString delegates and throws for unknown type", () => {
    expect(coerceFromString("integer", "5")).toBe(5);
    expect(() => coerceFromString("mystery", "x")).toThrow(/Unknown base type/);
  });

  it("isArrayType", () => {
    expect(isArrayType("string_array")).toBe(true);
    expect(isArrayType("integer_array")).toBe(true);
    expect(isArrayType("string")).toBe(false);
  });

  it("getBaseTypeOfArray", () => {
    expect(getBaseTypeOfArray("string_array")).toBe("string");
    expect(getBaseTypeOfArray("double_array")).toBe("double");
    expect(() => getBaseTypeOfArray("string")).toThrow(/not an array/);
  });
});

describe("typeSystem — runSelfTests", () => {
  it("runs without throwing and logs results", () => {
    const origLog = console.log;
    const origErr = console.error;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      runSelfTests();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    expect(logs.some((l) => /passed/.test(l))).toBe(true);
  });
});
