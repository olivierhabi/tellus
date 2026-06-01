// ---------------------------------------------------------------------------
// Unit tests for src/middleware/connectivityEtag.ts.
// Pure functions + Express Request/Response stubs — no DB, no network.
// Covers: weak ETag emission, If-Match parse (missing / malformed / weak / strong),
// 412 IfMatchRequired routing, 409 ResourceVersionMismatch routing.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  etagFor,
  parseConnectivityIfMatch,
  requireConnectivityIfMatch,
  setConnectivityEtag,
} from "../../../src/middleware/connectivityEtag";
import { TellusError } from "../../../src/lib/errors/envelope";

function mockResponse() {
  const headers: Record<string, string | number | readonly string[]> = {};
  return {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers[name] = value;
    },
    getHeader(name: string) {
      return headers[name];
    },
    _headers: headers,
  };
}

function mockRequest(ifMatch?: string) {
  const headers: Record<string, string | undefined> = {};
  if (ifMatch !== undefined) headers["if-match"] = ifMatch;
  return { headers } as any;
}

describe("connectivityEtag.etagFor", () => {
  it("emits a weak ETag from a number", () => {
    expect(etagFor(7)).toBe('W/"7"');
  });
  it("emits a weak ETag from a bigint", () => {
    expect(etagFor(BigInt(42))).toBe('W/"42"');
  });
  it("emits a weak ETag from a string", () => {
    expect(etagFor("12345")).toBe('W/"12345"');
  });
});

describe("connectivityEtag.setConnectivityEtag", () => {
  it("sets the ETag response header in weak form", () => {
    const res = mockResponse();
    setConnectivityEtag(res as any, 3);
    expect(res.getHeader("ETag")).toBe('W/"3"');
  });
});

describe("connectivityEtag.parseConnectivityIfMatch", () => {
  it("returns missing when header absent", () => {
    expect(parseConnectivityIfMatch(mockRequest()).kind).toBe("missing");
  });
  it("returns malformed when header is empty", () => {
    expect(parseConnectivityIfMatch(mockRequest("")).kind).toBe("malformed");
  });
  it("returns malformed when header lacks quotes", () => {
    expect(parseConnectivityIfMatch(mockRequest("7")).kind).toBe("malformed");
  });
  it("returns malformed when header is non-integer", () => {
    expect(parseConnectivityIfMatch(mockRequest('"abc"')).kind).toBe("malformed");
  });
  it("returns value when header is strong-quoted integer", () => {
    const r = parseConnectivityIfMatch(mockRequest('"42"'));
    expect(r.kind).toBe("value");
    if (r.kind === "value") expect(r.version).toBe(42);
  });
  it("returns value when header is weak-quoted integer", () => {
    const r = parseConnectivityIfMatch(mockRequest('W/"99"'));
    expect(r.kind).toBe("value");
    if (r.kind === "value") expect(r.version).toBe(99);
  });
  it("returns malformed for negative integer", () => {
    expect(parseConnectivityIfMatch(mockRequest('"-1"')).kind).toBe("malformed");
  });
});

describe("connectivityEtag.requireConnectivityIfMatch", () => {
  it("throws Tellus:Connectivity:IfMatchRequired (412) when header absent", () => {
    try {
      requireConnectivityIfMatch(mockRequest(), 5);
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TellusError);
      const t = e as TellusError;
      expect(t.definition.errorName).toBe(
        "Tellus:Connectivity:IfMatchRequired",
      );
      expect(t.definition.httpStatus).toBe(412);
    }
  });
  it("throws IfMatchRequired (412) when header malformed", () => {
    try {
      requireConnectivityIfMatch(mockRequest("nonsense"), 5);
      throw new Error("did not throw");
    } catch (e) {
      const t = e as TellusError;
      expect(t.definition.errorName).toBe(
        "Tellus:Connectivity:IfMatchRequired",
      );
      expect(t.parameters.reason).toBe("malformed");
    }
  });
  it("throws Tellus:Connectivity:ResourceVersionMismatch (409) on stale version", () => {
    try {
      requireConnectivityIfMatch(mockRequest('"3"'), 5);
      throw new Error("did not throw");
    } catch (e) {
      const t = e as TellusError;
      expect(t.definition.errorName).toBe(
        "Tellus:Connectivity:ResourceVersionMismatch",
      );
      expect(t.definition.httpStatus).toBe(409);
      expect(t.parameters.provided).toBe(3);
      expect(t.parameters.current).toBe(5);
    }
  });
  it("returns the parsed version on exact match", () => {
    expect(requireConnectivityIfMatch(mockRequest('W/"5"'), 5)).toBe(5);
  });
});
