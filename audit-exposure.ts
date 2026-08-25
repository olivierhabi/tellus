import "dotenv/config";
import { pool } from "./src/db.js";
import { DatasetAclService } from "./src/services/datasetAcl.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ridSuffix = (rid: string) => rid.split(".").pop() ?? rid;

(async () => {
  const builds = await pool.query<{ rid: string; actor: string; outputs: unknown; started_at: string }>(
    `SELECT rid, actor, outputs, started_at FROM transform_build ORDER BY started_at DESC`,
  );
  console.log(`auditing ${builds.rowCount} past transform_build(s) for permission-boundary crossings`);

  const svc = new DatasetAclService();
  const distinctActors = new Set<string>();
  let flagged = 0;
  let checked = 0;

  for (const b of builds.rows) {
    distinctActors.add(b.actor);
    const outs = Array.isArray(b.outputs) ? b.outputs : [];
    for (const o of outs) {
      const outRid = (o as { outputRid?: string }).outputRid;
      if (!outRid) continue;
      const uuid = ridSuffix(outRid);
      if (!UUID_RE.test(uuid)) continue; // slug-rid output (dataset-table) — not a foundry-catalog output the new check gates
      checked++;
      const role = await svc.effectiveRole(uuid, b.actor, []).catch((e) => { console.log(`  [err] effectiveRole failed for ${b.rid}/${outRid}: ${e.message}`); return "ERROR" as const; });
      const writeOk = role === "editor" || role === "owner";
      if (!writeOk) {
        flagged++;
        // Would now be denied UNLESS the actor was superadmin at build time (roles
        // aren't persisted on transform_build, so this can't be confirmed from the row).
        console.log(`  FLAG  build=${b.rid.slice(-12)} actor=${b.actor} output=${outRid.slice(-12)} effectiveRole=${role} -> write would be DENIED (unless actor was superadmin at the time; not persisted)`);
      }
    }
  }

  console.log(`\ndistinct actors: ${[...distinctActors].join(", ")}`);
  console.log(`foundry-catalog outputs checked: ${checked}`);
  console.log(`builds with an output the actor LACKS write on: ${flagged}`);
  console.log(`\nFINDING: ${flagged === 0
    ? "No past build crossed a permission boundary that the new write-check would deny (all outputs the actor had editor/owner on, OR superadmin-bypass applies). NOTE: transform_build persists only the actor userId, not roles, so a superadmin actor's bypass can't be confirmed from the row — but no build had a non-editor effectiveRole that would force a denial for a non-superadmin."
    : `${flagged} build(s) wrote a foundry-catalog output the actor lacks write access to — the new check would deny these UNLESS the actor was superadmin at build time (roles not persisted; verify the actor list above).`}`);
  await pool.end();
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
