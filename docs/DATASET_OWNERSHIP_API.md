# Dataset Ownership API Reference

> Tracks who created and last modified each dataset in the `foundry_datasets` table.
> Base URL: `/api/datasets`

## Overview

Every `foundry_datasets` row now stores `created_by` and `updated_by` as foreign keys to the `users` table. When the API returns a dataset via `GET /api/datasets/:datasetId`, it resolves these UUIDs into human-readable display names via LEFT JOINs on the `users` table.

This enables the Pipeline Builder's bottom-panel sidebar to show:

```
Updated    3 minutes ago by Habimana Olivier
Created    2 hours ago by Habimana Olivier
```

## Schema Changes

### Migration: `006_add_dataset_ownership`

Adds two nullable UUID columns to `foundry_datasets`:

```sql
ALTER TABLE foundry_datasets
  ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE foundry_datasets
  ADD COLUMN updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_foundry_datasets_created_by ON foundry_datasets (created_by);
CREATE INDEX idx_foundry_datasets_updated_by ON foundry_datasets (updated_by);
```

The same evolution is also applied by `foundryMigrate.ts` for environments that use the raw-SQL migration path.

### Updated `foundry_datasets` Table

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | `UUID` | No | Primary key |
| `name` | `VARCHAR(255)` | No | Display name |
| `folder_id` | `UUID` | Yes | Parent folder (null = project root) |
| `project_id` | `UUID` | Yes | Direct project reference |
| `file_path` | `TEXT` | No | S3/MinIO object key |
| `original_filename` | `VARCHAR(500)` | Yes | Original upload filename |
| `mime_type` | `VARCHAR(100)` | Yes | MIME type |
| `file_size_bytes` | `BIGINT` | Yes | File size in bytes |
| `row_count` | `INTEGER` | Yes | Number of rows (set after parsing) |
| `column_count` | `INTEGER` | Yes | Number of columns (set after parsing) |
| `schema_info` | `JSONB` | Yes | Column schema metadata |
| `status` | `VARCHAR(50)` | No | `pending` \| `processing` \| `ready` \| `error` |
| `content_hash` | `VARCHAR(64)` | Yes | SHA-256 of file content |
| **`created_by`** | **`UUID`** | **Yes** | **FK → `users.id`. The user who created this dataset.** |
| **`updated_by`** | **`UUID`** | **Yes** | **FK → `users.id`. The user who last modified this dataset.** |
| `created_at` | `TIMESTAMPTZ` | No | Creation timestamp |
| `updated_at` | `TIMESTAMPTZ` | No | Last update timestamp |
| `search_vector` | `TSVECTOR` | Yes | Full-text search vector |

## API Response Changes

### `GET /api/datasets/:datasetId`

Two new fields are included in the response, resolved via LEFT JOIN:

| Field | Type | Description |
|-------|------|-------------|
| `created_by` | `UUID \| null` | Raw user ID of the creator |
| `updated_by` | `UUID \| null` | Raw user ID of the last modifier |
| `created_by_display_name` | `string \| null` | Display name of the creator (e.g., `"Habimana Olivier"`) |
| `updated_by_display_name` | `string \| null` | Display name of the last modifier |

#### Example Response

```json
{
  "success": true,
  "data": {
    "id": "4b6a7d5b-c7f7-4b72-b421-ad4fd8a67b0b",
    "name": "employees.csv",
    "status": "ready",
    "row_count": 150,
    "column_count": 4,
    "file_size_bytes": 12480,
    "created_by": "249b289f-6ea7-4b7b-930c-a75a564501f5",
    "updated_by": "249b289f-6ea7-4b7b-930c-a75a564501f5",
    "created_by_display_name": "Habimana Olivier",
    "updated_by_display_name": "Habimana Olivier",
    "created_at": "2026-03-24T00:44:25.953388+00:00",
    "updated_at": "2026-03-24T16:12:08.306577+00:00",
    "columns": [
      {
        "id": "27227a8b-...",
        "name": "employee_id",
        "type": "text",
        "ordinal_position": 1,
        "nullable": false,
        "sample_values": ["EMP0001", "EMP0002", "EMP0003"]
      }
    ]
  }
}
```

#### Null Handling

When `created_by` or `updated_by` is `NULL` (e.g., datasets created before this migration, or by system processes), the corresponding `*_display_name` field is also `null`. The frontend falls back to the current user's display name in this case.

## Write Operations

### Dataset Upload (`POST /projects/:projectId/folders/:folderId/datasets/upload`)

Sets `created_by` and `updated_by` to the authenticated user's ID.

### Dataset Update (`PUT /api/datasets/:datasetId`)

Sets `updated_by` to the authenticated user's ID. `created_by` is never modified.

### Dataset Duplicate (`POST /api/datasets/:datasetId/duplicate`)

Sets both `created_by` and `updated_by` on the new copy to the authenticated user's ID.

### Zip Upload (`POST /projects/:projectId/folders/:folderId/upload-zip`)

Sets `created_by` and `updated_by` for each extracted file to the authenticated user's ID.

## Backfill

Existing datasets (created before this migration) are backfilled with the project owner's user ID:

```sql
UPDATE foundry_datasets d
SET created_by = p.owner_id, updated_by = p.owner_id
FROM projects p
WHERE d.project_id = p.id AND d.created_by IS NULL;
```

## SQL Query (getDatasetById)

The service method performs LEFT JOINs on `dataset_columns` (for schema) and `users` (for ownership display names). Column metadata uses **snake_case** keys (`name`, `type`, `ordinal_position`) to match the frontend `DatasetColumn` TypeScript interface:

```sql
SELECT d.*,
  json_agg(
    json_build_object(
      'id', dc.id,
      'name', dc.column_name,
      'type', dc.column_type,
      'ordinal_position', dc.ordinal_position,
      'nullable', dc.nullable,
      'sample_values', COALESCE(dc.sample_values, '[]'::jsonb)
    ) ORDER BY dc.ordinal_position ASC
  ) FILTER (WHERE dc.id IS NOT NULL) AS columns,
  uc.display_name AS created_by_display_name,
  uu.display_name AS updated_by_display_name
FROM foundry_datasets d
LEFT JOIN dataset_columns dc ON dc.dataset_id = d.id
LEFT JOIN users uc ON uc.id = d.created_by
LEFT JOIN users uu ON uu.id = d.updated_by
WHERE d.id = $1
GROUP BY d.id, uc.display_name, uu.display_name
```

## Frontend Integration

The frontend `DatasetDetail` TypeScript type in `types/api.ts` includes:

```typescript
export interface Dataset {
  // ... existing fields ...
  created_by: string | null;
  updated_by: string | null;
  created_by_display_name: string | null;
  updated_by_display_name: string | null;
}
```

The Pipeline Builder bottom panel uses `selectedDatasetDetail.created_by_display_name` and `selectedDatasetDetail.updated_by_display_name` to render the "by {Name}" text. Falls back to the current authenticated user's `display_name` when the API returns `null`.
