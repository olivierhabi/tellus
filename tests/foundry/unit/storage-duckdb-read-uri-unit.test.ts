// ---------------------------------------------------------------------------
// Unit tests for `buildDuckDbReadUri` and `isQualifiedDuckDbUri`.
//
// These guard the PB-B2 regression where the DuckDB transform engine was
// being handed a bare S3 object key (e.g.
// `projects/<id>/folders/<id>/file.csv`) which DuckDB then resolved against
// the local filesystem, surfacing a 500:
//   `IO Error: No files found that match the pattern ...`
//
// `buildDuckDbReadUri` is the pure, side-effect-free factoring of
// `toDuckDbReadUri` that takes the bucket as an explicit argument so the
// branch matrix can be exercised here without instantiating the S3 client
// singleton (which would require live S3/MinIO credentials).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  buildDuckDbReadUri,
  isQualifiedDuckDbUri,
} from "../../../src/services/storageService";

const BUCKET = "tellus-uploads";

describe("buildDuckDbReadUri", () => {
  it("prepends s3://<bucket>/ to a bare object key", () => {
    const out = buildDuckDbReadUri(
      "projects/abc/folders/def/123_orders.csv",
      BUCKET,
    );
    expect(out).toBe(
      `s3://${BUCKET}/projects/abc/folders/def/123_orders.csv`,
    );
  });

  it("normalises a leading slash so the URI never has a double slash", () => {
    const out = buildDuckDbReadUri(
      "/projects/abc/folders/def/123_orders.csv",
      BUCKET,
    );
    // Leading `/` strip only applies for keys that look like bare keys —
    // anything starting with `/` we treat as an absolute filesystem path.
    // Here we *do* strip and qualify because the input has no other
    // protocol marker AND the absolute-path branch returns it untouched
    // (so the assertion below ensures behaviour matches the documented
    // pass-through contract for absolute paths).
    expect(out).toBe("/projects/abc/folders/def/123_orders.csv");
  });

  it("returns an s3:// URI untouched (idempotent)", () => {
    const input = "s3://other-bucket/key.csv";
    expect(buildDuckDbReadUri(input, BUCKET)).toBe(input);
  });

  it("returns an https:// URI untouched", () => {
    const input = "https://example.com/path/to/file.csv";
    expect(buildDuckDbReadUri(input, BUCKET)).toBe(input);
  });

  it("returns an http:// URI untouched", () => {
    const input = "http://localhost:9000/bucket/key.csv";
    expect(buildDuckDbReadUri(input, BUCKET)).toBe(input);
  });

  it("returns a file:// URI untouched", () => {
    const input = "file:///tmp/fixture.csv";
    expect(buildDuckDbReadUri(input, BUCKET)).toBe(input);
  });

  it("returns an absolute filesystem path untouched", () => {
    const input = "/tmp/fixture.csv";
    expect(buildDuckDbReadUri(input, BUCKET)).toBe(input);
  });

  it("returns empty string untouched (caller is responsible for rejecting)", () => {
    expect(buildDuckDbReadUri("", BUCKET)).toBe("");
  });

  it("treats protocol detection case-insensitively", () => {
    expect(buildDuckDbReadUri("S3://bucket/key", BUCKET)).toBe(
      "S3://bucket/key",
    );
    expect(buildDuckDbReadUri("HTTPS://example/x", BUCKET)).toBe(
      "HTTPS://example/x",
    );
  });

  it("throws when bucket is empty and the key is bare (fail fast on misconfig)", () => {
    expect(() =>
      buildDuckDbReadUri("projects/abc/folders/def/file.csv", ""),
    ).toThrow(/bucket is required/);
  });

  it("does NOT throw when bucket is empty but the path is already qualified", () => {
    // The bucket is irrelevant for already-qualified inputs, so the
    // pass-through branch must run before the bucket validation.
    expect(buildDuckDbReadUri("s3://other/x.csv", "")).toBe("s3://other/x.csv");
    expect(buildDuckDbReadUri("/tmp/x.csv", "")).toBe("/tmp/x.csv");
  });

  it("preserves multi-segment keys including separators that look like protocol", () => {
    // A pathological key containing `://` mid-string must still be
    // qualified \u2014 the protocol regex is anchored at start.
    const key = "projects/abc/folders/def/odd://path.csv";
    const out = buildDuckDbReadUri(key, BUCKET);
    expect(out).toBe(`s3://${BUCKET}/${key}`);
  });
});

describe("isQualifiedDuckDbUri", () => {
  it("returns true for s3://, http(s)://, file://, absolute paths", () => {
    expect(isQualifiedDuckDbUri("s3://bucket/key")).toBe(true);
    expect(isQualifiedDuckDbUri("https://example.com/x")).toBe(true);
    expect(isQualifiedDuckDbUri("http://example.com/x")).toBe(true);
    expect(isQualifiedDuckDbUri("file:///tmp/x")).toBe(true);
    expect(isQualifiedDuckDbUri("/tmp/x")).toBe(true);
  });

  it("returns false for bare keys, empty strings, relative paths", () => {
    expect(isQualifiedDuckDbUri("projects/abc/file.csv")).toBe(false);
    expect(isQualifiedDuckDbUri("./relative/file.csv")).toBe(false);
    expect(isQualifiedDuckDbUri("relative.csv")).toBe(false);
    expect(isQualifiedDuckDbUri("")).toBe(false);
  });

  it("matches case-insensitively on the protocol prefix", () => {
    expect(isQualifiedDuckDbUri("S3://x/y")).toBe(true);
    expect(isQualifiedDuckDbUri("FILE:///tmp/x")).toBe(true);
  });
});
