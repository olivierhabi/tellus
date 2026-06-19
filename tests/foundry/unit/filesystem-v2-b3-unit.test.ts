// ---------------------------------------------------------------------------
// B3 unit tests — cursor encoder/decoder + ifMatchV2 + Conjure envelope
// ---------------------------------------------------------------------------
// Spec:      tasks/files-projects/files-projects-tasks.md §B3.
// Contracts: tasks/files-projects/contracts.md (B3-C-20..24, B3-C-40..42, B3-C-50).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { OntologyError } from "../../../src/utils/queryErrors";
import {
  encodeCursor,
  decodeCursor,
  validatePageSize,
} from "../../../src/lib/cursor";
import {
  formatV2Etag,
  parseV2Etag,
  requireIfMatchV2,
} from "../../../src/middleware/ifMatchV2";
import { buildConjureError } from "../../../src/lib/conjureError";
import { mintRid } from "../../../src/lib/rid";

describe("B3-C-40 — cursor round-trip", () => {
  it("encodes and decodes back to the same payload", () => {
    const rid = mintRid("compass", "compass-folder");
    const cursor = { lastUpdatedAt: "2026-01-01T00:00:00.000Z", lastRid: rid };
    const token = encodeCursor(cursor);
    const decoded = decodeCursor(token);
    expect(decoded).toEqual(cursor);
  });

  it("decodeCursor returns null for empty/undefined input", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

describe("B3-C-41 — invalid page tokens reject with INVALID_PAGE_TOKEN", () => {
  const cases: Array<{ name: string; token: string }> = [
    { name: "non-base64", token: "!!!" },
    { name: "valid base64 but not JSON", token: Buffer.from("not-json", "utf8").toString("base64url") },
    { name: "JSON without {t,r}", token: Buffer.from(JSON.stringify({}), "utf8").toString("base64url") },
    { name: "JSON with non-ISO timestamp", token: Buffer.from(JSON.stringify({ t: "abc", r: "ri.x.y.z.w" }), "utf8").toString("base64url") },
    { name: "JSON with malformed RID", token: Buffer.from(JSON.stringify({ t: "2026-01-01T00:00:00Z", r: "garbage" }), "utf8").toString("base64url") },
  ];
  for (const { name, token } of cases) {
    it(`rejects ${name}`, () => {
      try {
        decodeCursor(token);
        expect.fail(`expected throw for ${name}`);
      } catch (err) {
        expect(err).toBeInstanceOf(OntologyError);
        expect((err as OntologyError).code).toBe("INVALID_PAGE_TOKEN");
        expect((err as OntologyError).statusCode).toBe(400);
      }
    });
  }
});

describe("B3-C-42 — pageSize validation", () => {
  it("returns default when undefined/null/empty", () => {
    expect(validatePageSize(undefined, 50)).toBe(50);
    expect(validatePageSize(null, 50)).toBe(50);
    expect(validatePageSize("", 50)).toBe(50);
  });

  it("accepts integer values in 1..1000", () => {
    expect(validatePageSize(1)).toBe(1);
    expect(validatePageSize(100)).toBe(100);
    expect(validatePageSize(1000)).toBe(1000);
    // String numbers also accepted (express query params come as strings).
    expect(validatePageSize("250")).toBe(250);
  });

  for (const bad of [0, -1, 1001, 99999, 1.5, "not-a-number"]) {
    it(`rejects ${JSON.stringify(bad)} with INVALID_ARGUMENT`, () => {
      try {
        validatePageSize(bad);
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(OntologyError);
        expect((err as OntologyError).code).toBe("INVALID_ARGUMENT");
        expect((err as OntologyError).statusCode).toBe(400);
      }
    });
  }
});

describe("B3-C-22 / B3-C-24 — ifMatchV2 etag formatting", () => {
  it("formatV2Etag produces strong etag", () => {
    expect(formatV2Etag(0)).toBe('"v0"');
    expect(formatV2Etag(42)).toBe('"v42"');
    expect(formatV2Etag(999)).toBe('"v999"');
  });

  it("parseV2Etag round-trips", () => {
    expect(parseV2Etag('"v0"')).toBe(0);
    expect(parseV2Etag('"v42"')).toBe(42);
    expect(parseV2Etag('W/"v42"')).toBe(42); // weak etag
  });

  it("parseV2Etag returns null for malformed input", () => {
    expect(parseV2Etag(undefined)).toBeNull();
    expect(parseV2Etag("")).toBeNull();
    expect(parseV2Etag("garbage")).toBeNull();
    expect(parseV2Etag('"x42"')).toBeNull();
  });
});

describe("B3-C-20 / B3-C-21 / B3-C-24 — requireIfMatchV2 behavior matrix", () => {
  function reqWith(headers: Record<string, string> = {}): { headers: Record<string, string> } {
    return { headers };
  }

  it("missing If-Match → 428 PRECONDITION_REQUIRED", () => {
    expect(() => requireIfMatchV2(reqWith({}) as never, 5, "TEST")).toThrowError(/required/);
    try {
      requireIfMatchV2(reqWith({}) as never, 5, "TEST");
    } catch (err) {
      expect((err as OntologyError).code).toBe("PRECONDITION_REQUIRED");
      expect((err as OntologyError).statusCode).toBe(428);
    }
  });

  it("malformed If-Match → 400 INVALID_ARGUMENT", () => {
    try {
      requireIfMatchV2(reqWith({ "if-match": "garbage" }) as never, 5, "TEST");
      expect.fail("expected throw");
    } catch (err) {
      expect((err as OntologyError).code).toBe("INVALID_ARGUMENT");
      expect((err as OntologyError).statusCode).toBe(400);
    }
  });

  it("stale If-Match → 412 PRECONDITION_FAILED with {expected, actual}", () => {
    try {
      requireIfMatchV2(reqWith({ "if-match": '"v3"' }) as never, 5, "TEST");
      expect.fail("expected throw");
    } catch (err) {
      const e = err as OntologyError;
      expect(e.code).toBe("PRECONDITION_FAILED");
      expect(e.statusCode).toBe(412);
      expect(e.parameters.expected).toBe(3);
      expect(e.parameters.actual).toBe(5);
    }
  });

  it("matching If-Match → returns silently (no throw)", () => {
    expect(() =>
      requireIfMatchV2(reqWith({ "if-match": '"v5"' }) as never, 5, "TEST"),
    ).not.toThrow();
  });
});

describe("B3-C-50 — buildConjureError shape", () => {
  it("emits {errorCode, errorName, errorInstanceId, parameters}", () => {
    const body = buildConjureError("RESOURCE_NOT_FOUND", "Resource missing.", { rid: "ri.x.y.z.w" });
    expect(body.errorCode).toBe("RESOURCE_NOT_FOUND");
    expect(body.errorName).toBe("ResourceNotFoundError");
    expect(typeof body.errorInstanceId).toBe("string");
    expect(body.errorInstanceId.length).toBeGreaterThan(0);
    expect(body.parameters?._message).toBe("Resource missing.");
    expect(body.parameters?.rid).toBe("ri.x.y.z.w");
  });

  it("falls back to InternalError when code is unknown", () => {
    const body = buildConjureError("MADE_UP_CODE", "boom", {});
    expect(body.errorName).toBe("InternalError");
  });
});
