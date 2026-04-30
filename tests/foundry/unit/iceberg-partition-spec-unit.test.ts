// ---------------------------------------------------------------------------
// PB-B4 — Iceberg partition-spec validator (unit).
// No sidecar, no catalog; pure input/output assertions.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  validatePartitionSpec,
  type OutputColumn,
} from "../../../src/services/pipelines/icebergPartitionSpec";

const COLUMNS: OutputColumn[] = [
  { name: "order_id", type: "integer" },
  { name: "event_date", type: "date" },
  { name: "created_at", type: "timestamp" },
  { name: "tenant", type: "string" },
];

describe("validatePartitionSpec", () => {
  it("returns [] for null / undefined / empty", () => {
    expect(validatePartitionSpec(null, COLUMNS)).toEqual([]);
    expect(validatePartitionSpec(undefined, COLUMNS)).toEqual([]);
    expect(validatePartitionSpec([], COLUMNS)).toEqual([]);
  });

  it("accepts identity on any column type", () => {
    const out = validatePartitionSpec(
      [{ column: "tenant" }, { column: "order_id", transform: "identity" }],
      COLUMNS,
    );
    expect(out.map((p) => p.column)).toEqual(["tenant", "order_id"]);
  });

  it("accepts day/month/year/hour on date+timestamp columns", () => {
    const out = validatePartitionSpec(
      [
        { column: "event_date", transform: "day" },
        { column: "created_at", transform: "hour" },
      ],
      COLUMNS,
    );
    expect(out.length).toBe(2);
  });

  it("rejects day on an integer column", () => {
    try {
      validatePartitionSpec(
        [{ column: "order_id", transform: "day" }],
        COLUMNS,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("ICEBERG_PARTITION_SPEC_INVALID");
    }
  });

  it("rejects unknown column", () => {
    try {
      validatePartitionSpec(
        [{ column: "ghost", transform: "identity" }],
        COLUMNS,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("ICEBERG_PARTITION_SPEC_INVALID");
      const reasons = (err as { details?: { reasons: string[] } }).details?.reasons ?? [];
      expect(reasons.join(",")).toMatch(/ghost/);
    }
  });

  it("rejects unsupported transform", () => {
    try {
      validatePartitionSpec(
        [{ column: "tenant", transform: "bogus" as unknown as "identity" }],
        COLUMNS,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("ICEBERG_PARTITION_SPEC_INVALID");
    }
  });

  it("requires positive n for bucket/truncate", () => {
    try {
      validatePartitionSpec(
        [{ column: "tenant", transform: "bucket" }],
        COLUMNS,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("ICEBERG_PARTITION_SPEC_INVALID");
    }
  });

  it("detects duplicate partition-field names", () => {
    try {
      validatePartitionSpec(
        [
          { column: "event_date", transform: "day", name: "ebucket" },
          { column: "tenant", transform: "identity", name: "ebucket" },
        ],
        COLUMNS,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("ICEBERG_PARTITION_SPEC_INVALID");
    }
  });
});
