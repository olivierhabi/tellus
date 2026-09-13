import { describe, expect, it, vi } from "vitest";

import { resolveFunctionInputs } from "../../../src/actions/functionInputResolver";

describe("resolveFunctionInputs", () => {
  it("resolves parameter, static, timestamp, current-user, and object-property mappings", async () => {
    const objectFetcher = vi.fn().mockResolvedValue({
      givenName: "Alice",
      profile: { score: 91 },
    });
    const now = vi.fn(() => new Date("2026-09-13T00:00:00.000Z"));

    const result = await resolveFunctionInputs({
      inputs: {
        copiedPriority: { source: "parameter", param: "priority" },
        literal: { source: "static", value: "fixed" },
        submittedAt: { source: "currentTimestamp" },
        actor: { source: "currentUser" },
        investigatorName: {
          source: "objectProperty",
          param: "personId",
          path: "givenName",
        },
        nestedScore: {
          source: "objectProperty",
          param: "personId",
          path: "profile/score",
        },
      },
      resolvedParameters: {
        priority: "HIGH",
        personId: "person-1",
        untouched: "keep-me",
      },
      parameterDefinitions: [
        { apiName: "priority", type: "string" },
        {
          apiName: "personId",
          type: "object_reference",
          objectType: "RssbPerson",
        },
      ],
      currentUserId: "user-123",
      executedBy: "audit-name",
      objectFetcher,
      now,
    });

    expect(result).toMatchObject({
      untouched: "keep-me",
      copiedPriority: "HIGH",
      literal: "fixed",
      submittedAt: "2026-09-13T00:00:00.000Z",
      actor: "user-123",
      investigatorName: "Alice",
      nestedScore: 91,
    });
    expect(objectFetcher).toHaveBeenCalledWith("RssbPerson", "person-1");
  });

  it("fails closed when an object-property mapping references a non-object parameter", async () => {
    await expect(
      resolveFunctionInputs({
        inputs: {
          investigatorName: {
            source: "objectProperty",
            param: "personId",
            path: "givenName",
          },
        },
        resolvedParameters: { personId: "person-1" },
        parameterDefinitions: [{ apiName: "personId", type: "string" }],
        executedBy: "user-1",
        objectFetcher: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "FUNCTION_INPUT_MAPPING_INVALID" });
  });
});
