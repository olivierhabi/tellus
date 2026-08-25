import { describe, expect, it, vi } from "vitest";

import {
  validateParameters,
  type ParameterDefinition,
} from "../../../src/actions/parameterValidator";

const approver: ParameterDefinition = {
  apiName: "approver",
  displayName: "Approver",
  type: "string",
  required: true,
  visible: false,
  editable: false,
  defaultValueTypeClass: "currentUserId",
  constraints: { valueType: "user" },
};

describe("validateParameters — current-user constraints", () => {
  it("resolves a hidden required current-user parameter server-side", async () => {
    const userExists = vi.fn().mockResolvedValue(true);
    const result = await validateParameters(
      [approver],
      {},
      async () => true,
      undefined,
      { currentUserId: "user-123", userExists },
    );

    expect(result).toEqual({
      valid: true,
      errors: [],
      resolvedParameters: { approver: "user-123" },
    });
    expect(userExists).toHaveBeenCalledWith("user-123");
  });

  it("rejects spoofing a hidden current-user parameter", async () => {
    const result = await validateParameters(
      [approver],
      { approver: "somebody-else" },
      async () => true,
      undefined,
      { currentUserId: "user-123", userExists: async () => true },
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("bound to the authenticated current user");
  });

  it("rejects unknown and disabled user IDs", async () => {
    const editable = { ...approver, visible: true, editable: true };
    const result = await validateParameters(
      [editable],
      { approver: "deleted-user" },
      async () => true,
      undefined,
      { currentUserId: "user-123", userExists: async () => false },
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("unknown or disabled user");
  });

  it("fails closed when the identity directory cannot validate a user", async () => {
    const result = await validateParameters(
      [{ ...approver, defaultValueTypeClass: undefined, visible: true, editable: true }],
      { approver: "user-123" },
      async () => true,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("could not be validated");
  });
});
