import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "../../../src/actions/parameterValidator";

describe("interface-reference action parameters", () => {
  it("preserves an implementing object-type selection for interface creation", async () => {
    const result = await validateParameters(
      [
        {
          apiName: "implementation",
          type: "object_type_reference",
          interfaceId: "Asset",
          required: true,
        },
      ],
      { implementation: "Vehicle" },
      async () => true,
    );
    expect(result.valid).toBe(true);
    expect(result.resolvedParameters?.implementation).toBe("Vehicle");
  });

  it("preserves concrete implementation identity", async () => {
    const exists = vi.fn().mockResolvedValue(true);
    const result = await validateParameters(
      [
        {
          apiName: "ticket",
          displayName: "Ticket",
          type: "interface_reference",
          interfaceId: "Ticket",
          required: true,
        },
      ],
      { ticket: { objectType: "Bug", primaryKey: "BUG-1" } },
      exists,
    );
    expect(result).toEqual({
      valid: true,
      errors: [],
      resolvedParameters: {
        ticket: { objectType: "Bug", primaryKey: "BUG-1" },
      },
    });
    expect(exists).toHaveBeenCalledWith("Bug", "BUG-1");
  });

  it("validates every reference in a list", async () => {
    const exists = vi.fn().mockResolvedValue(true);
    const result = await validateParameters(
      [
        {
          apiName: "tickets",
          displayName: "Tickets",
          type: "interface_reference_array",
          interfaceId: "Ticket",
          required: true,
        },
      ],
      {
        tickets: [
          { objectType: "Bug", primaryKey: "BUG-1" },
          { objectType: "FeatureRequest", primaryKey: "FR-1" },
        ],
      },
      exists,
    );
    expect(result.valid).toBe(true);
    expect(exists).toHaveBeenCalledTimes(2);
  });

  it("rejects untyped interface references", async () => {
    const result = await validateParameters(
      [
        {
          apiName: "ticket",
          displayName: "Ticket",
          type: "interface_reference",
          interfaceId: "Ticket",
          required: true,
        },
      ],
      { ticket: "BUG-1" },
      vi.fn(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain(
      "must be an interface reference object",
    );
  });
});
