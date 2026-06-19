// ---------------------------------------------------------------------------
// Integration smoke test for the two new Compass Children kinds
// (`data-connection`, `quiver-analysis`). Exercises the REAL service code
// path (resolveFolder → per-source fan-out → merge → out-shape) against the
// live dev DB, then validates the output against the production zod contract.
//
//   npx tsx scripts/test-compass-children-newkinds.ts <projectId>
//
// Exit non-zero on any failed assertion so it can gate CI / a bash harness.
// ---------------------------------------------------------------------------
import { getChildren } from "../src/services/compassChildrenService";
import { ChildrenResponse, folderRid } from "../src/types/compassChildren";
import pool from "../src/db";

const projectId = process.argv[2] ?? "36271681-65d7-4c55-a6d0-20137f8212dc";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const rootRid = folderRid(projectId);
  console.log(`\nProject root folder RID: ${rootRid}\n`);

  // 1) Full listing (all kinds) — the project workspace's main call.
  const all = await getChildren({ folderRid: rootRid, pageSize: 200 });
  const out = ChildrenResponse.safeParse(all);
  assert(out.success, "response validates against ChildrenResponse contract");
  if (!out.success) { console.error(out.error.issues); return; }

  const byKind: Record<string, number> = {};
  for (const i of all.items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  console.log("  kind breakdown:", JSON.stringify(byKind));
  console.log("  partialErrors:", JSON.stringify(all.partialErrors));
  assert(all.partialErrors.length === 0, "no per-source partial errors");

  // 2) data-connection sources show up and carry the new fields.
  const sources = all.items.filter((i) => i.kind === "data-connection");
  assert(sources.length > 0, `data-connection sources present (${sources.length})`);
  for (const s of sources) {
    assert(s.rid.startsWith("ri.magritte.main.source."), `source rid well-formed: ${s.rid}`);
    assert(typeof (s as { connectorType?: unknown }).connectorType === "string", `source has connectorType (${s.displayName})`);
    assert(typeof (s as { status?: unknown }).status === "string", `source has status (${s.displayName})`);
    assert(s.parentFolderRid === rootRid, "source parentFolderRid echoes the queried folder");
  }

  // 3) kinds filter returns ONLY the requested kind.
  const onlySources = await getChildren({ folderRid: rootRid, pageSize: 200, kinds: "data-connection" });
  assert(
    onlySources.items.every((i) => i.kind === "data-connection"),
    "kinds=data-connection returns only data-connection items",
  );
  assert(onlySources.items.length === sources.length, "filtered count matches unfiltered count");

  // 4) quiver-analysis source is wired (count may be 0 for this project —
  //    that's correct, the existing rows live under workspace-default).
  const onlyQuiver = await getChildren({ folderRid: rootRid, pageSize: 200, kinds: "quiver-analysis" });
  assert(
    onlyQuiver.items.every((i) => i.kind === "quiver-analysis"),
    `kinds=quiver-analysis returns only quiver items (${onlyQuiver.items.length})`,
  );

  // 5) search narrows by displayName (case-insensitive) on the new kind.
  if (sources.length > 0) {
    const term = sources[0].displayName.slice(0, 4);
    const searched = await getChildren({ folderRid: rootRid, pageSize: 200, kinds: "data-connection", search: term });
    assert(
      searched.items.length > 0 && searched.items.every((i) => i.displayName.toLowerCase().includes(term.toLowerCase())),
      `search='${term}' narrows data-connection results`,
    );
  }

  console.log(`\nAll assertions passed.\n`);
}

main()
  .catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => {}); });
