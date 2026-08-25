// ---------------------------------------------------------------------------
// Outer-join match-rate diagnostics.
//
// Motivating report: a left join on pipeline 86cff275 returned all 746 left
// rows with every one of its ten right-side columns 100% null, and
// `warnings: []`. Nothing was wrong with the join — the two source files keyed
// orders differently (left `order_id` is a 72-char pair of concatenated UUIDs,
// right `orderId` is `A<digits>-<uuid>`), so zero rows could ever match. But
// the product said nothing at all, leaving "the join deleted my data"
// indistinguishable from "the right side is sparse".
//
// An inner join makes this obvious by returning 0 rows. An outer join cannot,
// so the match rate has to be reported explicitly. These tests pin that, and
// pin the key semantics against executeJoin's `matches()` — a percentage that
// disagrees with the rows on screen would be worse than no warning.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  buildJoinMatchWarnings,
  computeJoinMatchRate,
} from "../../../src/services/pipelines/joinMatchRate";

type Row = Record<string, unknown>;

const ON = [{ leftColumn: "order_id", rightColumn: "orderId" }];

/** The reported shape: composite left key vs prefixed right key. */
const LEFT_NO_OVERLAP: Row[] = [
  { order_id: "9266e88b-cc45-49b2-85d3-e8c5b3a8322ffc220883-6a6e-4eec-b8a9-d5ea58d43c53" },
  { order_id: "9266e88b-cc45-49b2-85d3-e8c5b3a8322fe8b47bbe-990b-48a6-a7c6-d15732f85e06" },
];
const RIGHT_NO_OVERLAP: Row[] = [
  { orderId: "A74270364-fc220883-6a6e-4eec-b8a9-d5ea58d43c53" },
  { orderId: "A74270364-fb778d8b-9a3b-4cf2-8e6b-0b33746886f7" },
];

describe("zero-match outer joins are reported, not silent", () => {
  it("warns when a left join matches nothing", () => {
    const w = buildJoinMatchWarnings(
      LEFT_NO_OVERLAP,
      RIGHT_NO_OVERLAP,
      "left",
      ON,
    );
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe("ZERO_MATCHES");
    // Must name the columns, the side that is null, and the row count — the
    // three facts a user needs to act without opening a shell.
    expect(w[0].message).toContain('"order_id" = "orderId"');
    expect(w[0].message).toContain("right-side columns are null");
    expect(w[0].message).toContain("2");
  });

  it("stays silent when every row matches", () => {
    const rows: Row[] = [{ order_id: "A" }, { order_id: "B" }];
    const right: Row[] = [{ orderId: "A" }, { orderId: "B" }];
    expect(buildJoinMatchWarnings(rows, right, "left", ON)).toEqual([]);
  });

  it("does not warn at a healthy partial match rate", () => {
    // 85% matched is the assignee case from the live pipeline: genuinely sparse
    // data, and warning on it would train users to ignore the warning.
    const left: Row[] = Array.from({ length: 100 }, (_, i) => ({
      order_id: String(i),
    }));
    const right: Row[] = Array.from({ length: 85 }, (_, i) => ({
      orderId: String(i),
    }));
    expect(buildJoinMatchWarnings(left, right, "left", ON)).toEqual([]);
  });

  it("reports a low match rate as sparse-or-suspect, not as zero", () => {
    const left: Row[] = Array.from({ length: 100 }, (_, i) => ({
      order_id: String(i),
    }));
    const right: Row[] = Array.from({ length: 20 }, (_, i) => ({
      orderId: String(i),
    }));
    const w = buildJoinMatchWarnings(left, right, "left", ON);
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe("LOW_MATCH_RATE");
    expect(w[0].message).toContain("20%");
    expect(w[0].message).toContain("80%");
    // A partial match is legitimate outer-join behaviour, so the wording must
    // not accuse the keys the way the zero case does.
    expect(w[0].message).not.toContain("share no values");
  });
});

describe("match counting matches executeJoin's key semantics", () => {
  it("treats null, empty and the string 'null' as non-matching", () => {
    // Palantir joinV2: null never equals null. Two rows that are both empty on
    // the key must not be counted as a match, or the rate would overstate.
    const left: Row[] = [
      { order_id: null },
      { order_id: "" },
      { order_id: "NULL" },
      { order_id: "real" },
    ];
    const right: Row[] = [
      { orderId: null },
      { orderId: "" },
      { orderId: "null" },
      { orderId: "real" },
    ];
    const { matched, probed } = computeJoinMatchRate(left, right, "left", ON);
    expect(probed).toBe(4);
    expect(matched).toBe(1); // only "real"
  });

  it("compares values as text, like the join itself", () => {
    // A CSV side reads "42" as a string while a cast side holds the number 42;
    // executeJoin compares String(lv) === String(rv), so this counts as a match.
    const { matched } = computeJoinMatchRate(
      [{ order_id: 42 }],
      [{ orderId: "42" }],
      "left",
      ON,
    );
    expect(matched).toBe(1);
  });

  it("requires every condition to match on a composite key", () => {
    const on = [
      { leftColumn: "a", rightColumn: "a" },
      { leftColumn: "b", rightColumn: "b" },
    ];
    const left: Row[] = [{ a: "1", b: "x" }, { a: "1", b: "y" }];
    const right: Row[] = [{ a: "1", b: "x" }];
    const { matched } = computeJoinMatchRate(left, right, "left", on);
    expect(matched).toBe(1); // the b: "y" row must not match
  });

  it("does not let composite parts run together across the separator", () => {
    // Joining key parts with a printable separator would make ("a b","c") and
    // ("a","b c") the same key and silently inflate the match rate.
    const on = [
      { leftColumn: "a", rightColumn: "a" },
      { leftColumn: "b", rightColumn: "b" },
    ];
    const { matched } = computeJoinMatchRate(
      [{ a: "a b", b: "c" }],
      [{ a: "a", b: "b c" }],
      "left",
      on,
    );
    expect(matched).toBe(0);
  });
});

describe("probe side follows which rows the join keeps", () => {
  it("probes the right input for a right join", () => {
    // A right join keeps right rows, so the unmatched-null columns are the
    // left ones and the denominator must be the right row count.
    const left: Row[] = [{ order_id: "A" }];
    const right: Row[] = [{ orderId: "X" }, { orderId: "Y" }, { orderId: "Z" }];
    const { probed, probeSide, matched } = computeJoinMatchRate(
      left,
      right,
      "right",
      ON,
    );
    expect(probeSide).toBe("right");
    expect(probed).toBe(3);
    expect(matched).toBe(0);
    const w = buildJoinMatchWarnings(left, right, "right", ON);
    expect(w[0].message).toContain("left-side columns are null");
    expect(w[0].message).toContain("3");
  });

  it("probes the left input for left and full_outer joins", () => {
    expect(
      computeJoinMatchRate(LEFT_NO_OVERLAP, RIGHT_NO_OVERLAP, "left", ON)
        .probeSide,
    ).toBe("left");
    expect(
      computeJoinMatchRate(LEFT_NO_OVERLAP, RIGHT_NO_OVERLAP, "full_outer", ON)
        .probeSide,
    ).toBe("left");
  });
});

describe("degenerate inputs produce no warning rather than a bad one", () => {
  it("says nothing when the probed side is empty", () => {
    // 0 of 0 matched is not a zero-match failure, and dividing by it must not
    // yield NaN% in a user-facing string.
    expect(buildJoinMatchWarnings([], RIGHT_NO_OVERLAP, "left", ON)).toEqual([]);
  });

  it("says nothing when there are no conditions", () => {
    expect(buildJoinMatchWarnings(LEFT_NO_OVERLAP, RIGHT_NO_OVERLAP, "left", []))
      .toEqual([]);
  });

  it("honours the column-name normalizer, so a BOM cannot fake zero matches", () => {
    // A leading BOM on a CSV header is stripped by the join, so the diagnostic
    // must strip it too or it would report ZERO_MATCHES on a working join.
    const left: Row[] = [{ order_id: "A" }];
    const right: Row[] = [{ orderId: "A" }];
    const on = [{ leftColumn: "﻿order_id", rightColumn: "orderId" }];
    const strip = (n: string) => n.replace(/^﻿/, "");
    expect(computeJoinMatchRate(left, right, "left", on, strip).matched).toBe(1);
    // Without the normalizer the key lookup misses and the rate collapses.
    expect(computeJoinMatchRate(left, right, "left", on).matched).toBe(0);
  });
});
