import { Express } from 'express';

/**
 * OpenAPI 3.0 specification for Foundry Backend API.
 */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Foundry Backend API',
    description: 'Data ingestion and management API for the Foundry platform',
    version: '1.0.0',
    contact: {
      name: 'Foundry Team',
    },
  },
  servers: [
    {
      url: '/api',
      description: 'API base path',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http' as const,
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      Error: {
        type: 'object' as const,
        properties: {
          error: {
            type: 'object' as const,
            properties: {
              code: { type: 'string' as const },
              message: { type: 'string' as const },
              details: { type: 'object' as const },
            },
            required: ['code', 'message'],
          },
        },
      },
      SuccessResponse: {
        type: 'object' as const,
        properties: {
          success: { type: 'boolean' as const },
          data: { type: 'object' as const },
        },
      },
      PaginationMeta: {
        type: 'object' as const,
        properties: {
          page: { type: 'integer' as const },
          limit: { type: 'integer' as const },
          totalCount: { type: 'integer' as const },
          totalPages: { type: 'integer' as const },
          hasNext: { type: 'boolean' as const },
          hasPrev: { type: 'boolean' as const },
        },
      },
      Dataset: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          name: { type: 'string' as const },
          folder_id: { type: 'string' as const, format: 'uuid' },
          file_path: { type: 'string' as const },
          original_filename: { type: 'string' as const },
          mime_type: { type: 'string' as const },
          file_size_bytes: { type: 'integer' as const },
          row_count: { type: 'integer' as const },
          column_count: { type: 'integer' as const },
          status: { type: 'string' as const, enum: ['pending', 'processing', 'ready', 'error'] },
          content_hash: { type: 'string' as const },
          created_at: { type: 'string' as const, format: 'date-time' },
          updated_at: { type: 'string' as const, format: 'date-time' },
        },
      },
      Project: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          name: { type: 'string' as const },
          description: { type: 'string' as const },
          owner_id: { type: 'string' as const, format: 'uuid' },
          created_at: { type: 'string' as const, format: 'date-time' },
          updated_at: { type: 'string' as const, format: 'date-time' },
        },
      },
      Folder: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          name: { type: 'string' as const },
          parent_folder_id: { type: 'string' as const, format: 'uuid', nullable: true },
          project_id: { type: 'string' as const, format: 'uuid' },
          depth: { type: 'integer' as const },
          created_at: { type: 'string' as const, format: 'date-time' },
          updated_at: { type: 'string' as const, format: 'date-time' },
        },
      },
      DatasetVersion: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          dataset_id: { type: 'string' as const, format: 'uuid' },
          version_number: { type: 'integer' as const },
          file_path: { type: 'string' as const },
          file_size_bytes: { type: 'integer' as const },
          row_count: { type: 'integer' as const },
          column_count: { type: 'integer' as const },
          content_hash: { type: 'string' as const },
          change_summary: { type: 'string' as const },
          created_at: { type: 'string' as const, format: 'date-time' },
        },
      },
      ProjectStats: {
        type: 'object' as const,
        properties: {
          folderCount: { type: 'integer' as const },
          datasetCount: { type: 'integer' as const },
          totalSizeBytes: { type: 'integer' as const },
          memberCount: { type: 'integer' as const },
        },
      },
      FolderTreeNode: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          name: { type: 'string' as const },
          parentFolderId: { type: 'string' as const, format: 'uuid', nullable: true },
          children: {
            type: 'array' as const,
            items: { $ref: '#/components/schemas/FolderTreeNode' },
          },
        },
      },
      BreadcrumbEntry: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          name: { type: 'string' as const },
          type: { type: 'string' as const, enum: ['project', 'folder', 'dataset'] },
        },
      },
      DatasetSummary: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          name: { type: 'string' as const },
          status: { type: 'string' as const, enum: ['pending', 'processing', 'ready', 'error'] },
          file_size_bytes: { type: 'integer' as const },
        },
      },
      UserPreference: {
        type: 'object' as const,
        properties: {
          key: { type: 'string' as const, pattern: '^[a-z][a-z0-9_]*$' },
          value: {},
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        security: [],
        responses: {
          '200': {
            description: 'Service is healthy',
            content: { 'application/json': { schema: { type: 'object' as const } } },
          },
        },
      },
    },
    '/auth/register': {
      post: {
        tags: ['Authentication'],
        summary: 'Register a new user',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  email: { type: 'string' as const, format: 'email' },
                  password: { type: 'string' as const, minLength: 8 },
                  displayName: { type: 'string' as const },
                },
                required: ['email', 'password', 'displayName'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'User registered successfully' },
          '409': { description: 'Email already in use' },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Authentication'],
        summary: 'Log in and receive JWT tokens',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  email: { type: 'string' as const, format: 'email' },
                  password: { type: 'string' as const },
                },
                required: ['email', 'password'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Login successful, returns tokens' },
          '401': { description: 'Invalid credentials' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Authentication'],
        summary: 'Refresh an access token',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  refreshToken: { type: 'string' as const, minLength: 1 },
                },
                required: ['refreshToken'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'New access token returned' },
          '401': { description: 'Invalid or expired refresh token' },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Authentication'],
        summary: 'Logout and invalidate refresh token',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  refreshToken: { type: 'string' as const, minLength: 1 },
                },
                required: ['refreshToken'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Logout successful' },
          '401': { description: 'Invalid refresh token' },
        },
      },
    },
    '/projects': {
      get: {
        tags: ['Projects'],
        summary: 'List all projects for the authenticated user',
        responses: {
          '200': { description: 'List of projects' },
        },
      },
      post: {
        tags: ['Projects'],
        summary: 'Create a new project',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  name: { type: 'string' as const },
                  description: { type: 'string' as const },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Project created' },
        },
      },
    },
    '/projects/{projectId}': {
      get: {
        tags: ['Projects'],
        summary: 'Get a project by ID',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Project details' },
          '404': { description: 'Project not found' },
        },
      },
      put: {
        tags: ['Projects'],
        summary: 'Update a project',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  name: { type: 'string' as const, minLength: 1, maxLength: 255 },
                  description: { type: 'string' as const, maxLength: 2000 },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Project updated' },
        },
      },
      delete: {
        tags: ['Projects'],
        summary: 'Delete a project',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '204': { description: 'Project deleted' },
        },
      },
    },
    '/projects/{projectId}/stats': {
      get: {
        tags: ['Projects'],
        summary: 'Get project statistics',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'Project statistics',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectStats' } } },
          },
          '404': { description: 'Project not found' },
        },
      },
    },
    '/projects/{projectId}/folders': {
      get: {
        tags: ['Folders'],
        summary: 'List folders in a project',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'parentId', in: 'query' as const, required: false, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'List of folders' },
        },
      },
      post: {
        tags: ['Folders'],
        summary: 'Create a folder',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '201': { description: 'Folder created' },
        },
      },
    },
    '/projects/{projectId}/folders/{folderId}': {
      get: {
        tags: ['Folders'],
        summary: 'Get a folder by ID with children',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'folderId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Folder details with children' },
          '404': { description: 'Folder not found' },
        },
      },
      put: {
        tags: ['Folders'],
        summary: 'Update or move a folder',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'folderId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  name: { type: 'string' as const, minLength: 1, maxLength: 255 },
                  parentFolderId: { type: 'string' as const, format: 'uuid', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Folder updated' },
        },
      },
      delete: {
        tags: ['Folders'],
        summary: 'Delete a folder and its contents',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'folderId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '204': { description: 'Folder deleted' },
        },
      },
    },
    '/projects/{projectId}/folders/tree': {
      get: {
        tags: ['Folders'],
        summary: 'Get the full project folder tree',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'Nested folder tree',
            content: {
              'application/json': {
                schema: {
                  type: 'array' as const,
                  items: { $ref: '#/components/schemas/FolderTreeNode' },
                },
              },
            },
          },
        },
      },
    },
    '/projects/{projectId}/folders/{folderId}/tree': {
      get: {
        tags: ['Folders'],
        summary: 'Get folder subtree',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'folderId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Folder subtree' },
          '404': { description: 'Folder not found' },
        },
      },
    },
    '/projects/{projectId}/folders/{folderId}/breadcrumb': {
      get: {
        tags: ['Folders'],
        summary: 'Get breadcrumb trail for a folder',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'folderId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'Breadcrumb trail from project root to folder',
            content: {
              'application/json': {
                schema: {
                  type: 'array' as const,
                  items: { $ref: '#/components/schemas/BreadcrumbEntry' },
                },
              },
            },
          },
          '404': { description: 'Folder not found' },
        },
      },
    },
    '/projects/{projectId}/folders/{folderId}/upload': {
      post: {
        tags: ['Uploads'],
        summary: 'Upload files to a folder',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'folderId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object' as const,
                properties: {
                  files: {
                    type: 'array' as const,
                    items: { type: 'string' as const, format: 'binary' },
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Files uploaded and processing started' },
          '413': { description: 'File too large' },
        },
      },
    },
    '/projects/{projectId}/folders/{folderId}/datasets': {
      get: {
        tags: ['Datasets'],
        summary: 'List datasets in a folder',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'folderId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'status', in: 'query' as const, required: false, schema: { type: 'string' as const } },
          { name: 'page', in: 'query' as const, required: false, schema: { type: 'integer' as const, default: 1 } },
          { name: 'limit', in: 'query' as const, required: false, schema: { type: 'integer' as const, default: 20 } },
        ],
        responses: {
          '200': { description: 'Paginated list of datasets' },
        },
      },
    },
    '/datasets/status-batch': {
      get: {
        tags: ['Datasets'],
        summary: 'Get processing status for multiple datasets',
        parameters: [
          { name: 'ids', in: 'query' as const, required: true, schema: { type: 'string' as const }, description: 'Comma-separated list of dataset UUIDs (max 50)' },
        ],
        responses: {
          '200': { description: 'Map of dataset IDs to their statuses' },
          '400': { description: 'Invalid or too many IDs' },
        },
      },
    },
    '/datasets/{datasetId}': {
      get: {
        tags: ['Datasets'],
        summary: 'Get a dataset by ID with columns',
        parameters: [
          { name: 'datasetId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Dataset details with columns' },
          '404': { description: 'Dataset not found' },
        },
      },
      delete: {
        tags: ['Datasets'],
        summary: 'Delete a dataset',
        parameters: [
          { name: 'datasetId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '204': { description: 'Dataset deleted' },
          '404': { description: 'Dataset not found' },
        },
      },
    },
    '/datasets/{datasetId}/preview': {
      get: {
        tags: ['Datasets'],
        summary: 'Preview dataset rows',
        parameters: [
          { name: 'datasetId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'rows', in: 'query' as const, required: false, schema: { type: 'integer' as const, default: 50 } },
        ],
        responses: {
          '200': { description: 'Preview rows' },
        },
      },
    },
    '/datasets/{datasetId}/status': {
      get: {
        tags: ['Datasets'],
        summary: 'Get dataset processing status',
        parameters: [
          { name: 'datasetId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Dataset status' },
        },
      },
    },
    '/datasets/{datasetId}/summary': {
      get: {
        tags: ['Datasets'],
        summary: 'Get dataset summary',
        parameters: [
          { name: 'datasetId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'Dataset summary',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DatasetSummary' } } },
          },
          '404': { description: 'Dataset not found' },
        },
      },
    },
    '/datasets/{datasetId}/columns/{columnName}/stats': {
      get: {
        tags: ['Column Stats'],
        summary: 'Get statistics for a specific column',
        parameters: [
          { name: 'datasetId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'columnName', in: 'path' as const, required: true, schema: { type: 'string' as const } },
        ],
        responses: {
          '200': { description: 'Column statistics' },
          '404': { description: 'Dataset or column not found' },
        },
      },
    },
    '/datasets/{datasetId}/profile': {
      get: {
        tags: ['Column Stats'],
        summary: 'Get full dataset profile with all column statistics',
        parameters: [
          { name: 'datasetId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Dataset profile' },
          '404': { description: 'Dataset not found' },
        },
      },
    },
    '/datasets/{datasetId}/versions': {
      get: {
        tags: ['Versions'],
        summary: 'List all versions for a dataset',
        parameters: [
          { name: 'datasetId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'List of versions' },
        },
      },
      post: {
        tags: ['Versions'],
        summary: 'Create a new version snapshot',
        parameters: [
          { name: 'datasetId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  changeSummary: { type: 'string' as const, maxLength: 500 },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Version created' },
        },
      },
    },
    '/datasets/{datasetId}/versions/{versionNumber}': {
      get: {
        tags: ['Versions'],
        summary: 'Get a specific version',
        parameters: [
          { name: 'datasetId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'versionNumber', in: 'path' as const, required: true, schema: { type: 'integer' as const } },
        ],
        responses: {
          '200': { description: 'Version details' },
          '404': { description: 'Version not found' },
        },
      },
    },
    '/datasets/{datasetId}/versions/restore': {
      post: {
        tags: ['Versions'],
        summary: 'Restore a dataset to a previous version',
        parameters: [
          { name: 'datasetId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  versionNumber: { type: 'integer' as const, minimum: 1 },
                },
                required: ['versionNumber'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Dataset restored' },
        },
      },
    },
    '/datasets/{datasetId}/deduplicate': {
      post: {
        tags: ['Duplicates'],
        summary: 'Check if a dataset is a duplicate',
        parameters: [
          { name: 'datasetId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Deduplication result' },
        },
      },
    },
    '/projects/{projectId}/duplicates': {
      get: {
        tags: ['Duplicates'],
        summary: 'Find all duplicate files in a project',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Duplicate groups' },
        },
      },
    },
    '/projects/{projectId}/members': {
      get: {
        tags: ['Members'],
        summary: 'List project members',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'List of members' },
        },
      },
      post: {
        tags: ['Members'],
        summary: 'Add a member to a project',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '201': { description: 'Member added' },
        },
      },
    },
    '/search': {
      get: {
        tags: ['Search'],
        summary: 'Search datasets, folders, and projects',
        parameters: [
          { name: 'q', in: 'query' as const, required: true, schema: { type: 'string' as const } },
          { name: 'type', in: 'query' as const, required: false, schema: { type: 'string' as const } },
        ],
        responses: {
          '200': { description: 'Search results' },
        },
      },
    },
    '/search/suggest': {
      get: {
        tags: ['Search'],
        summary: 'Get search suggestions and autocomplete',
        parameters: [
          { name: 'q', in: 'query' as const, required: false, schema: { type: 'string' as const }, description: 'Search query text' },
        ],
        responses: {
          '200': { description: 'Search suggestions' },
        },
      },
    },
    '/breadcrumb/{type}/{id}': {
      get: {
        tags: ['Navigation'],
        summary: 'Get breadcrumb trail for a project, folder, or dataset',
        parameters: [
          { name: 'type', in: 'path' as const, required: true, schema: { type: 'string' as const, enum: ['project', 'folder', 'dataset'] } },
          { name: 'id', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'includeChildren', in: 'query' as const, required: false, schema: { type: 'string' as const, enum: ['true', 'false'] }, description: 'Include children in breadcrumb result' },
        ],
        responses: {
          '200': {
            description: 'Breadcrumb trail',
            content: {
              'application/json': {
                schema: {
                  type: 'array' as const,
                  items: { $ref: '#/components/schemas/BreadcrumbEntry' },
                },
              },
            },
          },
          '404': { description: 'Resource not found' },
        },
      },
    },
    '/users/me/preferences': {
      get: {
        tags: ['User Preferences'],
        summary: 'Get all user preferences',
        responses: {
          '200': {
            description: 'List of user preferences',
            content: {
              'application/json': {
                schema: {
                  type: 'array' as const,
                  items: { $ref: '#/components/schemas/UserPreference' },
                },
              },
            },
          },
        },
      },
    },
    '/users/me/preferences/{key}': {
      get: {
        tags: ['User Preferences'],
        summary: 'Get a single user preference by key',
        parameters: [
          { name: 'key', in: 'path' as const, required: true, schema: { type: 'string' as const, pattern: '^[a-z][a-z0-9_]*$' } },
        ],
        responses: {
          '200': {
            description: 'User preference',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UserPreference' } } },
          },
          '404': { description: 'Preference not found' },
        },
      },
      put: {
        tags: ['User Preferences'],
        summary: 'Update a user preference',
        parameters: [
          { name: 'key', in: 'path' as const, required: true, schema: { type: 'string' as const, pattern: '^[a-z][a-z0-9_]*$' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  value: {},
                },
                required: ['value'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Preference updated' },
        },
      },
      delete: {
        tags: ['User Preferences'],
        summary: 'Delete (reset) a user preference',
        parameters: [
          { name: 'key', in: 'path' as const, required: true, schema: { type: 'string' as const, pattern: '^[a-z][a-z0-9_]*$' } },
        ],
        responses: {
          '204': { description: 'Preference deleted' },
        },
      },
    },
  },
};

/**
 * Set up Swagger UI and serve the OpenAPI spec.
 *
 * Serves the raw spec at GET /api/docs/spec.json
 * and a minimal HTML Swagger UI at GET /api/docs.
 */
export function setupSwagger(app: Express): void {
  // Serve the raw OpenAPI spec
  app.get('/api/docs/spec.json', (_req, res) => {
    res.json(openApiSpec);
  });

  // Serve a minimal Swagger UI HTML page.
  // Override Content-Security-Policy so the browser allows the unpkg CDN
  // assets and the small inline bootstrap script.
  app.get('/api/docs', (_req, res) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://unpkg.com 'unsafe-inline'; style-src 'self' https://unpkg.com 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://unpkg.com",
    );
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Foundry API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/docs/spec.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`;
    res.type('html').send(html);
  });
}
