// B2-C-11 negative-test proof. Asserts that creating a project with a
// well-formed but unknown spaceRid is rejected with SPACE_NOT_FOUND (404).
//
// Triplet protocol per the brief §5:
//   Run as-is → expect throw with code=SPACE_NOT_FOUND (GREEN exit 0)
//   Stash projectService.ts (B2 validation removed) → re-run → expect
//     the call to succeed (RED — proof the validation is what fails the
//     bad input). Caller must roll the project back to keep state clean.
//   Pop stash, re-run → GREEN again.
import knexLib from "knex";
import { ProjectService } from "../src/services/projectService";
import { OntologyError } from "../src/utils/queryErrors";

const knex = knexLib({
  client: "pg",
  connection: {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "tellus",
    password: process.env.PGPASSWORD || "tellus123",
    database: process.env.PGDATABASE || "tellus_db",
  },
});

async function main() {
  const u = await knex("users").first("id", "email");
  if (!u) throw new Error("no seed user");
  console.log(`[setup] seed user: ${u.email}`);

  const ps = new ProjectService(knex);
  const tag = `b2-spacenotfound-${Date.now()}`;
  const bogusSpace = "ri.compass.main.space.11111111-1111-4111-8111-111111111111";

  let thrownCode: string | null = null;
  let project: { id?: string } | null = null;
  try {
    project = (await ps.createProject(tag, u.id, {
      spaceRid: bogusSpace,
    })) as { id?: string };
  } catch (e) {
    if (e instanceof OntologyError) thrownCode = e.code;
    else throw e;
  }

  if (project && project.id) {
    // RED PATH (validation stripped): the create succeeded with the bogus
    // space rid. We must clean up so the suite leaves no residue.
    await knex.raw("DELETE FROM resources WHERE legacy_uuid = ?::uuid", [project.id]);
    await knex("project_members").where({ project_id: project.id }).delete();
    await knex("projects").where({ id: project.id }).delete();
    console.error(`[RED] project created with bogus spaceRid ${bogusSpace}; B2-C-11 not enforced`);
    await knex.destroy();
    process.exit(2);
  }

  if (thrownCode !== "SPACE_NOT_FOUND") {
    console.error(`[RED] expected SPACE_NOT_FOUND, got ${thrownCode}`);
    await knex.destroy();
    process.exit(2);
  }

  console.log(`[GREEN] B2-C-11: SPACE_NOT_FOUND raised for ${bogusSpace}`);
  await knex.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
