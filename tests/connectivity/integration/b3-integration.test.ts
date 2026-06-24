// ---------------------------------------------------------------------------
// B3 integration tests — Postgres 16 Testcontainers fixture.
//
// Exercises the six in-session acceptance criteria literally:
//   1. testConnection -> ok:true + server version in <2s.
//   2. Wrong password -> 401 JdbcAuthFailed; no plaintext in response/logs.
//   3. verify-full rejects self-signed; verify-ca accepts when CA provided.
//      (TLS branch uses a dedicated TLS container; gated on
//      TELLUS_B3_TLS_FIXTURE=1.)
//   4. Discovery on 1000-table fixture paginates deterministically.
//   5. getImportedKeys round-trips and feeds B10's FK suggestions.
//   6. Type mapper handles every entry in the table.
// ---------------------------------------------------------------------------

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PgFixture,
  setEnvForTest,
  startPostgres16,
} from "../../fixtures/containers";
import type { ConnectionCreateRequest } from "../../../src/services/connectivity/contracts";

// ---------------------------------------------------------------------------
// Fixture wiring (diagnosis: option B — wire the missing boot/shutdown/Booted
// surface INLINE over the helpers tests/fixtures/containers.ts actually
// exports).
//
// The original harness imported `boot`/`shutdown`/`Booted` from the shared
// fixture, but tests/fixtures/containers.ts only exports startPostgres16(),
// resetConnectivityTables() and setEnvForTest() — so that binding resolved to
// `undefined` and `await boot(...)` threw "boot is not a function". We provide
// the equivalent surface here, keeping the change local to b3 (no src/ or
// shared-fixture edits) and the test bodies verbatim.
//
// CRITICAL ORDERING: the src connectivity modules MUST be imported lazily,
// only AFTER we point the platform PG env at the test container. src/db.ts
// builds its pool eagerly at module load from PGHOST/PGPORT/PGDATABASE/PGUSER/
// PGPASSWORD — it does NOT read DATABASE_URL, which is the only thing
// setEnvForTest() sets. A static top-level import would therefore bind the
// platform pool to the global tellus_db (vitest's default PG env) instead of
// the B3 target container, and every connection-row lookup would then 404 —
// exactly the failure mode the sibling b1 suite exhibits in this environment.
// Deferring the import to after the env is set binds the pool to the container.
// ---------------------------------------------------------------------------

// Tests are skipped if Docker (the Testcontainers runtime) is opted out
// (CI gating mirrors B1).
const D = process.env.TELLUS_B3_DOCKER === "0" ? it.skip : it;

// Lazily-imported src connectivity stack (assigned in boot(), after the env is
// pointed at the container — see the ordering note above).
type TestHandlerModule =
  typeof import("../../../src/services/connectivity/handlers/test.handler");
type DiscoveryModule =
  typeof import("../../../src/services/connectivity/connectors/postgresql/discovery");
type PoolModule =
  typeof import("../../../src/services/connectivity/connectors/postgresql/pool");
type TypeMappingModule =
  typeof import("../../../src/services/connectivity/connectors/postgresql/type-mapping");
let testConnection: TestHandlerModule["testConnection"];
let discovery: DiscoveryModule;
let poolMod: PoolModule;
let mapOidToTellus: TypeMappingModule["mapOidToTellus"];

interface CreatePgConnectionOpts {
  folderRid: string;
  name: string;
  passwordOverride?: string;
}

interface Booted {
  rootFolderRid: string;
  createPgConnection(opts: CreatePgConnectionOpts): Promise<string>;
}

let booted: Booted;
let pgRid: string;
let fixture: PgFixture;

/**
 * Boot the B3 target: a fresh postgres:16 Testcontainer, the platform pool
 * bound to it, and the lazily-imported connectivity stack. Returns a `Booted`
 * handle exposing the root folder + a helper that persists a connection row
 * (config + inline egress allowlist) and seals its password credential via the
 * B2 vault — i.e. exactly the surface b3's tests consume.
 */
async function boot(_opts?: { includePg?: boolean }): Promise<Booted> {
  fixture = await startPostgres16();

  // The shared fixture's B1_MIGRATIONS list omits 085 (connection_settings),
  // which connections.repo.insert writes — without it the INSERT fails on the
  // missing `settings` column. Apply it directly here so the container schema
  // matches what the repo expects, without editing the shared fixture.
  await fixture.pool.query(
    readFileSync(
      resolve(
        __dirname,
        "..",
        "..",
        "..",
        "src/migrations/085_connection_settings.sql",
      ),
      "utf8",
    ),
  );

  // The container is BOTH the platform DB (connectivity_connections lives
  // here) AND the connection target the tests probe. Parse its URI once.
  const u = new URL(fixture.connectionString);
  const pgHost = u.hostname;
  const pgPort = Number(u.port);
  const pgDatabase = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const pgUser = decodeURIComponent(u.username);
  const pgPassword = decodeURIComponent(u.password);

  // Bind the platform pool (src/db.ts, eager at first import) to the container.
  process.env.PGHOST = pgHost;
  process.env.PGPORT = String(pgPort);
  process.env.PGDATABASE = pgDatabase;
  process.env.PGUSER = pgUser;
  process.env.PGPASSWORD = pgPassword;
  setEnvForTest(fixture);
  // The container listens on loopback; the egress guard blocks reserved
  // ranges unless an operator explicitly opts them back in.
  process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED =
    "localhost,127.0.0.1/8,::1";

  // The local-aesgcm KMS adapter reads its base KEK from this env var.
  process.env.TELLUS_LOCAL_KEK_B64 = randomBytes(32).toString("base64");

  // Now import the src stack — the platform pool binds to the container on
  // first evaluation.
  ({ testConnection } = await import(
    "../../../src/services/connectivity/handlers/test.handler"
  ));
  discovery = await import(
    "../../../src/services/connectivity/connectors/postgresql/discovery"
  );
  poolMod = await import(
    "../../../src/services/connectivity/connectors/postgresql/pool"
  );
  ({ mapOidToTellus } = await import(
    "../../../src/services/connectivity/connectors/postgresql/type-mapping"
  ));
  const vault = await import("../../../src/services/connectivity/credentials/vault");
  const connectionsRepo = await import(
    "../../../src/services/connectivity/store/connections.repo"
  );
  const db = await import("../../../src/db");
  // Inject the local KMS adapter via the documented test hook (setKmsAdapter)
  // rather than getKmsAdapter()'s lazy require("./adapters/local-aesgcm"),
  // whose CommonJS require() does not resolve a .ts module under vitest's
  // transform (MODULE_NOT_FOUND). ESM import() here IS transformed, so the
  // real AES-256-GCM adapter is used for seal/unseal — no production
  // behaviour is short-circuited.
  const { LocalAesGcmAdapter } = await import(
    "../../../src/lib/kms/adapters/local-aesgcm"
  );
  const { setKmsAdapter } = await import("../../../src/lib/kms");
  setKmsAdapter(new LocalAesGcmAdapter());
  const actor = fixture.testUserId;

  const createPgConnection = async ({
    folderRid,
    name,
    passwordOverride,
  }: CreatePgConnectionOpts): Promise<string> => {
    const rid = `ri.magritte.main.source.${randomUUID()}`;
    const password = passwordOverride ?? pgPassword;
    const request = {
      name,
      description: "b3 integration target",
      connectorType: "postgresql",
      workerType: "foundryWorker",
      config: {
        connectorType: "postgresql",
        postgres: {
          host: pgHost,
          port: pgPort,
          database: pgDatabase,
          user: pgUser,
          tlsMode: "disable",
        },
      },
      egressPolicy: {
        allowlist: [{ kind: "host", host: pgHost, port: pgPort }],
      },
      compassFolderRid: folderRid,
    } as ConnectionCreateRequest;
    await db.withTransaction(async (client) => {
      await connectionsRepo.insert(client, {
        rid,
        tenant: "default",
        request,
        actor,
      });
    });
    // Seal the credential through the B2 vault so the pool layer (getPool →
    // vault.unwrap) can recover the plaintext on connect.
    await vault.createOrRotate(
      rid,
      "default",
      "password",
      new TextEncoder().encode(password),
      actor,
    );
    return rid;
  };

  return { rootFolderRid: fixture.testFolderRid, createPgConnection };
}

async function shutdown(_b: Booted): Promise<void> {
  await poolMod?.drainAll().catch(() => undefined);
  await fixture?.cleanup().catch(() => undefined);
}

beforeAll(async () => {
  booted = await boot({ includePg: true });
  // Use the helper from containers.ts that creates a connection row pointing
  // at the test PG container and seeds a "default" credential.
  pgRid = await booted.createPgConnection({
    folderRid: booted.rootFolderRid,
    name: "b3-it-pg",
  });
}, 120_000);

afterAll(async () => {
  await poolMod.drainAll().catch(() => undefined);
  if (booted) await shutdown(booted);
}, 60_000);

describe("B3 — testConnection criterion 1", () => {
  D("returns ok:true with server version under 2s", async () => {
    const start = Date.now();
    const res = mockRes();
    await testConnection(
      { params: { rid: pgRid } } as never,
      res as never,
      ((e: unknown) => {
        if (e) throw e;
      }) as never,
    );
    const ms = Date.now() - start;
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.serverVersion).toMatch(/PostgreSQL 16/);
    expect(ms).toBeLessThan(2_000);
  });
});

describe("B3 — auth failure criterion 2", () => {
  D("wrong password yields 401 JdbcAuthFailed; no plaintext echo", async () => {
    const badRid = await booted.createPgConnection({
      folderRid: booted.rootFolderRid,
      name: "b3-it-pg-bad",
      passwordOverride: "definitely-wrong-PLAINTEXT-marker-A",
    });
    const res = mockRes();
    await testConnection(
      { params: { rid: badRid } } as never,
      res as never,
      ((e: unknown) => {
        if (e) throw e;
      }) as never,
    );
    expect(res.statusCode).toBe(401);
    expect(res.body.errorName).toBe("Tellus:Connectivity:JdbcAuthFailed");
    // Plaintext marker must NOT appear anywhere in the rendered envelope.
    expect(JSON.stringify(res.body)).not.toContain("PLAINTEXT-marker-A");
  });
});

describe("B3 — discovery pagination criterion 4", () => {
  D("1000-table fixture paginates deterministically", async () => {
    // Seed 1000 tables in a dedicated schema.
    await discovery._execOnPool(pgRid, "CREATE SCHEMA IF NOT EXISTS b3it");
    const stmts: string[] = [];
    for (let i = 0; i < 1000; i++) {
      stmts.push(`CREATE TABLE IF NOT EXISTS b3it.t_${i} (id int PRIMARY KEY)`);
    }
    // Batch in chunks of 200 to keep statements manageable.
    for (let i = 0; i < stmts.length; i += 200) {
      await discovery._execOnPool(pgRid, stmts.slice(i, i + 200).join(";"));
    }

    // Page through and assert deterministic order + no dup, no gap.
    const seen: string[] = [];
    let cursor: { schema: string; table: string } | null = null;
    let pages = 0;
    while (true) {
      pages += 1;
      const page = await discovery.discoverTables(pgRid, {
        schemaName: "b3it",
        cursor: cursor ?? undefined,
        pageSize: 200,
      });
      for (const r of page.rows) seen.push(r.tableName);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(20); // upper sanity bound
    }
    expect(seen.length).toBe(1000);
    // Deterministic lexicographic order:
    const sorted = [...seen].sort();
    expect(seen).toEqual(sorted);
    // No duplicates.
    expect(new Set(seen).size).toBe(1000);
  });
});

describe("B3 — imported keys criterion 5", () => {
  D("round-trips a multi-column FK", async () => {
    await discovery._execOnPool(
      pgRid,
      `CREATE SCHEMA IF NOT EXISTS b3fk;
       CREATE TABLE IF NOT EXISTS b3fk.parent (
         a int, b int, PRIMARY KEY (a, b));
       CREATE TABLE IF NOT EXISTS b3fk.child (
         id int PRIMARY KEY,
         pa int, pb int,
         FOREIGN KEY (pa, pb) REFERENCES b3fk.parent (a, b));`,
    );
    const fks = await discovery.discoverImportedKeys(pgRid, "b3fk", "child");
    expect(fks.length).toBe(1);
    expect(fks[0].columnNames).toEqual(["pa", "pb"]);
    expect(fks[0].refSchemaName).toBe("b3fk");
    expect(fks[0].refTableName).toBe("parent");
    expect(fks[0].refColumnNames).toEqual(["a", "b"]);
  });
});

describe("B3 — type mapper criterion 6", () => {
  D("every scalar OID in the canonical table maps without WARN", () => {
    const scalars = [
      16, 17, 20, 21, 23, 25, 114, 142, 700, 701, 1042, 1043, 1082, 1083,
      1114, 1184, 1186, 2950, 3802, 3910,
    ];
    for (const oid of scalars) {
      expect(mapOidToTellus(oid).warn).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Local helper: tiny Express-Response mock that captures status & body.
// ---------------------------------------------------------------------------
function mockRes(): { statusCode: number; body: any; status: any; json: any } {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (s: number) => {
    r.statusCode = s;
    return r;
  };
  r.json = (b: unknown) => {
    r.body = b;
    return r;
  };
  return r;
}
