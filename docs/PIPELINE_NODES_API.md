# Pipeline Nodes API Reference

> API endpoints for managing nodes within a pipeline graph.
> Base URL: `/api/projects/{projectId}/pipelines/{pipelineId}/nodes`

## Overview

Pipeline nodes represent individual steps in a pipeline graph — dataset inputs, transforms, joins, unions, and outputs. Each node is persisted in the `pipeline_nodes` table and rendered as a ReactFlow node in the Pipeline Builder UI.

When a user selects datasets via the "Add Data" dialog, the frontend calls the **bulk-add** endpoint to persist them as `dataset` nodes. The pipeline graph is then reconstructed from the stored nodes on each page load.

## Authentication

All endpoints require a valid JWT Bearer token in the `Authorization` header.

```
Authorization: Bearer <token>
```

## Data Model

### PipelineNode

| Field | Type | Description |
|-------|------|-------------|
| `id` | `UUID` | Auto-generated node ID |
| `pipeline_id` | `UUID` | Parent pipeline reference |
| `dataset_id` | `UUID \| null` | Optional reference to a `foundry_datasets` row |
| `node_type` | `string` | One of: `dataset`, `transform`, `join`, `union`, `output` |
| `label` | `string` | Display name (1–255 chars) |
| `position_x` | `number` | X coordinate in the graph canvas |
| `position_y` | `number` | Y coordinate in the graph canvas |
| `config` | `object` | Arbitrary JSON configuration (e.g., columnCount, rowCount) |
| `created_at` | `datetime` | Creation timestamp |
| `updated_at` | `datetime` | Last update timestamp |
| `dataset_column_count` | `integer \| null` | Joined from `foundry_datasets` — only present on GET |
| `dataset_row_count` | `integer \| null` | Joined from `foundry_datasets` — only present on GET |
| `dataset_name` | `string \| null` | Joined from `foundry_datasets` — only present on GET |
| `dataset_status` | `string \| null` | Joined from `foundry_datasets` — only present on GET |

### Database Table

```sql
CREATE TABLE pipeline_nodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id     UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  dataset_id      UUID REFERENCES foundry_datasets(id) ON DELETE SET NULL,
  node_type       VARCHAR(50) NOT NULL DEFAULT 'dataset'
                  CHECK (node_type IN ('dataset', 'transform', 'join', 'union', 'output')),
  label           VARCHAR(255) NOT NULL,
  position_x      DOUBLE PRECISION NOT NULL DEFAULT 0,
  position_y      DOUBLE PRECISION NOT NULL DEFAULT 0,
  config          JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

Indexes: `pipeline_id`, `dataset_id`. Cascade-deletes when the parent pipeline is deleted.

---

## Endpoints

### 1. List Pipeline Nodes

```
GET /api/projects/{projectId}/pipelines/{pipelineId}/nodes
```

Returns all nodes for a pipeline with joined dataset metadata. Ordered by `created_at` ascending.

**Response Headers:**
- `X-Total-Count`: Total number of nodes

**Response:** `200 OK`
```json
{
  "success": true,
  "data": [
    {
      "id": "588ce950-0b7b-43f3-9741-c5538b1037a0",
      "pipeline_id": "35de269e-c55c-4859-a28b-03ac78912958",
      "dataset_id": "80c78f0a-ae67-4a34-878d-a6b6128a0de2",
      "node_type": "dataset",
      "label": "employees_data",
      "position_x": 100,
      "position_y": 50,
      "config": { "columnCount": 4 },
      "created_at": "2026-03-24T14:29:03.058Z",
      "updated_at": "2026-03-24T14:29:03.058Z",
      "dataset_column_count": 4,
      "dataset_row_count": 50,
      "dataset_name": "test05_employees.csv",
      "dataset_status": "ready"
    }
  ]
}
```

**Error Responses:**
- `404` — Pipeline not found

---

### 2. Add a Single Node

```
POST /api/projects/{projectId}/pipelines/{pipelineId}/nodes
```

**Request Body:**
```json
{
  "datasetId": "80c78f0a-ae67-4a34-878d-a6b6128a0de2",
  "nodeType": "dataset",
  "label": "employees_data",
  "positionX": 100,
  "positionY": 50,
  "config": { "columnCount": 4 }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `label` | Yes | — | Display name (1–255 chars) |
| `nodeType` | No | `"dataset"` | Node type enum |
| `datasetId` | No | `null` | Dataset UUID (validated against project) |
| `positionX` | No | `0` | X position |
| `positionY` | No | `0` | Y position |
| `config` | No | `{}` | Arbitrary JSON |

**Response:** `201 Created`
```json
{
  "success": true,
  "data": {
    "id": "f64da1b9-1520-4605-b39b-a5232d7dcb56",
    "pipeline_id": "35de269e-c55c-4859-a28b-03ac78912958",
    "dataset_id": "80c78f0a-ae67-4a34-878d-a6b6128a0de2",
    "node_type": "dataset",
    "label": "employees_data",
    "position_x": 100,
    "position_y": 50,
    "config": { "columnCount": 4 },
    "created_at": "2026-03-24T14:29:03.058Z",
    "updated_at": "2026-03-24T14:29:03.058Z"
  }
}
```

**Error Responses:**
- `400` — Validation error (missing label, invalid nodeType, bad UUID format)
- `404` — Pipeline not found, or dataset not found in this project

---

### 3. Bulk-Add Nodes

```
POST /api/projects/{projectId}/pipelines/{pipelineId}/nodes/bulk
```

Creates 1–50 nodes in a single request. All dataset references are validated before any inserts. If any dataset is invalid, **no nodes are created** (atomic failure).

**Request Body:**
```json
{
  "nodes": [
    {
      "datasetId": "80c78f0a-ae67-4a34-878d-a6b6128a0de2",
      "nodeType": "dataset",
      "label": "employees_data",
      "positionX": 0,
      "positionY": 0
    },
    {
      "datasetId": "05dae37d-009a-4864-a355-0ef2a00043d3",
      "nodeType": "dataset",
      "label": "products_data",
      "positionX": 290,
      "positionY": 0
    }
  ]
}
```

**Response:** `201 Created`
```json
{
  "success": true,
  "data": [
    { "id": "...", "label": "employees_data", "..." : "..." },
    { "id": "...", "label": "products_data", "..." : "..." }
  ]
}
```

**Error Responses:**
- `400` — Empty nodes array, array exceeds 50, or validation error on any node
- `404` — Pipeline not found, or one or more datasets not found in this project

---

### 4. Update a Node

```
PUT /api/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}
```

Partially updates a node. At least one field must be provided.

**Request Body (all fields optional, at least one required):**
```json
{
  "label": "employees_renamed",
  "positionX": 200,
  "positionY": 300,
  "nodeType": "transform",
  "config": { "highlight": true }
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "data": {
    "id": "f64da1b9-1520-4605-b39b-a5232d7dcb56",
    "label": "employees_renamed",
    "position_x": 200,
    "position_y": 300,
    "..."
  }
}
```

**Error Responses:**
- `400` — No fields provided, or invalid field values
- `404` — Pipeline or node not found

---

### 5. Delete a Single Node

```
DELETE /api/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}
```

**Response:** `204 No Content`

**Error Responses:**
- `404` — Pipeline or node not found

---

### 6. Delete All Nodes

```
DELETE /api/projects/{projectId}/pipelines/{pipelineId}/nodes
```

Removes all nodes from the pipeline graph. Returns the count of deleted nodes.

**Response:** `200 OK`
```json
{
  "success": true,
  "data": {
    "deletedCount": 5
  }
}
```

**Error Responses:**
- `404` — Pipeline not found

---

## Endpoint Summary

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects/:projectId/pipelines/:pipelineId/nodes` | List all nodes (with joined dataset metadata) |
| `POST` | `/api/projects/:projectId/pipelines/:pipelineId/nodes` | Add a single node |
| `POST` | `/api/projects/:projectId/pipelines/:pipelineId/nodes/bulk` | Bulk-add 1–50 nodes |
| `PUT` | `/api/projects/:projectId/pipelines/:pipelineId/nodes/:nodeId` | Update a node |
| `DELETE` | `/api/projects/:projectId/pipelines/:pipelineId/nodes/:nodeId` | Delete a single node |
| `DELETE` | `/api/projects/:projectId/pipelines/:pipelineId/nodes` | Delete all nodes |

## Interactive Documentation

The OpenAPI spec is available at:
- **Swagger UI:** `GET /api/docs`
- **Raw spec JSON:** `GET /api/docs/spec.json`

Pipeline Nodes endpoints are tagged under **"Pipeline Nodes"** in the Swagger UI.

## Source Files

| Layer | File |
|-------|------|
| Route definitions | `src/routes/pipelines.ts` |
| Controller (HTTP) | `src/controllers/pipelineController.ts` |
| Service (business logic) | `src/services/pipelineService.ts` |
| Zod schemas & types | `src/types/pipeline.ts` |
| Database migration | `src/foundryMigrate.ts` |
| OpenAPI spec | `src/docs/openapi.ts` |
