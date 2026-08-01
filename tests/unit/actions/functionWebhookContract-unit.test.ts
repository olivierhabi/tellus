import { describe, expect, it } from "vitest";
import {
  parsePublishedFunctionType,
  validateFunctionWebhookContract,
} from "../../../src/actions/functionWebhookContract";

const webhookInputs = [
  { id: "name", required: true, type: { kind: "string" as const } },
  { id: "attempts", required: true, type: { kind: "long" as const } },
  {
    id: "metadata",
    required: true,
    type: {
      kind: "record" as const,
      fields: [
        { id: "enabled", required: true, type: { kind: "boolean" as const } },
      ],
    },
  },
];

describe("published Function webhook contracts", () => {
  it("parses lists, nested records, optional fields, and constrained strings", () => {
    const parsed = parsePublishedFunctionType(
      "Array<{ name: 'alpha' | 'beta'; attempts: Integer; metadata: { enabled: boolean; note?: string } }>",
    );
    expect(parsed?.type.kind).toBe("list");
    if (parsed?.type.kind !== "list" || parsed.type.elementType.kind !== "record") {
      throw new Error("expected a list of records");
    }
    expect(parsed.type.elementType.fields.map((field) => field.id)).toEqual([
      "name",
      "attempts",
      "metadata",
    ]);
  });

  it("accepts structurally compatible single payloads with safe numeric widening", () => {
    const result = validateFunctionWebhookContract(
      {
        parameters: [],
        output:
          "{ name: string; attempts: Integer; metadata: { enabled: boolean } }",
      },
      webhookInputs,
      "single",
    );
    expect(result).toEqual({ compatible: true, errors: [], repeated: false });
  });

  it("rejects optional required fields and list payloads for writeback", () => {
    const result = validateFunctionWebhookContract(
      {
        parameters: [],
        output:
          "Array<{ name?: string; attempts: Double; metadata: { enabled: boolean } }>",
      },
      webhookInputs,
      "single",
    );
    expect(result.compatible).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("cannot use a list-returning Function"),
        expect.stringContaining("'name' is optional"),
        expect.stringContaining("'attempts' is incompatible"),
      ]),
    );
  });

  it("accepts a list of compatible records for repeated side effects", () => {
    const result = validateFunctionWebhookContract(
      {
        parameters: [],
        output:
          "ReadonlyArray<{ name: string; attempts: Long; metadata: { enabled: boolean } }>",
      },
      webhookInputs,
      "list",
    );
    expect(result.compatible).toBe(true);
    expect(result.repeated).toBe(true);
  });
});
