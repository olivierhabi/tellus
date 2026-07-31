#!/usr/bin/env node
import "dotenv/config";
process.env.PGDATABASE = "tellus_automate_verify";
process.env.AUTOMATE_RUNTIME_DISABLED = "false";
process.env.CODE_REPOS_TEST_AUTH = "0";
process.env.TELLUS_TEST_HOOKS = "1";

async function main() {
  const automationId = process.argv[2];
  if (!automationId) {
    console.error("usage: node diag-live.mjs <automation-id>");
    process.exit(1);
  }
  const { pool } = await import("/Users/olivierhabimana/Desktop/projects/tellus/src/db.js");
  const { runAutomateLiveEventsOnce } = await import("/Users/olivierhabimana/Desktop/projects/tellus/src/services/automate/conditionRuntime.js");
  const beforeRow = (await pool.query(`SELECT last_event_sequence, state FROM automation_condition_state WHERE automation_id=$1`, [automationId])).rows[0] || {};
  console.log("before state: last_event_sequence=", beforeRow.last_event_sequence, "state=", String(beforeRow.state || "").slice(0, 80));
  const automation = (await pool.query("SELECT automation_id, current_version, tenant_id, ontology_id, status FROM automation WHERE automation_id=$1", [automationId])).rows[0] || {};
  console.log("automation:", JSON.stringify(automation));
  console.log("calling runAutomateLiveEventsOnce(worker=manual-1)...");
  const processed = await runAutomateLiveEventsOnce({ workerId: "manual-1", limitPerAutomation: 500 });
  console.log("processed =", processed);
  const afterRow = (await pool.query(`SELECT last_event_sequence FROM automation_condition_state WHERE automation_id=$1`, [automationId])).rows[0] || {};
  console.log("cursor after:", afterRow.last_event_sequence);
  await pool.end();
  process.exit(0);
}
main().catch(err => { console.error("error", err.message); process.exit(1); });
