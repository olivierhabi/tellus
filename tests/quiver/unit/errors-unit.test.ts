// Quiver — error envelope (G-02).

import { describe, it, expect } from "vitest";
import {
  analysisNotFound,
  invalidAnalysisRequest,
  isQuiverError,
  versionMismatch,
} from "../../../src/services/quiver/errors";

describe("Quiver error envelope (G-02)", () => {
  it("G-02: emits the canonical { errorCode, errorName, errorInstanceId, parameters } shape", () => {
    const e = invalidAnalysisRequest({ field: "displayName" });
    expect(isQuiverError(e)).toBe(true);
    expect(e.envelope.errorCode).toBe("INVALID_ARGUMENT");
    expect(e.envelope.errorName).toBe("Tellus:Quiver:InvalidAnalysisRequest");
    expect(e.envelope.errorInstanceId).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    expect(e.envelope.parameters).toEqual({ field: "displayName" });
    expect(e.status).toBe(400);
  });

  it("G-02: maps NOT_FOUND → 404", () => {
    const e = analysisNotFound({ rid: "x" });
    expect(e.status).toBe(404);
    expect(e.envelope.errorCode).toBe("NOT_FOUND");
  });

  it("G-02 + G-03: VERSION_MISMATCH → 412 with currentEtag parameter", () => {
    const e = versionMismatch({ currentEtag: 'W/"abc"' });
    expect(e.status).toBe(412);
    expect(e.envelope.errorCode).toBe("FAILED_PRECONDITION");
    expect(e.envelope.errorName).toBe("Tellus:Quiver:VersionMismatch");
    expect(e.envelope.parameters.currentEtag).toBe('W/"abc"');
  });

  it("G-02: errorInstanceId is unique across instances", () => {
    const a = analysisNotFound({ rid: "x" });
    const b = analysisNotFound({ rid: "x" });
    expect(a.envelope.errorInstanceId).not.toBe(b.envelope.errorInstanceId);
  });
});
