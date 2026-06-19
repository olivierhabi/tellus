// Quiver — ETag computation (G-03, B1 C-11/12).

import { describe, it, expect } from "vitest";
import {
  computeAnalysisEtag,
  etagsMatch,
  stripWeakPrefix,
} from "../../../src/services/quiver/etag";

const baseSnapshot = {
  rid: "ri.tellus-quiver.main.analysis.018f6c2d-7000-7abc-8def-1234567890ab",
  parentFolderRid: "ri.compass.main.folder.abc",
  displayName: "test",
  description: null,
  documentBlobUri: null,
  documentInline: { cards: {}, canvases: [], parameters: {} },
  currentVersion: 0,
  isDeleted: false,
  deletedAt: null,
  updatedAt: "2026-05-04T10:00:00.000Z",
  markings: [],
};

describe("Quiver ETag (G-03)", () => {
  it("G-03: computeAnalysisEtag is deterministic for identical input", () => {
    const a = computeAnalysisEtag(baseSnapshot);
    const b = computeAnalysisEtag(baseSnapshot);
    expect(a).toBe(b);
  });

  it("G-03: ETag is a Weak Etag (W/-prefixed quoted hex)", () => {
    const tag = computeAnalysisEtag(baseSnapshot);
    expect(tag).toMatch(/^W\/"[0-9a-f]{64}"$/u);
  });

  it("G-03: any change to displayName mutates the ETag", () => {
    const a = computeAnalysisEtag(baseSnapshot);
    const b = computeAnalysisEtag({ ...baseSnapshot, displayName: "other" });
    expect(a).not.toBe(b);
  });

  it("G-03: any change to updatedAt mutates the ETag", () => {
    const a = computeAnalysisEtag(baseSnapshot);
    const b = computeAnalysisEtag({
      ...baseSnapshot,
      updatedAt: "2026-05-04T10:00:00.001Z",
    });
    expect(a).not.toBe(b);
  });

  it("G-03: etagsMatch ignores weak prefix and quoting", () => {
    const tag = computeAnalysisEtag(baseSnapshot);
    expect(etagsMatch(tag, tag)).toBe(true);
    expect(etagsMatch(tag, stripWeakPrefix(tag))).toBe(true);
    expect(etagsMatch(tag, "W/" + stripWeakPrefix(tag))).toBe(true);
  });

  it("G-03: etagsMatch returns false on mismatched digest", () => {
    expect(etagsMatch('W/"a"', 'W/"b"')).toBe(false);
  });
});
