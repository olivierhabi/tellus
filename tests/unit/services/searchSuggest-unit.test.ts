// ---------------------------------------------------------------------------
// searchSuggest-unit.test.ts
// ---------------------------------------------------------------------------
// Pure-unit coverage for the algorithmic core of
// `SearchService.suggest` — the autocomplete suggester that powers the
// `SelectDatasetDialog` "JUMP TO" overlay in tellus-fe.
//
// What this file pins:
//
//   1. **Tokenization semantics.** "customer da", "customer_data",
//      "customer-data", "customer/data", and "customer.data" all
//      tokenize to the same `['customer', 'data']`. This is the
//      single most user-visible guarantee — without it, the live
//      curl reproducer the user reported (`q=customer da` returning
//      `[]`) is the *correct* behavior.
//
//   2. **Escape correctness.** `escapeLikePattern` neutralizes SQL
//      LIKE wildcards so a malicious `100%_` token can't widen a
//      `%token%` filter to "everything containing `100`".
//
//   3. **Ranking heuristics.** Exact-name > prefix > all-tokens-in-
//      name > path-token > recency. The numeric spread between
//      classes (1000 / 500 / 200 / 50 / 20) is wide enough that the
//      relative ordering of any two rows is fully determined by the
//      highest class they both differ on — these tests pin that
//      property by composing rows that disagree on exactly one
//      class at a time.
//
// SQL behavior (knex chain wiring, table joins, transactional
// isolation) lives in the integration suite — pure tokenization and
// scoring is what's covered here.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  tokenizeSearchQuery,
  escapeLikePattern,
  scoreSuggestion,
  type ScoreInput,
} from "../../../src/services/searchService";

describe("tokenizeSearchQuery", () => {
  describe("equivalence classes — separators that should tokenize identically", () => {
    // Each row in this matrix should produce the SAME token list.
    // The tokenizer's primary job is to make these visually-different
    // queries yield the same matcher behavior — the user shouldn't
    // have to know whether the file on disk uses `_`, `-`, `/`, or
    // a literal space.
    it.each([
      ["whitespace",       "customer da",       ["customer", "da"]],
      ["underscore",       "customer_da",       ["customer", "da"]],
      ["dash",             "customer-da",       ["customer", "da"]],
      ["slash",            "customer/da",       ["customer", "da"]],
      ["dot",              "customer.da",       ["customer", "da"]],
      ["mixed sep run",    "customer__/da",     ["customer", "da"]],
      ["leading sep",      "  customer da ",    ["customer", "da"]],
      ["mixed case",       "Customer DA",       ["customer", "da"]],
    ])("'%s' (%s) → %j", (_label, input, expected) => {
      expect(tokenizeSearchQuery(input)).toEqual(expected);
    });
  });

  describe("edge cases", () => {
    it("returns [] for empty input", () => {
      expect(tokenizeSearchQuery("")).toEqual([]);
    });

    it("returns [] for whitespace-only input", () => {
      expect(tokenizeSearchQuery("    ")).toEqual([]);
    });

    it("returns [] for separator-only input (no token survives split)", () => {
      // Without this guard the `%%`-pattern would match every row
      // in the database — the regression that motivated the explicit
      // empty-token filter inside the tokenizer.
      expect(tokenizeSearchQuery("__//..")).toEqual([]);
    });

    it("preserves single-letter tokens", () => {
      // A user typing just "a" should still get a meaningful prefix
      // hit; we deliberately do NOT drop length-1 tokens.
      expect(tokenizeSearchQuery("a b")).toEqual(["a", "b"]);
    });

    it("collapses runs of whitespace into a single split", () => {
      expect(tokenizeSearchQuery("foo     bar")).toEqual(["foo", "bar"]);
    });

    it("handles unicode letters without splitting them", () => {
      // The tokenizer splits on ASCII separators only — non-ASCII
      // letters stay glued together.
      expect(tokenizeSearchQuery("café données")).toEqual(["café", "données"]);
    });
  });
});

describe("escapeLikePattern", () => {
  it("escapes `%` so it isn't treated as a wildcard", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
  });

  it("escapes `_` so it isn't treated as a single-char wildcard", () => {
    // Without this, `customer_da` would be a *pattern* (any single
    // char between `customer` and `da`) rather than a literal — a
    // user-visible drift between what they typed and what matched.
    expect(escapeLikePattern("customer_da")).toBe("customer\\_da");
  });

  it("escapes the escape character itself (no double-meaning)", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("leaves regular characters alone", () => {
    expect(escapeLikePattern("customer.csv")).toBe("customer.csv");
  });

  it("is idempotent under composition with substring wrapping", () => {
    // The pattern actually used at the call site is `%${escaped}%`.
    // The wrapper `%`s must remain literal wildcards and the inner
    // `%`s must remain escaped — pin both halves.
    const escaped = escapeLikePattern("ab%cd");
    expect(escaped).toBe("ab\\%cd");
    expect(`%${escaped}%`).toBe("%ab\\%cd%");
  });
});

describe("scoreSuggestion", () => {
  // A frozen "now" so recency contributions are deterministic across
  // runs. All `updatedAt` values below are expressed relative to this
  // instant.
  const NOW = Date.parse("2026-04-27T12:00:00Z");
  const score = (
    row: ScoreInput,
    query: string,
    tokens?: string[],
  ): number => scoreSuggestion(row, query, tokens ?? tokenizeSearchQuery(query), NOW);

  // Helpers that pin individual classes of the ranking by holding
  // every other contributor constant. Each pair of `expect(score)`
  // assertions in `describe('class ordering')` below differs on
  // EXACTLY ONE class — read them as "this class beats that class
  // when nothing else differs".
  const dataset = (overrides: Partial<ScoreInput>): ScoreInput => ({
    name: "noise",
    path: "/Acme/noise",
    type: "dataset",
    updatedAt: undefined,
    ...overrides,
  });

  describe("class ordering — higher class always beats every lower class on its own", () => {
    it("exact-name match (1000+) beats prefix match (500)", () => {
      const exact = dataset({ name: "customer", path: "/Acme/customer" });
      const prefix = dataset({ name: "customerville", path: "/Acme/customerville" });
      expect(score(exact, "customer")).toBeGreaterThan(score(prefix, "customer"));
    });

    it("prefix match (500+) beats all-tokens-in-name match (200)", () => {
      const prefix = dataset({ name: "customer_xyz", path: "/Acme/customer_xyz" });
      const allTokens = dataset({
        name: "xyz_customer_da",
        path: "/Acme/xyz_customer_da",
      });
      expect(score(prefix, "customer")).toBeGreaterThan(score(allTokens, "customer"));
    });

    it("all-tokens-in-name (200+) beats path-only token match (50)", () => {
      const inName = dataset({
        name: "customer_data_dump",
        path: "/Acme/Other/customer_data_dump",
      });
      const inPath = dataset({
        name: "irrelevant_dump",
        path: "/Acme/customer/data/irrelevant_dump",
      });
      expect(score(inName, "customer da")).toBeGreaterThan(
        score(inPath, "customer da"),
      );
    });

    it("path-token match (50+) beats type prior alone", () => {
      const inPath = dataset({
        name: "untitled",
        path: "/Acme/customer/untitled",
      });
      const noMatch = dataset({ name: "untitled", path: "/Acme/Other/untitled" });
      expect(score(inPath, "customer")).toBeGreaterThan(score(noMatch, "customer"));
    });

    it("recency boost (20) is dominated by all-tokens-in-name (200)", () => {
      // A dataset with a stale timestamp but matching every token
      // must outrank a fresher dataset that misses tokens. This is
      // the test that prevents the recency boost from accidentally
      // flipping ordering classes.
      const stale = dataset({
        name: "customer_data",
        path: "/Acme/customer_data",
        updatedAt: "2025-01-01T00:00:00Z",
      });
      const freshButOff = dataset({
        name: "customer",
        path: "/Acme/customer",
        updatedAt: new Date(NOW - 60_000).toISOString(),
      });
      // `customer_data` matches both `customer` AND `data` tokens →
      // +200; `customer` only matches `customer` → no all-tokens
      // bonus, only the type prior + maybe path bonus.
      expect(score(stale, "customer da")).toBeGreaterThan(
        score(freshButOff, "customer da"),
      );
    });
  });

  describe("type prior — dataset > folder > pipeline > project for otherwise-equal rows", () => {
    const make = (type: ScoreInput["type"]): ScoreInput => ({
      name: "x",
      path: "/x",
      type,
      updatedAt: undefined,
    });
    it("dataset > folder > pipeline > project on the type prior alone", () => {
      const ds = score(make("dataset"), "x");
      const fo = score(make("folder"), "x");
      const pi = score(make("pipeline"), "x");
      const pr = score(make("project"), "x");
      expect(ds).toBeGreaterThan(fo);
      expect(fo).toBeGreaterThan(pi);
      expect(pi).toBeGreaterThan(pr);
    });
  });

  describe("recency boost", () => {
    it("adds for rows updated within the last 7 days", () => {
      const recent = dataset({
        updatedAt: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
      });
      const ancient = dataset({
        updatedAt: "2020-01-01T00:00:00Z",
      });
      expect(score(recent, "noise")).toBeGreaterThan(score(ancient, "noise"));
    });

    it("contributes nothing for missing or unparseable timestamps", () => {
      const missing = dataset({ updatedAt: undefined });
      const garbage = dataset({ updatedAt: "not-a-date" });
      // No throw, no score difference vs each other.
      expect(score(missing, "noise")).toBe(score(garbage, "noise"));
    });
  });

  describe("path-token contribution scales with token coverage", () => {
    it("each additional token found in the path adds another +50", () => {
      const onePath = dataset({
        name: "irrelevant",
        path: "/Acme/customer/Other",
      });
      const twoPath = dataset({
        name: "irrelevant",
        path: "/Acme/customer/data",
      });
      // Same name (no name match), same type, no recency. The only
      // difference is `data` appears in `twoPath`'s path.
      expect(score(twoPath, "customer da") - score(onePath, "customer da"))
        .toBe(50);
    });
  });
});
