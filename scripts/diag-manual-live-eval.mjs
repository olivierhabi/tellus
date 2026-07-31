#!/usr/bin/env node
import "dotenv/config";
process.env.PGDATABASE = "tellus_automate_verify";
process.env.AUTOMATE_RUNTIME_DISABLED = "false";
process.env.CODE_REPOS_TEST_AUTH = "0";

const { pool } = await import("../src/db.js");
const { runAutomateLiveEventsOnce } = await import("../src/services/automate/conditionRuntime.js");

async function main() {
  const r = await runAutomateLiveEventsOnce({ workerId: `manual-${process.pid}`, limitPerAutomation: 500 });
  console.log("processed =", r);
  await pool.end();
  process.exit(0);
}
main().catch((e) => { console.error("err", e.message); process.exit(1); });
