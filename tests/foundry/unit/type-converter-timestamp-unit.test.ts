// ---------------------------------------------------------------------------
// Cast to Timestamp.
//
// Two defects motivate this file, and both were invisible to a fully green
// suite because every existing date test used `targetType: "date"`.
//
// 1. `convertValue` forwarded `dateFormat` to the date branch but dropped it on
//    the timestamp branch, and `convertTimestamp` accepted only ISO/epoch
//    shapes. So "Cast to Timestamp" on a column of "7/30/23" threw on every
//    single row — reported in the UI as "500 of 500 values could not be cast to
//    Timestamp and were set to null" — while "Cast to Date" on the very same
//    column succeeded. The module's own compatibility table says a timestamp
//    target accepts a date (`timestamp: {timestamp, date}`), so this was an
//    internal contract violation, not a missing feature.
//
// 2. The strict path parsed zone-less datetimes with `new Date(...)`, which
//    applies the *host* offset. "2023-07-30 14:05:00" became 12:05Z on a
//    +02:00 server and 14:05Z on a UTC one, and disagreed with the DuckDB
//    engine, whose TIMESTAMP is timezone-naive and keeps 14:05. Since previews
//    always run the TS engine while /execute may run DuckDB, that divergence
//    shows up as the canvas contradicting the deployed dataset.
//
// The tests below therefore assert *values*, not just "did not throw" — a cast
// that silently shifts an hour or lands in year 0030 is worse than one that
// fails loudly.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { convertValue, inferDateFormat } from "../../../src/utils/typeConverter";

/** Cast with the same options the transform path builds via castOptionsForColumn. */
function cast(
  raw: unknown,
  targetType: "date" | "timestamp",
  dateFormat?: "dmy" | "mdy",
): unknown {
  return convertValue(
    raw,
    targetType,
    (dateFormat ? { coerce: true, dateFormat } : { coerce: true }) as never,
  );
}

describe("cast to timestamp accepts every shape cast to date accepts", () => {
  // The exact column that produced the bug report: order_due_date, entirely
  // 2-digit-year slash dates.
  const ORDER_DUE_DATE = ["7/30/23", "1/15/23", "12/31/99", "2/29/24"];

  it("infers mdy for the reported column", () => {
    expect(inferDateFormat(ORDER_DUE_DATE)).toBe("mdy");
  });

  it("casts the reported column to timestamp without a single failure", () => {
    // This is the regression in its original form. Before the fix this loop
    // threw 4/4; at production scale, 500/500.
    const out = ORDER_DUE_DATE.map((v) => cast(v, "timestamp", "mdy"));
    expect(out).toEqual([
      "2023-07-30T00:00:00.000Z",
      "2023-01-15T00:00:00.000Z",
      "1999-12-31T00:00:00.000Z", // %y pivot: 99 → 1999, not 2099
      "2024-02-29T00:00:00.000Z",
    ]);
  });

  it("agrees with the date target on the calendar day", () => {
    // Widening a date to midnight is lossless, so the two targets must never
    // disagree about which day a string denotes.
    for (const v of ORDER_DUE_DATE) {
      const asDate = cast(v, "date", "mdy") as string;
      const asTs = cast(v, "timestamp", "mdy") as string;
      expect(asTs).toBe(`${asDate}T00:00:00.000Z`);
    }
  });

  it("honours the dmy hint the same way the date target does", () => {
    // "30/7/23" is unambiguously DMY (30 > 12). Under a naive TRY_CAST this is
    // the value that silently becomes year 0030 rather than failing, so pin it.
    expect(cast("30/7/23", "timestamp", "dmy")).toBe("2023-07-30T00:00:00.000Z");
    expect(cast("30/7/23", "timestamp", "mdy")).toBe("2023-07-30T00:00:00.000Z");
  });

  it("accepts the month-name and 4-digit-year forms too", () => {
    expect(cast("30-Mar-2025", "timestamp")).toBe("2025-03-30T00:00:00.000Z");
    expect(cast("2023-07-30", "timestamp")).toBe("2023-07-30T00:00:00.000Z");
  });
});

describe("timestamp parsing is independent of the server timezone", () => {
  it("treats a zone-less datetime as naive rather than local", () => {
    // The assertion that fails on any machine whose TZ is not UTC if the
    // implementation regresses to a bare `new Date(...)`.
    expect(cast("2023-07-30 14:05:00", "timestamp")).toBe(
      "2023-07-30T14:05:00.000Z",
    );
    expect(cast("2023-07-30T14:05:00", "timestamp")).toBe(
      "2023-07-30T14:05:00.000Z",
    );
  });

  it("matches DuckDB, whose TIMESTAMP is timezone-naive", () => {
    // Verified against the engine: TRY_CAST('2023-07-30 14:05:00' AS TIMESTAMP)
    // yields '2023-07-30 14:05:00'. Previews run this TS path while /execute
    // may run DuckDB, so the hour has to survive both.
    const hour = (cast("2023-07-30 14:05:00", "timestamp") as string).slice(
      11,
      16,
    );
    expect(hour).toBe("14:05");
  });

  it("still honours an explicit offset, which is a real zone assertion", () => {
    expect(cast("2023-07-30T14:05:00+02:00", "timestamp")).toBe(
      "2023-07-30T12:05:00.000Z",
    );
    expect(cast("2023-07-30T14:05:00Z", "timestamp")).toBe(
      "2023-07-30T14:05:00.000Z",
    );
  });

  it("keeps sub-second precision", () => {
    expect(cast("2023-07-30T14:05:00.123Z", "timestamp")).toBe(
      "2023-07-30T14:05:00.123Z",
    );
  });
});

describe("the strict gate is preserved, not loosened", () => {
  // The whole point of the ISO gate is to keep JS's lenient parsing out. The
  // fix delegates unrecognised shapes to convertDate, which also throws — so
  // garbage must still fail loudly instead of becoming a plausible wrong date.
  it.each([
    ["hello", "not a date at all"],
    ["not-a-date", "hyphenated words"],
    ["7/99/23", "impossible day and month"],
    ["2023-13-45", "out-of-range ISO"],
    ["Jul 30", "no year"],
  ])("rejects %s (%s)", (bad) => {
    expect(() => cast(bad, "timestamp")).toThrow();
  });

  it("rejects non-string, non-number input", () => {
    expect(() => cast({ a: 1 }, "timestamp")).toThrow();
    expect(() => cast(true, "timestamp")).toThrow();
  });

  it("still passes null and empty through as null", () => {
    // Lenient null handling is deliberate and separate from cast failure: an
    // empty cell is missing data, not a cast error, and must not inflate the
    // castErrors counter that produces the "N of N" message.
    expect(cast(null, "timestamp")).toBeNull();
    expect(cast("", "timestamp")).toBeNull();
  });

  it("keeps the epoch shortcuts working", () => {
    expect(cast("1690718400000", "timestamp")).toBe("2023-07-30T12:00:00.000Z");
    expect(cast("1690718400", "timestamp")).toBe("2023-07-30T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Shapes found by probing rather than by waiting for a user report.
//
// The month-name grammar was hardcoded to exactly three letters, so
// "30-Mar-2025" worked while "30 March 2025" failed — an arbitrary distinction
// from a user's point of view, and one that only surfaces the day a new source
// file happens to spell the month out. Compact YYYYMMDD had the same character:
// a routine warehouse/Excel export shape that the grammar simply had no branch
// for. Both are pinned here so widening the regexes cannot silently narrow again.
// ---------------------------------------------------------------------------
describe("timestamp cast — month names and compact dates", () => {
  it.each([
    ["30 March 2025", "2025-03-30T00:00:00.000Z", "day + full month + year"],
    ["11 September 2025", "2025-09-11T00:00:00.000Z", "longest month name"],
    ["March 11 2025", "2025-03-11T00:00:00.000Z", "full month first, no comma"],
    ["Sept 30, 2025", "2025-09-30T00:00:00.000Z", "irregular 4-letter abbrev"],
    ["Mar-11-2025", "2025-03-11T00:00:00.000Z", "dash-separated month-first"],
    ["30-Mar-2025", "2025-03-30T00:00:00.000Z", "the shape that already worked"],
    ["20230730", "2023-07-30T00:00:00.000Z", "compact ISO basic"],
  ])("accepts %s -> %s (%s)", (input, expected) => {
    expect(cast(input, "timestamp")).toBe(expected);
  });

  it("accepts the same shapes for the date target, identically", () => {
    // The two targets must never disagree about what a string *means*; widening
    // a date to midnight is the only difference allowed.
    for (const s of ["30 March 2025", "Sept 30, 2025", "20230730"]) {
      expect(String(cast(s, "timestamp")).slice(0, 10)).toBe(cast(s, "date"));
    }
  });

  it("rejects compact digits that are not a calendar date", () => {
    // 20231345 is 8 digits and matches the shape, but month 13 / day 45 do not
    // exist. Coercing it into something plausible would be worse than failing:
    // a loud cast error is recoverable, a silently wrong date is not.
    expect(() => cast("20231345", "timestamp")).toThrow();
    expect(() => cast("20230230", "timestamp")).toThrow(); // Feb 30 in a non-leap shape
  });

  it("does not let compact dates shadow the epoch branches", () => {
    // 10- and 13-digit epochs are intercepted before the date grammar, so the
    // new 8-digit branch must not have moved that boundary.
    expect(cast("1690718400", "timestamp")).toBe("2023-07-30T12:00:00.000Z");
    expect(cast("1690718400000", "timestamp")).toBe("2023-07-30T12:00:00.000Z");
  });

  it("still rejects a bare month name or a partial date", () => {
    expect(() => cast("March", "timestamp")).toThrow();
    expect(() => cast("March 2025", "timestamp")).toThrow();
    expect(() => cast("Notamonth 11 2025", "timestamp")).toThrow();
  });
});
