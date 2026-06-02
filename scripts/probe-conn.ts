// Exercise the REAL connectivity code path for one connection: build the pool
// exactly as the app does (vault unwrap → egress gate → pg.Pool), run the same
// liveness query the health prober uses, and persist the resulting status.
// This is the production code path, not a simulation.
import "dotenv/config";
import { getPool, evict } from "../src/services/connectivity/connectors/postgresql/pool";
import { recordStatus, stateForTellusError } from "../src/services/connectivity/health/recordStatus";
import { TellusError } from "../src/lib/errors/envelope";
import { pool as appPool } from "../src/db";

function stateForProbeError(err: any): "AUTH_FAILED" | "TLS_FAILED" | "UNREACHABLE" {
  if (err?.code === "28P01" || err?.code === "28000") return "AUTH_FAILED";
  if (/tls|ssl|certificate|self-signed/i.test(err?.message ?? "")) return "TLS_FAILED";
  return "UNREACHABLE";
}

async function main() {
  const rid = process.argv[2];
  if (!rid) {
    console.error("usage: tsx probe-conn.ts <connectionRid>");
    process.exit(2);
  }
  // Drop any cached pool so credentials/role changes are picked up fresh.
  await evict(rid).catch(() => undefined);
  try {
    const pg = await getPool(rid);
    const r = await pg.query("SELECT 1 AS ok");
    await recordStatus(rid, "HEALTHY", { probedBy: "scripts/probe-conn" });
    console.log(`PROBE_RESULT=HEALTHY rows=${JSON.stringify(r.rows)}`);
  } catch (err: any) {
    const state =
      err instanceof TellusError
        ? stateForTellusError(err.definition.errorName)
        : stateForProbeError(err);
    const reason =
      err instanceof TellusError ? err.definition.errorName : err?.message ?? String(err);
    await recordStatus(rid, state, { probedBy: "scripts/probe-conn", reason });
    console.log(`PROBE_RESULT=${state} reason=${reason}`);
    process.exitCode = 1;
  } finally {
    await evict(rid).catch(() => undefined);
    await appPool.end().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error("PROBE_FATAL:", e?.message ?? e);
  process.exit(1);
});
