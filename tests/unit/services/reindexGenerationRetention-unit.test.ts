import { describe, expect, it } from "vitest";
import { obsoleteReindexGenerations } from "../../../src/services/reindexService";

describe("reindex generation retention", () => {
  it("retains only the live generation and immediate rollback", () => {
    expect(obsoleteReindexGenerations(
      ["idx-replacement-old", "idx-rollback-old", "idx-replacement-live", "idx-replacement-prev"],
      "idx-replacement-live",
      "idx-replacement-prev",
    )).toEqual(["idx-replacement-old", "idx-rollback-old"]);
  });

  it("retains only live when no rollback exists", () => {
    expect(obsoleteReindexGenerations(["idx-live", "idx-old"], "idx-live", null))
      .toEqual(["idx-old"]);
  });
});
