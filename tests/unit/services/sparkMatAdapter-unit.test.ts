// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §1 — Spark (Livy) MatPort adapter unit tests.
//
// No Livy cluster: `fetch` is stubbed (vi.stubGlobal), same philosophy as
// the Trino adapter tests. Covers: plan → Spark SQL translation, session
// creation + reuse, statement polling, timeout, typed error mapping, the
// env-gated adapter selection default, and the delegation of non-spark
// MatPort methods to the in-process adapter.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SparkMatAdapter,
  compilePlanToSparkSql,
  defaultMatPortFromEnv,
  sparkConfigFromEnv,
  type SparkMatAdapterConfig,
} from "../../../src/services/quiver/compute/mat/sparkMatAdapter";
import { InProcessMatAdapter } from "../../../src/services/quiver/compute/mat/inProcessMat";
import type { CalcitePlan } from "../../../src/services/quiver/compute/mat/calcitePlan";
import type { MatExecuteContext } from "../../../src/services/quiver/compute/mat/matPort";
import { AppError } from "../../../src/utils/foundryAppError";

const CTX: MatExecuteContext = {
  branch: "feature-x",
  remainingMs: undefined,
  userSubject: "user-1",
};

const CONFIG: SparkMatAdapterConfig = {
  url: "http://livy:8998",
  sessionKind: "sql",
  statementTimeoutMs: 5_000,
  pollIntervalMs: 1, // no real sleeping in tests
};

/** Representative plan: scan → filter → aggregate. */
const PLAN: CalcitePlan = {
  root: "agg",
  nodes: [
    { kind: "scan", id: "s", datasetRid: "ri.tellus.main.dataset.orders", columns: ["region", "amount"] },
    { kind: "filter", id: "f", input: "s", predicate: { op: "gt", args: ["amount", 10] } },
    { kind: "aggregate", id: "agg", input: "f", groupBy: ["region"], aggregations: [{ fn: "sum", column: "amount", alias: "total" }] },
  ],
};

type FetchCall = { url: string; init: RequestInit | undefined };

/** Stub fetch with a queue of JSON responses; records every call. */
function stubFetch(responses: Array<{ status?: number; body: unknown }>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch call: ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LIVY_URL;
  delete process.env.LIVY_SESSION_KIND;
  delete process.env.SPARK_STATEMENT_TIMEOUT_MS;
});

// ---------------------------------------------------------------------------
// Plan translation
// ---------------------------------------------------------------------------

describe("compilePlanToSparkSql", () => {
  it("compiles scan → filter → aggregate into one Spark SELECT", () => {
    const { sql, columns } = compilePlanToSparkSql(PLAN);
    expect(sql).toBe(
      "SELECT `region`, SUM(`amount`) AS `total` FROM " +
        "(SELECT * FROM (SELECT `region`, `amount` FROM `ri.tellus.main.dataset.orders`) t0 WHERE `amount` > 10) t1 " +
        "GROUP BY `region` ORDER BY `region`",
    );
    expect(columns).toEqual([
      { name: "region", type: "STRING" },
      { name: "total", type: "NUMBER" },
    ]);
  });

  it("compiles joins, projections, and orderBy", () => {
    const plan: CalcitePlan = {
      root: "ord",
      nodes: [
        { kind: "scan", id: "a", datasetRid: "ri.a", columns: ["id", "v"] },
        { kind: "scan", id: "b", datasetRid: "ri.b", columns: ["id2", "w"] },
        { kind: "join", id: "j", left: "a", right: "b", on: [{ leftCol: "id", rightCol: "id2" }], type: "left" },
        { kind: "project", id: "p", input: "j", columns: ["id", "w"] },
        { kind: "orderBy", id: "ord", input: "p", orderings: [{ column: "w", direction: "desc" }] },
      ],
    };
    const { sql, columns } = compilePlanToSparkSql(plan);
    expect(sql).toContain("LEFT JOIN");
    expect(sql).toContain("ON t0.`id` = t1.`id2`");
    expect(sql).toMatch(/ORDER BY `w` DESC$/);
    expect(columns.map((c) => c.name)).toEqual(["id", "w"]);
  });

  it("escapes string literals and supports eq/neq/in predicates", () => {
    const plan: CalcitePlan = {
      root: "f",
      nodes: [
        { kind: "scan", id: "s", datasetRid: "ri.a", columns: ["name"] },
        { kind: "filter", id: "f", input: "s", predicate: { op: "in", args: ["name", ["o'brien", "smith"]] } },
      ],
    };
    expect(compilePlanToSparkSql(plan).sql).toContain("`name` IN ('o''brien', 'smith')");
  });

  it("throws typed SPARK_PLAN_NOT_SUPPORTED for pivot and expression nodes", () => {
    const pivot: CalcitePlan = {
      root: "p",
      nodes: [
        { kind: "scan", id: "s", datasetRid: "ri.a", columns: ["r", "c", "v"] },
        { kind: "pivot", id: "p", input: "s", rows: ["r"], cols: "c", value: "v", fn: "sum" },
      ],
    };
    try {
      compilePlanToSparkSql(pivot);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("SPARK_PLAN_NOT_SUPPORTED");
      expect((e as AppError).statusCode).toBe(422);
    }

    const expr: CalcitePlan = {
      root: "e",
      nodes: [
        { kind: "scan", id: "s", datasetRid: "ri.a", columns: ["v"] },
        { kind: "expression", id: "e", input: "s", column: "v2", expression: "v * 2" },
      ],
    };
    expect(() => compilePlanToSparkSql(expr)).toThrowError(/does not translate/);
  });
});

// ---------------------------------------------------------------------------
// Livy protocol
// ---------------------------------------------------------------------------

const SQL_OUTPUT = {
  status: "ok",
  data: {
    "application/json": {
      schema: { fields: [{ name: "region", type: "string" }, { name: "total", type: "double" }] },
      data: [["eu", 42], ["us", 7]],
    },
  },
};

describe("SparkMatAdapter.sparkExecute (Livy protocol)", () => {
  it("creates a session when none is idle, polls it, runs the statement, and parses rows", async () => {
    const calls = stubFetch([
      { body: { sessions: [] } },                                  // GET /sessions
      { body: { id: 7, state: "starting" } },                      // POST /sessions
      { body: { id: 7, state: "idle" } },                          // GET /sessions/7
      { body: { id: 0, state: "running" } },                       // POST /sessions/7/statements
      { body: { id: 0, state: "available", output: SQL_OUTPUT } }, // GET .../statements/0
    ]);
    const adapter = new SparkMatAdapter(new InProcessMatAdapter(), CONFIG);
    const result = await adapter.sparkExecute(PLAN, CTX);

    expect(calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
      "GET http://livy:8998/sessions",
      "POST http://livy:8998/sessions",
      "GET http://livy:8998/sessions/7",
      "POST http://livy:8998/sessions/7/statements",
      "GET http://livy:8998/sessions/7/statements/0",
    ]);
    // Branch propagation (G-09) on every Livy round-trip.
    for (const c of calls) {
      expect((c.init?.headers as Record<string, string>)["X-Tellus-Branch"]).toBe("feature-x");
    }
    // Statement carries the compiled SQL verbatim for sql sessions.
    const stmtBody = JSON.parse(String(calls[3].init?.body)) as { code: string };
    expect(stmtBody.code).toContain("GROUP BY `region`");

    // Livy's schema refines the translated types (double → NUMBER).
    expect(result.columns).toEqual([
      { name: "region", type: "STRING" },
      { name: "total", type: "NUMBER" },
    ]);
    expect(result.rows).toEqual([["eu", 42], ["us", 7]]);
    expect(result.arrowBytes).toBeGreaterThan(0);
  });

  it("reuses an idle session of the matching kind without POST /sessions", async () => {
    const calls = stubFetch([
      { body: { sessions: [{ id: 3, kind: "sql", state: "idle" }] } },
      { body: { id: 9, state: "available", output: SQL_OUTPUT } },
    ]);
    const adapter = new SparkMatAdapter(new InProcessMatAdapter(), CONFIG);
    await adapter.sparkExecute(PLAN, CTX);
    expect(calls[1].url).toBe("http://livy:8998/sessions/3/statements");
    expect(calls.some((c) => c.init?.method === "POST" && c.url.endsWith("/sessions"))).toBe(false);
  });

  it("wraps the SQL in spark.sql(...) for scala sessions and parses JSON-line output", async () => {
    const calls = stubFetch([
      { body: { sessions: [{ id: 1, kind: "spark", state: "idle" }] } },
      {
        body: {
          id: 0,
          state: "available",
          output: {
            status: "ok",
            data: { "text/plain": '{"region":"eu","total":42}\n{"region":"us","total":7}\n' },
          },
        },
      },
    ]);
    const adapter = new SparkMatAdapter(new InProcessMatAdapter(), { ...CONFIG, sessionKind: "spark" });
    const result = await adapter.sparkExecute(PLAN, CTX);
    const stmtBody = JSON.parse(String(calls[1].init?.body)) as { code: string };
    expect(stmtBody.code).toMatch(/^spark\.sql\("""/);
    expect(stmtBody.code).toContain(".toJSON.collect.foreach(println)");
    expect(result.rows).toEqual([["eu", 42], ["us", 7]]);
  });

  it("times out with SPARK_STATEMENT_TIMEOUT when the statement never becomes available", async () => {
    // Session idle immediately; statement stays "running" forever.
    const running = { id: 0, state: "running" };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/sessions")) {
        return new Response(JSON.stringify({ sessions: [{ id: 1, kind: "sql", state: "idle" }] }), { status: 200 });
      }
      return new Response(JSON.stringify(running), { status: 200 });
    }));
    const adapter = new SparkMatAdapter(new InProcessMatAdapter(), { ...CONFIG, statementTimeoutMs: 25 });
    await expect(adapter.sparkExecute(PLAN, CTX)).rejects.toMatchObject({
      code: "SPARK_STATEMENT_TIMEOUT",
      statusCode: 504,
    });
  });

  it("maps a failed statement output to SPARK_QUERY_FAILED", async () => {
    stubFetch([
      { body: { sessions: [{ id: 1, kind: "sql", state: "idle" }] } },
      {
        body: {
          id: 0,
          state: "available",
          output: { status: "error", ename: "AnalysisException", evalue: "Table not found" },
        },
      },
    ]);
    const adapter = new SparkMatAdapter(new InProcessMatAdapter(), CONFIG);
    await expect(adapter.sparkExecute(PLAN, CTX)).rejects.toMatchObject({
      code: "SPARK_QUERY_FAILED",
      statusCode: 502,
      message: expect.stringContaining("AnalysisException"),
    });
  });

  it("maps a dead session to SPARK_SUBMIT_FAILED and unreachable Livy to SPARK_UNAVAILABLE", async () => {
    stubFetch([
      { body: { sessions: [] } },
      { body: { id: 5, state: "dead" } },
    ]);
    const adapter = new SparkMatAdapter(new InProcessMatAdapter(), CONFIG);
    await expect(adapter.sparkExecute(PLAN, CTX)).rejects.toMatchObject({ code: "SPARK_SUBMIT_FAILED" });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(adapter.sparkExecute(PLAN, CTX)).rejects.toMatchObject({
      code: "SPARK_UNAVAILABLE",
      statusCode: 502,
    });
  });

  it("honours the caller's remainingMs deadline (G-06) when tighter than config", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/sessions")) {
        return new Response(JSON.stringify({ sessions: [{ id: 1, kind: "sql", state: "idle" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 0, state: "waiting" }), { status: 200 });
    }));
    const adapter = new SparkMatAdapter(new InProcessMatAdapter(), CONFIG); // 5 s config budget
    await expect(
      adapter.sparkExecute(PLAN, { ...CTX, remainingMs: 20 }),
    ).rejects.toMatchObject({ code: "SPARK_STATEMENT_TIMEOUT" });
  });
});

// ---------------------------------------------------------------------------
// Delegation + env-gated selection
// ---------------------------------------------------------------------------

describe("SparkMatAdapter composition and selection", () => {
  it("delegates pinSnapshots / polarsExecute / estimateCardinality to the inner port", async () => {
    const inner = new InProcessMatAdapter();
    inner.registerDataset("ri.tellus.main.dataset.orders", {
      columns: [{ name: "region", type: "STRING" }, { name: "amount", type: "NUMBER" }],
      rows: [["eu", 42]],
      snapshotId: "snap-1",
    });
    const adapter = new SparkMatAdapter(inner, CONFIG);

    expect(await adapter.pinSnapshots(PLAN, CTX)).toEqual({ "ri.tellus.main.dataset.orders": "snap-1" });
    expect((await adapter.estimateCardinality(PLAN, CTX)).rows).toBe(1);
    expect((await adapter.polarsExecute(PLAN, CTX)).rows).toEqual([["eu", 42]]);
    // No fetch needed — the global fetch is not stubbed here on purpose;
    // any network call would hit a real socket and fail the test.
    expect(inner.calls.map((c) => c.op)).toEqual([
      "pinSnapshots",
      "estimateCardinality",
      "polarsExecute",
    ]);
  });

  it("defaultMatPortFromEnv returns the in-process adapter when LIVY_URL is unset", () => {
    delete process.env.LIVY_URL;
    expect(defaultMatPortFromEnv()).toBeInstanceOf(InProcessMatAdapter);
  });

  it("defaultMatPortFromEnv returns the Spark adapter when LIVY_URL is set", () => {
    process.env.LIVY_URL = "http://livy:8998/";
    process.env.LIVY_SESSION_KIND = "spark";
    process.env.SPARK_STATEMENT_TIMEOUT_MS = "60000";
    expect(defaultMatPortFromEnv()).toBeInstanceOf(SparkMatAdapter);
    const cfg = sparkConfigFromEnv();
    expect(cfg).toMatchObject({
      url: "http://livy:8998", // trailing slash stripped
      sessionKind: "spark",
      statementTimeoutMs: 60_000,
    });
  });
});
