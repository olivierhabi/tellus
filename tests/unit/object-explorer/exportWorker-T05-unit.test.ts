// ---------------------------------------------------------------------------
// T-05 — Export pipeline worker + constants unit tests.
//
// Contracts covered:
//   C-070  Export job rows snapshot security context + branch on creation.
//   C-071  Worker is idempotent at the job level (re-running a COMPLETED job
//          is a no-op that returns COMPLETED with rowCount=0).
//   C-072  Worker enforces MAX_EXPORT_ROWS, transitions to FAILED on overflow,
//          and persists `failure_reason = 'EXPORT_LIMIT_EXCEEDED'`.
//   C-073  Worker uses the snapshot (NOT the calling thread's session) when
//          calling streamObjectSet — the security context AND branch id
//          forwarded to the streamer must be the snapshotted values.
//   C-074  Format validation rejects non-csv|jsonl|xlsx with VALIDATION_ERROR.
//   C-075  buildExportObjectKey is deterministic and key/format-stable.
//   C-076  Format writers (CsvWriter, JsonlWriter) produce correct bytes for
//          empty input, simple rows, and rows requiring CSV quoting.
//   C-077  parseSnapshot recovers from JSON-string snapshots, object snapshots,
//          and malformed/missing inputs (returns {}).
//   C-078  Successful runs increment tellus_export_jobs_total{outcome=completed}
//          and tellus_export_rows_streamed_total by exact row count.
//   C-079  Failed runs increment tellus_export_jobs_total{outcome=failed} and
//          set status=FAILED with failure_reason.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock db before importing exportWorker so the import-time `withTransaction`
// reference is the mock (the worker injects deps.withTransaction so this is
// belt-and-braces).
const { queryMock, withTransactionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));
vi.mock("../../../src/db", () => ({
  query: (sql: string, args?: unknown[]) => queryMock(sql, args),
  withTransaction: (cb: (c: unknown) => Promise<unknown>) =>
    withTransactionMock(cb),
}));

import {
  executeExportActivity,
  __internals,
  type ExportActivityDeps,
  type ExportPage,
} from "../../../src/services/exports/exportWorker";
import {
  buildExportObjectKey,
  assertSupportedFormat,
} from "../../../src/services/exports/exportConstants";
import {
  __resetMetricsForTesting,
  renderPrometheus,
} from "../../../src/services/funnel/metrics";

beforeEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
  __resetMetricsForTesting();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: "job-1",
    ontology_id: "ont-1",
    requested_by: "alice",
    object_type_api_name: "Trip",
    format: "csv",
    query_json: { match_all: {} },
    status: "PENDING",
    security_context_snapshot: {
      userId: "alice",
      markings: ["PUBLIC"],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    },
    branch_id_snapshot: "main",
    ...overrides,
  };
}

function makeStreamer(
  rows: Array<Record<string, unknown>>,
  capture?: (input: Parameters<ExportActivityDeps["streamObjectSet"]>[0]) => void,
): ExportActivityDeps["streamObjectSet"] {
  return async function* (input): AsyncIterable<ExportPage> {
    capture?.(input);
    // One page per call keeps the test deterministic.
    yield { rows };
  };
}

function makeDeps(
  job: Record<string, unknown>,
  opts: {
    streamRows?: Array<Record<string, unknown>>;
    captureStream?: (i: Parameters<ExportActivityDeps["streamObjectSet"]>[0]) => void;
    overrideStream?: ExportActivityDeps["streamObjectSet"];
    uploadOk?: boolean;
    presignUrl?: string;
  } = {},
): ExportActivityDeps {
  // Wire withTransaction → callback returns the job row.
  withTransactionMock.mockImplementation(async (cb: (c: unknown) => Promise<unknown>) =>
    cb({
      query: async () => ({ rows: [job], rowCount: 1 }),
    }),
  );
  // The worker also calls `query()` for status updates — accept anything,
  // remember the calls for assertions.
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  return {
    streamObjectSet:
      opts.overrideStream ??
      makeStreamer(opts.streamRows ?? [], opts.captureStream),
    uploadObject: vi.fn(async (key: string) => ({ key })),
    getPresignedDownloadUrl: vi.fn(async () => opts.presignUrl ?? "https://signed.example/x"),
  };
}

// ---------------------------------------------------------------------------
// C-074, C-075 — exportConstants pure helpers.
// ---------------------------------------------------------------------------

describe("T-05 C-074: assertSupportedFormat", () => {
  it("T-05 C-074a: accepts csv, jsonl, xlsx", () => {
    expect(() => assertSupportedFormat("csv")).not.toThrow();
    expect(() => assertSupportedFormat("jsonl")).not.toThrow();
    expect(() => assertSupportedFormat("xlsx")).not.toThrow();
  });
  it("T-05 C-074b: rejects everything else with VALIDATION_ERROR", () => {
    try {
      assertSupportedFormat("parquet" as string);
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as { code?: string; details?: unknown };
      expect(e.code).toBe("VALIDATION_ERROR");
      expect((e.details as { format: string }).format).toBe("parquet");
    }
  });
});

describe("T-05 C-075: buildExportObjectKey", () => {
  it("T-05 C-075a: deterministic, format-suffixed, jobId-stable", () => {
    expect(buildExportObjectKey("abc", "csv")).toBe("exports/abc.csv");
    expect(buildExportObjectKey("abc", "jsonl")).toBe("exports/abc.jsonl");
    expect(buildExportObjectKey("abc", "xlsx")).toBe("exports/abc.xlsx");
    // No silent collision between two jobs.
    expect(buildExportObjectKey("abc", "csv")).not.toBe(
      buildExportObjectKey("abd", "csv"),
    );
  });
});

// ---------------------------------------------------------------------------
// C-076, C-077 — Format writers + snapshot parser.
// ---------------------------------------------------------------------------

describe("T-05 C-076: CsvWriter byte-level correctness", () => {
  it("T-05 C-076a: empty writer produces empty buffer", () => {
    const w = new __internals.CsvWriter();
    expect(w.finalize().toString("utf8")).toBe("");
  });
  it("T-05 C-076b: simple row has sorted-header line + values", () => {
    const w = new __internals.CsvWriter();
    w.writeRow({ b: 2, a: 1 });
    expect(w.finalize().toString("utf8")).toBe("a,b\n1,2");
  });
  it("T-05 C-076c: comma + newline + quote in a value triggers RFC4180 quoting", () => {
    const w = new __internals.CsvWriter();
    w.writeRow({ x: 'has,"quote"\nbreak' });
    const out = w.finalize().toString("utf8");
    // Header line, then quoted value: "has,""quote""\nbreak"
    expect(out).toBe('x\n"has,""quote""\nbreak"');
  });
});

describe("T-05 C-076: JsonlWriter is one-object-per-line", () => {
  it("T-05 C-076d: one row per line, no trailing newline (Buffer concat is join)", () => {
    const w = new __internals.JsonlWriter();
    w.writeRow({ a: 1 });
    w.writeRow({ b: 2 });
    expect(w.finalize().toString("utf8")).toBe('{"a":1}\n{"b":2}');
  });
});

describe("T-05 C-077: parseSnapshot recovery", () => {
  it("T-05 C-077a: object passthrough", () => {
    expect(__internals.parseSnapshot({ a: 1 })).toEqual({ a: 1 });
  });
  it("T-05 C-077b: JSON string parsed", () => {
    expect(__internals.parseSnapshot('{"a":2}')).toEqual({ a: 2 });
  });
  it("T-05 C-077c: malformed JSON → {}", () => {
    expect(__internals.parseSnapshot("{not json")).toEqual({});
  });
  it("T-05 C-077d: null/undefined → {}", () => {
    expect(__internals.parseSnapshot(null)).toEqual({});
    expect(__internals.parseSnapshot(undefined)).toEqual({});
  });
  it("T-05 C-077e: JSON primitive → {}", () => {
    expect(__internals.parseSnapshot("42")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// C-071, C-073, C-078 — happy path + idempotency + observability.
// ---------------------------------------------------------------------------

describe("T-05 C-071: idempotency", () => {
  it("T-05 C-071a: re-running a COMPLETED job returns COMPLETED without re-streaming", async () => {
    const job = makeJobRow({ status: "COMPLETED" });
    const stream = vi.fn(async function* () {
      yield { rows: [{ x: 1 }] };
    });
    const deps = makeDeps(job, {
      overrideStream: stream as ExportActivityDeps["streamObjectSet"],
    });
    const out = await executeExportActivity("job-1", deps);
    expect(out.status).toBe("COMPLETED");
    expect(out.rowCount).toBe(0);
    expect(stream).not.toHaveBeenCalled();
    // No status update SQL should have been issued for COMPLETED short-circuit.
    const updateCalls = queryMock.mock.calls.filter(([sql]) =>
      typeof sql === "string" && /UPDATE export_job/.test(sql),
    );
    expect(updateCalls.length).toBe(0);
  });
});

describe("T-05 C-073, C-078: happy path forwards snapshot + emits metrics", () => {
  it("T-05 C-073a: streamObjectSet receives snapshotted security + branch", async () => {
    let captured: Parameters<ExportActivityDeps["streamObjectSet"]>[0] | null = null;
    const job = makeJobRow();
    const deps = makeDeps(job, {
      streamRows: [{ a: 1 }, { a: 2 }],
      captureStream: (i) => {
        captured = i;
      },
    });
    const out = await executeExportActivity("job-1", deps);
    expect(out.status).toBe("COMPLETED");
    expect(out.rowCount).toBe(2);
    expect(captured).not.toBeNull();
    expect(captured!.branchId).toBe("main");
    expect((captured!.securityContext as { userId: string }).userId).toBe("alice");
    expect(captured!.objectTypeApiName).toBe("Trip");
    // C-078: counters incremented.
    const prom = renderPrometheus();
    expect(prom).toContain('tellus_export_jobs_total{format="csv",outcome="completed"} 1');
    expect(prom).toContain('tellus_export_rows_streamed_total{format="csv"} 2');
  });

  it("T-05 C-073b: snapshot is parsed even when stored as JSON string (PG JSONB roundtrip)", async () => {
    let captured: Parameters<ExportActivityDeps["streamObjectSet"]>[0] | null = null;
    const job = makeJobRow({
      security_context_snapshot: JSON.stringify({
        userId: "bob",
        markings: ["TS"],
      }),
    });
    const deps = makeDeps(job, {
      streamRows: [{ a: 1 }],
      captureStream: (i) => {
        captured = i;
      },
    });
    await executeExportActivity("job-1", deps);
    expect((captured!.securityContext as { userId: string }).userId).toBe("bob");
  });

  it("T-05 C-078b: COMPLETED row is updated with download_url, expires_at, row_count", async () => {
    const job = makeJobRow();
    const deps = makeDeps(job, {
      streamRows: [{ a: 1 }],
      presignUrl: "https://signed.example/job-1.csv?token=abc",
    });
    await executeExportActivity("job-1", deps);
    const completedUpdate = queryMock.mock.calls.find(
      ([sql]) =>
        typeof sql === "string" &&
        /UPDATE export_job[\s\S]*status = 'COMPLETED'/.test(sql),
    );
    expect(completedUpdate).toBeDefined();
    const params = completedUpdate![1] as unknown[];
    expect(params[1]).toBe(1); // row_count
    expect(params[2]).toBe("exports/job-1.csv"); // file_path
    expect(params[3]).toBe("https://signed.example/job-1.csv?token=abc"); // download_url
    expect(params[4]).toBeInstanceOf(Date); // expires_at
  });
});

// ---------------------------------------------------------------------------
// C-072, C-079 — failure path: row cap and FAILED transition.
// ---------------------------------------------------------------------------

describe("T-05 C-072, C-079: failure paths", () => {
  it("T-05 C-072: exceeding MAX_EXPORT_ROWS produces FAILED with EXPORT_LIMIT_EXCEEDED", async () => {
    // exportConstants.envInt clamps MAX_EXPORT_ROWS to a [1000, 100M] range,
    // so we set the env to the floor (1000) and stream 1001 rows. Setting
    // env BEFORE the dynamic import ensures the freshly-evaluated module
    // sees the override.
    const prev = process.env.MAX_EXPORT_ROWS;
    process.env.MAX_EXPORT_ROWS = "1000";
    vi.resetModules();
    const { executeExportActivity: run } = await import(
      "../../../src/services/exports/exportWorker"
    );
    try {
      const job = makeJobRow();
      const rows: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 1001; i++) rows.push({ a: i });
      const deps = makeDeps(job, { streamRows: rows });
      const out = await run("job-1", deps);
      expect(out.status).toBe("FAILED");
      expect(out.failureReason).toBe("EXPORT_LIMIT_EXCEEDED");
      const failedUpdate = queryMock.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          /UPDATE export_job[\s\S]*status = 'FAILED'/.test(sql),
      );
      expect(failedUpdate).toBeDefined();
      const params = failedUpdate![1] as unknown[];
      expect(params[1]).toBe("EXPORT_LIMIT_EXCEEDED"); // failure_reason
    } finally {
      if (prev === undefined) delete process.env.MAX_EXPORT_ROWS;
      else process.env.MAX_EXPORT_ROWS = prev;
      vi.resetModules();
    }
  });

  it("T-05 C-079: upload failure → FAILED counter + failure_reason persisted", async () => {
    const job = makeJobRow();
    const deps = makeDeps(job, { streamRows: [{ a: 1 }] });
    deps.uploadObject = vi.fn(async () => {
      const e = new Error("S3 503") as Error & { code?: string };
      e.code = "STORAGE_UNAVAILABLE";
      throw e;
    });
    const out = await executeExportActivity("job-1", deps);
    expect(out.status).toBe("FAILED");
    expect(out.failureReason).toBe("STORAGE_UNAVAILABLE");
    const prom = renderPrometheus();
    expect(prom).toContain('tellus_export_jobs_total{format="csv",outcome="failed"} 1');
  });

  it("T-05 C-072b: missing job → EXPORT_JOB_NOT_FOUND raised, no status update issued", async () => {
    withTransactionMock.mockImplementation(async (cb: (c: unknown) => Promise<unknown>) =>
      cb({
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
    );
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const deps: ExportActivityDeps = {
      streamObjectSet: makeStreamer([]),
      uploadObject: vi.fn(),
      getPresignedDownloadUrl: vi.fn(),
    };
    await expect(executeExportActivity("missing", deps)).rejects.toMatchObject({
      code: "EXPORT_JOB_NOT_FOUND",
    });
    // No UPDATE was issued — we never reached the running-state mutation.
    const updateCalls = queryMock.mock.calls.filter(([sql]) =>
      typeof sql === "string" && /UPDATE export_job/.test(sql),
    );
    expect(updateCalls.length).toBe(0);
  });
});
