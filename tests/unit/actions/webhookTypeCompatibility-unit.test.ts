import { describe, expect, it } from "vitest";
import {
  isActionParameterCompatibleWithWebhook,
  isStaticWebhookValueCompatible,
} from "../../../src/actions/webhookTypeCompatibility";

describe("webhook type compatibility", () => {
  it("uses safe numeric widening and preserves date/timestamp distinctions", () => {
    expect(
      isActionParameterCompatibleWithWebhook(
        { apiName: "count", type: "integer" },
        { kind: "long" },
      ),
    ).toBe(true);
    expect(
      isActionParameterCompatibleWithWebhook(
        { apiName: "amount", type: "double" },
        { kind: "integer" },
      ),
    ).toBe(false);
    expect(
      isActionParameterCompatibleWithWebhook(
        { apiName: "date", type: "date" },
        { kind: "timestamp" },
      ),
    ).toBe(false);
  });

  it("validates nested record, list, enum, and nullability contracts", () => {
    const type = {
      kind: "record" as const,
      fields: [
        {
          id: "status",
          required: true,
          type: {
            kind: "string" as const,
            allowedValues: ["OPEN", "CLOSED"],
          },
        },
        {
          id: "scores",
          required: true,
          type: {
            kind: "list" as const,
            elementType: { kind: "double" as const },
          },
        },
        {
          id: "note",
          required: false,
          type: { kind: "string" as const },
        },
      ],
    };
    expect(
      isStaticWebhookValueCompatible(
        { status: "OPEN", scores: [1, 2.5], note: null },
        type,
        false,
      ),
    ).toBe(true);
    expect(
      isStaticWebhookValueCompatible(
        { status: "UNKNOWN", scores: [1] },
        type,
        false,
      ),
    ).toBe(false);
    expect(isStaticWebhookValueCompatible(null, type, false)).toBe(false);
    expect(isStaticWebhookValueCompatible(null, type, true)).toBe(true);
  });

  it("rejects untyped legacy structs for typed records", () => {
    expect(
      isActionParameterCompatibleWithWebhook(
        { apiName: "payload", type: "struct" },
        { kind: "record", fields: [] },
      ),
    ).toBe(false);
  });
});
