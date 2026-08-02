// ---------------------------------------------------------------------------
// parameterValidation — authoritative backend validation unit tests.
//
// Every required semantic from the contract: false / 0 / "" are valid,
// missing required rejected, null never silently configured, numeric strings
// rejected as numbers, canonical date/timestamp formats, recursive list and
// struct paths, optional omission preserving JS defaults.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import {
  ParameterValidationError,
  resolvePositionalArguments,
  validateConstantValue,
  validateValue,
  type ParameterIssue,
} from "../../../src/services/functions/parameterValidation";
import {
  readCanonicalSignature,
  type PublishedParameter,
} from "../../../src/services/functions/canonicalSignature";

function param(
  name: string,
  typeText: string,
  opts: { optional?: boolean; hasDefault?: boolean } = {},
): PublishedParameter {
  const signature = readCanonicalSignature({
    parameters: [
      {
        name,
        type: typeText,
        optional: opts.optional ?? false,
        hasDefault: opts.hasDefault ?? false,
        position: 0,
      },
    ],
    output: "string",
  })!;
  return signature.parameters[0];
}

function run(type: PublishedParameter["type"], value: unknown): ParameterIssue[] {
  const issues: ParameterIssue[] = [];
  validateValue(type, value, "p", issues);
  return issues;
}

describe("validateValue — primitives", () => {
  it("accepts empty string, false and 0 as valid configured values", () => {
    expect(run({ kind: "string" }, "")).toEqual([]);
    expect(run({ kind: "boolean" }, false)).toEqual([]);
    expect(run({ kind: "integer" }, 0)).toEqual([]);
    expect(run({ kind: "double" }, 0)).toEqual([]);
  });

  it("rejects a numeric string for a numeric parameter (no silent coercion)", () => {
    const issues = run({ kind: "integer" }, "42");
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("FUNCTION_PARAMETER_TYPE");
  });

  it("rejects non-integer numbers for integer/long", () => {
    expect(run({ kind: "integer" }, 1.5)).toHaveLength(1);
    expect(run({ kind: "long" }, Number.MAX_SAFE_INTEGER + 1)).toHaveLength(1);
    expect(run({ kind: "long" }, 9007199254740990)).toEqual([]);
  });

  it("rejects NaN/Infinity for double", () => {
    expect(run({ kind: "double" }, Number.NaN)).toHaveLength(1);
    expect(run({ kind: "double" }, Number.POSITIVE_INFINITY)).toHaveLength(1);
  });

  it("rejects a boolean-parameter mismatch", () => {
    expect(run({ kind: "boolean" }, "true")).toHaveLength(1);
  });
});

describe("validateValue — date and timestamp canonical formats", () => {
  it("date accepts YYYY-MM-DD only", () => {
    expect(run({ kind: "date" }, "2026-08-02")).toEqual([]);
    expect(run({ kind: "date" }, "08/02/2026")).toHaveLength(1);
    expect(run({ kind: "date" }, "2026-13-99")).toHaveLength(1);
    expect(run({ kind: "date" }, "")).toHaveLength(1);
  });

  it("timestamp requires RFC 3339 with an explicit zone and normalizes to UTC", () => {
    const issues: ParameterIssue[] = [];
    const normalized = validateValue(
      { kind: "timestamp" },
      "2026-08-02T12:30:00+02:00",
      "p",
      issues,
    );
    expect(issues).toEqual([]);
    expect(normalized).toBe("2026-08-02T10:30:00.000Z");
    expect(run({ kind: "timestamp" }, "2026-08-02 10:00:00")).toHaveLength(1);
    expect(run({ kind: "timestamp" }, "2026-08-02")).toHaveLength(1);
  });
});

describe("validateValue — lists, structs, null", () => {
  it("validates list elements with indexed paths", () => {
    const issues: ParameterIssue[] = [];
    validateValue(
      { kind: "list", element: { kind: "integer" } },
      [1, "two", 3],
      "p",
      issues,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("p[1]");
  });

  it("validates nested structs with precise paths and rejects unknown fields", () => {
    const type = {
      kind: "struct" as const,
      fields: [
        { name: "id", type: { kind: "string" as const } },
        {
          name: "address",
          type: {
            kind: "struct" as const,
            fields: [{ name: "city", type: { kind: "string" as const } }],
          },
        },
      ],
    };
    const issues: ParameterIssue[] = [];
    validateValue(type, { id: "x", address: { city: 5 }, extra: true }, "p", issues);
    expect(issues.map((i) => i.path).sort()).toEqual(["p.address.city", "p.extra"]);
  });

  it("reports missing required struct fields", () => {
    const type = {
      kind: "struct" as const,
      fields: [{ name: "id", type: { kind: "string" as const } }],
    };
    const issues: ParameterIssue[] = [];
    validateValue(type, {}, "p", issues);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("FUNCTION_PARAMETER_MISSING");
    expect(issues[0].path).toBe("p.id");
  });

  it("null is rejected unless the published type explicitly permits it", () => {
    expect(run({ kind: "string" }, null)).toHaveLength(1);
    expect(
      run({ kind: "optional", value: { kind: "string" }, allowsNull: false }, null),
    ).toHaveLength(1);
    expect(run({ kind: "optional", value: { kind: "string" }, allowsNull: false }, null)[0].code).toBe("FUNCTION_PARAMETER_NULL");
    expect(
      run({ kind: "optional", value: { kind: "string" }, allowsNull: true }, null),
    ).toEqual([]);
  });

  it("unsupported declared types pass through without coercion", () => {
    const issues = run({ kind: "unsupported", typeText: "Mediaset" }, {
      arbitrary: true,
    });
    expect(issues).toEqual([]);
  });
});

describe("resolvePositionalArguments", () => {
  const signature = readCanonicalSignature({
    parameters: [
      { name: "first", type: "string", optional: false },
      { name: "second", type: "number", optional: true },
      { name: "third", type: "string", optional: true },
    ],
    output: "string",
  })!;

  it("resolves by published name in published order (object-key order irrelevant)", () => {
    const result = resolvePositionalArguments({
      parameters: signature.parameters,
      values: { third: "C", first: "A" },
      injectClient: () => ({}),
    });
    expect(result.args).toEqual(["A", undefined, "C"]);
  });

  it("throws on a missing required parameter", () => {
    expect(() =>
      resolvePositionalArguments({
        parameters: signature.parameters,
        values: {},
        injectClient: () => ({}),
      }),
    ).toThrow(ParameterValidationError);
  });

  it("optional omission yields undefined (JS default semantics)", () => {
    const result = resolvePositionalArguments({
      parameters: signature.parameters,
      values: { first: "hello" },
      injectClient: () => ({}),
    });
    expect(result.args).toEqual(["hello", undefined, undefined]);
  });

  it("false / 0 / \"\" are bound, not mistaken for missing", () => {
    const s = readCanonicalSignature({
      parameters: [
        { name: "flag", type: "boolean", optional: false },
        { name: "count", type: "number", optional: false },
        { name: "label", type: "string", optional: false },
      ],
      output: "string",
    })!;
    const result = resolvePositionalArguments({
      parameters: s.parameters,
      values: { flag: false, count: 0, label: "" },
      injectClient: () => ({}),
    });
    expect(result.args).toEqual([false, 0, ""]);
  });

  it("explicit undefined on a required parameter is missing", () => {
    const s = readCanonicalSignature({
      parameters: [{ name: "v", type: "string", optional: false }],
      output: "string",
    })!;
    expect(() =>
      resolvePositionalArguments({
        parameters: s.parameters,
        values: { v: undefined },
        injectClient: () => ({}),
      }),
    ).toThrow(ParameterValidationError);
  });

  it("injects the client for a parameter whose published type is Client", () => {
    const sentinel = { sentinel: true };
    const s = readCanonicalSignature({
      parameters: [
        { name: "client", type: "Client", optional: false },
        { name: "orderId", type: "string", optional: false },
      ],
      output: "string",
    })!;
    const result = resolvePositionalArguments({
      parameters: s.parameters,
      values: { orderId: "o-1" },
      injectClient: () => sentinel,
    });
    expect(result.args).toEqual([sentinel, "o-1"]);
  });

  it("collects multiple issues in one structured error", () => {
    const s = readCanonicalSignature({
      parameters: [
        { name: "a", type: "string", optional: false },
        { name: "b", type: "number", optional: false },
      ],
      output: "string",
    })!;
    try {
      resolvePositionalArguments({
        parameters: s.parameters,
        values: { b: "not-a-number" },
        injectClient: () => ({}),
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ParameterValidationError);
      const issues = (error as ParameterValidationError).issues;
      expect(issues.map((i) => i.code).sort()).toEqual([
        "FUNCTION_PARAMETER_MISSING",
        "FUNCTION_PARAMETER_TYPE",
      ]);
    }
  });
});

describe("validateConstantValue", () => {
  it("null on a required parameter reports missing", () => {
    const issues = validateConstantValue(param("name", "string"), null);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("FUNCTION_PARAMETER_MISSING");
  });

  it("null on an optional non-nullable parameter reports the null rule", () => {
    const issues = validateConstantValue(param("name", "string", { optional: true }), null);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("FUNCTION_PARAMETER_NULL");
  });

  it("undefined is valid for optional, missing for required", () => {
    expect(validateConstantValue(param("a", "string", { optional: true }), undefined)).toEqual([]);
    expect(validateConstantValue(param("a", "string"), undefined)).toHaveLength(1);
    expect(
      validateConstantValue(param("a", "string", { hasDefault: true, optional: true }), undefined),
    ).toEqual([]);
  });

  it("valid values pass", () => {
    expect(validateConstantValue(param("n", "number"), 0)).toEqual([]);
    expect(validateConstantValue(param("b", "boolean"), false)).toEqual([]);
    expect(validateConstantValue(param("s", "string"), "")).toEqual([]);
  });
});
