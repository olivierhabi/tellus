import "dotenv/config";
import { pool } from "../../../src/db.js";

async function main(): Promise<void> {
  const r = await pool.query(
    "SELECT key, value FROM system_settings WHERE key='require_passkey_enrollment'",
  );
  console.log("current:", JSON.stringify(r.rows));
  if (r.rows.length === 0) {
    await pool.query(
      "INSERT INTO system_settings (key, value) VALUES ('require_passkey_enrollment', 'false')",
    );
  } else {
    await pool.query(
      "UPDATE system_settings SET value='false' WHERE key='require_passkey_enrollment'",
    );
  }
  const r2 = await pool.query(
    "SELECT key, value FROM system_settings WHERE key='require_passkey_enrollment'",
  );
  console.log("after:", JSON.stringify(r2.rows));
  process.exit(0);
}
main();
