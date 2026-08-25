import "dotenv/config";
import { pool } from "./src/db.js";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ridSuffix = (rid: string) => rid.split(".").pop() ?? rid;
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
(async () => {
  const builds = await pool.query<{ rid: string; actor: string; outputs: unknown; started_at: string }>(
    `SELECT rid, actor, outputs, started_at FROM transform_build ORDER BY started_at DESC`);
  const actors = new Set<string>(); let foundryOuts = 0; let totalOuts = 0;
  const outRows: { build: string; actor: string; outRid: string; uuid: string }[] = [];
  for (const b of builds.rows) {
    actors.add(b.actor);
    for (const o of (Array.isArray(b.outputs) ? b.outputs : [])) {
      const r = (o as { outputRid?: string }).outputRid; if (!r) continue; totalOuts++;
      const uuid = ridSuffix(r);
      if (UUID_RE.test(uuid)) { foundryOuts++; outRows.push({ build: b.rid, actor: b.actor, outRid: r, uuid }); }
    }
  }
  console.log(`past builds: ${builds.rowCount} | distinct actors: ${[...actors].join(", ")}`);
  console.log(`total outputs: ${totalOuts} | foundry-catalog (uuid) outputs: ${foundryOuts}`);

  // Now the per-output effectiveRole check (lazy-load foundryDb only here, with a per-call timeout).
  const { DatasetAclService } = await import("./src/services/datasetAcl.js");
  const svc = new DatasetAclService();
  let flagged = 0; let checked = 0; let errored = 0;
  for (const r of outRows) {
    checked++;
    let role: string;
    try { role = String(await withTimeout(svc.effectiveRole(r.uuid, r.actor, []), 8000)); }
    catch (e) { role = `ERR:${(e as Error).message.slice(0,40)}`; errored++; }
    const writeOk = role === "editor" || role === "owner";
    if (!writeOk) { flagged++; console.log(`  FLAG build=${r.build.slice(-12)} actor=${r.actor} output=${r.outRid.slice(-12)} effectiveRole=${role} -> write would be DENIED (unless actor was superadmin at the time; roles not persisted on the row)`); }
  }
  console.log(`\nfoundry outputs checked: ${checked} | errored: ${errored} | builds lacking write on an output: ${flagged}`);
  console.log(`FINDING: ${flagged === 0 ? "No past build crossed a boundary the new write-check would deny (every foundry-catalog output had editor/owner, OR the actor was superadmin — bypass). Roles aren't persisted on transform_build, so a superadmin actor's bypass can't be row-confirmed; the actor list above is the key signal." : `${flagged} build(s) wrote a foundry output the actor lacks write on -> the new check denies these UNLESS the actor was superadmin at build time (verify the actor list).`}`);
  await pool.end(); try { const { default: knex } = await import("knex"); } catch {}
})().catch((e)=>{console.error("ERR:",e.message);process.exit(1);});
