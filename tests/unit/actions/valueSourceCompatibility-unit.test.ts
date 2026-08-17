import { describe, expect, it } from "vitest";

import { validateSystemValueSourceForProperty } from "../../../src/actions/valueSourceCompatibility";

describe("system value-source compatibility", () => {
  it("allows Current timestamp for timestamp and date properties", () => {
    expect(
      validateSystemValueSourceForProperty(
        { source: "currentTimestamp" },
        "rules[0].properties.submittedAt",
        "timestamp",
      ),
    ).toEqual([]);
    expect(
      validateSystemValueSourceForProperty(
        { source: "currentTimestamp" },
        "rules[0].properties.submittedOn",
        "date",
      ),
    ).toEqual([]);
  });

  it("rejects Current timestamp for an incompatible property type", () => {
    expect(
      validateSystemValueSourceForProperty(
        { source: "currentTimestamp" },
        "rules[0].properties.submittedAt",
        "string",
      ),
    ).toEqual([
      "rules[0].properties.submittedAt maps Current timestamp to 'string'. Current timestamp is only compatible with date or timestamp properties.",
    ]);
  });
});
