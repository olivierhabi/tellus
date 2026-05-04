// ---------------------------------------------------------------------------
// B2 — DDL round-trip integration test for migration 053.
//
// Spec contracts proven:
//   B2-C-10  state CHECK ('ACTIVE','ARCHIVED','TRASHED')
//   B2-C-11  case-insensitive unique (parent_folder_rid, lower(display_name))
//           WHERE state='ACTIVE'
//   B2-C-12  resource_version >= 1 CHECK
//   B2-C-13  branch_cache PK(repository_rid, branch_name) + FK ON DELETE CASCADE
//   B2-C-14  saga_ledger.state CHECK
//   B2-C-15  saga_ledger UNIQUE (idempotency_key, principal_sub)
//   DoD §6  reversible — DOWN → UP succeeds idempotently.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openTestSchema, type TestSchema } from "../_helpers/pg";

const UP_PATH = path.resolve(
  process.cwd(),
  "src/migrations/053_b2_code_repository.sql",
);
const DOWN_PATH = path.resolve(
  process.cwd(),
  "src/migrations/053_b2_code_repository.down.sql",
);

const UP_SQL = readFileSync(UP_PATH, "utf8");
const DOWN_SQL = readFileSync(DOWN_PATH, "utf8");

let schema: TestSchema;

beforeAll(async () => {
  schema = await openTestSchema("b2_ddl");
  await schema.applyMigrationSql(UP_SQL);
});

afterAll(async () => {
  await schema.close();
});

const REPO_RID = (n: number) =>
  `ri.code-repository.main.repository.${String(n).padStart(8, "0")}-aaaa-bbbb-cccc-${String(
    n,
  ).padStart(12, "0")}`;
const FOLDER_RID = "ri.compass.main.folder.0123abcd-ef01-2345-6789-abcdef012345";
const PRINCIPAL_SUB = "11111111-2222-3333-4444-555555555555";
const TEMPLATE_ID = "typescript-functions";
const TEMPLATE_VERSION = "2.4.0";
const PROJECT_RID = "ri.compass.main.project.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function insertRepo(opts: {
  rid: string;
  displayName: string;
  state?: "ACTIVE" | "ARCHIVED" | "TRASHED";
  parentFolderRid?: string;
}) {
  const { rid, displayName } = opts;
  const state = opts.state ?? "ACTIVE";
  const parent = opts.parentFolderRid ?? FOLDER_RID;
  await schema.pool.query(
    `INSERT INTO code_repository (
       rid, display_name, parent_folder_rid, project_rid,
       template_id, template_version, default_branch,
       settings_json, state, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,'main','{}'::jsonb,$7,$8)`,
    [rid, displayName, parent, PROJECT_RID, TEMPLATE_ID, TEMPLATE_VERSION, state, PRINCIPAL_SUB],
  );
}

describe("B2 — code_repository CHECK + uniqueness", () => {
  it("B2-C-10: rejects state=BOGUS via CHECK", async () => {
    await expect(
      schema.pool.query(
        `INSERT INTO code_repository (rid, display_name, parent_folder_rid, project_rid,
           template_id, template_version, state, created_by)
         VALUES ($1,'rejected',$2,$3,'tpl','1.0.0','BOGUS',$4)`,
        [REPO_RID(900), FOLDER_RID, PROJECT_RID, PRINCIPAL_SUB],
      ),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });

  it("B2-C-12: rejects resource_version=0 via CHECK", async () => {
    await expect(
      schema.pool.query(
        `INSERT INTO code_repository (rid, display_name, parent_folder_rid, project_rid,
           template_id, template_version, state, created_by, resource_version)
         VALUES ($1,'rv-zero',$2,$3,'tpl','1.0.0','ACTIVE',$4, 0)`,
        [REPO_RID(901), FOLDER_RID, PROJECT_RID, PRINCIPAL_SUB],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("B2-C-11: rejects two ACTIVE repos with same (parent, lower(name))", async () => {
    await insertRepo({ rid: REPO_RID(1), displayName: "ProjectAlpha" });
    await expect(
      insertRepo({ rid: REPO_RID(2), displayName: "projectalpha" }),
    ).rejects.toMatchObject({ code: "23505" }); // unique_violation
  });

  it("B2-C-11: ALLOWS same name when one is TRASHED", async () => {
    const folder = "ri.compass.main.folder.dddddddd-aaaa-bbbb-cccc-eeeeeeeeeeee";
    await insertRepo({
      rid: REPO_RID(3),
      displayName: "Beta",
      state: "TRASHED",
      parentFolderRid: folder,
    });
    // Should succeed — partial index ignores non-ACTIVE.
    await insertRepo({
      rid: REPO_RID(4),
      displayName: "beta",
      state: "ACTIVE",
      parentFolderRid: folder,
    });
    const r = await schema.pool.query(
      `SELECT count(*)::int as c FROM code_repository WHERE parent_folder_rid=$1`,
      [folder],
    );
    expect(r.rows[0].c).toBe(2);
  });

  it("B2-C-11: ALLOWS same name in different parent folders", async () => {
    const otherFolder =
      "ri.compass.main.folder.bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    await insertRepo({
      rid: REPO_RID(5),
      displayName: "Gamma",
      parentFolderRid: FOLDER_RID,
    });
    await insertRepo({
      rid: REPO_RID(6),
      displayName: "Gamma",
      parentFolderRid: otherFolder,
    });
  });
});

describe("B2 — code_repository_branch_cache", () => {
  it("B2-C-13: PK is (repository_rid, branch_name)", async () => {
    await insertRepo({ rid: REPO_RID(10), displayName: "Cache1" });
    await schema.pool.query(
      `INSERT INTO code_repository_branch_cache (repository_rid, branch_name) VALUES ($1, 'main')`,
      [REPO_RID(10)],
    );
    await expect(
      schema.pool.query(
        `INSERT INTO code_repository_branch_cache (repository_rid, branch_name) VALUES ($1, 'main')`,
        [REPO_RID(10)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("B2-C-13: ON DELETE CASCADE removes branch cache rows", async () => {
    await insertRepo({ rid: REPO_RID(11), displayName: "Cache2" });
    await schema.pool.query(
      `INSERT INTO code_repository_branch_cache (repository_rid, branch_name) VALUES ($1, 'main'), ($1, 'dev')`,
      [REPO_RID(11)],
    );
    await schema.pool.query(`DELETE FROM code_repository WHERE rid = $1`, [
      REPO_RID(11),
    ]);
    const r = await schema.pool.query(
      `SELECT count(*)::int as c FROM code_repository_branch_cache WHERE repository_rid = $1`,
      [REPO_RID(11)],
    );
    expect(r.rows[0].c).toBe(0);
  });
});

describe("B2 — code_repository_saga_ledger", () => {
  it("B2-C-14: rejects state=BOGUS via CHECK", async () => {
    await expect(
      schema.pool.query(
        `INSERT INTO code_repository_saga_ledger
           (saga_id, idempotency_key, principal_sub, display_name,
            parent_folder_rid, template_id, template_version, state)
         VALUES ('01HSAGA000','22222222-3333-4444-5555-666666666666',$1,'x',$2,'tpl','1.0.0','BOGUS')`,
        [PRINCIPAL_SUB, FOLDER_RID],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("B2-C-15: UNIQUE (idempotency_key, principal_sub) — second insert wins on conflict only across keys", async () => {
    const idem = "33333333-4444-5555-6666-777777777777";
    await schema.pool.query(
      `INSERT INTO code_repository_saga_ledger
         (saga_id, idempotency_key, principal_sub, display_name,
          parent_folder_rid, template_id, template_version, state)
       VALUES ('01HSAGA001',$1,$2,'first',$3,'tpl','1.0.0','INIT')`,
      [idem, PRINCIPAL_SUB, FOLDER_RID],
    );
    // Same (idem, sub) → conflict.
    await expect(
      schema.pool.query(
        `INSERT INTO code_repository_saga_ledger
           (saga_id, idempotency_key, principal_sub, display_name,
            parent_folder_rid, template_id, template_version, state)
         VALUES ('01HSAGA002',$1,$2,'duplicate',$3,'tpl','1.0.0','INIT')`,
        [idem, PRINCIPAL_SUB, FOLDER_RID],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    // Same idem, different sub → OK.
    await schema.pool.query(
      `INSERT INTO code_repository_saga_ledger
         (saga_id, idempotency_key, principal_sub, display_name,
          parent_folder_rid, template_id, template_version, state)
       VALUES ('01HSAGA003',$1,'77777777-8888-9999-aaaa-bbbbbbbbbbbb','second',$2,'tpl','1.0.0','INIT')`,
      [idem, FOLDER_RID],
    );
  });

  it("accepts every legal saga state from the enum", async () => {
    const states = [
      "INIT",
      "COMPASS_RESERVED",
      "STEMMA_CREATED",
      "TEMPLATE_PUSHED",
      "ACTIVE",
      "COMPENSATING",
      "ROLLED_BACK",
      "INIT_FAILED",
    ];
    let i = 0;
    for (const s of states) {
      i += 1;
      const idem = `4${i}444444-5555-6666-7777-888888888888`;
      await schema.pool.query(
        `INSERT INTO code_repository_saga_ledger
           (saga_id, idempotency_key, principal_sub, display_name,
            parent_folder_rid, template_id, template_version, state)
         VALUES ($1, $2, $3, 'state-test', $4, 'tpl', '1.0.0', $5)`,
        [`01HSAGA${100 + i}`, idem, PRINCIPAL_SUB, FOLDER_RID, s],
      );
    }
    const r = await schema.pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM code_repository_saga_ledger WHERE display_name = 'state-test'`,
    );
    expect(r.rows[0].c).toBe(8);
  });
});

describe("B2 — DDL is reversible", () => {
  it("DOWN → UP succeeds idempotently", async () => {
    // Use a fresh schema to avoid disrupting the populated one above.
    const downSchema = await openTestSchema("b2_down");
    try {
      await downSchema.applyMigrationSql(UP_SQL);
      await downSchema.applyMigrationSql(DOWN_SQL);
      // After DOWN, tables should not exist.
      const after = await downSchema.pool.query(
        `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND relname IN
            ('code_repository','code_repository_branch_cache','code_repository_saga_ledger')`,
      );
      expect(after.rowCount).toBe(0);
      // Re-up must succeed.
      await downSchema.applyMigrationSql(UP_SQL);
    } finally {
      await downSchema.close();
    }
  });
});
