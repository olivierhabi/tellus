/**
 * csvHeader-unit.test.ts — locks the header-sanitization contract.
 *
 * Background: `csv-parse` with `columns: true` collapses duplicate /
 * blank header cells via JS object-key dedup, which silently drops
 * columns from the dataset schema. `sanitizeCsvHeader` is wired into
 * every csv-parse call site to prevent that. These tests pin its
 * behaviour so the bug — observed in production as
 * "orders_bureau_transactional_system.csv 7 columns" for a 9-column
 * file — cannot regress.
 */
import { describe, expect, it } from "vitest";

import {
  sanitizeCsvHeader,
  stripZeroWidth,
} from "../../../src/utils/csvHeader";

describe("sanitizeCsvHeader", () => {
  it("returns a clean header unchanged", () => {
    const out = sanitizeCsvHeader(["order_id", "amount", "ts"]);
    expect(out).toEqual(["order_id", "amount", "ts"]);
  });

  it("preserves cardinality: length(out) === length(in)", () => {
    // The whole reason this module exists.
    const out = sanitizeCsvHeader(["a", "a", "", "b", ""]);
    expect(out).toHaveLength(5);
  });

  it("renames duplicate header cells with numeric suffixes", () => {
    const out = sanitizeCsvHeader(["amount", "amount", "amount"]);
    expect(out).toEqual(["amount", "amount_2", "amount_3"]);
  });

  it("fills blank header cells with positional names", () => {
    const out = sanitizeCsvHeader(["a", "", "b", ""]);
    expect(out).toEqual(["a", "column_2", "b", "column_4"]);
  });

  it("handles the production case: 9 cells, 2 blanks, 0 duplicates", () => {
    // Models the bad header observed on
    // orders_bureau_transactional_system.csv — trailing commas
    // produced two empty header cells, which csv-parse's default
    // collapsed into a single "" key, yielding 7 columns from 9 data
    // cells.
    const header = [
      "order_id",
      "customer_id",
      "amount",
      "currency",
      "status",
      "created_at",
      "updated_at",
      "",
      "",
    ];
    const out = sanitizeCsvHeader(header);
    expect(out).toHaveLength(9);
    expect(out).toEqual([
      "order_id",
      "customer_id",
      "amount",
      "currency",
      "status",
      "created_at",
      "updated_at",
      "column_8",
      "column_9",
    ]);
  });

  it("strips BOM/zero-width chars and trims whitespace", () => {
    const out = sanitizeCsvHeader([
      "\uFEFForder_id",
      "  amount  ",
      "ts\u200B",
    ]);
    expect(out).toEqual(["order_id", "amount", "ts"]);
  });

  it("avoids suffix collisions when the suffixed name already exists", () => {
    // Original header already contains `amount_2` and `amount_3`; the
    // duplicate must skip to `amount_4`.
    const out = sanitizeCsvHeader([
      "amount",
      "amount_2",
      "amount_3",
      "amount",
    ]);
    expect(out).toEqual(["amount", "amount_2", "amount_3", "amount_4"]);
  });

  it("treats whitespace-only cells as blanks", () => {
    const out = sanitizeCsvHeader(["a", "   ", "b"]);
    expect(out).toEqual(["a", "column_2", "b"]);
  });

  it("emits a structured warning when any cell is mutated", () => {
    const logs: string[] = [];
    sanitizeCsvHeader(["amount", "amount", ""], {
      source: "s3://bucket/test.csv",
      log: (line) => logs.push(line),
    });
    expect(logs).toHaveLength(1);
    // The token `"event":"csv_header_sanitized"` is the runbook hook —
    // log scrapers (Loki/Datadog) alert on it. Do not rename without
    // coordinating with ops.
    expect(logs[0]).toContain('"event":"csv_header_sanitized"');
    expect(logs[0]).toContain("s3://bucket/test.csv");
    // The single line must be valid JSON-ish so log aggregators can
    // parse it. We extract everything after the prefix and JSON.parse.
    const json = JSON.parse(logs[0].replace(/^\[csvHeader\] /, ""));
    expect(json.event).toBe("csv_header_sanitized");
    expect(json.header_length).toBe(3);
    expect(json.filled_blanks_at).toEqual([3]);
    expect(json.renamed_duplicates).toEqual([
      { original: "amount", renamed: "amount_2", ordinal: 2 },
    ]);
  });

  it("emits no warning on a clean header", () => {
    const logs: string[] = [];
    sanitizeCsvHeader(["a", "b", "c"], { log: (l) => logs.push(l) });
    expect(logs).toHaveLength(0);
  });

  it("survives a header of all duplicates without collisions", () => {
    // Stress: every cell is the same name; the output must still be
    // unique and length-preserving.
    const out = sanitizeCsvHeader(["x", "x", "x", "x", "x"]);
    expect(out).toHaveLength(5);
    expect(new Set(out).size).toBe(5);
  });

  it("survives a header of all blanks without collisions", () => {
    const out = sanitizeCsvHeader(["", "", "", ""]);
    expect(out).toEqual(["column_1", "column_2", "column_3", "column_4"]);
  });

  it("guarantees uniqueness across mixed blank + duplicate inputs", () => {
    // Realistic worst case — every kind of malformity at once.
    const out = sanitizeCsvHeader([
      "id",
      "",
      "amount",
      "amount",
      "",
      "id",
    ]);
    expect(out).toHaveLength(6);
    expect(new Set(out).size).toBe(6);
  });
});

describe("stripZeroWidth", () => {
  it("removes BOM (U+FEFF)", () => {
    expect(stripZeroWidth("\uFEFFhello")).toBe("hello");
  });

  it("removes zero-width spaces (U+200B-U+200D, U+2060)", () => {
    expect(stripZeroWidth("a\u200Bb\u200Cc\u200Dd\u2060e")).toBe("abcde");
  });

  it("is a no-op on clean input", () => {
    expect(stripZeroWidth("plain")).toBe("plain");
  });
});
