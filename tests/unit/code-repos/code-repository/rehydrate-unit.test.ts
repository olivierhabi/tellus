// ---------------------------------------------------------------------------
// B2 — rehydrateInMemoryStemma unit tests.
//
// Boot-time helper that re-injects every ACTIVE `code_repository` Postgres
// row into the in-memory Stemma adapter. Verifies:
//
//   • Production guard rejects non-`InMemoryStemma` adapters.
//   • Idempotent — already-seeded RIDs are skipped, not re-created.
//   • Best-effort — Pool query failures and adapter throws are swallowed
//     and counted, never re-thrown.
//   • Logger receives structured events for every state transition.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { rehydrateInMemoryStemma } from "../../../../src/services/codeRepository/rehydrate";
import { InMemoryStemma } from "../../../../src/services/codeRepository/adapters/inMemory";
import type {
  StemmaAdapter,
  StemmaCreateArgs,
  StemmaCreateOutcome,
  StemmaListTreeArgs,
  StemmaListTreeOutcome,
  StemmaReadBlobArgs,
  StemmaReadBlobOutcome,
} from "../../../../src/services/codeRepository/adapters/types";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface Row {
  rid: string;
  default_branch: string;
  created_by: string;
}

function makeMockPool(rows: ReadonlyArray<Row>): Pool {
  return {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
  } as unknown as Pool;
}

function makeFailingPool(message: string): Pool {
  return {
    query: vi.fn(async () => {
      throw new Error(message);
    }),
  } as unknown as Pool;
}

class NoopStemma implements StemmaAdapter {
  async createRepository(_args: StemmaCreateArgs): Promise<StemmaCreateOutcome> {
    return { kind: "ok", repositoryRid: "noop" };
  }
  async tombstone(_args: { repositoryRid: string }): Promise<void> {}
  async listTree(_args: StemmaListTreeArgs): Promise<StemmaListTreeOutcome> {
    return { kind: "branch-not-found" };
  }
  async readBlob(_args: StemmaReadBlobArgs): Promise<StemmaReadBlobOutcome> {
    return { kind: "branch-not-found" };
  }
}

const RID_A =
  "ri.stemma.main.repository.0123abcd-ef01-4345-8789-aaaaaaaaaaaa";
const RID_B =
  "ri.stemma.main.repository.0123abcd-ef01-4345-8789-bbbbbbbbbbbb";

const ROW_A: Row = {
  rid: RID_A,
  default_branch: "main",
  created_by: "00000000-0000-0000-0000-000000000001",
};
const ROW_B: Row = {
  rid: RID_B,
  default_branch: "main",
  created_by: "00000000-0000-0000-0000-000000000002",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rehydrateInMemoryStemma — production guard", () => {
  it("returns applied:false against any non-InMemoryStemma", async () => {
    const pool = makeMockPool([ROW_A, ROW_B]);
    const log = vi.fn();
    const r = await rehydrateInMemoryStemma({
      pool,
      stemma: new NoopStemma(),
      logger: log,
    });
    expect(r.applied).toBe(false);
    expect(r.rehydrated).toBe(0);
    expect(r.skipped).toBe(0);
    // Pool is NEVER queried when the adapter is real — the production code
    // path must not touch metadata at all.
    expect((pool.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("code-repos.rehydrate.skip-real-adapter");
  });
});

describe("rehydrateInMemoryStemma — happy path", () => {
  it("seeds every ACTIVE row into the adapter", async () => {
    const stemma = new InMemoryStemma();
    const pool = makeMockPool([ROW_A, ROW_B]);
    const r = await rehydrateInMemoryStemma({ pool, stemma });
    expect(r.applied).toBe(true);
    expect(r.rehydrated).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.total).toBe(2);
    expect(stemma.exists(RID_A)).toBe(true);
    expect(stemma.exists(RID_B)).toBe(true);
  });

  it("emits per-row + summary log events", async () => {
    const stemma = new InMemoryStemma();
    const pool = makeMockPool([ROW_A]);
    const log = vi.fn();
    await rehydrateInMemoryStemma({ pool, stemma, logger: log });
    const events = log.mock.calls.map((c) => c[0]);
    expect(events).toContain("code-repos.rehydrate.seeded");
    expect(events).toContain("code-repos.rehydrate.done");
  });
});

describe("rehydrateInMemoryStemma — idempotency", () => {
  it("skips rows already present in the adapter", async () => {
    const stemma = new InMemoryStemma();
    // Pre-seed RID_A so the rehydrator should skip it.
    await stemma.createRepository({
      proposedRid: RID_A,
      defaultBranchName: "main",
      principalSub: ROW_A.created_by,
    });

    const pool = makeMockPool([ROW_A, ROW_B]);
    const r = await rehydrateInMemoryStemma({ pool, stemma });
    expect(r.rehydrated).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.total).toBe(2);
  });

  it("running twice in a row produces zero new seeds the second time", async () => {
    const stemma = new InMemoryStemma();
    const pool = makeMockPool([ROW_A, ROW_B]);
    const first = await rehydrateInMemoryStemma({ pool, stemma });
    const second = await rehydrateInMemoryStemma({ pool, stemma });
    expect(first.rehydrated).toBe(2);
    expect(second.rehydrated).toBe(0);
    expect(second.skipped).toBe(2);
  });
});

describe("rehydrateInMemoryStemma — fault tolerance", () => {
  it("swallows pool query failures and reports zeros", async () => {
    const stemma = new InMemoryStemma();
    const pool = makeFailingPool("boom");
    const log = vi.fn();
    const r = await rehydrateInMemoryStemma({ pool, stemma, logger: log });
    expect(r.applied).toBe(true);
    expect(r.rehydrated).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.total).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "code-repos.rehydrate.scan-failed",
      expect.objectContaining({ message: "boom" }),
    );
  });

  it("counts adapter non-ok outcomes as failed without throwing", async () => {
    // Force the adapter to return a transient outcome instead of `ok`.
    const stemma = new InMemoryStemma({
      forceOutcome: { kind: "transient", reason: "stemma-down" },
    });
    const pool = makeMockPool([ROW_A]);
    const r = await rehydrateInMemoryStemma({ pool, stemma });
    expect(r.failed).toBe(1);
    expect(r.rehydrated).toBe(0);
    expect(r.total).toBe(1);
  });

  it("counts thrown adapter errors as failed without throwing", async () => {
    // Wrap an in-memory stemma so it survives the production guard
    // (instanceof check) but throws on createRepository.
    class ThrowingInMemoryStemma extends InMemoryStemma {
      override async createRepository(): Promise<StemmaCreateOutcome> {
        throw new Error("adapter-down");
      }
    }
    const stemma = new ThrowingInMemoryStemma();
    const pool = makeMockPool([ROW_A]);
    const r = await rehydrateInMemoryStemma({ pool, stemma });
    expect(r.failed).toBe(1);
    expect(r.rehydrated).toBe(0);
  });
});
