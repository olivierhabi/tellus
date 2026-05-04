// Quiver — zod-typed request schema unit tests (B1 C-03/04/07/08, G-01).

import { describe, it, expect } from "vitest";
import {
  AnalysisRid,
  CardId,
  CreateAnalysisRequest,
} from "../../../src/services/quiver/types";

describe("CreateAnalysisRequest (B1 C-03/04/07/08)", () => {
  it("B1 C-03: rejects empty displayName", () => {
    const r = CreateAnalysisRequest.safeParse({
      parentFolderRid: "ri.compass.main.folder.x",
      displayName: "",
    });
    expect(r.success).toBe(false);
  });

  it("B1 C-03: rejects displayName > 200 chars", () => {
    const r = CreateAnalysisRequest.safeParse({
      parentFolderRid: "ri.compass.main.folder.x",
      displayName: "a".repeat(201),
    });
    expect(r.success).toBe(false);
  });

  it("B1 C-04: rejects description > 2000 chars", () => {
    const r = CreateAnalysisRequest.safeParse({
      parentFolderRid: "ri.compass.main.folder.x",
      displayName: "ok",
      description: "x".repeat(2001),
    });
    expect(r.success).toBe(false);
  });

  it("B1 C-07: rejects both seedFromObjectSet and seedFromTemplate", () => {
    const r = CreateAnalysisRequest.safeParse({
      parentFolderRid: "ri.compass.main.folder.x",
      displayName: "ok",
      seedFromObjectSet: { ontologyRid: "ri.ontology.main.ontology.a" },
      seedFromTemplate: "ri.tellus-quiver.main.template.x",
    });
    expect(r.success).toBe(false);
  });

  it("B1 C-04: accepts valid request", () => {
    const r = CreateAnalysisRequest.safeParse({
      parentFolderRid: "ri.compass.main.folder.x",
      displayName: "Q1 sales",
      description: "ok",
    });
    expect(r.success).toBe(true);
  });
});

describe("AnalysisRid (G-01 / B1 C-02)", () => {
  it("G-01: accepts only ri.tellus-quiver.main.analysis.<uuid7>", () => {
    expect(
      AnalysisRid.safeParse(
        "ri.tellus-quiver.main.analysis.018f6c2d-7000-7abc-8def-1234567890ab",
      ).success,
    ).toBe(true);
  });
  it("G-01: rejects v4 uuid", () => {
    expect(
      AnalysisRid.safeParse(
        "ri.tellus-quiver.main.analysis.018f6c2d-7000-4abc-8def-1234567890ab",
      ).success,
    ).toBe(false);
  });
});

describe("CardId (B2 C-10)", () => {
  it("B2 C-10: accepts $A, $Z, $AA", () => {
    expect(CardId.safeParse("$A").success).toBe(true);
    expect(CardId.safeParse("$Z").success).toBe(true);
    expect(CardId.safeParse("$AA").success).toBe(true);
  });
  it("B2 C-10: rejects $a, $1, A, etc.", () => {
    expect(CardId.safeParse("$a").success).toBe(false);
    expect(CardId.safeParse("$1").success).toBe(false);
    expect(CardId.safeParse("A").success).toBe(false);
  });
});
