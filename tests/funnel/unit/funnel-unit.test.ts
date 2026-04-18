// ---------------------------------------------------------------------------
// Funnel Unit Tests — tasks-01.md §B1-B5
//
// Pure-function tests that don't touch Postgres, S3, or OpenSearch. The
// merge stage's PG commit path is exercised in integration tests; these
// tests cover the business-rule primitives that must be provably correct
// before any orchestration layer runs them.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  validateColumnwiseMDO,
  resolveProperty,
  MAX_DATASOURCES_PER_OBJECT_TYPE,
  DatasourceContribution,
} from "../../../src/services/funnel/mergeStage";
import {
  ThroughputGuard,
  computeChangelog,
  ChangelogRow,
  SourceChangeRow,
  SnapshotDiffReader,
} from "../../../src/services/funnel/changelogStage";
import { funnelNamespace } from "../../../src/services/funnel/icebergCatalog";

// ---------------------------------------------------------------------------
// B5: Column-wise Multi-Datasource Overlay (MDO) enforcement
// ---------------------------------------------------------------------------

describe("B5 — validateColumnwiseMDO", () => {
  const contrib = (
    id: string,
    owned: string[]
  ): DatasourceContribution => ({
    datasource_id: id,
    owned_properties: owned,
    changelog_rows: [],
    markings: [],
  });

  it("accepts distinct property ownership across datasources", () => {
    expect(() =>
      validateColumnwiseMDO([
        contrib("A", ["name", "email"]),
        contrib("B", ["address", "phone"]),
      ])
    ).not.toThrow();
  });

  it("accepts the same datasource listing a property twice (idempotent)", () => {
    // Harmless self-overlap: same datasource, same property.
    expect(() =>
      validateColumnwiseMDO([contrib("A", ["name", "name"])])
    ).not.toThrow();
  });

  it("rejects the same property owned by two different datasources", () => {
    expect(() =>
      validateColumnwiseMDO([
        contrib("A", ["name"]),
        contrib("B", ["name"]),
      ])
    ).toThrow(/column-wise MDO violation/);
  });

  it("rejects more than the Palantir limit of 70 datasources", () => {
    const over = Array.from({ length: MAX_DATASOURCES_PER_OBJECT_TYPE + 1 }, (_, i) =>
      contrib(`ds${i}`, [`p${i}`])
    );
    expect(() => validateColumnwiseMDO(over)).toThrow(/limit is 70/);
  });

  it("accepts exactly 70 datasources", () => {
    const atLimit = Array.from({ length: MAX_DATASOURCES_PER_OBJECT_TYPE }, (_, i) =>
      contrib(`ds${i}`, [`p${i}`])
    );
    expect(() => validateColumnwiseMDO(atLimit)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// B5: Conflict strategies — user_edit_wins vs latest_wins
// ---------------------------------------------------------------------------

describe("B5 — resolveProperty(user_edit_wins)", () => {
  it("returns the source value when there is no edit", () => {
    expect(resolveProperty("src", "2026-01-01T00:00:00Z", null, "user_edit_wins"))
      .toBe("src");
  });

  it("returns the edit value when an edit exists (property pinned)", () => {
    expect(
      resolveProperty(
        "src",
        "2026-12-31T23:59:59Z",
        { value: "edited", createdAt: "2026-01-01T00:00:00Z" },
        "user_edit_wins"
      )
    ).toBe("edited");
  });

  it("pins even when the source update is newer than the edit", () => {
    // This is the Palantir behavior: once edited, pinned forever.
    expect(
      resolveProperty(
        "updated-source",
        "2027-06-01T00:00:00Z",
        { value: "older-edit", createdAt: "2026-01-01T00:00:00Z" },
        "user_edit_wins"
      )
    ).toBe("older-edit");
  });
});

describe("B5 — resolveProperty(latest_wins)", () => {
  it("returns the edit when edit.createdAt > source.timestamp", () => {
    expect(
      resolveProperty(
        "src",
        "2026-01-01T00:00:00Z",
        { value: "edited", createdAt: "2026-06-01T00:00:00Z" },
        "latest_wins"
      )
    ).toBe("edited");
  });

  it("returns the source when source.timestamp > edit.createdAt", () => {
    expect(
      resolveProperty(
        "src",
        "2026-12-01T00:00:00Z",
        { value: "older-edit", createdAt: "2026-01-01T00:00:00Z" },
        "latest_wins"
      )
    ).toBe("src");
  });

  it("falls back to user_edit_wins when the source has no timestamp", () => {
    // Without a comparable timestamp, latest_wins cannot make a
    // defensible decision — degrade safely to pinning.
    expect(
      resolveProperty("src", null, { value: "edit", createdAt: "2026-01-01" }, "latest_wins")
    ).toBe("edit");
  });
});

// ---------------------------------------------------------------------------
// B4: Changelog — duplicate-PK-within-transaction rule
// ---------------------------------------------------------------------------

function arrayReader(rows: SourceChangeRow[]): SnapshotDiffReader {
  return {
    async *read() {
      for (const r of rows) yield r;
    },
  };
}

describe("B4 — computeChangelog duplicate PK detection", () => {
  it("rejects a duplicate primary key inside a single source transaction", async () => {
    const rows: SourceChangeRow[] = [
      {
        primary_key: "A",
        operation: "INSERT",
        properties: {},
        source_transaction_id: "tx1",
        source_commit_timestamp: "2026-04-17T00:00:00Z",
      },
      {
        primary_key: "A",
        operation: "UPDATE",
        properties: {},
        source_transaction_id: "tx1",
        source_commit_timestamp: "2026-04-17T00:00:00Z",
      },
    ];
    await expect(() =>
      computeChangelog(
        {
          ontologyId: "00000000-0000-0000-0000-000000000001",
          objectTypeApiName: "Order",
          datasourceId: "00000000-0000-0000-0000-000000000002",
          sourceTableId: "src",
          fromSnapshotId: null,
          toSnapshotId: "to",
          changelogTableId: "cl",
          outputFileLocation: "s3://_/",
        },
        arrayReader(rows)
      )
    ).rejects.toThrow(/duplicate primary key 'A'/);
  });

  it("allows the same PK across different source transactions", async () => {
    // This path does hit commitSnapshot which needs the DB. We only
    // verify the validation side-effect by stopping before commit —
    // push a sentinel error from a fake commit by using an absent
    // table. Instead we short-circuit: assert the duplicate detection
    // with a single transaction and rely on integration tests for the
    // happy path.
    //
    // Swap the two rows' transaction ids: both INSERTs of A but tx1/tx2.
    const rows: SourceChangeRow[] = [
      { primary_key: "A", operation: "INSERT", properties: {}, source_transaction_id: "tx1", source_commit_timestamp: "2026-04-17T00:00:00Z" },
      { primary_key: "A", operation: "UPDATE", properties: {}, source_transaction_id: "tx2", source_commit_timestamp: "2026-04-17T00:00:01Z" },
    ];
    // We can still assert that duplicate detection does NOT fire —
    // the call will throw later at commit (DB). Capture and inspect
    // the message.
    let threw: Error | null = null;
    try {
      await computeChangelog(
        {
          ontologyId: "00000000-0000-0000-0000-000000000001",
          objectTypeApiName: "Order",
          datasourceId: "00000000-0000-0000-0000-000000000002",
          sourceTableId: "src",
          fromSnapshotId: null,
          toSnapshotId: "to",
          changelogTableId: "cl",
          outputFileLocation: "s3://_/",
        },
        arrayReader(rows)
      );
    } catch (e) {
      threw = e as Error;
    }
    // If Postgres is unavailable we still assert the duplicate rule
    // did NOT fire — any error must be about commitSnapshot, not PK
    // duplication.
    if (threw) {
      expect(threw.message).not.toMatch(/duplicate primary key/);
    }
  });
});

// ---------------------------------------------------------------------------
// B4: ThroughputGuard pacing
// ---------------------------------------------------------------------------

describe("B4 — ThroughputGuard", () => {
  it("permits consumption up to the cap without blocking", async () => {
    let t = 1_000_000;
    const guard = new ThroughputGuard(1000, () => t);
    await guard.consume(500); // 500 <= 1000 — no wait
    await guard.consume(500); // bucket exhausted but no more calls — ok
  });

  it("caps at 0 disables the guard entirely", async () => {
    const guard = new ThroughputGuard(0);
    await guard.consume(1_000_000_000); // should return immediately
  });

  it("refills proportionally over time", () => {
    let t = 1_000_000;
    const guard = new ThroughputGuard(1000, () => t);
    // Drain the bucket.
    (guard as unknown as { tokens: number }).tokens = 0;
    t += 500; // 0.5 seconds elapsed
    // Calling consume(0) triggers refill without consumption.
    return guard.consume(0).then(() => {
      // Should have refilled ~500 tokens (1000 per second × 0.5s).
      const tokens = (guard as unknown as { tokens: number }).tokens;
      expect(tokens).toBeGreaterThanOrEqual(500);
      expect(tokens).toBeLessThanOrEqual(1000);
    });
  });
});

// ---------------------------------------------------------------------------
// B2: Namespace prefix convention
// ---------------------------------------------------------------------------

describe("B2 — funnelNamespace", () => {
  it("produces the _funnel.<type>.<kind> prefix per the spec", () => {
    expect(funnelNamespace("Order", "changelog")).toBe("_funnel.Order.changelog");
    expect(funnelNamespace("Order", "merged")).toBe("_funnel.Order.merged");
    expect(funnelNamespace("Order", "index")).toBe("_funnel.Order.index");
    expect(funnelNamespace("Order", "hydration")).toBe("_funnel.Order.hydration");
  });
});
