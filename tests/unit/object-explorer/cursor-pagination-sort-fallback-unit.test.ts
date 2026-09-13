// ---------------------------------------------------------------------------
// Cursor pagination — `_sort` fallback (2026-09 regression fix).
//
// OpenSearch/Elasticsearch 7.5+ only populates `hit._sort` for non-fielddata
// sort criteria. A sort clause consisting solely of keyword doc-value fields
// (the injected `__pk` tiebreaker — the DEFAULT for unfiltered searches)
// triggers an optimization that omits `_sort` from every hit, which made
// `nextPageToken` permanently null on the default Object Table page and broke
// infinite scroll end-to-end. `resolveHitSortValues` recovers the doc-values
// from `hit._source` so cursor pagination works for EVERY sort shape.
//
// Pins:
//   1. `formatObjectList` emits a token when `_sort` is ABSENT (keyword-only
//      sort) — previously returned null.
//   2. Token absent only when genuinely unsortable (missing criteria in both
//      `_sort` AND `_source`).
//   3. No more pages ⇒ null token (last page) — unchanged.
//   4. `_sort` path still preferred when present and complete.
//   5. orderBy + __pk tiebreaker parity with `buildSortClause` — positional.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  formatObjectList,
  resolveHitSortValues,
} from "../../../src/services/objectResponseFormatter";

function makeResponse(pkValues: string[]): unknown {
  return {
    hits: {
      total: { value: 1000, relation: "eq" },
      hits: pkValues.map((pk) => ({
        _index: "ontology-testtype",
        _id: pk,
        _source: { __pk: pk, __objectType: "TestType", name: `n-${pk}` },
        // NOTE: no `sort` / `_sort` — reproduces the keyword-only omission.
      })),
    },
  };
}

const NO_ORDERBY: Array<{ field: string; direction: string }> = [];

describe("resolveHitSortValues — keyword-only sort fallback", () => {
  it("derives __pk cursor from _source when _sort is omitted", () => {
    const hit = { _source: { __pk: "EMP-007", __objectType: "T", name: "x" } };
    expect(resolveHitSortValues(hit, NO_ORDERBY)).toEqual(["EMP-007"]);
  });

  it("prefers a complete _sort array over _source", () => {
    const hit = {
      _sort: ["s-pk"],
      _source: { __pk: "EMP-007", __objectType: "T" },
    };
    expect(resolveHitSortValues(hit, NO_ORDERBY)).toEqual(["s-pk"]);
  });

  it("honours orderBy fields + __pk tiebreaker positionally", () => {
    const hit = {
      _source: {
        __pk: "EMP-007",
        __objectType: "T",
        salary: 42000,
        __primaryKey: "EMP-007",
      },
    };
    expect(
      resolveHitSortValues(hit, [{ field: "salary", direction: "desc" }]),
    ).toEqual([42000, "EMP-007"]);
  });

  it("returns null when a criterion is absent from both _sort and _source", () => {
    const hit = { _source: { __objectType: "T", name: "x" } };
    expect(resolveHitSortValues(hit, NO_ORDERBY)).toBeNull();
  });

  it("resolves the indexed __pk field (raw OpenSearch hit shape)", () => {
    // OpenSearch indexes `__pk` (the API envelope projects it as
    // `__primaryKey`); the cursor fallback reads the RAW `_source`.
    const hit = {
      _source: { __pk: "EMP-009", __objectType: "T" },
    };
    expect(resolveHitSortValues(hit, NO_ORDERBY)).toEqual(["EMP-009"]);
  });
});

describe("formatObjectList — nextPageToken on keyword-only sorts", () => {
  it("emits a cursor when there are more pages (unfiltered pk sort)", () => {
    // pageSize 2 over 3 hits → hasMore, and the fallback must supply the
    // cursor even though every hit lacks `_sort`.
    const res = formatObjectList(
      makeResponse(["EMP-001", "EMP-002", "EMP-003"]),
      "TestType",
      ["name"],
      undefined,
      NO_ORDERBY,
      undefined,
      2,
    );
    expect(res.data.length).toBe(2);
    expect(res.totalCount).toBe(1000);
    expect(typeof res.nextPageToken).toBe("string");
    // The token decodes to the last row's __pk — a valid search_after cursor.
    const decoded = JSON.parse(
      Buffer.from(res.nextPageToken!, "base64").toString("utf-8"),
    );
    expect(decoded.sort).toEqual(["EMP-002"]);
  });

  it("returns null token on the last page (no more hits)", () => {
    const res = formatObjectList(
      makeResponse(["EMP-001", "EMP-002"]),
      "TestType",
      ["name"],
      undefined,
      NO_ORDERBY,
      undefined,
      2,
    );
    expect(res.nextPageToken).toBeNull();
  });

  it("emits an ordered cursor for a property sort + __pk tiebreaker", () => {
    const response = {
      hits: {
        total: { value: 1000, relation: "eq" },
        hits: [
          { _id: "a", _source: { __pk: "a", salary: 500 } },
          { _id: "b", _source: { __pk: "b", salary: 400 } },
          { _id: "c", _source: { __pk: "c", salary: 300 } },
        ],
      },
    };
    const res = formatObjectList(
      response,
      "TestType",
      ["salary"],
      undefined,
      [{ field: "salary", direction: "desc" }],
      undefined,
      2,
    );
    expect(typeof res.nextPageToken).toBe("string");
    const decoded = JSON.parse(
      Buffer.from(res.nextPageToken!, "base64").toString("utf-8"),
    );
    // Positional: [salary-value, __pk] — exactly what search_after needs.
    expect(decoded.sort).toEqual([400, "b"]);
  });
});
