#!/usr/bin/env node
import "dotenv/config";
process.env.PGDATABASE = "tellus_automate_verify";
process.env.AUTOMATE_RUNTIME_DISABLED = "false";
process.env.CODE_REPOS_TEST_AUTH = "0";

const { pool } = await import("../src/db.js");
const { runAutomateLiveEventsOnce } = await import("../src/services/automate/conditionRuntime.js");

// DIRECTLY reproduce S1: create an automation via the REST API (as _employee),
// seed an object, touch province (no trigger), rename (trigger expected).
const AUTOMATION_ID = "cypress-diag-" + Date.now();
const OWNER_UID = "d19a428a-1b78-40ce-95b7-850d799d0b65";

async function main() {
  // 1) Seed the VerifyTaxpayer object via the action route (login-bypass token)
  console.log("S1 DIAG — reading ontology object/object-set + os_state for baseline completeness");
  const events_before = (await pool.query(
    "SELECT count(*) AS cnt FROM object_set_event WHERE object_type_api_name='VerifyTaxpayer'"
  )).rows[0].cnt;
  console.log("events-before:", events_before);

  console.log("S1 DIAG — calling runAutomateLiveEventsOnce...");
  const processed = await runAutomateLiveEventsOnce({ workerId: "manual-diag-1", limitPerAutomation: 500 });
  console.log("processed =", processed);

  // Dump everything about any live automation
  const results = await pool.query(`
    SELECT a.automation_id, a.current_version, a.tenant_id, s.last_event_sequence, s.state
    FROM automation a
    JOIN automation_version v ON v.automation_id=a.automation_id AND v.version=a.current_version
    JOIN automation_condition_state s
      ON s.automation_id=a.automation_id AND s.automation_version=a.current_version
    WHERE a.status IN ('active','muted') AND v.definition->'condition'->>'evaluationMode'='live'
  `);
  console.log("live-automs:", JSON.stringify(results.rows.map(r=>({id:r.automation_id, es:r.last_event_sequence, state: r.state})), null, 2));

  await pool.end();
  process.exit(0);
}
main().catch((e) => { console.error("error:", e.message, e.stack); process.exit(1); });
