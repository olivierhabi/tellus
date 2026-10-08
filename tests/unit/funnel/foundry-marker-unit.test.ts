// ---------------------------------------------------------------------------
// Foundry marker + zero-row gate — unit tests (Blocker 4).
//
// Pinned here:
//   * parseFoundryMarker accepts exactly
//     `<s3-key>#foundry-dataset:<uuid>#object-type:<uuid>` and throws a
//     clear error on missing/malformed markers (no silent zero-row reads);
//   * assertChangelogNonEmpty throws only when rows are zero AND the source
//     is positively non-empty (genuinely edit-less types still pass).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  parseFoundryMarker,
  assertChangelogNonEmpty,
} from "../../../src/services/funnel/temporal/activities";

const GOOD =
  "gate4/accounts_synth.csv#foundry-dataset:7ff4f9f6-de66-4dec-b117-19176feb66db#object-type:7e7c2da4-a837-498c-974a-d8d167b568ac";

describe("parseFoundryMarker", () => {
  it("parses a well-formed locator", () => {
    expect(parseFoundryMarker(GOOD)).toEqual({
      s3Key: "gate4/accounts_synth.csv",
      foundryDatasetUuid: "7ff4f9f6-de66-4dec-b117-19176feb66db",
      objectTypeUuid: "7e7c2da4-a837-498c-974a-d8d167b568ac",
    });
  });

  it("throws on a missing marker", () => {
    expect(() => parseFoundryMarker("gate4/accounts_synth.csv")).toThrow(
      /missing or malformed marker/,
    );
  });

  it("throws on a malformed dataset uuid", () => {
    expect(() =>
      parseFoundryMarker(
        "gate4/accounts_synth.csv#foundry-dataset:not-a-uuid#object-type:7e7c2da4-a837-498c-974a-d8d167b568ac",
      ),
    ).toThrow(/missing or malformed marker/);
  });

  it("throws on an empty object key", () => {
    expect(() =>
      parseFoundryMarker(
        "#foundry-dataset:7ff4f9f6-de66-4dec-b117-19176feb66db#object-type:7e7c2da4-a837-498c-974a-d8d167b568ac",
      ),
    ).toThrow(/missing or malformed marker/);
  });

  it("throws on a missing object-type tag", () => {
    expect(() =>
      parseFoundryMarker(
        "gate4/accounts_synth.csv#foundry-dataset:7ff4f9f6-de66-4dec-b117-19176feb66db",
      ),
    ).toThrow(/missing or malformed marker/);
  });
});

describe("assertChangelogNonEmpty", () => {
  it("throws on zero rows for a non-empty source", () => {
    expect(() =>
      assertChangelogNonEmpty({
        objectTypeApiName: "Account",
        rowsEmitted: 0,
        sourceNonEmpty: true,
      }),
    ).toThrow(/emitted 0 rows for a non-empty source/);
  });

  it("passes on zero rows for a possibly-empty source", () => {
    expect(() =>
      assertChangelogNonEmpty({
        objectTypeApiName: "Account",
        rowsEmitted: 0,
        sourceNonEmpty: false,
      }),
    ).not.toThrow();
  });

  it("passes on non-zero rows either way", () => {
    expect(() =>
      assertChangelogNonEmpty({
        objectTypeApiName: "Account",
        rowsEmitted: 10,
        sourceNonEmpty: true,
      }),
    ).not.toThrow();
  });
});
