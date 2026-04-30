// ---------------------------------------------------------------------------
// T-05 — Export route unit tests.
//
// Contracts covered (route surface):
//   C-080  POST / persists security_context_snapshot + branch_id_snapshot.
//   C-081  POST / validates `format` (csv|jsonl|xlsx) — rejects parquet.
//   C-082  POST / rejects non-object `query` (array/primitive/null).
//   C-083  GET /:jobId returns 404 when the row is missing OR not owned by
//          the caller (IDOR-prevention; identical envelope in both cases).
//   C-084  GET /:jobId/download returns 501 EXPORT_NOT_AVAILABLE while the
//          job is still PENDING/RUNNING.
//   C-085  GET /:jobId/download returns 410 EXPORT_DOWNLOAD_EXPIRED when the
//          signed URL TTL has passed; counter incremented.
//   C-086  GET /:jobId/download returns 200 with downloadUrl + expiresAt
//          when the job is COMPLETED and the URL is unexpired; counter
//          incremented.
//   C-087  GET / lists ONLY the caller's jobs (requested_by = $userId).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import request from "supertest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../src/db", () => ({
  default: { query: queryMock },
  query: (sql: string, args?: unknown[]) => queryMock(sql, args),
}));

import {
  __resetMetricsForTesting,
  renderPrometheus,
} from "../../../src/services/funnel/metrics";
import exportsRouter from "../../../src/routes/exports";

beforeEach(() => {
  queryMock.mockReset();
  __resetMetricsForTesting();
});

function makeApp(opts: { userId?: string; markings?: string[] } = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: { id: string } }).user = {
      id: opts.userId ?? "alice",
    };
    (req as unknown as { security: unknown }).security = {
      userId: opts.userId ?? "alice",
      markings: opts.markings ?? ["PUBLIC"],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    };
    (req as unknown as { correlationId: string }).correlationId = "req-T05";
    next();
  });
  app.use("/api/v1/ontology/:ontologyId/exports", exportsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// C-080, C-081, C-082 — POST validation + snapshot.
// ---------------------------------------------------------------------------

describe("T-05 C-080: POST snapshots security context + branch", () => {
  it("T-05 C-080a: INSERT carries 7-arg vector with snapshot + branch", async () => {
    queryMock.mockResolvedValue({
      rows: [{ job_id: "job-1", status: "PENDING" }],
      rowCount: 1,
    });
    const app = makeApp({ userId: "alice", markings: ["SECRET"] });
    const r = await request(app)
      .post("/api/v1/ontology/ont-1/exports")
      .set("X-Branch-Id", "feature-x")
      .send({
        objectTypeApiName: "Trip",
        format: "csv",
        query: { match_all: {} },
      });
    expect(r.status).toBe(202);
    const insert = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && /INSERT INTO export_job/.test(sql),
    );
    expect(insert).toBeDefined();
    const params = insert![1] as unknown[];
    expect(params[0]).toBe("ont-1");
    expect(params[1]).toBe("alice");
    expect(params[2]).toBe("Trip");
    expect(params[3]).toBe("csv");
    // params[4] = JSON.stringify(query)
    expect(params[4]).toBe('{"match_all":{}}');
    // params[5] = JSON.stringify(securityContext) — must contain the marking.
    expect(typeof params[5]).toBe("string");
    expect(params[5] as string).toContain('"markings":["SECRET"]');
    // params[6] = branch id from header.
    expect(params[6]).toBe("feature-x");
  });

  it("T-05 C-080b: missing branch header → snapshot stores null branch", async () => {
    queryMock.mockResolvedValue({
      rows: [{ job_id: "job-2", status: "PENDING" }],
      rowCount: 1,
    });
    const app = makeApp();
    const r = await request(app)
      .post("/api/v1/ontology/ont-1/exports")
      .send({ format: "csv" });
    expect(r.status).toBe(202);
    const insert = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && /INSERT INTO export_job/.test(sql),
    );
    const params = insert![1] as unknown[];
    expect(params[6]).toBeNull();
  });
});

describe("T-05 C-081, C-082: POST validation", () => {
  it("T-05 C-081: format=parquet → 400 VALIDATION_ERROR (no INSERT issued)", async () => {
    const app = makeApp();
    const r = await request(app)
      .post("/api/v1/ontology/ont-1/exports")
      .send({ format: "parquet" });
    expect(r.status).toBe(400);
    expect(r.body.errorCode).toBe("VALIDATION_ERROR");
    expect(r.body.parameters.field).toBe("format");
    const inserts = queryMock.mock.calls.filter(
      ([sql]) => typeof sql === "string" && /INSERT INTO export_job/.test(sql),
    );
    expect(inserts.length).toBe(0);
  });

  it("T-05 C-082a: query=[] (array) → 400 VALIDATION_ERROR", async () => {
    const app = makeApp();
    const r = await request(app)
      .post("/api/v1/ontology/ont-1/exports")
      .send({ format: "csv", query: ["bad"] });
    expect(r.status).toBe(400);
    expect(r.body.errorCode).toBe("VALIDATION_ERROR");
    expect(r.body.parameters.field).toBe("query");
  });

  it("T-05 C-082b: query=null → 400 VALIDATION_ERROR", async () => {
    const app = makeApp();
    const r = await request(app)
      .post("/api/v1/ontology/ont-1/exports")
      .send({ format: "csv", query: null });
    expect(r.status).toBe(400);
    expect(r.body.errorCode).toBe("VALIDATION_ERROR");
  });

  it("T-05 C-082c: objectTypeApiName=number → 400 VALIDATION_ERROR", async () => {
    const app = makeApp();
    const r = await request(app)
      .post("/api/v1/ontology/ont-1/exports")
      .send({ format: "csv", objectTypeApiName: 42 });
    expect(r.status).toBe(400);
    expect(r.body.errorCode).toBe("VALIDATION_ERROR");
    expect(r.body.parameters.field).toBe("objectTypeApiName");
  });
});

// ---------------------------------------------------------------------------
// C-083 — IDOR prevention on GET /:jobId.
// ---------------------------------------------------------------------------

describe("T-05 C-083: GET /:jobId IDOR prevention", () => {
  it("T-05 C-083a: row not owned by caller → 404 OBJECT_NOT_FOUND (same envelope as missing)", async () => {
    // The route's WHERE clause includes `requested_by = $2`, so the caller
    // never sees an existence-leaking 403 — the SQL returns 0 rows. The
    // symbolic `NOT_FOUND` code is aliased to `OBJECT_NOT_FOUND` on the
    // wire by responseFormatter ERROR_CODE_ALIASES.
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const app = makeApp({ userId: "alice" });
    const r = await request(app).get("/api/v1/ontology/ont-1/exports/job-secret");
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe("OBJECT_NOT_FOUND");
    // The SQL we issued must include the requested_by=$2 IDOR guard.
    const select = queryMock.mock.calls.find(([sql]) =>
      typeof sql === "string" &&
      /FROM export_job\s+WHERE job_id = \$1 AND requested_by = \$2/.test(sql),
    );
    expect(select).toBeDefined();
    expect((select![1] as unknown[])[1]).toBe("alice");
  });

  it("T-05 C-083b: owned row → 200 with row body", async () => {
    queryMock.mockResolvedValue({
      rows: [{ job_id: "job-mine", requested_by: "alice", status: "PENDING" }],
      rowCount: 1,
    });
    const app = makeApp({ userId: "alice" });
    const r = await request(app).get("/api/v1/ontology/ont-1/exports/job-mine");
    expect(r.status).toBe(200);
    expect(r.body.job_id).toBe("job-mine");
  });
});

// ---------------------------------------------------------------------------
// C-084, C-085, C-086 — Download lifecycle.
// ---------------------------------------------------------------------------

describe("T-05 C-084: download blocked while non-COMPLETED", () => {
  it("T-05 C-084a: PENDING job → 501 EXPORT_NOT_AVAILABLE", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          status: "PENDING",
          download_url: null,
          download_url_expires_at: null,
          format: "csv",
        },
      ],
      rowCount: 1,
    });
    const app = makeApp();
    const r = await request(app).get("/api/v1/ontology/ont-1/exports/job-1/download");
    expect(r.status).toBe(501);
    expect(r.body.errorCode).toBe("EXPORT_NOT_AVAILABLE");
    expect(r.body.parameters.status).toBe("PENDING");
  });
});

describe("T-05 C-085: download expired", () => {
  it("T-05 C-085: expires_at in the past → 410 EXPORT_DOWNLOAD_EXPIRED + counter increment", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    queryMock.mockResolvedValue({
      rows: [
        {
          status: "COMPLETED",
          download_url: "https://signed.example/x",
          download_url_expires_at: past,
          format: "csv",
        },
      ],
      rowCount: 1,
    });
    const app = makeApp();
    const r = await request(app).get("/api/v1/ontology/ont-1/exports/job-1/download");
    expect(r.status).toBe(410);
    expect(r.body.errorCode).toBe("EXPORT_DOWNLOAD_EXPIRED");
    const prom = renderPrometheus();
    expect(prom).toContain('tellus_export_download_expired_total{format="csv"} 1');
  });
});

describe("T-05 C-086: download issued", () => {
  it("T-05 C-086: COMPLETED + unexpired → 200 with downloadUrl + expiresAt + counter", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    queryMock.mockResolvedValue({
      rows: [
        {
          status: "COMPLETED",
          download_url: "https://signed.example/job-1.csv?t=abc",
          download_url_expires_at: future,
          format: "csv",
        },
      ],
      rowCount: 1,
    });
    const app = makeApp();
    const r = await request(app).get("/api/v1/ontology/ont-1/exports/job-1/download");
    expect(r.status).toBe(200);
    expect(r.body.downloadUrl).toBe("https://signed.example/job-1.csv?t=abc");
    expect(r.body.expiresAt).toBe(future);
    const prom = renderPrometheus();
    expect(prom).toContain('tellus_export_download_issued_total{format="csv"} 1');
  });

  it("T-05 C-086b: download not owned → 404 OBJECT_NOT_FOUND (no leak)", async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const app = makeApp({ userId: "alice" });
    const r = await request(app).get("/api/v1/ontology/ont-1/exports/job-x/download");
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe("OBJECT_NOT_FOUND");
    const select = queryMock.mock.calls.find(([sql]) =>
      typeof sql === "string" &&
      /FROM export_job\s+WHERE job_id = \$1 AND requested_by = \$2/.test(sql),
    );
    expect(select).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// C-087 — list endpoint scoped to caller.
// ---------------------------------------------------------------------------

describe("T-05 C-087: GET / lists only the caller's jobs", () => {
  it("T-05 C-087: SQL filters by requested_by = currentUser", async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const app = makeApp({ userId: "carol" });
    const r = await request(app).get("/api/v1/ontology/ont-1/exports");
    expect(r.status).toBe(200);
    const list = queryMock.mock.calls.find(
      ([sql]) =>
        typeof sql === "string" &&
        /FROM export_job\s+WHERE ontology_id = \$1 AND requested_by = \$2/.test(sql),
    );
    expect(list).toBeDefined();
    expect((list![1] as unknown[])[1]).toBe("carol");
  });
});
