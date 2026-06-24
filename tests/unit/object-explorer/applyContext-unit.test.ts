// ---------------------------------------------------------------------------
// T-01 — applyContext canonical helper unit tests.
//
// Covers contracts C-01..C-06, C-10 (see tasks/object-explorer/contracts.md).
// Property test uses seedrandom with a fixed seed so the suite is
// deterministic per the cross-cutting test rules. fast-check is not
// installed (see decisions/object-explorer/D-2026-04-30-003).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import seedrandom from "seedrandom";
import {
  applyContextToQuery,
  applyContextToBody,
  flattenAppliedContextOnce,
} from "../../../src/services/opensearch/applyContext";

const COMPLEX_Q: Record<string, unknown> = {
  bool: {
    must: [
      { term: { status: "active" } },
      { range: { ageInDays: { gte: 0, lt: 30 } } },
    ],
  },
};

const SEC: Record<string, unknown> = {
  bool: { must: [{ terms: { "_security.markings.keyword": ["SECRET"] } }] },
};

const BRANCH = "11111111-1111-1111-1111-111111111111";

describe("T-01 applyContextToQuery — Cartesian (C-01..C-04)", () => {
  it("T-01 C-01a: match_all + null sec + null branch → unchanged reference", () => {
    const q = { match_all: {} };
    expect(applyContextToQuery(q, null, null)).toBe(q);
  });

  it("T-01 C-01b: complex query + null sec + null branch → unchanged reference", () => {
    expect(applyContextToQuery(COMPLEX_Q, null, null)).toBe(COMPLEX_Q);
  });

  it("T-01 C-04a: empty-string branch + null sec → unchanged reference (empty == null)", () => {
    expect(applyContextToQuery(COMPLEX_Q, null, "")).toBe(COMPLEX_Q);
  });

  it("T-01 C-04b: undefined branch + undefined sec → unchanged reference", () => {
    expect(applyContextToQuery(COMPLEX_Q, undefined, undefined)).toBe(
      COMPLEX_Q,
    );
  });

  it("T-01 C-02a: match_all + sec + null branch → bool.must=[orig, sec]", () => {
    const out = applyContextToQuery({ match_all: {} }, SEC, null) as {
      bool: { must: unknown[] };
    };
    expect(out.bool.must).toHaveLength(2);
    expect(out.bool.must[0]).toEqual({ match_all: {} });
    expect(out.bool.must[1]).toEqual(SEC);
  });

  it("T-01 C-02b: complex + sec + null branch → bool.must=[complex, sec]", () => {
    const out = applyContextToQuery(COMPLEX_Q, SEC, null) as {
      bool: { must: unknown[] };
    };
    expect(out.bool.must).toEqual([COMPLEX_Q, SEC]);
  });

  it("T-01 C-03a: match_all + null sec + branch → bool.must=[orig, branch-disjunct]", () => {
    const out = applyContextToQuery({ match_all: {} }, null, BRANCH) as {
      bool: { must: unknown[] };
    };
    expect(out.bool.must).toHaveLength(2);
    expect(out.bool.must[0]).toEqual({ match_all: {} });
    expect(out.bool.must[1]).toEqual({
      bool: {
        should: [
          { term: { __branch: BRANCH } },
          { bool: { must_not: [{ exists: { field: "__branch" } }] } },
        ],
        minimum_should_match: 1,
      },
    });
  });

  it("T-01 C-03b: complex + sec + branch → bool.must=[complex, sec, branch]", () => {
    const out = applyContextToQuery(COMPLEX_Q, SEC, BRANCH) as {
      bool: { must: unknown[] };
    };
    expect(out.bool.must).toHaveLength(3);
    expect(out.bool.must[0]).toBe(COMPLEX_Q);
    expect(out.bool.must[1]).toBe(SEC);
    expect((out.bool.must[2] as any).bool.minimum_should_match).toBe(1);
  });
});

describe("T-01 applyContextToQuery — purity (C-05)", () => {
  it("T-01 C-05a: input query is not mutated", () => {
    const original: Record<string, unknown> = {
      bool: { must: [{ term: { x: 1 } }] },
    };
    const snapshot = JSON.stringify(original);
    applyContextToQuery(original, SEC, BRANCH);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("T-01 C-05b: input securityFilter is not mutated", () => {
    const sec: Record<string, unknown> = JSON.parse(JSON.stringify(SEC));
    const snapshot = JSON.stringify(sec);
    applyContextToQuery(COMPLEX_Q, sec, BRANCH);
    expect(JSON.stringify(sec)).toBe(snapshot);
  });
});

describe("T-01 applyContextToBody — body shim (C-06)", () => {
  it("T-01 C-06a: defaults missing query to match_all", () => {
    const out = applyContextToBody({ size: 10 }, SEC, null) as Record<
      string,
      unknown
    >;
    expect(out.size).toBe(10);
    expect((out.query as any).bool.must[0]).toEqual({ match_all: {} });
  });

  it("T-01 C-06b: passes through aggs/_source/sort untouched", () => {
    const body = {
      size: 0,
      query: { match_all: {} },
      aggs: { byField: { terms: { field: "x" } } },
      _source: false,
      sort: [{ ts: "desc" }],
    };
    const out = applyContextToBody(body, SEC, BRANCH) as Record<
      string,
      unknown
    >;
    expect(out.size).toBe(0);
    expect(out.aggs).toEqual(body.aggs);
    expect(out._source).toBe(false);
    expect(out.sort).toEqual(body.sort);
  });

  it("T-01 C-06c: null sec + null branch returns body shape with original (or default) query", () => {
    const body = { size: 5, query: COMPLEX_Q };
    const out = applyContextToBody(body, null, null);
    expect(out).toEqual({ size: 5, query: COMPLEX_Q });
  });
});

// ---------------------------------------------------------------------------
// Property test — wrapper idempotence after one canonical normalization.
//
// Generates 200 random nested bool shapes and asserts:
//   normalise(apply(apply(q, S, B), S, B)) === apply(q, S, B)
//
// `flattenAppliedContextOnce` peels the redundant outer layer when
// `apply` is invoked on an already-applied tree with the same clauses.
// ---------------------------------------------------------------------------

describe("T-01 applyContextToQuery — property: idempotent shape (C-10)", () => {
  const TRIALS = 200;
  const SEED = "T-01-applyContext-idempotence-2026-04-30";

  it(`T-01 C-10: applying twice with same args has same canonical shape (${TRIALS} trials)`, () => {
    const rng = seedrandom(SEED);

    function genLeaf(): Record<string, unknown> {
      const kinds = ["term", "range", "exists", "match"];
      const k = kinds[Math.floor(rng() * kinds.length)];
      switch (k) {
        case "term":
          return { term: { [`f${Math.floor(rng() * 5)}`]: rng() } };
        case "range":
          return {
            range: { [`f${Math.floor(rng() * 5)}`]: { gte: rng() } },
          };
        case "exists":
          return { exists: { field: `f${Math.floor(rng() * 5)}` } };
        default:
          return { match: { [`f${Math.floor(rng() * 5)}`]: "v" } };
      }
    }

    function genQuery(depth: number): Record<string, unknown> {
      if (depth <= 0 || rng() < 0.4) return genLeaf();
      const armCount = 1 + Math.floor(rng() * 3);
      const arms: Record<string, unknown>[] = [];
      for (let i = 0; i < armCount; i++) arms.push(genQuery(depth - 1));
      const op = rng() < 0.5 ? "must" : "should";
      return op === "should"
        ? { bool: { should: arms, minimum_should_match: 1 } }
        : { bool: { must: arms } };
    }

    let failures = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      const q = genQuery(3);
      const sec = rng() < 0.5 ? SEC : null;
      const branch = rng() < 0.5 ? BRANCH : null;

      const once = applyContextToQuery(q, sec, branch);
      const twice = applyContextToQuery(once, sec, branch);

      // When neither is applied, twice === once (both equal q).
      if (sec === null && branch === null) {
        if (once !== q || twice !== q) failures++;
        continue;
      }

      // Otherwise, peel one redundant layer from `twice` and compare.
      const peeled = flattenAppliedContextOnce(twice);
      if (JSON.stringify(peeled) !== JSON.stringify(once)) {
        failures++;
      }
    }
    expect(failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sanity: applyContextToBody respects the C-04 rule on empty-branch.
// ---------------------------------------------------------------------------

describe("T-01 applyContextToBody — empty branch (C-04)", () => {
  it("T-01 C-04c: body with no clauses requested → body returned as-is shape", () => {
    const body = { size: 1, query: COMPLEX_Q };
    const out = applyContextToBody(body, null, "");
    expect(out).toEqual({ size: 1, query: COMPLEX_Q });
  });
});
