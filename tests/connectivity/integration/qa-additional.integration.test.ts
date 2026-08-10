// ---------------------------------------------------------------------------
// QA additional integration tests for the Tellus Data Connection stack.
//
// Covers behaviours that are not provable from a browser:
//   1. Tenant isolation across connections + webhooks.
//   2. SSRF guard (assertEgressForConfig) for IPv4 + IPv6 reserved ranges.
//   3. Credential rotation + audit (vault + audit.repo).
//   4. Orphaned-execution reaper + completeExecution idempotency.
//   5. Idempotency-key replay for webhook executions.
//   6. OpenAPI completeness — registered paths vs mounted routes.
//   7. Writeback transaction rollback — a failed writeback returns a
//      `rejected` result so the actionExecutor never commits the ontology
//      mutation.
//   8. Side-effect post-commit execution — the outbox rows are only visible
//      to the worker after the main transaction commits.
//
// Uses a real Postgres 16 Testcontainer (same fixture as b1/b3). Modules are
// imported lazily AFTER PG* env is pointed at the container so src/db's eager
// pool binds to it.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resetConnectivityTables,
  setEnvForTest,
  startPostgres16,
  type PgFixture,
} from "../../fixtures/containers";
import type { WritebackExecutionContext } from "../../../src/actions/writebackExecutor";

// ---------------------------------------------------------------------------
// Mocks (hoisted before any import).
// ---------------------------------------------------------------------------

// zod v4 / @asteasolutions/zod-to-openapi v7 incompat — buildOpenApiDocument()
// throws `zodSchema.openapi is not a function`. Mock the bridge so the
// registerPath calls are captured into a synthetic OpenAPI doc instead of
// running the v3-only prototype patch. This lets us count registered paths.
vi.mock("@asteasolutions/zod-to-openapi", () => {
  class OpenAPIRegistry {
    captured: Array<{ method: string; path: string }> = [];
    register() {}
    registerPath(def: { method: string; path: string }) {
      this.captured.push({ method: def.method, path: def.path });
    }
    registerComponent() {}
    get definitions() {
      return this.captured;
    }
  }
  class OpenApiGeneratorV31 {
    constructor(private defs: Array<{ method: string; path: string }>) {}
    generateDocument(opts: { openapi: string; info: unknown }) {
      const paths: Record<string, Record<string, unknown>> = {};
      for (const { method, path } of this.defs) {
        (paths[path] ??= {})[method] = {};
      }
      return {
        openapi: opts.openapi,
        info: opts.info,
        paths,
        components: {},
      };
    }
  }
  return {
    OpenAPIRegistry,
    OpenApiGeneratorV31,
    extendZodWithOpenApi: (z: any) => {
      // zod v4 has no shared base prototype: each schema type (ZodString,
      // ZodOptional, ...) has its own prototype, and `.openapi()` is not a
      // method on any of them. Install a chain-through no-op on every Zod*
      // prototype so the inline `.openapi({...})` metadata calls in
      // openapi.ts don't throw.
      const noop = function (this: unknown) {
        return this;
      };
      for (const name of Object.getOwnPropertyNames(z)) {
        if (!/^Zod/.test(name)) continue;
        const Ctor = z[name];
        if (typeof Ctor !== "function" || !Ctor.prototype) continue;
        if (!("openapi" in Ctor.prototype)) {
          Object.defineProperty(Ctor.prototype, "openapi", {
            value: noop,
            configurable: true,
            enumerable: false,
          });
        }
      }
    },
  };
});

// writebackExecutor's legacy path calls getWebhookByNameVersion; stub it so
// the writeback test stays a pure unit test with an injected httpRequest.
const wbState = vi.hoisted(() => ({ webhook: null as any }));
vi.mock("../../../src/models/webhookDefinition", () => ({
  getWebhookByNameVersion: async () => wbState.webhook,
}));

// ---------------------------------------------------------------------------
// Lazy module handles — assigned in beforeAll AFTER env is pointed at the
// container (src/db builds its pool eagerly at first import).
// ---------------------------------------------------------------------------
let fixture: PgFixture;
let dbMod: typeof import("../../../src/db");
let connectionsRepo: typeof import("../../../src/services/connectivity/store/connections.repo");
let webhooksRepo: typeof import("../../../src/services/connectivity/webhooks/repository");
let vault: typeof import("../../../src/services/connectivity/credentials/vault");
let storeRepo: typeof import("../../../src/services/connectivity/credentials/store.repo");
let auditRepo: typeof import("../../../src/services/connectivity/credentials/audit.repo");
let egress: typeof import("../../../src/services/connectivity/connectors/postgresql/egress");
let openapiMod: typeof import("../../../src/services/connectivity/openapi");
let indexMod: typeof import("../../../src/services/connectivity/index");
let sideEffectMod: typeof import("../../../src/models/actionSideEffectJob");
let webhookContracts: typeof import("../../../src/services/connectivity/webhooks/contracts");
let writeback: typeof import("../../../src/actions/writebackExecutor");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
function readMigration(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

beforeAll(async () => {
  fixture = await startPostgres16();

  // src/db reads PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD at module load —
  // bind them to the container BEFORE importing any src module.
  const u = new URL(fixture.connectionString);
  process.env.PGHOST = u.hostname;
  process.env.PGPORT = u.port;
  process.env.PGDATABASE = decodeURIComponent(u.pathname.replace(/^\//, ""));
  process.env.PGUSER = decodeURIComponent(u.username);
  process.env.PGPASSWORD = decodeURIComponent(u.password);
  setEnvForTest(fixture);

  // Local KMS adapter (AES-256-GCM envelope) — needed by the vault tests.
  process.env.TELLUS_LOCAL_KEK_B64 = randomBytes(32).toString("base64");

  // Apply migrations the shared fixture omits: 085 (connection_settings —
  // connections.insert writes `settings`), 135 (webhook tables), 131
  // (action_side_effect_job outbox).
  await fixture.pool.query(readMigration("src/migrations/085_connection_settings.sql"));
  await fixture.pool.query(readMigration("src/migrations/135_connectivity_webhooks.sql"));
  await fixture.pool.query(readMigration("src/migrations/131_side_effect_outbox.sql"));

  dbMod = await import("../../../src/db");
  connectionsRepo = await import("../../../src/services/connectivity/store/connections.repo");
  webhooksRepo = await import("../../../src/services/connectivity/webhooks/repository");
  vault = await import("../../../src/services/connectivity/credentials/vault");
  storeRepo = await import("../../../src/services/connectivity/credentials/store.repo");
  auditRepo = await import("../../../src/services/connectivity/credentials/audit.repo");
  egress = await import("../../../src/services/connectivity/connectors/postgresql/egress");
  openapiMod = await import("../../../src/services/connectivity/openapi");
  indexMod = await import("../../../src/services/connectivity/index");
  sideEffectMod = await import("../../../src/models/actionSideEffectJob");
  webhookContracts = await import("../../../src/services/connectivity/webhooks/contracts");
  writeback = await import("../../../src/actions/writebackExecutor");

  const { LocalAesGcmAdapter } = await import("../../../src/lib/kms/adapters/local-aesgcm");
  const { setKmsAdapter } = await import("../../../src/lib/kms");
  setKmsAdapter(new LocalAesGcmAdapter());
}, 240_000);

afterAll(async () => {
  await fixture?.cleanup();
});

beforeEach(async () => {
  vault?._clearCacheForTest();
  // Truncate the webhook + side-effect tables (not covered by
  // resetConnectivityTables) then the connectivity tables.
  await fixture.pool.query(`
    TRUNCATE TABLE
      connectivity_webhook_delivery_attempt,
      connectivity_webhook_execution,
      connectivity_webhook_version,
      connectivity_webhook,
      action_side_effect_job
      RESTART IDENTITY CASCADE`);
  await resetConnectivityTables(fixture.pool);
  delete process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertConnection(tenant: string): Promise<string> {
  const rid = `ri.magritte.main.source.${randomUUID()}`;
  const request = {
    name: `src-${randomUUID().slice(0, 8)}`,
    description: "qa",
    connectorType: "postgresql",
    workerType: "foundryWorker",
    config: {
      connectorType: "postgresql",
      postgres: { host: "db.example.com", database: "fraud" },
    },
    egressPolicy: {
      allowlist: [{ kind: "host", host: "db.example.com", port: 5432 }],
    },
    compassFolderRid: fixture.testFolderRid,
  };
  await dbMod.withTransaction(async (client) => {
    await connectionsRepo.insert(client, {
      rid,
      tenant,
      request: request as any,
      actor: fixture.testUserId,
    });
  });
  return rid;
}

function sampleWebhookConfig() {
  return webhookContracts.WebhookVersionConfiguration.parse({
    request: {
      calls: [
        {
          id: randomUUID(),
          name: "call1",
          method: "GET",
          relativePath: "/health",
        },
      ],
    },
  });
}

async function insertWebhook(tenant: string, connectionRid: string): Promise<string> {
  const wh = await webhooksRepo.create({
    tenant,
    connectionRid,
    apiName: `Wh${randomUUID().replace(/-/g, "").slice(0, 18)}`,
    displayName: "qa webhook",
    description: "qa",
    status: "draft",
    configuration: sampleWebhookConfig(),
    actor: fixture.testUserId,
  });
  return wh.rid;
}

// ---------------------------------------------------------------------------
// 1. Tenant isolation
// ---------------------------------------------------------------------------

describe("Tenant isolation", () => {
  it("a connection created by one tenant is invisible to another", async () => {
    const rid = await insertConnection("tenantA");

    const own = await connectionsRepo.findByRid(rid, "tenantA");
    expect(own.rid).toBe(rid);
    expect(own.tenant).toBe("tenantA");

    await expect(connectionsRepo.findByRid(rid, "tenantB")).rejects.toMatchObject({
      definition: { errorName: "Tellus:Connectivity:ConnectionNotFound" },
    });

    const listA = await connectionsRepo.list({ tenant: "tenantA" });
    expect(listA.data.some((c) => c.rid === rid)).toBe(true);
    const listB = await connectionsRepo.list({ tenant: "tenantB" });
    expect(listB.data.some((c) => c.rid === rid)).toBe(false);
  });

  it("a webhook created by one tenant is invisible to another", async () => {
    const connRid = await insertConnection("tenantA");
    const whRid = await insertWebhook("tenantA", connRid);

    const own = await webhooksRepo.getByRid(whRid, "tenantA");
    expect(own.rid).toBe(whRid);
    expect(own.tenant).toBe("tenantA");

    await expect(webhooksRepo.getByRid(whRid, "tenantB")).rejects.toThrow(
      "WEBHOOK_NOT_FOUND",
    );

    const ownList = await webhooksRepo.listByConnection(connRid, "tenantA");
    expect(ownList.some((w) => w.rid === whRid)).toBe(true);
    const otherList = await webhooksRepo.listByConnection(connRid, "tenantB");
    expect(otherList.some((w) => w.rid === whRid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. SSRF IPv4 + IPv6 variants
// ---------------------------------------------------------------------------

describe("SSRF guard — assertEgressForConfig", () => {
  const blocked = [
    "localhost",
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "fe80::1",
  ];
  const allowed = ["8.8.8.8", "example.com"];

  it.each(blocked)("blocks reserved target %s", (host) => {
    expect(() => egress.assertEgressForConfig(host, 443)).toThrow();
    expect(() => egress.assertEgressForConfig(host, 443)).toThrowError(
      "Tellus:Connectivity:EgressBlocked",
    );
  });

  it.each(allowed)("allows public target %s", (host) => {
    expect(() => egress.assertEgressForConfig(host, 443)).not.toThrow();
  });

  it("does not block 172.32.x (just outside the RFC-1918 172.16/12 block)", () => {
    expect(() => egress.assertEgressForConfig("172.32.0.1", 443)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Secret rotation and audit
// ---------------------------------------------------------------------------

describe("Secret rotation + audit", () => {
  it("rotation creates a new version, supersedes the old as head, writes audit rows", async () => {
    const rid = `ri.magritte.main.source.${randomUUID()}`;
    const actor = fixture.testUserId;
    const enc = new TextEncoder();

    const v1 = await vault.createOrRotate(rid, "default", "password", enc.encode("hunter2"), actor);
    expect(v1.version).toBe(1);

    const head1 = await storeRepo.headVersion(rid, "default", "password");
    expect(head1?.version).toBe(1);

    const v2 = await vault.createOrRotate(rid, "default", "password", enc.encode("hunter3"), actor);
    expect(v2.version).toBe(2);

    // The new version is now the authoritative read target.
    const head2 = await storeRepo.headVersion(rid, "default", "password");
    expect(head2?.version).toBe(2);

    // Older rows stay readable (until cleanup) — not yet superseded.
    const versions = await storeRepo.listVersions(rid, "default", "password");
    expect(versions.map((v) => v.version).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(versions.every((v) => v.superseded === false)).toBe(true);

    // Explicit supersede marks every row; headVersion then resolves to null.
    const n = await vault.supersede(rid, "default", "password", actor);
    expect(n).toBe(2);
    const head3 = await storeRepo.headVersion(rid, "default", "password");
    expect(head3).toBeNull();
    const superseded = await storeRepo.listVersions(rid, "default", "password");
    expect(superseded.every((v) => v.superseded === true)).toBe(true);
  });

  it("writes one audit row per create / rotate / supersede operation", async () => {
    const rid = `ri.magritte.main.source.${randomUUID()}`;
    const actor = fixture.testUserId;
    const enc = new TextEncoder();

    await vault.createOrRotate(rid, "default", "password", enc.encode("a"), actor);
    await vault.createOrRotate(rid, "default", "password", enc.encode("b"), actor);
    await vault.supersede(rid, "default", "password", actor);

    const rows = await auditRepo.listForConnection(rid, "default");
    const ops = rows.map((r) => r.operation);
    expect(ops).toContain("create");
    expect(ops).toContain("rotate");
    expect(ops).toContain("supersede");
    const rotateRow = rows.find((r) => r.operation === "rotate");
    expect(rotateRow?.version).toBe(2);
    expect(rotateRow?.outcome).toBe("success");
    expect(rotateRow?.actor).toBe(actor);
  });
});

// ---------------------------------------------------------------------------
// 4. Orphaned-execution reaper + completeExecution idempotency
// ---------------------------------------------------------------------------

describe("Orphaned execution reaper", () => {
  it("marks stale queued/running executions as failed with ORPHANED", async () => {
    const connRid = await insertConnection("default");
    const whRid = await insertWebhook("default", connRid);
    const created = await webhooksRepo.createExecution({
      tenant: "default",
      webhookRid: whRid,
      webhookVersion: 1,
      kind: "test",
      correlationId: randomUUID(),
      idempotencyKeyHash: randomUUID(),
      triggeredBy: fixture.testUserId,
      inputSummary: {},
    });
    expect(created.replayed).toBe(false);

    // Backdate the execution so it is older than the reaper threshold.
    await dbMod.pool.query(
      `UPDATE connectivity_webhook_execution
          SET created_at = now() - interval '10 minutes'
        WHERE rid = $1`,
      [created.execution.rid],
    );

    const reaped = await webhooksRepo.reapOrphanedExecutions(5 * 60 * 1000);
    expect(reaped).toBeGreaterThanOrEqual(1);

    const row = await dbMod.pool.query(
      `SELECT status, error_code FROM connectivity_webhook_execution WHERE rid = $1`,
      [created.execution.rid],
    );
    expect(row.rows[0].status).toBe("failed");
    expect(row.rows[0].error_code).toBe("ORPHANED");
  });

  it("does not reap freshly-created executions", async () => {
    const connRid = await insertConnection("default");
    const whRid = await insertWebhook("default", connRid);
    const created = await webhooksRepo.createExecution({
      tenant: "default",
      webhookRid: whRid,
      webhookVersion: 1,
      kind: "test",
      correlationId: randomUUID(),
      idempotencyKeyHash: randomUUID(),
      triggeredBy: fixture.testUserId,
      inputSummary: {},
    });

    const reaped = await webhooksRepo.reapOrphanedExecutions(5 * 60 * 1000);
    expect(reaped).toBe(0);

    const row = await dbMod.pool.query(
      `SELECT status FROM connectivity_webhook_execution WHERE rid = $1`,
      [created.execution.rid],
    );
    expect(row.rows[0].status).toBe("queued");
  });

  it("completeExecution is idempotent — re-completing a terminal execution is a no-op", async () => {
    const connRid = await insertConnection("default");
    const whRid = await insertWebhook("default", connRid);
    const created = await webhooksRepo.createExecution({
      tenant: "default",
      webhookRid: whRid,
      webhookVersion: 1,
      kind: "test",
      correlationId: randomUUID(),
      idempotencyKeyHash: randomUUID(),
      triggeredBy: fixture.testUserId,
      inputSummary: {},
    });

    await webhooksRepo.markExecutionRunning(created.execution.rid);
    await webhooksRepo.completeExecution({
      executionRid: created.execution.rid,
      status: "succeeded",
      outputSummary: { ok: true },
      durationMs: 42,
    });

    const afterFirst = await dbMod.pool.query(
      `SELECT status, output_summary, duration_ms FROM connectivity_webhook_execution WHERE rid = $1`,
      [created.execution.rid],
    );
    expect(afterFirst.rows[0].status).toBe("succeeded");
    expect(afterFirst.rows[0].duration_ms).toBe(42);

    // Second completion attempts to UPDATE WHERE status IN ('queued','running')
    // — 'succeeded' matches nothing, so nothing changes.
    await webhooksRepo.completeExecution({
      executionRid: created.execution.rid,
      status: "failed",
      errorCode: "LATE",
      durationMs: 999,
    });

    const afterSecond = await dbMod.pool.query(
      `SELECT status, output_summary, duration_ms, error_code FROM connectivity_webhook_execution WHERE rid = $1`,
      [created.execution.rid],
    );
    expect(afterSecond.rows[0].status).toBe("succeeded");
    expect(afterSecond.rows[0].duration_ms).toBe(42);
    expect(afterSecond.rows[0].error_code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Idempotency replay
// ---------------------------------------------------------------------------

describe("Idempotency replay", () => {
  it("the same idempotency key returns the same execution with replayed=true", async () => {
    const connRid = await insertConnection("default");
    const whRid = await insertWebhook("default", connRid);
    const key = randomUUID();

    const first = await webhooksRepo.createExecution({
      tenant: "default",
      webhookRid: whRid,
      webhookVersion: 1,
      kind: "production",
      correlationId: randomUUID(),
      idempotencyKeyHash: key,
      triggeredBy: fixture.testUserId,
      inputSummary: { a: 1 },
    });
    expect(first.replayed).toBe(false);

    const second = await webhooksRepo.createExecution({
      tenant: "default",
      webhookRid: whRid,
      webhookVersion: 1,
      kind: "production",
      correlationId: randomUUID(),
      idempotencyKeyHash: key,
      triggeredBy: fixture.testUserId,
      inputSummary: { a: 1 },
    });
    expect(second.replayed).toBe(true);
    expect(second.execution.rid).toBe(first.execution.rid);
    expect(second.execution.status).toBe(first.execution.status);

    // A different key produces a distinct execution.
    const third = await webhooksRepo.createExecution({
      tenant: "default",
      webhookRid: whRid,
      webhookVersion: 1,
      kind: "production",
      correlationId: randomUUID(),
      idempotencyKeyHash: randomUUID(),
      triggeredBy: fixture.testUserId,
      inputSummary: { a: 2 },
    });
    expect(third.replayed).toBe(false);
    expect(third.execution.rid).not.toBe(first.execution.rid);
  });
});

// ---------------------------------------------------------------------------
// 6. OpenAPI completeness — registered paths vs mounted routes
// ---------------------------------------------------------------------------

describe("OpenAPI completeness", () => {
  function registeredRoutes(doc: any): Set<string> {
    const out = new Set<string>();
    for (const [path, ops] of Object.entries(doc.paths ?? {})) {
      for (const method of Object.keys(ops as object)) {
        out.add(`${method.toUpperCase()} ${path}`);
      }
    }
    return out;
  }

  function mountedRoutes(router: any): Set<string> {
    const PREFIX = "/api/v1/connectivity";
    const out = new Set<string>();
    for (const layer of router.stack as any[]) {
      const route = layer.route;
      if (!route) continue;
      const path = PREFIX + String(route.path).replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      for (const method of Object.keys(route.methods as object)) {
        out.add(`${method.toUpperCase()} ${path}`);
      }
    }
    return out;
  }

  it("every registered OpenAPI path+method is mounted and vice-versa", () => {
    const doc = openapiMod.buildOpenApiDocument() as any;
    expect(doc.openapi).toMatch(/^3\.1/);

    const registered = registeredRoutes(doc);
    const router = indexMod.createConnectivityRouter();
    const mounted = mountedRoutes(router);

    expect(registered.size).toBeGreaterThan(0);
    expect(mounted.size).toBeGreaterThan(0);

    const missingFromOpenApi = [...mounted].filter((r) => !registered.has(r));
    const missingFromRouter = [...registered].filter((r) => !mounted.has(r));
    expect({
      registeredCount: registered.size,
      mountedCount: mounted.size,
      missingFromOpenApi,
      missingFromRouter,
    }).toEqual({
      registeredCount: registered.size,
      mountedCount: mounted.size,
      missingFromOpenApi: [],
      missingFromRouter: [],
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Writeback transaction rollback
// ---------------------------------------------------------------------------

describe("Writeback transaction rollback", () => {
  const policy = {
    httpsRequired: true,
    followRedirects: false,
    allowedHosts: [],
    headerAllowlist: [],
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
    allowedResponseContentTypes: ["application/json"],
  } as const;

  function legacyWebhook() {
    wbState.webhook = {
      webhook_id: "wb-1",
      ontology_id: "ont-1",
      name: "legacy-writeback-hook",
      version: 1,
      description: null,
      status: "active",
      method: "POST",
      endpoint_config: { url: "https://example.com/hook" },
      input_schema: {},
      output_schema: null,
      authentication_config: {},
      timeout_ms: 5000,
      max_response_bytes: 1024 * 1024,
      retry_policy: null,
      created_by: "u",
      created_at: "",
      updated_at: "",
    };
  }

  function ctx(): WritebackExecutionContext {
    return {
      actor: "u",
      executionId: randomUUID(),
      ontologyId: "ont-1",
    };
  }

  it("a non-2xx response returns rejected so the ontology mutation does NOT commit", async () => {
    legacyWebhook();
    const result = await writeback.executeWriteback(
      {
        webhookId: "legacy-writeback-hook",
        webhookVersion: 1,
        inputs: { x: 1 },
        failurePolicy: "abort",
        outputBindings: {},
      },
      ctx(),
      policy as any,
      async () => ({
        status: 500,
        body: "boom",
        contentType: "application/json",
        headers: {},
      }),
    );

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.code).toBe("WRITEBACK_REJECTED");
      expect(result.userMessage).toContain("No ontology edits were applied");
    }
  });

  it("a transport failure returns WRITEBACK_TIMEOUT", async () => {
    legacyWebhook();
    const result = await writeback.executeWriteback(
      {
        webhookId: "legacy-writeback-hook",
        webhookVersion: 1,
        inputs: { x: 1 },
        failurePolicy: "abort",
        outputBindings: {},
      },
      ctx(),
      policy as any,
      async () => {
        throw new Error("ETIMEDOUT");
      },
    );

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.code).toBe("WRITEBACK_TIMEOUT");
      expect(result.userMessage).toContain("No ontology edits were applied");
    }
  });

  it("a successful writeback returns ok with extracted outputs", async () => {
    legacyWebhook();
    const result = await writeback.executeWriteback(
      {
        webhookId: "legacy-writeback-hook",
        webhookVersion: 1,
        inputs: { x: 1 },
        failurePolicy: "abort",
        outputBindings: {
          outer: { outputId: "outer", path: "/a/b", schema: {}, valueType: "integer" },
        },
      },
      ctx(),
      policy as any,
      async () => ({
        status: 200,
        body: JSON.stringify({ a: { b: 42 } }),
        contentType: "application/json",
        headers: {},
      }),
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.outputs.outer).toBe(42);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Side-effect post-commit execution
// ---------------------------------------------------------------------------

describe("Side-effect post-commit execution", () => {
  it("outbox rows are invisible to the worker when the main transaction rolls back", async () => {
    const executionId = randomUUID();
    const actionTypeId = randomUUID();

    const client = await dbMod.getClient();
    try {
      await client.query("BEGIN");
      await sideEffectMod.enqueueSideEffectJobsInTransaction(client, {
        executionId,
        actionTypeId,
        actionTypeVersion: 1,
        jobs: [
          {
            sideEffectIndex: 0,
            kind: "webhook",
            payload: { spec: { url: "https://example.com" }, context: {} },
          },
        ],
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const claimed = await sideEffectMod.claimSideEffectJobs(10);
    expect(claimed.some((j) => j.execution_id === executionId)).toBe(false);
  });

  it("outbox rows become claimable only after the main transaction commits", async () => {
    const executionId = randomUUID();
    const actionTypeId = randomUUID();

    const client = await dbMod.getClient();
    try {
      await client.query("BEGIN");
      await sideEffectMod.enqueueSideEffectJobsInTransaction(client, {
        executionId,
        actionTypeId,
        actionTypeVersion: 1,
        jobs: [
          {
            sideEffectIndex: 0,
            kind: "webhook",
            payload: { spec: { url: "https://example.com" }, context: {} },
            idempotencyKey: "k1",
          },
        ],
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const claimed = await sideEffectMod.claimSideEffectJobs(10);
    const mine = claimed.filter((j) => j.execution_id === executionId);
    expect(mine.length).toBe(1);
    expect(mine[0].status).toBe("running");
    expect(mine[0].kind).toBe("webhook");
    expect(mine[0].idempotency_key).toBe("k1");
  });

  it("enqueue is idempotent within one transaction (unique execution+index)", async () => {
    const executionId = randomUUID();
    const actionTypeId = randomUUID();

    const client = await dbMod.getClient();
    try {
      await client.query("BEGIN");
      await sideEffectMod.enqueueSideEffectJobsInTransaction(client, {
        executionId,
        actionTypeId,
        actionTypeVersion: 1,
        jobs: [
          { sideEffectIndex: 0, kind: "notification", payload: {} },
        ],
      });
      await expect(
        sideEffectMod.enqueueSideEffectJobsInTransaction(client, {
          executionId,
          actionTypeId,
          actionTypeVersion: 1,
          jobs: [
            { sideEffectIndex: 0, kind: "notification", payload: {} },
          ],
        }),
      ).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
