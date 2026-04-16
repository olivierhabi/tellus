# Pipelines in File Browser — API Reference

> Changes to the Pipeline and Folder APIs to support listing pipelines alongside folders and datasets in the project file browser.

## Overview

Pipelines can now be scoped to a specific folder, just like datasets. They appear in the file browser (project root page and folder pages) between folders and datasets, with a purple `data-lineage` icon and a status tag.

### Key Changes

| Area | Change |
|------|--------|
| `pipelines` table | Added `folder_id UUID REFERENCES folders(id) ON DELETE SET NULL` |
| `GET /pipelines` | New `?folderId=` query param for filtering |
| `POST /pipelines` | New optional `folderId` field in request body |
| `GET /folders/:folderId` | Response `children` now includes `pipelines` array |

---

## Database Schema Change

```sql
ALTER TABLE pipelines
  ADD COLUMN folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;

CREATE INDEX idx_pipelines_folder ON pipelines(folder_id);
```

- `folder_id = NULL` means the pipeline lives at the project root
- `folder_id = <uuid>` means the pipeline lives inside that folder
- `ON DELETE SET NULL` — if the folder is deleted, pipelines move to project root

---

## Updated Endpoints

### 1. List Pipelines (Updated)

```
GET /api/v1/projects/{projectId}/pipelines[?folderId=<filter>]
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `folderId` | `string` | Optional filter. `"null"` for root-only, UUID for a specific folder, omit for all pipelines. |

**Examples:**

```bash
# All pipelines in the project
GET /api/v1/projects/:projectId/pipelines

# Only root-level pipelines (no folder)
GET /api/v1/projects/:projectId/pipelines?folderId=null

# Only pipelines in a specific folder
GET /api/v1/projects/:projectId/pipelines?folderId=92e1b122-2b04-4df9-96b7-733499f3e092
```

**Response:** `200 OK`
```json
{
  "success": true,
  "data": [
    {
      "id": "35de269e-c55c-4859-a28b-03ac78912958",
      "project_id": "437c7712-0c0e-4d82-afff-4c430d2ae0e7",
      "folder_id": null,
      "name": "Orders Pipeline",
      "description": null,
      "pipeline_type": "batch",
      "compute_type": "standard",
      "status": "draft",
      "config": {},
      "created_by": "...",
      "created_at": "2026-03-24T00:00:00.000Z",
      "updated_at": "2026-03-24T00:00:00.000Z"
    }
  ]
}
```

**Headers:** `X-Total-Count: <number>`

---

### 2. Create Pipeline (Updated)

```
POST /api/v1/projects/{projectId}/pipelines
```

**Request Body (updated):**

```json
{
  "name": "My Pipeline",
  "pipelineType": "batch",
  "computeType": "standard",
  "description": "Optional description",
  "folderId": "92e1b122-2b04-4df9-96b7-733499f3e092"
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Pipeline name (1–255 chars, unique per project) |
| `pipelineType` | No | `"batch"` | `batch` or `streaming` |
| `computeType` | No | `"standard"` | `standard`, `lightweight`, or `external` |
| `description` | No | `null` | Up to 2000 chars |
| `folderId` | No | `null` | **NEW** — Folder UUID to place the pipeline in. Omit or `null` for project root. |

**Response:** `201 Created`
```json
{
  "success": true,
  "data": {
    "id": "...",
    "folder_id": "92e1b122-2b04-4df9-96b7-733499f3e092",
    "name": "My Pipeline",
    "status": "draft",
    "..."
  }
}
```

**Error Responses:**
- `400` — Invalid `folderId` UUID format
- `409` — Pipeline name already exists in the project

---

### 3. Get Folder Contents (Updated)

```
GET /api/v1/projects/{projectId}/folders/{folderId}
```

The `children` object in the response now includes a `pipelines` array.

**Response:** `200 OK`
```json
{
  "success": true,
  "data": {
    "id": "92e1b122-2b04-4df9-96b7-733499f3e092",
    "name": "My Folder",
    "parent_folder_id": null,
    "child_count": 2,
    "dataset_count": 3,
    "has_children": true,
    "children": {
      "folders": [ ... ],
      "datasets": [ ... ],
      "pipelines": [
        {
          "id": "...",
          "name": "Folder Pipeline",
          "status": "draft",
          "pipeline_type": "batch",
          "compute_type": "standard",
          "created_at": "...",
          "updated_at": "..."
        }
      ]
    }
  }
}
```

The `pipelines` array contains pipelines where `folder_id` matches the requested folder. It is always present (empty array `[]` if no pipelines exist in the folder).

---

## Pipeline Schema (Updated)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `UUID` | Pipeline ID |
| `project_id` | `UUID` | Parent project |
| `folder_id` | `UUID \| null` | **NEW** — Folder location (`null` = project root) |
| `name` | `string` | Display name |
| `description` | `string \| null` | Optional description |
| `pipeline_type` | `string` | `batch` or `streaming` |
| `compute_type` | `string` | `standard`, `lightweight`, or `external` |
| `status` | `string` | `draft`, `active`, `paused`, `failed`, or `archived` |
| `config` | `object` | Arbitrary JSON config |
| `created_by` | `UUID \| null` | Creator user ID |
| `created_at` | `datetime` | Creation timestamp |
| `updated_at` | `datetime` | Last update timestamp |

---

## Frontend Rendering

Pipelines appear in the file browser table between folders and datasets:

| Order | Icon | Color | Item Type |
|-------|------|-------|-----------|
| 1 | `folder-open` / `folder-close` | Yellow | Folder |
| 2 | `data-lineage` | Purple (`#9b59b6`) | Pipeline |
| 3 | `panel-table` | Blue | Dataset |

Pipeline status is shown as a tag:

| Status | Intent | Label |
|--------|--------|-------|
| `draft` | warning | Draft |
| `active` | success | Active |
| `paused` | warning | Paused |
| `failed` | danger | Failed |
| `archived` | none | Archived |

Clicking a pipeline row navigates to: `/projects/{projectId}/pipeline-builder/{pipelineId}`

---

## Interactive Documentation

- **Swagger UI:** `GET /api/docs`
- **Raw spec:** `GET /api/docs/spec.json`

## Source Files

| Layer | File |
|-------|------|
| Migration | `src/foundryMigrate.ts` |
| Folder service (children query) | `src/services/folderService.ts` |
| Pipeline service (folderId filter) | `src/services/pipelineService.ts` |
| Pipeline controller (query param) | `src/controllers/pipelineController.ts` |
| Pipeline types (folderId field) | `src/types/pipeline.ts` |
| OpenAPI spec | `src/docs/openapi.ts` |
| Frontend FileSystemTable | `tellus-fe/components/folders/FileSystemTable.tsx` |
| Frontend project page | `tellus-fe/app/projects/[projectId]/page.tsx` |
| Frontend folder page | `tellus-fe/app/projects/[projectId]/folders/[folderId]/page.tsx` |
