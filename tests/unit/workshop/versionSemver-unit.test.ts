import { describe, expect, it } from "vitest";

import { compareStableSemver } from "../../../src/services/workshop/versionService.js";

describe("Workshop publication semantic version ordering", () => {
  it.each([
    ["0.2.9", "0.4.2", -1],
    ["0.4.2", "0.4.2", 0],
    ["0.4.3", "0.4.2", 1],
    ["1.0.0", "0.99.99", 1],
    ["10.0.0", "2.99.99", 1],
  ])("compares %s with %s", (left, right, expected) => {
    expect(compareStableSemver(left, right)).toBe(expected);
  });

  it("rejects versions outside the stable-version contract", () => {
    expect(() => compareStableSemver("v1.0.0", "1.0.0")).toThrow();
  });
});
