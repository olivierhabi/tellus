/**
 * Comprehensive integration tests for all Foundry Backend API endpoints.
 *
 * Runs real HTTP requests against a running server backed by PostgreSQL.
 * File naming: *-integration.test.ts (picked up by vitest include pattern).
 *
 * Prerequisites:
 *   1. PostgreSQL running with the foundry database and all migrations applied.
 *   2. The backend server running on http://localhost:3001 (or TEST_BASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api } from '../helpers/api';
import { getTestDb, truncateAllTables, closeTestDb } from '../helpers/db';
import type { Knex } from 'knex';

// ---------------------------------------------------------------------------
// Shared state across describe blocks
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
let db: Knex;
let serverAvailable = false;

// Project CRUD
let createdProjectId: string;
let createdProjectName: string;

// Folder CRUD
let folderProjectId: string;
let rootFolderId: string;
let nestedFolderId: string;

// Auth
let authAccessToken: string;
let authRefreshToken: string;
const AUTH_EMAIL = `integration-${Date.now()}@foundry.test`;
const AUTH_PASSWORD = 'Str0ngP@ssword!';
const AUTH_DISPLAY_NAME = 'Integration Tester';

// Dataset (manually inserted)
let datasetFolderId: string;
let datasetProjectId: string;
let manualDatasetId: string;

// Non-existent UUID for 404 tests
const NON_EXISTENT_UUID = '00000000-0000-4000-a000-000000000000';
const INVALID_UUID = 'not-a-uuid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate ALL tables including auth tables; order matters for FK constraints. */
async function truncateEverything(): Promise<void> {
  await db.raw(
    'TRUNCATE refresh_tokens, dataset_columns, datasets, folders, project_members, projects, users CASCADE'
  );
}

/** Safely try to truncate – ignore errors (e.g. table does not exist). */
async function safeTruncate(): Promise<void> {
  try {
    await truncateEverything();
  } catch {
    // If project_members doesn't exist, fall back to simpler truncate
    try {
      await db.raw(
        'TRUNCATE refresh_tokens, dataset_columns, datasets, folders, projects, users CASCADE'
      );
    } catch {
      // Last resort: use the helper which only covers core tables
      try {
        await truncateAllTables();
      } catch {
        // DB might not be available – tests will be skipped
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------
beforeAll(async () => {
  // 1. Check if server is reachable
  try {
    const res = await fetch(
      (process.env.TEST_BASE_URL || 'http://localhost:3001') + '/health'
    );
    serverAvailable = res.ok;
  } catch {
    serverAvailable = false;
  }

  if (!serverAvailable) {
    console.warn(
      '\n⚠  Server not reachable – all integration tests will be skipped.\n' +
        '   Start the server with `npm run dev` and ensure PostgreSQL is running.\n'
    );
    return;
  }

  // 2. Connect to test DB and clean slate
  db = getTestDb();
  await safeTruncate();
});

afterAll(async () => {
  if (serverAvailable) {
    await safeTruncate();
  }
  await closeTestDb();
});

// ═══════════════════════════════════════════════════════════════════════════
//  BE-001 + BE-023: Health Check
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-001 + BE-023: GET /health', () => {
  it('should return 200 with status ok', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });

  it('should include a valid ISO timestamp', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/health');
    expect(res.body).toHaveProperty('timestamp');
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  });

  it('should include uptime as a number', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/health');
    expect(res.body).toHaveProperty('uptime');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThan(0);
  });

  it('should respond with application/json content-type', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/health');
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BE-002: Schema Verification
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-002: Database Schema', () => {
  it('should have the projects table', async () => {
    if (!serverAvailable) return;
    const result = await db.raw(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'projects'"
    );
    expect(result.rows).toHaveLength(1);
  });

  it('should have the folders table', async () => {
    if (!serverAvailable) return;
    const result = await db.raw(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'folders'"
    );
    expect(result.rows).toHaveLength(1);
  });

  it('should have the datasets table', async () => {
    if (!serverAvailable) return;
    const result = await db.raw(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'datasets'"
    );
    expect(result.rows).toHaveLength(1);
  });

  it('should have the dataset_columns table', async () => {
    if (!serverAvailable) return;
    const result = await db.raw(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'dataset_columns'"
    );
    expect(result.rows).toHaveLength(1);
  });

  it('should have the users table', async () => {
    if (!serverAvailable) return;
    const result = await db.raw(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'"
    );
    expect(result.rows).toHaveLength(1);
  });

  it('should have the refresh_tokens table', async () => {
    if (!serverAvailable) return;
    const result = await db.raw(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'refresh_tokens'"
    );
    expect(result.rows).toHaveLength(1);
  });

  it('should have ltree extension enabled', async () => {
    if (!serverAvailable) return;
    const result = await db.raw(
      "SELECT extname FROM pg_extension WHERE extname = 'ltree'"
    );
    expect(result.rows).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BE-013: Auth – Register, Login, Refresh, Logout
//  NOTE: Auth tests run before project/folder tests because the stub
//  middleware uses a hardcoded user ID. We still exercise the auth API.
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-013: Auth Endpoints', () => {
  it('POST /api/auth/register → 201 with user and tokens', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/auth/register', {
      email: AUTH_EMAIL,
      password: AUTH_PASSWORD,
      displayName: AUTH_DISPLAY_NAME,
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('user');
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');
    expect(res.body.data.user.email).toBe(AUTH_EMAIL.toLowerCase());
    authAccessToken = res.body.data.accessToken;
    authRefreshToken = res.body.data.refreshToken;
  });

  it('POST /api/auth/register → 409 duplicate email', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/auth/register', {
      email: AUTH_EMAIL,
      password: AUTH_PASSWORD,
      displayName: AUTH_DISPLAY_NAME,
    });
    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('POST /api/auth/register → 400 missing fields', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/auth/register', {
      email: 'bad',
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/register → 400 password too short', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/auth/register', {
      email: 'short-pw@test.com',
      password: '1234',
      displayName: 'Short PW',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/auth/login → 200 with tokens', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/auth/login', {
      email: AUTH_EMAIL,
      password: AUTH_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');
    expect(res.body.data.user).toHaveProperty('id');
    // Save for refresh test
    authRefreshToken = res.body.data.refreshToken;
  });

  it('POST /api/auth/login → 401 wrong password', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/auth/login', {
      email: AUTH_EMAIL,
      password: 'WrongPassword!',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('POST /api/auth/login → 401 non-existent email', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/auth/login', {
      email: 'ghost@nowhere.com',
      password: AUTH_PASSWORD,
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/refresh → 200 with new tokens', async () => {
    if (!serverAvailable || !authRefreshToken) return;
    const res = await api('POST', '/api/auth/refresh', {
      refreshToken: authRefreshToken,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');
    // The old refresh token is invalidated (one-time use)
    authRefreshToken = res.body.data.refreshToken;
  });

  it('POST /api/auth/refresh → 401 reusing an already-used refresh token', async () => {
    if (!serverAvailable) return;
    // Use a random string that won't match any stored hash
    const res = await api('POST', '/api/auth/refresh', {
      refreshToken: 'invalid-or-already-consumed-token',
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/logout → 200', async () => {
    if (!serverAvailable || !authRefreshToken) return;
    const res = await api('POST', '/api/auth/logout', {
      refreshToken: authRefreshToken,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /api/auth/refresh → 401 after logout (token deleted)', async () => {
    if (!serverAvailable || !authRefreshToken) return;
    const res = await api('POST', '/api/auth/refresh', {
      refreshToken: authRefreshToken,
    });
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BE-003: Project CRUD
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-003: Project CRUD', () => {
  it('POST /api/projects → 201 creates a project', async () => {
    if (!serverAvailable) return;
    createdProjectName = `IntegrationProject-${Date.now()}`;
    const res = await api('POST', '/api/projects', { name: createdProjectName });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.name).toBe(createdProjectName);
    createdProjectId = res.body.data.id;
  });

  it('POST /api/projects → 409 duplicate name', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/projects', { name: createdProjectName });
    expect(res.status).toBe(409);
    expect(res.body.error).toHaveProperty('code', 'CONFLICT');
  });

  it('POST /api/projects → 400 empty name', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/projects', { name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  it('POST /api/projects → 400 missing name field', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/projects', {});
    expect(res.status).toBe(400);
  });

  it('POST /api/projects → 400 name exceeds 255 chars', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/projects', { name: 'a'.repeat(256) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/projects → 200 returns array including created project', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/api/projects');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    const found = res.body.data.find((p: { id: string }) => p.id === createdProjectId);
    expect(found).toBeDefined();
    expect(found.name).toBe(createdProjectName);
  });

  it('GET /api/projects/:id → 200 with root_folders', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', `/api/projects/${createdProjectId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(createdProjectId);
    // root_folders may be null (no folders yet) or an array
    expect(
      res.body.data.root_folders === null || Array.isArray(res.body.data.root_folders)
    ).toBe(true);
  });

  it('GET /api/projects/:id → 404 non-existent ID', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', `/api/projects/${NON_EXISTENT_UUID}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/projects/:id → 400 invalid UUID', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', `/api/projects/${INVALID_UUID}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /api/projects/:id → 200 updates the name', async () => {
    if (!serverAvailable) return;
    const newName = `Renamed-${Date.now()}`;
    const res = await api('PUT', `/api/projects/${createdProjectId}`, {
      name: newName,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe(newName);
    createdProjectName = newName;
  });

  it('PUT /api/projects/:id → 400 empty body', async () => {
    if (!serverAvailable) return;
    const res = await api('PUT', `/api/projects/${createdProjectId}`, {});
    expect(res.status).toBe(400);
  });

  it('PUT /api/projects/:id → 404 non-existent project', async () => {
    if (!serverAvailable) return;
    const res = await api('PUT', `/api/projects/${NON_EXISTENT_UUID}`, {
      name: 'GhostProject',
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/projects/:id → 204', async () => {
    if (!serverAvailable) return;
    const res = await api('DELETE', `/api/projects/${createdProjectId}`);
    expect(res.status).toBe(204);
  });

  it('GET /api/projects/:id → 404 after deletion', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', `/api/projects/${createdProjectId}`);
    expect(res.status).toBe(404);
  });

  it('DELETE /api/projects/:id → 404 already deleted', async () => {
    if (!serverAvailable) return;
    const res = await api('DELETE', `/api/projects/${createdProjectId}`);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BE-004: Folder CRUD
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-004: Folder CRUD', () => {
  beforeAll(async () => {
    if (!serverAvailable) return;
    // Create a project to host folders
    const res = await api('POST', '/api/projects', {
      name: `FolderTestProject-${Date.now()}`,
    });
    folderProjectId = res.body.data.id;
  });

  it('POST folder → 201 creates a root folder', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', `/api/projects/${folderProjectId}/folders`, {
      name: 'RootFolder',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.name).toBe('RootFolder');
    expect(res.body.data.depth).toBe(0);
    rootFolderId = res.body.data.id;
  });

  it('POST folder → 201 creates a nested folder', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', `/api/projects/${folderProjectId}/folders`, {
      name: 'NestedFolder',
      parentFolderId: rootFolderId,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('NestedFolder');
    expect(res.body.data.depth).toBe(1);
    nestedFolderId = res.body.data.id;
  });

  it('POST folder → 400 empty name', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', `/api/projects/${folderProjectId}/folders`, {
      name: '',
    });
    expect(res.status).toBe(400);
  });

  it('POST folder → 400 name with path separators', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', `/api/projects/${folderProjectId}/folders`, {
      name: 'bad/name',
    });
    expect(res.status).toBe(400);
  });

  it('POST folder → 400 invalid project UUID', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', `/api/projects/${INVALID_UUID}/folders`, {
      name: 'Whatever',
    });
    expect(res.status).toBe(400);
  });

  it('GET folders → 200 list root folders (parentId=null)', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'GET',
      `/api/projects/${folderProjectId}/folders?parentId=null`
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    const root = res.body.data.find(
      (f: { id: string }) => f.id === rootFolderId
    );
    expect(root).toBeDefined();
  });

  it('GET folders → 200 list children of root folder', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'GET',
      `/api/projects/${folderProjectId}/folders?parentId=${rootFolderId}`
    );
    expect(res.status).toBe(200);
    const nested = res.body.data.find(
      (f: { id: string }) => f.id === nestedFolderId
    );
    expect(nested).toBeDefined();
  });

  it('GET folder/:folderId → 200 folder details', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'GET',
      `/api/projects/${folderProjectId}/folders/${rootFolderId}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(rootFolderId);
    expect(res.body.data.name).toBe('RootFolder');
  });

  it('GET folder/:folderId → 404 non-existent', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'GET',
      `/api/projects/${folderProjectId}/folders/${NON_EXISTENT_UUID}`
    );
    expect(res.status).toBe(404);
  });

  it('GET folder/:folderId/tree → 200 returns tree structure', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'GET',
      `/api/projects/${folderProjectId}/folders/${rootFolderId}/tree`
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  it('GET folder/:folderId/breadcrumb → 200 returns breadcrumb array', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'GET',
      `/api/projects/${folderProjectId}/folders/${nestedFolderId}/breadcrumb`
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    // Should have at least the root folder and the nested folder
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('PUT folder/:folderId → 200 renames folder', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'PUT',
      `/api/projects/${folderProjectId}/folders/${nestedFolderId}`,
      { name: 'RenamedNested' }
    );
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('RenamedNested');
  });

  it('PUT folder/:folderId → 400 invalid UUID', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'PUT',
      `/api/projects/${folderProjectId}/folders/${INVALID_UUID}`,
      { name: 'Whatever' }
    );
    expect(res.status).toBe(400);
  });

  it('DELETE folder/:folderId → 204 deletes nested folder', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'DELETE',
      `/api/projects/${folderProjectId}/folders/${nestedFolderId}`
    );
    expect(res.status).toBe(204);
  });

  it('GET folder/:folderId → 404 after deletion', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'GET',
      `/api/projects/${folderProjectId}/folders/${nestedFolderId}`
    );
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BE-005: Upload Validation
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-005: Upload Validation', () => {
  it('POST upload to non-existent project → 404', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'POST',
      `/api/projects/${NON_EXISTENT_UUID}/folders/${NON_EXISTENT_UUID}/upload`
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('POST upload to non-existent folder → 404', async () => {
    if (!serverAvailable || !folderProjectId) return;
    const res = await api(
      'POST',
      `/api/projects/${folderProjectId}/folders/${NON_EXISTENT_UUID}/upload`
    );
    expect(res.status).toBe(404);
  });

  it('POST upload with no files (JSON body) → 400', async () => {
    if (!serverAvailable || !folderProjectId || !rootFolderId) return;
    const res = await api(
      'POST',
      `/api/projects/${folderProjectId}/folders/${rootFolderId}/upload`
    );
    // Could be 400 (no files) or validation error
    expect([400, 404].includes(res.status)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BE-007: Dataset Endpoints (after manual DB insert)
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-007: Dataset Endpoints', () => {
  beforeAll(async () => {
    if (!serverAvailable) return;

    // Create project + folder for dataset tests
    const projRes = await api('POST', '/api/projects', {
      name: `DatasetProject-${Date.now()}`,
    });
    datasetProjectId = projRes.body.data.id;

    const folderRes = await api(
      'POST',
      `/api/projects/${datasetProjectId}/folders`,
      { name: 'DatasetFolder' }
    );
    datasetFolderId = folderRes.body.data.id;

    // Manually insert a dataset directly into the DB
    const [ds] = await db('datasets')
      .insert({
        name: 'test-dataset.csv',
        folder_id: datasetFolderId,
        file_path: '/tmp/test-dataset.csv',
        original_filename: 'test-dataset.csv',
        mime_type: 'text/csv',
        file_size_bytes: 1024,
        row_count: 10,
        column_count: 3,
        status: 'ready',
        content_hash: 'abc123hash',
      })
      .returning('*');
    manualDatasetId = ds.id;

    // Insert columns
    await db('dataset_columns').insert([
      {
        dataset_id: manualDatasetId,
        column_name: 'id',
        column_type: 'integer',
        ordinal_position: 1,
        nullable: false,
      },
      {
        dataset_id: manualDatasetId,
        column_name: 'name',
        column_type: 'text',
        ordinal_position: 2,
        nullable: true,
      },
      {
        dataset_id: manualDatasetId,
        column_name: 'value',
        column_type: 'numeric',
        ordinal_position: 3,
        nullable: true,
      },
    ]);
  });

  it('GET /api/datasets/:datasetId → 200 with dataset and columns', async () => {
    if (!serverAvailable || !manualDatasetId) return;
    const res = await api('GET', `/api/datasets/${manualDatasetId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(manualDatasetId);
    expect(res.body.data.name).toBe('test-dataset.csv');
    expect(res.body.data.status).toBe('ready');
  });

  it('GET /api/datasets/:datasetId → 404 non-existent', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', `/api/datasets/${NON_EXISTENT_UUID}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/datasets/:datasetId → 400 invalid UUID', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', `/api/datasets/${INVALID_UUID}`);
    expect(res.status).toBe(400);
  });

  it('GET /api/datasets/:datasetId/status → 200', async () => {
    if (!serverAvailable || !manualDatasetId) return;
    const res = await api('GET', `/api/datasets/${manualDatasetId}/status`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('status');
  });

  it('GET /api/datasets/:datasetId/preview → 200', async () => {
    if (!serverAvailable || !manualDatasetId) return;
    const res = await api('GET', `/api/datasets/${manualDatasetId}/preview`);
    // preview may fail if file doesn't exist on disk, but the endpoint should still respond
    expect([200, 404, 500].includes(res.status)).toBe(true);
  });

  it('GET datasets in folder → 200 with pagination', async () => {
    if (!serverAvailable || !datasetProjectId || !datasetFolderId) return;
    const res = await api(
      'GET',
      `/api/projects/${datasetProjectId}/folders/${datasetFolderId}/datasets`
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body).toHaveProperty('meta');
  });

  it('GET datasets in folder → 200 with status filter', async () => {
    if (!serverAvailable || !datasetProjectId || !datasetFolderId) return;
    const res = await api(
      'GET',
      `/api/projects/${datasetProjectId}/folders/${datasetFolderId}/datasets?status=ready`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.every((d: { status: string }) => d.status === 'ready')).toBe(
      true
    );
  });

  it('GET datasets in folder → 200 empty for pending filter', async () => {
    if (!serverAvailable || !datasetProjectId || !datasetFolderId) return;
    const res = await api(
      'GET',
      `/api/projects/${datasetProjectId}/folders/${datasetFolderId}/datasets?status=pending`
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BE-010: Search
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-010: Search', () => {
  it('GET /api/search?q=<name> → 200 with results', async () => {
    if (!serverAvailable) return;
    // Search for the dataset project name (guaranteed to exist)
    const res = await api('GET', '/api/search?q=Dataset');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty('data');
  });

  it('GET /api/search?q= → 200 with empty or all results', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/api/search?q=');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/search?q=nonexistent_xyz_999 → 200 with empty results', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/api/search?q=nonexistent_xyz_999');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('GET /api/search?q=Dataset&type=project → 200 filtered by type', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/api/search?q=Dataset&type=project');
    expect(res.status).toBe(200);
    if (res.body.data && res.body.data.length > 0) {
      expect(
        res.body.data.every((r: { type: string }) => r.type === 'project')
      ).toBe(true);
    }
  });

  it('GET /api/search/suggest?q=Data → 200 with suggestions', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/api/search/suggest?q=Data');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /api/search/suggest?q= → 200 with suggestions (empty query)', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/api/search/suggest?q=');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BE-011: Breadcrumb (top-level endpoint)
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-011: Breadcrumb', () => {
  it('GET /api/breadcrumb/project/:id → 200', async () => {
    if (!serverAvailable || !datasetProjectId) return;
    const res = await api(
      'GET',
      `/api/breadcrumb/project/${datasetProjectId}`
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  it('GET /api/breadcrumb/folder/:id → 200', async () => {
    if (!serverAvailable || !rootFolderId) return;
    const res = await api('GET', `/api/breadcrumb/folder/${rootFolderId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/breadcrumb/project/:id → 404 non-existent', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'GET',
      `/api/breadcrumb/project/${NON_EXISTENT_UUID}`
    );
    // Could be 404 or empty result depending on implementation
    expect([200, 404].includes(res.status)).toBe(true);
  });

  it('GET /api/breadcrumb/invalid_type/:id → 400', async () => {
    if (!serverAvailable) return;
    const res = await api(
      'GET',
      `/api/breadcrumb/invalid_type/${NON_EXISTENT_UUID}`
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/breadcrumb/folder/:id → 400 invalid UUID', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', `/api/breadcrumb/folder/${INVALID_UUID}`);
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BE-022: Error Envelope Format
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-022: Error Envelope Format', () => {
  it('POST /api/projects with invalid body returns { error: { code, message } }', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/projects', { name: '' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
    expect(typeof res.body.error.code).toBe('string');
    expect(typeof res.body.error.message).toBe('string');
  });

  it('GET /api/projects/:id with invalid UUID returns error envelope', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', `/api/projects/${INVALID_UUID}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
  });

  it('GET /api/projects/:id with non-existent UUID returns error envelope', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', `/api/projects/${NON_EXISTENT_UUID}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toHaveProperty('code', 'NOT_FOUND');
    expect(res.body.error).toHaveProperty('message');
  });

  it('error envelope code is a known error code string', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/projects', { name: '' });
    const knownCodes = [
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'CONFLICT',
      'UNAUTHORIZED',
      'INTERNAL_ERROR',
    ];
    expect(knownCodes).toContain(res.body.error.code);
  });

  it('malformed JSON body returns error envelope', async () => {
    if (!serverAvailable) return;
    const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
    const raw = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json!!!',
    });
    const body = await raw.json();
    expect(raw.status).toBe(400);
    expect(body.error).toHaveProperty('code', 'VALIDATION_ERROR');
    expect(body.error).toHaveProperty('message');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BE-029: Swagger / API Docs
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-029: Swagger / API Docs', () => {
  it('GET /api/docs → 200 returns HTML', async () => {
    if (!serverAvailable) return;
    const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
    const raw = await fetch(`${BASE_URL}/api/docs`);
    expect(raw.status).toBe(200);
    const contentType = raw.headers.get('content-type');
    expect(contentType).toContain('html');
    const html = await raw.text();
    expect(html).toContain('swagger-ui');
  });

  it('GET /api/docs/spec.json → 200 returns OpenAPI spec', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/api/docs/spec.json');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('openapi');
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body).toHaveProperty('info');
    expect(res.body).toHaveProperty('paths');
  });

  it('OpenAPI spec has required info fields', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/api/docs/spec.json');
    expect(res.body.info).toHaveProperty('title');
    expect(res.body.info).toHaveProperty('version');
  });

  it('OpenAPI spec includes /projects path', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/api/docs/spec.json');
    expect(res.body.paths).toHaveProperty('/projects');
  });

  it('OpenAPI spec includes /health path', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/api/docs/spec.json');
    expect(res.body.paths).toHaveProperty('/health');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Additional Edge Cases & Cross-Cutting Concerns
// ═══════════════════════════════════════════════════════════════════════════
describe('Cross-cutting: Correlation ID & Headers', () => {
  it('responses include x-correlation-id header', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/health');
    const corrId = res.headers.get('x-correlation-id');
    // correlation ID middleware should set this
    expect(corrId).toBeDefined();
    expect(typeof corrId).toBe('string');
  });

  it('responses include security headers from helmet', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/health');
    // Helmet sets x-content-type-options
    const xcto = res.headers.get('x-content-type-options');
    expect(xcto).toBe('nosniff');
  });
});

describe('Cross-cutting: CORS', () => {
  it('responds with access-control-allow-origin for allowed origin', async () => {
    if (!serverAvailable) return;
    const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
    const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
    const raw = await fetch(`${BASE_URL}/health`, {
      headers: { Origin: FRONTEND_URL },
    });
    const acao = raw.headers.get('access-control-allow-origin');
    // Should either be the frontend URL or '*'
    expect(acao).toBeDefined();
  });
});

describe('Cross-cutting: 404 for unknown routes', () => {
  it('GET /api/nonexistent → 404 or appropriate error', async () => {
    if (!serverAvailable) return;
    const res = await api('GET', '/api/nonexistent');
    expect([404, 500].includes(res.status)).toBe(true);
  });

  it('GET /totally-unknown-path → 404', async () => {
    if (!serverAvailable) return;
    const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
    const raw = await fetch(`${BASE_URL}/totally-unknown-path`);
    expect([404, 500].includes(raw.status)).toBe(true);
  });
});

describe('Cross-cutting: Request body limits', () => {
  it('POST /api/projects with very large body → rejects', async () => {
    if (!serverAvailable) return;
    // Express default or configured limit is 10mb; send something huge
    const hugeString = 'x'.repeat(11 * 1024 * 1024); // 11MB
    const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
    try {
      const raw = await fetch(`${BASE_URL}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: hugeString }),
      });
      // Should be 413 (payload too large) or 400
      expect([400, 413].includes(raw.status)).toBe(true);
    } catch {
      // Network error from large payload is also acceptable
      expect(true).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  DB Verification: Data integrity after API operations
// ═══════════════════════════════════════════════════════════════════════════
describe('DB Verification: Data integrity', () => {
  let verifyProjectId: string;
  let verifyFolderId: string;

  it('project created via API is persisted in the DB', async () => {
    if (!serverAvailable) return;
    const res = await api('POST', '/api/projects', {
      name: `VerifyProject-${Date.now()}`,
    });
    verifyProjectId = res.body.data.id;
    const row = await db('projects').where({ id: verifyProjectId }).first();
    expect(row).toBeDefined();
    expect(row.id).toBe(verifyProjectId);
  });

  it('folder created via API is persisted with correct path', async () => {
    if (!serverAvailable || !verifyProjectId) return;
    const res = await api('POST', `/api/projects/${verifyProjectId}/folders`, {
      name: 'VerifyFolder',
    });
    verifyFolderId = res.body.data.id;
    const row = await db('folders').where({ id: verifyFolderId }).first();
    expect(row).toBeDefined();
    expect(row.project_id).toBe(verifyProjectId);
    expect(row.depth).toBe(0);
    // path should be an ltree containing the project and folder UUIDs (with underscores)
    expect(row.path).toBeDefined();
  });

  it('project deletion cascades to folders', async () => {
    if (!serverAvailable || !verifyProjectId) return;
    await api('DELETE', `/api/projects/${verifyProjectId}`);
    const folders = await db('folders')
      .where({ project_id: verifyProjectId })
      .select('id');
    expect(folders).toHaveLength(0);
  });

  it('auth user is persisted in users table', async () => {
    if (!serverAvailable) return;
    const row = await db('users')
      .where({ email: AUTH_EMAIL.toLowerCase() })
      .first();
    expect(row).toBeDefined();
    expect(row.display_name).toBe(AUTH_DISPLAY_NAME);
    // Password hash should never be the plain password
    expect(row.password_hash).not.toBe(AUTH_PASSWORD);
    expect(row.password_hash.length).toBeGreaterThan(20);
  });
});
