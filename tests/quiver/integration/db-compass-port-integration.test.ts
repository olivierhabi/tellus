// dbCompassPort — focused authorization tests (missing-authorization fix).
//
// Proves the membership model against the real schema:
//   folder rid → resources (NOT_TRASHED) → project →
//     edit  = projects.owner_id OR project_members owner|editor
//     read  = edit OR project_members viewer
//   plus the fail-closed edges: missing/trashed folder, non-UUID subject,
//   missing/deleted analysis, registerAnalysis resource-row parity.
//
// Follows the quiver-lane convention: connects to the same Postgres the
// integration suite uses (src/db pool + dotenv), seeds a minimal
// project/folder tree, and cleans up every seeded row afterwards.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, query } from "../../../src/db";
import { dbCompassPort } from "../../../src/services/quiver/dbCompassPort";
import { newQuiverRid } from "../../../src/services/quiver/rids";
import { getCompassPort } from "../../../src/services/quiver/analysisService";
import { isQuiverError } from "../../../src/services/quiver/errors";
import { applyQuiverMigrations } from "./_harness";

const RUN = randomUUID().slice(0, 8);
const BRANCH = "main";

interface Seeded {
  owner: string;
  editor: string;
  viewer: string;
  outsider: string;
  projectId: string;
  folderId: string;
  folderRid: string;
  analysisRid: string;
}

let seeded: Seeded | null = null;

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES ($1::uuid, $2, 'not-a-real-hash', 'quiver-port-test')`,
    [id, `quiver-port-${RUN}-${id.slice(0, 8)}@tellus.test`],
  );
  return id;
}

beforeAll(async () => {
  await applyQuiverMigrations();

  const owner = await seedUser();
  const editor = await seedUser();
  const viewer = await seedUser();
  const outsider = await seedUser();

  const project = await query(
    `INSERT INTO projects (name, owner_id) VALUES ($1, $2::uuid) RETURNING id::text AS id`,
    [`quiver-port-project-${RUN}`, owner],
  );
  const projectId = project.rows[0].id as string;
  const projectRid = `ri.compass.main.project.${projectId}`;

  const folder = await query(
    `INSERT INTO folders (name, project_id) VALUES ($1, $2::uuid) RETURNING id::text AS id`,
    [`quiver-port-folder-${RUN}`, projectId],
  );
  const folderId = folder.rows[0].id as string;
  const folderRid = `ri.compass.main.compass-folder.${folderId}`;

  // Project resources row first (mirrors projectService B1-C-24) — the
  // folder row's parent_folder_rid FK targets it.
  await query(
    `INSERT INTO resources (rid, service, type, display_name,
                            parent_folder_rid, project_rid, space_rid,
                            created_by, updated_by, legacy_uuid)
     VALUES ($1, 'compass', 'PROJECT', $2, NULL, $1, $3, $4::uuid, $4::uuid, $5::uuid)`,
    [
      projectRid,
      `quiver-port-project-${RUN}`,
      "ri.compass.main.space.00000000-0000-0000-0000-000000000000",
      owner,
      projectId,
    ],
  );

  await query(
    `INSERT INTO resources (rid, service, type, display_name,
                            parent_folder_rid, project_rid, space_rid,
                            created_by, updated_by, legacy_uuid)
     VALUES ($1, 'compass', 'COMPASS_FOLDER', $2, $3, $3, $4, $5::uuid, $5::uuid, $6::uuid)`,
    [
      folderRid,
      `quiver-port-folder-${RUN}`,
      projectRid,
      "ri.compass.main.space.00000000-0000-0000-0000-000000000000",
      owner,
      folderId,
    ],
  );

  await query(
    `INSERT INTO project_members (project_id, user_id, role)
     VALUES ($1::uuid, $2::uuid, 'editor'), ($1::uuid, $3::uuid, 'viewer')`,
    [projectId, editor, viewer],
  );

  const analysisRid = newQuiverRid("analysis");
  await query(
    `INSERT INTO quiver_analysis
       (rid, parent_folder_rid, display_name, cards, canvases, parameters,
        current_version, etag, document_inline, markings, created_by, updated_by)
     VALUES ($1, $2, $3, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
             0, $4, '{}'::jsonb, '{}', $5::uuid, $5::uuid)`,
    [analysisRid, folderRid, "port-test", `etag-${RUN}`, owner],
  );

  seeded = {
    owner,
    editor,
    viewer,
    outsider,
    projectId,
    folderId,
    folderRid,
    analysisRid,
  };
});

afterAll(async () => {
  if (seeded) {
    const s = seeded;
    await query(`DELETE FROM resources WHERE rid = $1`, [s.folderRid]);
    await query(`DELETE FROM resources WHERE rid LIKE 'ri.tellus-quiver.main.analysis.%' AND project_rid = $1`,
      [`ri.compass.main.project.${s.projectId}`]);
    await query(`DELETE FROM resources WHERE rid = $1`, [
      `ri.compass.main.project.${s.projectId}`,
    ]);
    await query(`DELETE FROM quiver_analysis WHERE rid = $1`, [s.analysisRid]);
    await query(`DELETE FROM folders WHERE id = $1::uuid`, [s.folderId]);
    await query(`DELETE FROM projects WHERE id = $1::uuid`, [s.projectId]);
    for (const u of [s.owner, s.editor, s.viewer, s.outsider]) {
      await query(`DELETE FROM users WHERE id = $1::uuid`, [u]);
    }
  }
  await pool.end();
});

function expectDeny(p: Promise<void>, errorName: string): Promise<void> {
  return p.then(
    () => {
      throw new Error(`expected ${errorName}, got allow`);
    },
    (e: unknown) => {
      expect(isQuiverError(e)).toBe(true);
      expect((e as { envelope?: { errorName?: string } }).envelope?.errorName).toBe(
        `Tellus:Quiver:${errorName}`,
      );
    },
  );
}

describe("dbCompassPort — assertEditorOnFolder (membership model)", () => {
  it("project owner (projects.owner_id) may edit", async () => {
    await dbCompassPort.assertEditorOnFolder({
      folderRid: seeded!.folderRid,
      userSubject: seeded!.owner,
      branch: BRANCH,
    });
  });

  it("project_members editor may edit", async () => {
    await dbCompassPort.assertEditorOnFolder({
      folderRid: seeded!.folderRid,
      userSubject: seeded!.editor,
      branch: BRANCH,
    });
  });

  it("project_members viewer is read-only → InsufficientPermission", async () => {
    await expectDeny(
      dbCompassPort.assertEditorOnFolder({
        folderRid: seeded!.folderRid,
        userSubject: seeded!.viewer,
        branch: BRANCH,
      }),
      "InsufficientPermission",
    );
  });

  it("non-member is denied (InsufficientPermission)", async () => {
    await expectDeny(
      dbCompassPort.assertEditorOnFolder({
        folderRid: seeded!.folderRid,
        userSubject: seeded!.outsider,
        branch: BRANCH,
      }),
      "InsufficientPermission",
    );
  });

  it("non-UUID subject (test principal shape) fails closed", async () => {
    await expectDeny(
      dbCompassPort.assertEditorOnFolder({
        folderRid: seeded!.folderRid,
        userSubject: "ri.multipass.main.user.alice",
        branch: BRANCH,
      }),
      "InsufficientPermission",
    );
  });

  it("unknown folder rid → ParentFolderNotFound", async () => {
    await expectDeny(
      dbCompassPort.assertEditorOnFolder({
        folderRid: "ri.compass.main.folder.does-not-exist",
        userSubject: seeded!.owner,
        branch: BRANCH,
      }),
      "ParentFolderNotFound",
    );
  });

  it("trashed folder → ParentFolderNotFound (no existence leak past trash)", async () => {
    await query(
      `UPDATE resources SET trash_status = 'DIRECTLY_TRASHED' WHERE rid = $1`,
      [seeded!.folderRid],
    );
    try {
      await expectDeny(
        dbCompassPort.assertEditorOnFolder({
          folderRid: seeded!.folderRid,
          userSubject: seeded!.owner,
          branch: BRANCH,
        }),
        "ParentFolderNotFound",
      );
    } finally {
      await query(
        `UPDATE resources SET trash_status = 'NOT_TRASHED' WHERE rid = $1`,
        [seeded!.folderRid],
      );
    }
  });
});

describe("dbCompassPort — assertFolderReadable", () => {
  it("owner, editor and viewer may all read the folder", async () => {
    for (const user of [seeded!.owner, seeded!.editor, seeded!.viewer]) {
      await dbCompassPort.assertFolderReadable({
        folderRid: seeded!.folderRid,
        userSubject: user,
        branch: BRANCH,
      });
    }
  });

  it("non-member is denied", async () => {
    await expectDeny(
      dbCompassPort.assertFolderReadable({
        folderRid: seeded!.folderRid,
        userSubject: seeded!.outsider,
        branch: BRANCH,
      }),
      "InsufficientPermission",
    );
  });
});

describe("dbCompassPort — assertReadable (analysis read gate)", () => {
  it("owner, editor and viewer may read a member analysis", async () => {
    for (const user of [seeded!.owner, seeded!.editor, seeded!.viewer]) {
      await dbCompassPort.assertReadable({
        rid: seeded!.analysisRid,
        userSubject: user,
        branch: BRANCH,
      });
    }
  });

  it("non-member is denied even though the analysis exists", async () => {
    await expectDeny(
      dbCompassPort.assertReadable({
        rid: seeded!.analysisRid,
        userSubject: seeded!.outsider,
        branch: BRANCH,
      }),
      "InsufficientPermission",
    );
  });

  it("unknown rid → AnalysisNotFound (parity with GET /analyses/:rid)", async () => {
    await expectDeny(
      dbCompassPort.assertReadable({
        rid: newQuiverRid("analysis"),
        userSubject: seeded!.owner,
        branch: BRANCH,
      }),
      "AnalysisNotFound",
    );
  });

  it("soft-deleted analysis → AnalysisNotFound", async () => {
    await query(`UPDATE quiver_analysis SET is_deleted = true WHERE rid = $1`, [
      seeded!.analysisRid,
    ]);
    try {
      await expectDeny(
        dbCompassPort.assertReadable({
          rid: seeded!.analysisRid,
          userSubject: seeded!.owner,
          branch: BRANCH,
        }),
        "AnalysisNotFound",
      );
    } finally {
      await query(`UPDATE quiver_analysis SET is_deleted = false WHERE rid = $1`, [
        seeded!.analysisRid,
      ]);
    }
  });
});

describe("dbCompassPort — registerAnalysis (Compass resource parity)", () => {
  it("inserts a tellus-quiver ANALYSIS resource under the parent folder", async () => {
    const rid = newQuiverRid("analysis");
    await dbCompassPort.registerAnalysis({
      rid,
      parentFolderRid: seeded!.folderRid,
      displayName: "registered-by-port-test",
      branch: BRANCH,
      userSubject: seeded!.owner,
    });
    const r = await query(
      `SELECT service, type, display_name, parent_folder_rid, project_rid, trash_status
         FROM resources WHERE rid = $1`,
      [rid],
    );
    expect(r.rowCount).toBe(1);
    const row = r.rows[0] as Record<string, string>;
    expect(row.service).toBe("tellus-quiver");
    expect(row.type).toBe("ANALYSIS");
    expect(row.display_name).toBe("registered-by-port-test");
    expect(row.parent_folder_rid).toBe(seeded!.folderRid);
    expect(row.project_rid).toBe(`ri.compass.main.project.${seeded!.projectId}`);
    expect(row.trash_status).toBe("NOT_TRASHED");
    await query(`DELETE FROM resources WHERE rid = $1`, [rid]);
  });

  it("unknown parent folder → ParentFolderNotFound (fatal for the caller's txn)", async () => {
    await expectDeny(
      dbCompassPort.registerAnalysis({
        rid: newQuiverRid("analysis"),
        parentFolderRid: "ri.compass.main.folder.no-such-folder",
        displayName: "x",
        branch: BRANCH,
        userSubject: seeded!.owner,
      }),
      "ParentFolderNotFound",
    );
  });

  it("non-local principal cannot own a registration row", async () => {
    await expectDeny(
      dbCompassPort.registerAnalysis({
        rid: newQuiverRid("analysis"),
        parentFolderRid: seeded!.folderRid,
        displayName: "x",
        branch: BRANCH,
        userSubject: "ri.multipass.main.user.alice",
      }),
      "InsufficientPermission",
    );
  });
});

describe("analysisService — deny-by-wiring default (no port installed)", () => {
  it("denies with CompassNotConfigured until a port is wired", async () => {
    // This file never builds the quiver router, so the module still holds
    // its pristine fail-closed default — the previous allow-all no-op is
    // gone and absent wiring can never read as permission granted.
    await expectDeny(
      getCompassPort().assertEditorOnFolder({
        folderRid: seeded!.folderRid,
        userSubject: seeded!.owner,
        branch: BRANCH,
      }),
      "CompassNotConfigured",
    );
    await expectDeny(
      getCompassPort().assertReadable({
        rid: seeded!.analysisRid,
        userSubject: seeded!.owner,
        branch: BRANCH,
      }),
      "CompassNotConfigured",
    );
  });
});
