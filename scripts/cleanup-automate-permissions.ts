import "dotenv/config";
import { getKeycloakAdminService } from "../src/services/keycloakAdminService";
import { pool } from "../src/db";

// Idempotent cleanup for verify-automate-permissions.ts: re-enable the
// dedicated owner (if disabled mid-run), archive any leftover
// "Perm verify %" automations, and delete the dedicated owner.
async function main() {
  const KC = getKeycloakAdminService();
  const u = await KC.findUserByEmail("automate-verify-owner@tellus.local").catch(() => null);
  if (u) {
    await KC.setUserEnabled(u.id, true).catch(() => undefined);
    console.log("owner re-enabled:", u.id);
  }
  const r = await pool.query(
    "SELECT automation_id FROM automation WHERE name LIKE 'Perm verify %' AND status <> 'archived'",
  );
  for (const row of r.rows) {
    await pool.query("UPDATE automation SET status = 'archived' WHERE automation_id = $1", [
      row.automation_id,
    ]);
    console.log("archived:", row.automation_id);
  }
  if (u) await KC.deleteUser(u.id).catch(() => undefined);
  console.log("owner removed");
  await pool.end();
}
void main().catch((e) => console.error(e)).finally(() => pool.end());
