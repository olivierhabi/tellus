// ---------------------------------------------------------------------------
// Vitest Global Setup — Server Lifecycle for Integration Tests
//
// F-05 FIX: When `npx vitest run` is invoked directly, the vitest process
// sets RATE_LIMIT_MAX=999999 in its own worker env (vitest.config.ts:54),
// but integration tests hit http://localhost:3000 — a separate process
// that never received that env var and defaults to 200 req/min.
//
// This globalSetup spawns the server process with the GLOBAL rate-limit
// (express-rate-limit) elevated to 999999, preventing 429s on non-rate-
// limiter tests. The ACTION-specific rate limits (ACTION_RATE_LIMIT_MAX,
// BATCH_RATE_LIMIT_MAX, etc.) are left at their defaults so that
// tests/tuesday/integration/rate-limiter-integration.test.ts can verify
// the action rate limiter works correctly at 100/min and 10/min batch.
//
// The server is killed on teardown. Port 3000 is claimed FAIL-CLOSED: only
// a leftover server that self-identifies (via /health.environmentId) as
// THIS test lane is ever killed; dev/verify servers abort the run loudly.
// The lane itself is pinned to dedicated infrastructure by ./laneEnv and
// re-proofed through src/services/testing/destructiveTestGuard.ts.
// ---------------------------------------------------------------------------

// Lane env MUST be pinned before any other import executes (the pg pool,
// envIdentity and auth configs all read process.env at import time). The
// `./laneEnv` module applies the deterministic test-lane identity
// (tellus_tests / tellus-tests-main / dedicated realm+indices+bucket) as an
// import side effect — the default lane can no longer be steered into the
// shared dev environment by a partially-overridden shell config.
import "./laneEnv";
import { spawn, execSync, spawnSync, type ChildProcess } from "child_process";
import path from "path";
import { LANE } from "./laneEnv";
import { bootstrapTestStack } from "./testStackBootstrap";
import { assertDestructiveTestEnvironment } from "../src/services/testing/destructiveTestGuard";

const ROOT = path.resolve(__dirname, "..");
let serverProcess: ChildProcess | null = null;

// ---------------------------------------------------------------------------
// Gap A — deterministic controlled webhook test service.
//
// A long-lived child process on 127.0.0.1:$CONTROLLED_WEBHOOK_PORT (default
// 3329, advertised as http://localhost:<port>) that every integration / E2E /
// Cypress test can target for writeback + side-effect webhook behavior. It is
// started here so no test requires a developer to start it manually, and torn
// down with the server. The app server's env also gets
// WebhookAllowInsecureHttpForDev=1 so the production webhook transport's
// buildEgressPolicy() permits HTTP to localhost ONLY (the SSRF-safe dev
// relaxation; production NODE_ENV keeps httpsRequired=true + unrestricted, so
// the relaxation never escapes the test environment). See §5 and §18 of the
// completion directive. The CLI lives at tests/webhooks/controlledWebhookServer.ts
// and the server factory at src/services/testing/controlledWebhookServer.ts.
// ---------------------------------------------------------------------------
let controlledWebhookProcess: ChildProcess | null = null;

/**
 * FUNN-ISO-1: port claiming is FAIL-CLOSED, not "kill whatever's there".
 *
 * A development server on :3000 self-identifies via /health.environmentId
 * (default "tellus-dev"). We kill the port ONLY when the responder is the
 * test lane's own leftover server (environmentId === lane env id). Any
 * other responder — dev, verify, unknown, silent — is an error: test
 * infrastructure never destroys a foreign process. That turn of the screw
 * is what makes "the integration suite wiped the dev ontology" impossible
 * even when a developer happens to leave their dev stack running.
 */
async function claimTestApiPort(port = 3000): Promise<void> {
  let foreign: string | null = null;
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const body = (await res.json()) as { environmentId?: unknown };
      foreign = typeof body?.environmentId === "string" ? body.environmentId : "<missing>";
    } else {
      foreign = `<http ${res.status}>`;
    }
  } catch {
    foreign = null; // unreachable — port is free
  }
  if (foreign === null) return;
  if (foreign !== LANE.TELLUS_ENVIRONMENT_ID) {
    throw new Error(
      `[globalSetup] REFUSING to scaffold the test lane: port ${port} is held by a ` +
        `server that self-identifies as environmentId='${foreign}' ` +
        `(expected '${LANE.TELLUS_ENVIRONMENT_ID}'). Stop it yourself — test ` +
        `infrastructure never kills foreign processes.`,
    );
  }
  console.log(
    `[globalSetup] port ${port} held by a leftover '${foreign}' server — killing it (lane-owned).`,
  );
  execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
}

/**
 * Seed the canonical test ontology (RRA Tax Ontology) + action types.
 *
 * This runs once per vitest invocation, BEFORE the server spawns. The seed
 * scripts (src/seed.ts + src/seeds/actionTypes.seed.ts) are idempotent:
 * src/seed.ts deletes and recreates the "RRA Tax Ontology"; actionTypes.seed
 * uses INSERT ... ON CONFLICT semantics via the service layer.
 *
 * Per the Palantir-1:1 test-fixture contract (docs/TEST-FIXTURES.md), every
 * integration suite assumes this canonical ontology exists. Per-suite
 * isolation is achieved via request-level ontology scoping (tests create
 * their own action types with unique apiNames under the shared ontology),
 * not via per-suite ontology re-creation.
 *
 * DATA_DIR is pinned to /tmp/ontology-testdata so datasourceService's
 * path-traversal guard accepts the seed CSVs.
 */
function runSeeds(): void {
  console.log("[globalSetup] Running seed: RRA Tax Ontology...");
  const seedEnv = {
    ...process.env,
    DATA_DIR: "/tmp/ontology-testdata",
  };

  const r1 = spawnSync("npx", ["tsx", path.join(ROOT, "src/seed.ts")], {
    cwd: ROOT,
    env: seedEnv,
    encoding: "utf8",
  });
  if (r1.status !== 0) {
    console.error("[globalSetup] seed stdout:", r1.stdout?.slice(-500));
    console.error("[globalSetup] seed stderr:", r1.stderr?.slice(-500));
    throw new Error(
      `[globalSetup] src/seed.ts failed with exit code ${r1.status}`,
    );
  }

  console.log("[globalSetup] Running seed: action types...");
  const r2 = spawnSync(
    "npx",
    ["tsx", path.join(ROOT, "src/seeds/actionTypes.seed.ts")],
    {
      cwd: ROOT,
      env: seedEnv,
      encoding: "utf8",
    },
  );
  if (r2.status !== 0) {
    console.error("[globalSetup] actionTypes seed stdout:", r2.stdout?.slice(-500));
    console.error("[globalSetup] actionTypes seed stderr:", r2.stderr?.slice(-500));
    throw new Error(
      `[globalSetup] actionTypes.seed.ts failed with exit code ${r2.status}`,
    );
  }

  console.log("[globalSetup] Seeds applied.");
}

/**
 * Backfill `_security.markings = ['PUBLIC']` onto every document in every
 * ontology index. Phase A4 (F-03) remediation: after the public-leak
 * branch was removed from buildSecurityFilter, a doc without
 * `_security.markings` is invisible to all marking-constrained users.
 * This step guarantees every pre-existing doc (seeded via API, indexed
 * via editApplicator before the ensure-security helper landed, or
 * persisted across a prior test run) carries the default classification
 * so legitimate reads are not accidentally starved.
 *
 * Idempotent: the painless script inside backfill-security.ts skips any
 * doc that already has non-empty markings.
 */
function runSecurityBackfill(): void {
  console.log("[globalSetup] Running _security backfill (F-03)...");
  const r = spawnSync(
    "npx",
    ["tsx", path.join(ROOT, "scripts/backfill-security.ts")],
    {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: "/tmp/ontology-testdata" },
      encoding: "utf8",
    },
  );
  if (r.status !== 0) {
    // Don't fail startup — if OpenSearch is down, backfill is a no-op and
    // marking-dependent tests will report their own clear failures. This
    // matches the Keycloak probe's "warn, don't block" posture.
    console.warn(
      "[globalSetup] backfill-security.ts exited with status",
      r.status,
      "— markings-dependent tests may fail (this is expected if OpenSearch is absent).",
    );
    console.warn("[globalSetup] backfill stderr:", r.stderr?.slice(-500));
    return;
  }
  console.log("[globalSetup] _security backfill complete.");
}

/**
 * Bootstrap the Keycloak realm with the test users the integration suites
 * authenticate as. Idempotent — safe to rerun.
 *
 * The four canonical test users (Palantir Multipass archetypes):
 *   • cypress-admin@tellus.local  — ontology-admin role (full clearance)
 *   • cypress@tellus.local        — ontology-editor role
 *   • cypress-viewer@tellus.local — ontology-viewer role
 *   • (dave — no-group/no-clearance — seeded in Phase A3 for fail-closed tests)
 *
 * Requires Keycloak at http://localhost:8086 with admin/admin credentials.
 * The bootstrap script is authoritative and creates the realm, clients,
 * roles, flows, required-actions, and users to spec.
 */
function runKeycloakBootstrap(): void {
  // Probe first — if Keycloak isn't reachable, warn loudly but don't block
  // unit-only suites. Integration suites that need auth will fail fast on
  // first login attempt, producing a clear signal (not a cryptic 401).
  const probe = spawnSync(
    "curl",
    ["-sf", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:8086"],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) {
    console.warn(
      "[globalSetup] Keycloak not reachable at http://localhost:8086 — " +
        "auth-dependent integration tests will fail. Start tellus-keycloak-1.",
    );
    return;
  }

  console.log("[globalSetup] Bootstrapping Keycloak test users...");
  const r = spawnSync("bash", [path.join(ROOT, "scripts/bootstrap-keycloak.sh")], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, KC_REALM: LANE.KEYCLOAK_REALM },
  });
  if (r.status !== 0) {
    console.error("[globalSetup] keycloak stdout:", r.stdout?.slice(-500));
    console.error("[globalSetup] keycloak stderr:", r.stderr?.slice(-500));
    throw new Error(
      `[globalSetup] bootstrap-keycloak.sh failed with exit code ${r.status}`,
    );
  }
  console.log("[globalSetup] Keycloak bootstrapped.");
}

/** Wait for PostgreSQL to be reachable (Docker Desktop may be waking up). */
async function waitForPg(maxWaitMs = 30_000): Promise<void> {
  const { Pool } = await import("pg");
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const p = new Pool({
      host: process.env.PGHOST || "localhost",
      port: parseInt(process.env.PGPORT || "5432", 10),
      // Maintenance DB: the lane DB (PGDATABASE tellus_tests) may not EXIST
      // yet — that's bootstrapTestStack's job; reachability is a server
      // property, not a lane-DB property.
      database: "postgres",
      user: process.env.PGUSER || "tellus",
      password: process.env.PGPASSWORD || "tellus123",
      connectionTimeoutMillis: 3000,
      max: 1,
    });
    try {
      await p.query("SELECT 1");
      await p.end();
      return; // PG is ready
    } catch {
      await p.end().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    "[globalSetup] PostgreSQL not reachable within 30 seconds. " +
      "Ensure Docker Desktop is running and `tellus-db` container is healthy."
  );
}

/**
 * Reuse branch — set by tests/runAll.ts via TELLUS_REUSE_SERVER=1.
 *
 * When runAll already owns a healthy server on :3000 (it calls startServer()
 * before Phase 3), each vitest invocation must NOT:
 *   - kill port 3000 (that nukes runAll's server mid-run)
 *   - re-run src/seed.ts + actionTypes.seed.ts (wasted ~4s each, ~400 MB
 *     peak RSS in two tsx children)
 *   - re-bootstrap Keycloak (the CI workflow already did it at
 *     .github/workflows/ci.yml:554-578, and runAll's server depends on it)
 *   - spawn a duplicate `tsx src/server.ts` (the root cause of the OOM —
 *     two app servers and five tsx children concurrent on a 7 GB runner
 *     reliably tripped the kernel OOM killer, exit 137).
 *
 * We still run the v8 coverage dir prep if COVERAGE_COLLECT_SERVER=1, and
 * we still probe :3000/health so the caller sees a clear error if the
 * runAll-owned server died since it was last verified.
 */
async function isServerHealthy(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:3000/health", {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function setup(): Promise<void> {
  if (process.env.TELLUS_REUSE_SERVER === "1") {
    if (await isServerHealthy()) {
      console.log(
        "[globalSetup] TELLUS_REUSE_SERVER=1 and :3000 is healthy — " +
          "reusing caller-managed server (skipping seed, Keycloak bootstrap, and server spawn).",
      );
      return;
    }
    console.warn(
      "[globalSetup] TELLUS_REUSE_SERVER=1 but :3000 is NOT healthy — " +
        "falling through to full setup. Caller (runAll.ts) should have " +
        "started the server before invoking vitest.",
    );
  }

  // (FUNN-ISO-1) Step −1: the lane identity is pinned by `./laneEnv` on
  // import. NOTHING in the following sequence may run unless the resulting
  // environment passes the destructive-test guard end to end — including a
  // live DB-level seal check. This is the structural turn of the screw that
  // makes the 2026-07-31 "the integration suite wiped the dev ontology"
  // incident unpossible.

  // Step 0: Ensure PostgreSQL is reachable before spawning the server.
  // Docker Desktop on macOS can take several seconds to wake up.
  console.log("[globalSetup] Waiting for PostgreSQL...");
  await waitForPg();
  console.log("[globalSetup] PostgreSQL ready.");

  // Step 0.1: provision the lane's own infrastructure (idempotent):
  // tellus_tests database + migrations + environment seal + dedicated
  // Temporal namespace/search attributes. Non-destructive — runs BEFORE the
  // destructive guard so a fresh machine can establish the seal the guard
  // then demands.
  await bootstrapTestStack();

  // Step 0.2: prove this lane may destructively mutate infrastructure. Any
  // missing/ambiguous/foreign fragment → hard failure, before ANY delete.
  const proof = await assertDestructiveTestEnvironment({
    operation: "vitest-globalSetup",
    skipApiProbe: true, // the lane server does not exist yet
  });
  console.log(
    `[globalSetup] destructive-test guard passed: lane='${proof.environmentId}' ` +
      `db='${proof.databaseName}' realm='${proof.keycloakRealm}' prefix='${proof.objectIndexPrefix}' ` +
      `bucket='${proof.objectStorageBucketOrPrefix}'`,
  );

  // Step 0.3: Quiesce — claim :3000 ONLY if it belongs to a leftover lane
  // server (foreign environments are NEVER killed; see claimTestApiPort).
  await claimTestApiPort(3000);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Step 0.5: Seed the canonical test ontology + action types. This must
  // run BEFORE the server spawns — some routes read the seeded ontology
  // on startup (action type registry warmup).
  runSeeds();

  // Step 0.6: Bootstrap Keycloak test realm + users so auth-dependent
  // integration suites can log in as cypress@tellus.local / Password123!.
  // Idempotent and fast on a re-run (all upserts are HTTP 409-safe).
  runKeycloakBootstrap();

  const serverPath = path.join(ROOT, "src/server.ts");

  // F-12 (Phase A exit gate): Critical-path modules (editApplicator,
  // actionExecutor, queryExecutor, branchMergeService, route handlers,
  // middleware) execute in the spawned server subprocess, not the vitest
  // worker. Vitest's coverage-v8 provider uses `inspector.takePreciseCoverage`
  // against its own V8 isolate and cannot see the subprocess — so server
  // modules show 0% coverage by default.
  //
  // Workaround: set NODE_V8_COVERAGE on the subprocess so Node writes raw
  // v8 coverage profiles to disk on graceful shutdown. A post-vitest step
  // (see scripts/coverage-server.sh + package.json `test:coverage:full`)
  // runs `c8 report` against those profiles to produce a separate
  // critical-path coverage report. When COVERAGE_COLLECT_SERVER=1 is set
  // (by the script), globalSetup activates the instrumentation.
  let v8CovDir = process.env.NODE_V8_COVERAGE;
  if (!v8CovDir && process.env.COVERAGE_COLLECT_SERVER === "1") {
    v8CovDir = path.join(ROOT, "coverage/server-profiles");
    try {
      execSync(`mkdir -p "${v8CovDir}" && rm -f "${v8CovDir}"/coverage-*.json`);
    } catch {
      // Directory creation best-effort; subsequent write failures surface clearly.
    }
    console.log(
      `[globalSetup] Collecting server v8 coverage to ${v8CovDir} (F-12 instrumentation).`,
    );
  }

  serverProcess = spawn("npx", ["tsx", serverPath], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...(v8CovDir ? { NODE_V8_COVERAGE: v8CovDir } : {}),
      // Elevate the global express-rate-limit AND the batch per-user
      // limit so non-rate-limiter test suites don't exhaust the shared
      // counter. The dedicated rate-limiter-integration.test.ts reads
      // these env vars to calibrate its request counts.
      // Enable test-only hooks (e.g., /api/v1/_test/rate-limiter/reset).
      // This is gated in src/server.ts by TELLUS_TEST_HOOKS === "1" and MUST
      // NOT be set in production. It enables the rate-limiter test suite to
      // reset in-process counter state without restarting the server.
      TELLUS_TEST_HOOKS: "1",
      RATE_LIMIT_MAX: "999999",
      // Restore action-specific rate limits to their production defaults.
      // CI workflows (and some developer shells) set these to elevated
      // values to avoid cross-suite interference on the global express
      // limiter, but the rate-limiter integration suite fires exactly
      // 101 requests expecting the default 100/min perActionType limit
      // to fire. Without these explicit overrides, CI's
      // ACTION_RATE_LIMIT_MAX=10000 leaks through `...process.env` and
      // tests 2-5 + 9-10 of rate-limiter-integration.test.ts fail with
      // "expected 200 to be 429". All other action tests use unique
      // action-type names and fire <100 requests per action per minute,
      // so defaults are safe. See rate-limiter-integration.test.ts for
      // the contract these defaults satisfy.
      ACTION_RATE_LIMIT_MAX: "100",
      USER_RATE_LIMIT_MAX: "50000",
      GLOBAL_ACTION_RATE_LIMIT_MAX: "100000",
      // F-CI-POOL: bump PG pool to handle concurrent vitest workers + the
      // batch action / rate-limiter suites that fan out 100+ inflight
      // requests against a single server. Default 20 exhausts under load
      // and surfaces as `timeout exceeded when trying to connect`.
      PG_POOL_MAX: process.env.PG_POOL_MAX || "40",
      PG_CONNECT_TIMEOUT_MS: process.env.PG_CONNECT_TIMEOUT_MS || "20000",
      // Elevate the batch-per-user limit to 500. The batch rate limiter
      // keys on `batch:${user.id || "anonymous"}`, and every
      // unauthenticated integration test shares the "anonymous" key.
      // vitest runs suites in parallel, so combined batch calls from
      // friday-integration.test.ts (3), batch-actions-integration.test.ts
      // (~10) and rate-limiter-integration.test.ts (batchLimit+1) easily
      // exceed the production default of 10/min. Setting 500 keeps headroom
      // for all suites while allowing rate-limiter test 8 to self-calibrate
      // via its own read of BATCH_RATE_LIMIT_MAX (it sends batchLimit+1
      // requests = 501, which consumes ~15–20s at sequential cadence).
      // Phase A2 (F-01 global auth) will move each test to a per-user JWT,
      // at which point this can return to the production default.
      BATCH_RATE_LIMIT_MAX: "500",
      // Disable background workers that require external services
      // (Temporal, ClickHouse, Lakekeeper) — integration tests exercise
      // the HTTP surface, not the async worker paths.
      FUNNEL_DISPATCHER_DISABLED: "true",
      PIPELINE_DISPATCHER_DISABLED: "true",
      PIPELINE_ICEBERG_MAINTENANCE_DISABLED: "true",
      OVERLAY_SWEEPER_DISABLED: "true",
      REPLACEMENT_SCHEDULER_DISABLED: "true",
      TEMPORAL_WORKER_DISABLED: "true",
      // Gap A — permit the production webhook transport to call the
      // controlled webhook service over HTTP to localhost ONLY. The
      // SSRF-safe buildEgressPolicy() relaxation requires NODE_ENV !==
      // "production" AND WebhookAllowInsecureHttpForDev=1; the running
      // test server is a dev process, so this is safe and scoped.
      WebhookAllowInsecureHttpForDev: "1",
      // Gap E/F — enable version-2 action-type creation so interface-object
      // and interface-link rule discriminators can be authored on the test
      // server. Gated off by default in production pending the v2 runbook.
      ACTION_SEMANTICS_V2_CREATION_ENABLED: "1",
      // Gap G/H — allow the action side-effect webhook delivery path
      // (connectivity egress) to reach the controlled service on loopback.
      // Mirrors the existing actionWebhooks unit-test opt-in. Test-only.
      CONNECTIVITY_EGRESS_ALLOW_RESERVED: "localhost,127.0.0.1/8,::1",
      // The request-timeout middleware defaults to 5000ms; the first action
      // apply after a cold seed (fresh OpenSearch indices) can exceed that on
      // a chilly CI box and falsely 504. Give the integration server a
      // generous action budget (test-only; production keeps the 5s default).
      REQUEST_TIMEOUT_MS: "30000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  serverProcess.unref();

  // Gap A — start the deterministic controlled webhook service alongside the
  // app server. It advertises http://localhost:<port>; integration/E2E tests
  // read CONTROLLED_WEBHOOK_URL (set below) to target it. Detached so it dies
  // with the group on teardown.
  const controlledPort = String(process.env.CONTROLLED_WEBHOOK_PORT ?? "3329");
  try {
    controlledWebhookProcess = spawn(
      "npx",
      ["tsx", path.join(ROOT, "tests/webhooks/controlledWebhookServer.ts")],
      {
        cwd: ROOT,
        env: { ...process.env, CONTROLLED_WEBHOOK_PORT: controlledPort },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    controlledWebhookProcess.unref();
    process.env.CONTROLLED_WEBHOOK_URL = `http://localhost:${controlledPort}`;
    // Tests that drive the side-effect worker IN-PROCESS (runOnce) deliver
    // webhooks from the vitest process itself, so the connectivity egress
    // guard reads THIS process's env — mirror the server child's allowlist
    // or in-process deliveries are egress-blocked while server-loop
    // deliveries succeed (flaky split-brain delivery in outbox tests).
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED ??= "localhost,127.0.0.1/8,::1";
    controlledWebhookProcess.stderr?.on("data", (c: Buffer) => {
      // eslint-disable-next-line no-console
      console.error(`[globalSetup] controlled-webhook stderr: ${c.toString()}`);
    });
  } catch {
    controlledWebhookProcess = null;
  }

  // Collect server stdout/stderr for diagnostic output on failure
  let serverLog = "";
  serverProcess.stdout?.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString();
  });
  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    serverLog += msg + "\n";
    if (msg.includes("FATAL") || msg.includes("Error")) {
      console.error(`[globalSetup:server:stderr] ${msg}`);
    }
  });

  // Wait for server to become healthy (max 60s — Docker Desktop can be slow)
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch("http://localhost:3000/health", {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        console.log(
          `[globalSetup] Server ready (PID ${serverProcess.pid}) with RATE_LIMIT_MAX=999999`
        );
        // Post-spawn re-proof: the lane API's own /health.environmentId must
        // attest to identical identity. If an existing FOREIGN server got
        // there first (race), we notice before any test touches it.
        await assertDestructiveTestEnvironment({
          operation: "vitest-globalSetup-post-spawn",
        });
        // Server is up; seeded data has been indexed to OpenSearch via
        // editApplicator. Run the F-03 backfill last so both pre-existing
        // docs AND seed-generated docs carry _security.markings.
        runSecurityBackfill();
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Server failed to start — dump collected logs and throw
  console.error("[globalSetup] Server log:\n" + serverLog.slice(-2000));
  throw new Error(
    "[globalSetup] Server failed to start within 60 seconds. " +
      "Check that PostgreSQL is running and PGHOST/PGDATABASE/PGUSER/PGPASSWORD are set."
  );
}

export async function teardown(): Promise<void> {
  // Reuse branch: we did NOT spawn a server (serverProcess is null) because
  // runAll.ts owns it. Killing :3000 here would destroy the caller's server
  // between vitest invocations and break the subsequent Phase 3 suites.
  // Leave lifecycle management entirely to runAll in that mode.
  if (process.env.TELLUS_REUSE_SERVER === "1" && !serverProcess) {
    return;
  }

  if (serverProcess?.pid) {
    try {
      // Kill the entire process group (negative PID) since detached=true.
      // SIGTERM allows the server's gracefulShutdown to fire, which gives
      // Node's v8 coverage writer time to flush the profile to
      // NODE_V8_COVERAGE. Without this, the server's coverage would be
      // lost and critical-path modules would show 0% in reports.
      process.kill(-serverProcess.pid, "SIGTERM");
      // Allow up to 3s for graceful flush (matches gracefulShutdown.ts).
      await new Promise((r) => setTimeout(r, 3000));
    } catch {
      // Process might already be dead
    }
    serverProcess = null;
  }
  // Gap A — stop the controlled webhook service with the server.
  if (controlledWebhookProcess?.pid) {
    try {
      process.kill(-controlledWebhookProcess.pid, "SIGTERM");
    } catch {
      // Best-effort; the process may have already exited.
    }
    controlledWebhookProcess = null;
  }
  // Belt+braces: only kills the port if it currently belongs to the lane
  // server (never a foreign process — see claimTestApiPort).
  await claimTestApiPort(3000);
}
