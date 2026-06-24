// ---------------------------------------------------------------------------
// B2 — saga executor integration test.
//
// Drives the executor end-to-end against real Postgres + in-memory adapters.
//
// Spec contracts proven:
//   B2-C-20..29  saga state machine + compensation
//   B2-C-50      idempotency-key required + replay deterministic (G-C-22)
//   B2-C-30      NameConflict surfaced from PG unique-violation at step 4
//   B2-C-31      TemplateNotFound surfaced from template adapter
//   B2-C-32      TemplateInitFailed surfaced from template adapter
//   B2-C-33      ParentFolderNotFound surfaced from compass adapter
//   B2-C-15      DDL: UNIQUE (idempotency_key, principal_sub) replay
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openTestSchema, type TestSchema } from "../_helpers/pg";
import {
  InMemoryCompass,
  InMemoryStemma,
  InMemoryTemplate,
} from "../../../../src/services/codeRepository/adapters/inMemory";
import {
  executeCreateRepositorySaga,
  type SagaExecutorDeps,
} from "../../../../src/services/codeRepository/saga/executor";
import { loadSagaById } from "../../../../src/services/codeRepository/saga/ledgerStore";

const UP_PATH = path.resolve(
  process.cwd(),
  "src/migrations/053_b2_code_repository.sql",
);
const UP_SQL = readFileSync(UP_PATH, "utf8");

let schema: TestSchema;

beforeAll(async () => {
  schema = await openTestSchema("b2_executor");
  await schema.applyMigrationSql(UP_SQL);
});

afterAll(async () => {
  await schema.close();
});

const PRINCIPAL_SUB = "11111111-2222-3333-4444-555555555555";
const FOLDER_RID = "ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345";

function makeDeps(args: {
  compass?: InMemoryCompass;
  stemma?: InMemoryStemma;
  template?: InMemoryTemplate;
}): SagaExecutorDeps {
  return {
    pool: schema.pool,
    compass: args.compass ?? new InMemoryCompass(),
    stemma: args.stemma ?? new InMemoryStemma(),
    template: args.template ?? new InMemoryTemplate(),
  };
}

let idemCounter = 0;
function nextIdem(): string {
  idemCounter += 1;
  return `${String(idemCounter).padStart(8, "0")}-aaaa-bbbb-cccc-ddddddddeeee`;
}

describe("B2 saga executor — happy path", () => {
  it("walks INIT → COMPASS_RESERVED → STEMMA_CREATED → TEMPLATE_PUSHED → ACTIVE", async () => {
    const compass = new InMemoryCompass();
    const stemma = new InMemoryStemma();
    const template = new InMemoryTemplate();
    const deps = makeDeps({ compass, stemma, template });

    const result = await executeCreateRepositorySaga(deps, {
      idempotencyKey: nextIdem(),
      principalSub: PRINCIPAL_SUB,
      displayName: "MyRepo",
      parentFolderRid: FOLDER_RID,
      templateId: "typescript-functions",
      templateVersion: "2.4.0",
      defaultBranch: "main",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.replayed).toBe(false);
    expect(result.repositoryRid).toMatch(/^ri\.stemma\.main\.repository\./);

    const saga = await loadSagaById(schema.pool, result.sagaId);
    expect(saga?.state).toBe("ACTIVE");
    expect(saga?.compassResourceRid).toBeTruthy();
    expect(saga?.stemmaRepositoryRid).toBe(result.repositoryRid);
    expect(saga?.initialCommitSha).toMatch(/^[0-9a-f]{40}$/);

    // Verify code_repository row exists.
    const repo = await schema.pool.query(
      `SELECT state, display_name FROM code_repository WHERE rid = $1`,
      [result.repositoryRid],
    );
    expect(repo.rows[0]?.state).toBe("ACTIVE");
  });
});

describe("B2 saga executor — idempotency replay (G-C-22, B2-C-50)", () => {
  it("returns the same result on replay with same (idempotency_key, principal)", async () => {
    const deps = makeDeps({});
    const idem = nextIdem();
    const input = {
      idempotencyKey: idem,
      principalSub: PRINCIPAL_SUB,
      displayName: "ReplayRepo",
      parentFolderRid: FOLDER_RID,
      templateId: "typescript-functions",
      templateVersion: "2.4.0",
      defaultBranch: "main",
    };

    const r1 = await executeCreateRepositorySaga(deps, input);
    const r2 = await executeCreateRepositorySaga(deps, input);

    expect(r1.kind).toBe("ok");
    expect(r2.kind).toBe("ok");
    if (r1.kind !== "ok" || r2.kind !== "ok") return;

    expect(r2.sagaId).toBe(r1.sagaId);
    expect(r2.repositoryRid).toBe(r1.repositoryRid);
    expect(r1.replayed).toBe(false);
    expect(r2.replayed).toBe(true);
  });

  it("different principal can use the same idempotency key (separate sagas)", async () => {
    const deps = makeDeps({});
    const idem = nextIdem();
    const r1 = await executeCreateRepositorySaga(deps, {
      idempotencyKey: idem,
      principalSub: PRINCIPAL_SUB,
      displayName: "PrincipalIsolation1",
      parentFolderRid: FOLDER_RID,
      templateId: "typescript-functions",
      templateVersion: "2.4.0",
      defaultBranch: "main",
    });
    const r2 = await executeCreateRepositorySaga(deps, {
      idempotencyKey: idem,
      principalSub: "99999999-8888-7777-6666-555555555555",
      displayName: "PrincipalIsolation2",
      parentFolderRid: FOLDER_RID,
      templateId: "typescript-functions",
      templateVersion: "2.4.0",
      defaultBranch: "main",
    });
    expect(r1.kind).toBe("ok");
    expect(r2.kind).toBe("ok");
    if (r1.kind !== "ok" || r2.kind !== "ok") return;
    expect(r1.sagaId).not.toBe(r2.sagaId);
    expect(r1.repositoryRid).not.toBe(r2.repositoryRid);
  });
});

describe("B2 saga executor — failure paths + compensation", () => {
  it("step1 NameConflict → ROLLED_BACK directly (B2-C-29)", async () => {
    const compass = new InMemoryCompass({
      forceOutcome: { kind: "name-conflict" },
    });
    const deps = makeDeps({ compass });

    const result = await executeCreateRepositorySaga(deps, {
      idempotencyKey: nextIdem(),
      principalSub: PRINCIPAL_SUB,
      displayName: "ConflictRepo",
      parentFolderRid: FOLDER_RID,
      templateId: "typescript-functions",
      templateVersion: "2.4.0",
      defaultBranch: "main",
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.finalState).toBe("ROLLED_BACK");
    expect(result.errorName).toBe("CodeRepos:NameConflict");
  });

  it("step1 ParentFolderNotFound → ROLLED_BACK with ParentFolderNotFound (B2-C-33)", async () => {
    const compass = new InMemoryCompass({
      forceOutcome: { kind: "parent-not-found" },
    });
    const deps = makeDeps({ compass });
    const result = await executeCreateRepositorySaga(deps, {
      idempotencyKey: nextIdem(),
      principalSub: PRINCIPAL_SUB,
      displayName: "NoParent",
      parentFolderRid: FOLDER_RID,
      templateId: "typescript-functions",
      templateVersion: "2.4.0",
      defaultBranch: "main",
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.errorName).toBe("CodeRepos:ParentFolderNotFound");
  });

  it("step3 TemplateNotFound → COMPENSATING → ROLLED_BACK (B2-C-31)", async () => {
    const compass = new InMemoryCompass();
    const stemma = new InMemoryStemma();
    const template = new InMemoryTemplate({
      knownTemplates: new Set(), // every template is unknown
    });
    const deps = makeDeps({ compass, stemma, template });

    const result = await executeCreateRepositorySaga(deps, {
      idempotencyKey: nextIdem(),
      principalSub: PRINCIPAL_SUB,
      displayName: "BadTemplate",
      parentFolderRid: FOLDER_RID,
      templateId: "unknown-template",
      templateVersion: "1.0.0",
      defaultBranch: "main",
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.errorName).toBe("CodeRepos:TemplateNotFound");
    expect(result.finalState).toBe("ROLLED_BACK");

    // Compensations executed: stemma was tombstoned, compass was released.
    const saga = await loadSagaById(schema.pool, result.sagaId);
    expect(saga?.compassResourceRid).toBeTruthy();
    expect(saga?.stemmaRepositoryRid).toBeTruthy();
    expect(stemma.isTombstoned(saga!.stemmaRepositoryRid!)).toBe(true);
    expect(compass.isReleased(saga!.compassResourceRid!)).toBe(true);
  });

  it("step3 TemplateInitFailed → COMPENSATING → ROLLED_BACK (B2-C-32)", async () => {
    const template = new InMemoryTemplate({
      forceOutcome: { kind: "init-failed", reason: "out-of-disk" },
    });
    const deps = makeDeps({ template });

    const result = await executeCreateRepositorySaga(deps, {
      idempotencyKey: nextIdem(),
      principalSub: PRINCIPAL_SUB,
      displayName: "DiskFull",
      parentFolderRid: FOLDER_RID,
      templateId: "typescript-functions",
      templateVersion: "2.4.0",
      defaultBranch: "main",
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.errorName).toBe("CodeRepos:TemplateInitFailed");
    expect(result.finalState).toBe("ROLLED_BACK");
  });

  it("compensation failure → INIT_FAILED retriable (B2-C-26)", async () => {
    const compass = new InMemoryCompass({ releaseShouldThrow: true });
    const template = new InMemoryTemplate({
      forceOutcome: { kind: "init-failed", reason: "x" },
    });
    const deps = makeDeps({ compass, template });

    const result = await executeCreateRepositorySaga(deps, {
      idempotencyKey: nextIdem(),
      principalSub: PRINCIPAL_SUB,
      displayName: "InitFailed",
      parentFolderRid: FOLDER_RID,
      templateId: "typescript-functions",
      templateVersion: "2.4.0",
      defaultBranch: "main",
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.finalState).toBe("INIT_FAILED");
  });

  it("step4 unique-violation maps to NameConflict (B2-C-30)", async () => {
    // Pre-insert a code_repository row that will conflict with the saga's
    // step 4 INSERT (same parent + lower(name)).
    const conflictRid = "ri.stemma.main.repository.preexisting-aaaa-bbbb";
    await schema.pool.query(
      `INSERT INTO code_repository
         (rid, display_name, parent_folder_rid, project_rid,
          template_id, template_version, default_branch,
          settings_json, state, created_by)
       VALUES ($1, 'CollisionName', $2, $2, 'tpl', '1.0.0', 'main',
               '{}'::jsonb, 'ACTIVE', $3)`,
      [conflictRid, FOLDER_RID, PRINCIPAL_SUB],
    );

    const deps = makeDeps({});
    const result = await executeCreateRepositorySaga(deps, {
      idempotencyKey: nextIdem(),
      principalSub: PRINCIPAL_SUB,
      displayName: "collisionname", // case-insensitive
      parentFolderRid: FOLDER_RID,
      templateId: "typescript-functions",
      templateVersion: "2.4.0",
      defaultBranch: "main",
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.errorName).toBe("CodeRepos:NameConflict");
    expect(result.finalState).toBe("ROLLED_BACK");
  });
});
