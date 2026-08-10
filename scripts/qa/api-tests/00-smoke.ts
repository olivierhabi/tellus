// Smoke test: verify the API harness can log in and reach connectivity endpoints.
import { getApiContext, assert, assertStatus, qaRunSuffix } from "./harness.js";

async function main(): Promise<void> {
  const ctx = await getApiContext("admin");
  console.log(`logged in as ${ctx.username} (suffix ${ctx.runSuffix})`);
  assert(ctx.token.length > 50, "token should be non-trivial");

  // List connector types — read-only, every QA role can call it.
  const ct = await ctx.api("/api/v1/connectivity/connector-types");
  assertStatus(ct, 200, "GET /connector-types");
  console.log(`  /connector-types -> 200, body: ${JSON.stringify(ct.body).slice(0, 200)}`);

  // List folders — read-only.
  const folders = await ctx.api("/api/v1/connectivity/folders?pageSize=1");
  assert(folders.status === 200, `GET /folders should be 200, got ${folders.status}`);
  console.log(`  /folders -> ${folders.status}`);

  // List egress policies — read-only.
  const ep = await ctx.api("/api/v1/connectivity/egress-policies?pageSize=1");
  assert(ep.status === 200, `GET /egress-policies should be 200, got ${ep.status}`);
  console.log(`  /egress-policies -> ${ep.status}, body: ${JSON.stringify(ep.body).slice(0, 200)}`);

  console.log("harness smoke OK");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
