// ---------------------------------------------------------------------------
// Unit tests for the streaming + OOM-safe metadata extraction in
// src/services/uploadService.ts.
//
// What's being protected here:
//   - extractJsonMetadata used to fs.readFileSync the *entire* file, so a 1 GB
//     JSON/JSONL upload (now permitted by the raised MAX_FILE_SIZE) would OOM
//     the process at metadata-extraction time. The JSONL branch now streams
//     line-by-line; the JSON-array branch is size-guarded.
//
// Pure unit — no S3/PG/Keycloak. Uses temp files under os.tmpdir().
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Force the inline-JSON cap down to 1 MB so the over-cap branch can be
// exercised with a small fixture instead of a 64 MB file. Must run before
// uploadService.ts is evaluated — its MAX_INLINE_JSON_BYTES is computed once
// at module load from process.env.MAX_INLINE_JSON_MB.
vi.hoisted(() => {
  process.env.MAX_INLINE_JSON_MB = "1";
});

// Imported AFTER the hoisted env assignment takes effect.
import { extractJsonMetadata } from "../../src/services/uploadService";

afterAll(() => {
  delete process.env.MAX_INLINE_JSON_MB;
});

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-stream-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("extractJsonMetadata — JSONL streaming", () => {
  it("counts every row without buffering them all (samples are capped)", async () => {
    // 5 000 records — large enough that the old readFileSync+split path would
    // build a 5 000-element array; the streaming path keeps only <= 10 samples.
    const n = 5_000;
    const lines = Array.from(
      { length: n },
      (_, i) => `{"id":${i},"name":"row${i}","score":${i / 7}}`,
    );
    const p = tmpFile("big.jsonl", lines.join("\n") + "\n");

    const meta = await extractJsonMetadata(p, "jsonl");

    expect(meta.rowCount).toBe(n);
    expect(meta.sampleRows.length).toBe(10); // MAX_SAMPLE_ROWS
    expect(meta.columnNames).toContain("id");
    expect(meta.columnNames).toContain("name");
    expect(meta.columnNames).toContain("score");
    expect(meta.fileSizeBytes).toBeGreaterThan(0);
    // Keys are unioned only from the sampled rows (first 10), matching the
    // legacy contract — not from every row.
    expect(meta.columnNames.length).toBe(3);
  });

  it("skips blank and malformed lines (counts only valid object records)", async () => {
    const p = tmpFile(
      "mixed.jsonl",
      [
        '{"id":1}', // valid
        "", // blank — skip
        "   ", // whitespace — skip
        "{not valid json", // malformed — skip (matches old .map().filter() behavior)
        '{"id":2}', // valid
        "[]", // valid JSON but an array — not an object record, skip
        "null", // valid JSON but null — skip
        "42", // valid JSON but primitive — skip
        '{"id":3}', // valid
      ].join("\n") + "\n",
    );

    const meta = await extractJsonMetadata(p, "jsonl");

    expect(meta.rowCount).toBe(3); // only id=1,2,3
    expect(meta.columnNames).toEqual(["id"]);
  });

  it("handles an empty JSONL file (0 rows, 0 columns)", async () => {
    const p = tmpFile("empty.jsonl", "");
    const meta = await extractJsonMetadata(p, "jsonl");
    expect(meta.rowCount).toBe(0);
    expect(meta.columnNames).toEqual([]);
    expect(meta.sampleRows).toEqual([]);
  });
});

describe("extractJsonMetadata — JSON array (size-guarded)", () => {
  it("parses a small top-level array under the cap", async () => {
    const p = tmpFile(
      "small.json",
      JSON.stringify([
        { id: 1, name: "Alice", score: 95.5 },
        { id: 2, name: "Bob", score: 88 },
      ]),
    );
    const meta = await extractJsonMetadata(p, "json");
    expect(meta.rowCount).toBe(2);
    expect(meta.columnNames).toContain("id");
    expect(meta.columnNames).toContain("name");
    expect(meta.columnNames).toContain("score");
  });

  it("refuses a JSON array over the inline cap (OOM guard) with a JSONL hint", async () => {
    // ~2 MB of JSON-array content — over the 1 MB cap forced above.
    const big = "[" + Array.from(
      { length: 50_000 },
      (_, i) => `{"id":${i},"pad":"${"x".repeat(20)}"}`,
    ).join(",") + "]";
    const p = tmpFile("big.json", big);
    expect(fs.statSync(p).size).toBeGreaterThan(1 * 1024 * 1024);

    await expect(extractJsonMetadata(p, "json")).rejects.toThrow(
      /capped|JSONL/i,
    );
  });

  it("rejects a non-array JSON document", async () => {
    const p = tmpFile("obj.json", JSON.stringify({ key: "value" }));
    await expect(extractJsonMetadata(p, "json")).rejects.toThrow(
      /top-level array/i,
    );
  });
});
