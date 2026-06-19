// ---------------------------------------------------------------------------
// B3 unit tests — pg-types parser overrides (interval ISO encoder, tstzrange
// structured parse). Spec line 167.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  pgIntervalToIso,
  parseTstzRange,
} from "../../../src/services/connectivity/connectors/postgresql/pg-types-config";

describe("pgIntervalToIso", () => {
  it("encodes years + months + days + time", () => {
    expect(pgIntervalToIso("1 year 2 mons 3 days 04:05:06")).toBe(
      "P1Y2M3DT4H5M6S",
    );
  });

  it("encodes time-only intervals", () => {
    expect(pgIntervalToIso("04:05:06.789")).toBe("PT4H5M6.789S");
  });

  it("encodes negative years", () => {
    expect(pgIntervalToIso("-1 years")).toBe("P-1Y");
  });

  it("encodes zero interval", () => {
    expect(pgIntervalToIso("00:00:00")).toBe("PT0H0M0S");
  });

  it("pass-through on unparsable shapes", () => {
    expect(pgIntervalToIso("garbage value")).toBe("garbage value");
  });
});

describe("parseTstzRange", () => {
  it("parses inclusive-exclusive range", () => {
    const r = parseTstzRange(
      '["2024-01-01 00:00:00+00","2024-02-01 00:00:00+00")',
    );
    expect(r.lowerInc).toBe(true);
    expect(r.upperInc).toBe(false);
    expect(r.lower).toBe("2024-01-01 00:00:00+00");
    expect(r.upper).toBe("2024-02-01 00:00:00+00");
  });

  it("parses inclusive-inclusive range", () => {
    const r = parseTstzRange(
      '["2024-01-01 00:00:00+00","2024-02-01 00:00:00+00"]',
    );
    expect(r.lowerInc).toBe(true);
    expect(r.upperInc).toBe(true);
  });

  it("parses empty range to nulls", () => {
    const r = parseTstzRange("empty");
    expect(r).toEqual({
      lower: null,
      upper: null,
      lowerInc: false,
      upperInc: false,
    });
  });

  it("handles unbounded lower", () => {
    const r = parseTstzRange('(,"2024-02-01 00:00:00+00")');
    expect(r.lower).toBeNull();
    expect(r.upper).toBe("2024-02-01 00:00:00+00");
  });
});
