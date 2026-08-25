// scripts/bootstrap_link_instances.ts
// Idempotent link_instances bootstrap + reconciliation command (§6).
//   PGHOST=… npx tsx scripts/bootstrap_link_instances.ts [--ontology=ID] [--branch=ID]
import { projectFromLedger, reconcileProjection } from "../src/actions/relationshipStateRepository";

async function main() {
  const args = process.argv.slice(2);
  const ontArg = args.find((a) => a.startsWith("--ontology="))?.split("=")[1] || undefined;
  const brArg = args.find((a) => a.startsWith("--branch="))?.split("=")[1] || undefined;

  console.log("=== link_instances bootstrap (idempotent ledger replay) ===");
  const built = await projectFromLedger(ontArg as any, brArg as any);
  console.log("applied from ledger:", built);

  console.log("=== reconciliation (projection vs ledger-derived active state) ===");
  const r = await reconcileProjection(ontArg as any, brArg as any);
  console.log(JSON.stringify(r, null, 2));
  console.log(r.mismatches === 0
    ? "PROJECTION READY — mismatch count is zero; safe to set ACTION_SEMANTICS_V2_PROJECTION_READY=1."
    : `PROJECTION NOT READY — ${r.mismatches} mismatch(es) remain; rerun bootstrap after resolving.`);
}

main().catch((e) => { console.error("bootstrap failed:", e); process.exit(1); }).finally(() => process.exit(0));
