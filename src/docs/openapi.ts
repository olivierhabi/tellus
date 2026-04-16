import { Express } from 'express';
import { ontologyPaths, ontologySchemas } from './ontology-openapi';

/**
 * OpenAPI 3.0 specification for the Tellus Backend.
 *
 * Combines two surface areas:
 *   1. The original Foundry data ingestion API (defined inline below).
 *   2. The Ontology Manager / Object Explorer API, defined separately in
 *      `ontology-openapi.ts` and merged in below so the file stays
 *      navigable.
 */
const baseSpec = {
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
      // Keycloak-issued RS256 JWT. Obtain via POST /api/v1/auth/login
      // (direct grant) or GET /api/v1/auth/oidc/authorize (PKCE redirect).
      // Validated against the realm's JWKS — see
      // http://localhost:8086/realms/tellus/.well-known/openid-configuration.
      bearerAuth: {
        type: 'http' as const,
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Keycloak RS256 JWT. Acquire via POST /api/v1/auth/login or the ' +
          'PKCE flow at GET /api/v1/auth/oidc/authorize. HS256 tokens from ' +
          'the legacy /api/auth/* surface are no longer accepted.',
      },
      // Browser flows may skip the Authorization header entirely and rely
      // on the httpOnly TELLUS_TOKEN cookie that /api/v1/auth/login sets.
      cookieAuth: {
        type: 'apiKey' as const,
        in: 'cookie' as const,
        name: 'TELLUS_TOKEN',
        description:
          'httpOnly session cookie set by /api/v1/auth/login, refreshed by ' +
          'the PKCE callback. Shipped automatically by any browser client ' +
          'using withCredentials: true.',
      },
      // Personal Access Tokens (/api/v1/auth/tokens). Prefix tellus_pat_.
      patAuth: {
        type: 'http' as const,
        scheme: 'bearer',
        bearerFormat: 'PAT',
        description:
          'Personal Access Token (tellus_pat_ prefix). Created via POST ' +
          '/api/v1/auth/tokens, hashed at rest, revocable, cannot mint ' +
          'other tokens.',
      },
    },
    // Global default — every operation that does not opt out via
    // `security: []` requires one of the three Keycloak-sourced credentials.
    // Callers may satisfy any one of the alternatives.
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
      Pipeline: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          project_id: { type: 'string' as const, format: 'uuid' },
          folder_id: { type: 'string' as const, format: 'uuid', nullable: true, description: 'Folder the pipeline belongs to (null = project root)' },
          name: { type: 'string' as const },
          description: { type: 'string' as const, nullable: true },
          pipeline_type: { type: 'string' as const, enum: ['batch', 'streaming'] },
          compute_type: { type: 'string' as const, enum: ['standard', 'lightweight', 'external'] },
          status: { type: 'string' as const, enum: ['draft', 'active', 'paused', 'failed', 'archived'] },
          config: { type: 'object' as const },
          created_by: { type: 'string' as const, format: 'uuid', nullable: true },
          created_at: { type: 'string' as const, format: 'date-time' },
          updated_at: { type: 'string' as const, format: 'date-time' },
        },
        required: ['id', 'project_id', 'name', 'pipeline_type', 'compute_type', 'status'],
      },
      CreatePipelineRequest: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, minLength: 1, maxLength: 255 },
          description: { type: 'string' as const, maxLength: 2000 },
          pipelineType: { type: 'string' as const, enum: ['batch', 'streaming'], default: 'batch' },
          computeType: { type: 'string' as const, enum: ['standard', 'lightweight', 'external'], default: 'standard' },
          folderId: { type: 'string' as const, format: 'uuid', nullable: true, description: 'Folder to place the pipeline in (omit or null for project root)' },
        },
        required: ['name'],
      },
      UpdatePipelineRequest: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, minLength: 1, maxLength: 255 },
          description: { type: 'string' as const, maxLength: 2000 },
          pipelineType: { type: 'string' as const, enum: ['batch', 'streaming'] },
          computeType: { type: 'string' as const, enum: ['standard', 'lightweight', 'external'] },
          status: { type: 'string' as const, enum: ['draft', 'active', 'paused', 'failed', 'archived'] },
          config: { type: 'object' as const },
        },
      },
      PipelineNode: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          pipeline_id: { type: 'string' as const, format: 'uuid' },
          dataset_id: { type: 'string' as const, format: 'uuid', nullable: true },
          node_type: { type: 'string' as const, enum: ['dataset', 'transform', 'join', 'union', 'output'] },
          label: { type: 'string' as const },
          position_x: { type: 'number' as const },
          position_y: { type: 'number' as const },
          config: { type: 'object' as const },
          created_at: { type: 'string' as const, format: 'date-time' },
          updated_at: { type: 'string' as const, format: 'date-time' },
          dataset_column_count: { type: 'integer' as const, nullable: true, description: 'Joined from foundry_datasets (GET only)' },
          dataset_row_count: { type: 'integer' as const, nullable: true, description: 'Joined from foundry_datasets (GET only)' },
          dataset_name: { type: 'string' as const, nullable: true, description: 'Joined from foundry_datasets (GET only)' },
          dataset_status: { type: 'string' as const, nullable: true, description: 'Joined from foundry_datasets (GET only)' },
        },
        required: ['id', 'pipeline_id', 'node_type', 'label', 'position_x', 'position_y'],
      },
      CreatePipelineNodeRequest: {
        type: 'object' as const,
        properties: {
          datasetId: { type: 'string' as const, format: 'uuid', description: 'Optional reference to a foundry_dataset in the project' },
          nodeType: { type: 'string' as const, enum: ['dataset', 'transform', 'join', 'union', 'output'], default: 'dataset' },
          label: { type: 'string' as const, minLength: 1, maxLength: 255 },
          positionX: { type: 'number' as const, default: 0 },
          positionY: { type: 'number' as const, default: 0 },
          config: { type: 'object' as const },
        },
        required: ['label'],
      },
      BulkCreatePipelineNodesRequest: {
        type: 'object' as const,
        properties: {
          nodes: {
            type: 'array' as const,
            items: { $ref: '#/components/schemas/CreatePipelineNodeRequest' },
            minItems: 1,
            maxItems: 50,
          },
        },
        required: ['nodes'],
      },
      UpdatePipelineNodeRequest: {
        type: 'object' as const,
        properties: {
          label: { type: 'string' as const, minLength: 1, maxLength: 255 },
          nodeType: { type: 'string' as const, enum: ['dataset', 'transform', 'join', 'union', 'output'] },
          positionX: { type: 'number' as const },
          positionY: { type: 'number' as const },
          config: { type: 'object' as const },
        },
        description: 'At least one field must be provided.',
      },
    },
  },
  security: [{ bearerAuth: [] }, { cookieAuth: [] }, { patAuth: [] }],
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
    // ---------------------------------------------------------------
    // Authentication — Keycloak-backed (ontology/tellus-auth.md Tasks
    // 3, 4, 9; Phase 3 in-app credential UX).
    //
    // Every authenticated operation requires one of the three credential
    // types declared in `components.securitySchemes`: bearerAuth (RS256
    // JWT), cookieAuth (TELLUS_TOKEN httpOnly cookie), or patAuth
    // (tellus_pat_* Personal Access Token). The legacy HS256
    // /api/auth/* surface is gone — the router, routes, and path docs
    // were all removed. Callers that still hit it get a 404 from the
    // notFoundHandler.
    // ---------------------------------------------------------------
    '/v1/auth/login': {
      post: {
        tags: ['Authentication'],
        summary: 'Direct-grant login against Keycloak',
        description:
          'Proxies the email/password pair to Keycloak via the OAuth2 ' +
          'Resource Owner Password Credentials grant against the ' +
          'tellus-frontend client. On success the backend sets an ' +
          'httpOnly TELLUS_TOKEN cookie (Max-Age 16h) and also returns the ' +
          'access token in the response body so programmatic clients can ' +
          'use the Authorization: Bearer path.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  username: { type: 'string' as const, description: 'Email or Keycloak username' },
                  email: { type: 'string' as const, format: 'email' },
                  password: { type: 'string' as const },
                },
                required: ['password'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Login successful — TELLUS_TOKEN cookie set; body contains accessToken + tokenInfo.',
          },
          '401': { description: 'Invalid credentials (Keycloak rejected the direct grant)' },
          '429': { description: 'AUTH_RATE_LIMIT — too many failed attempts (per IP+username)' },
          '502': { description: 'KEYCLOAK_UNREACHABLE' },
        },
      },
    },
    '/v1/auth/logout': {
      post: {
        tags: ['Authentication'],
        summary: 'Logout + revoke current session',
        description:
          'Adds the current jti to the server-side revocation set, calls ' +
          'Keycloak\'s logout endpoint with the refresh token, and clears ' +
          'the TELLUS_TOKEN + TELLUS_REFRESH cookies. Idempotent.',
        responses: { '204': { description: 'Logged out' } },
      },
    },
    '/v1/auth/token-info': {
      get: {
        tags: ['Authentication'],
        summary: 'Decoded session claims for the current caller',
        description:
          'Returns sub, jti, org, markings, orgs, realmRoles, session scope ' +
          'and timing data. Works for both JWT and PAT auth; PATs return ' +
          '`tokenKind: "pat"` and the `scopes` array.',
        responses: {
          '200': { description: 'Session info' },
          '401': { description: 'TOKEN_INVALID / TOKEN_EXPIRED / TOKEN_REVOKED' },
        },
      },
    },
    '/v1/auth/check-access': {
      post: {
        tags: ['Authentication'],
        summary: 'Centralized hasOperation() authorization check',
        description:
          'The Palantir Multipass-equivalent permission probe. Returns ' +
          '{ allowed, reason } for the (operation, resourceType, resourceRid) ' +
          'triple evaluated against the caller\'s realm roles.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  operation: { type: 'string' as const },
                  resourceRid: { type: 'string' as const },
                  resourceType: { type: 'string' as const },
                },
                required: ['operation'],
              },
            },
          },
        },
        responses: {
          '200': { description: '{ allowed: boolean, reason: string }' },
          '401': { description: 'Unauthenticated' },
        },
      },
    },
    // /v1/auth/oidc/authorize and /v1/auth/oidc/callback were retired in
    // Phase 3 (ontology/tellus-auth.md) because they browser-redirected
    // to the Keycloak hostname. Authentication is now fully in-app via
    // /v1/auth/login (password, possibly two-step) and /v1/auth/login/mfa
    // (TOTP or WebAuthn). Only the pure-JSON /oidc/config is still here.
    '/v1/auth/login/mfa': {
      post: {
        tags: ['Authentication'],
        summary: 'Complete a two-step login (TOTP code or WebAuthn assertion)',
        description:
          'Second step of /api/v1/auth/login when the user has enrolled ' +
          'TOTP or a WebAuthn passkey. Pass the mfaChallenge from step 1 ' +
          'plus either a TOTP `code` or a WebAuthn `assertionResponse`. ' +
          'On success the TELLUS_TOKEN cookie is set and the session goes live.',
        security: [],
        responses: {
          '200': { description: 'MFA satisfied — session cookie now set' },
          '401': { description: 'MFA_CHALLENGE_INVALID / MFA_INVALID' },
        },
      },
    },
    '/v1/auth/login/mfa/webauthn-options': {
      post: {
        tags: ['Authentication'],
        summary: 'Build a WebAuthn authentication request for an in-flight MFA challenge',
        security: [],
        responses: { '200': { description: '@simplewebauthn authenticationOptions JSON' } },
      },
    },
    '/v1/auth/me/password': {
      post: {
        tags: ['Authentication'],
        summary: 'In-app password change (old + new, no Keycloak redirect)',
        description:
          'Verifies the current password via direct-grant to Keycloak, ' +
          'then resets the password via the admin API. The new password ' +
          'is validated against the realm password policy server-side.',
        responses: {
          '204': { description: 'Password updated' },
          '401': { description: 'OLD_PASSWORD_INVALID' },
          '400': { description: 'PASSWORD_POLICY_VIOLATION' },
        },
      },
    },
    '/v1/auth/me/totp/start': {
      post: {
        tags: ['Authentication'],
        summary: 'Begin TOTP enrollment — returns QR data URL + base32 secret',
        responses: { '200': { description: 'Enrollment envelope (one-time)' } },
      },
    },
    '/v1/auth/me/totp/verify': {
      post: {
        tags: ['Authentication'],
        summary: 'Activate a TOTP secret by proving a valid 6-digit code',
        responses: { '204': { description: 'Enrollment complete' }, '400': { description: 'INVALID_CODE' } },
      },
    },
    '/v1/auth/me/totp': {
      delete: {
        tags: ['Authentication'],
        summary: 'Disable TOTP for the current user',
        responses: { '204': { description: 'TOTP disabled' } },
      },
    },
    '/v1/auth/me/totp/status': {
      get: {
        tags: ['Authentication'],
        summary: '{ enabled: boolean } — whether TOTP is verified for this user',
        responses: { '200': { description: 'Status' } },
      },
    },
    '/v1/auth/me/webauthn/register-options': {
      post: {
        tags: ['Authentication'],
        summary: 'Build a WebAuthn registration challenge for in-app passkey enrollment',
        description:
          '@simplewebauthn/server generates the PublicKeyCredentialCreationOptions JSON that ' +
          'the browser passes to navigator.credentials.create(). RP = tellus-fe origin; no ' +
          'redirect to the Keycloak hostname.',
        responses: { '200': { description: 'registrationOptions' } },
      },
    },
    '/v1/auth/me/webauthn/register-verify': {
      post: {
        tags: ['Authentication'],
        summary: 'Verify a WebAuthn attestation and persist the credential',
        responses: { '201': { description: 'Credential stored' }, '400': { description: 'VERIFICATION_FAILED' } },
      },
    },
    '/v1/auth/me/webauthn/credentials': {
      get: {
        tags: ['Authentication'],
        summary: 'List the current user\'s in-app passkeys',
        responses: { '200': { description: 'Credential list (public metadata only)' } },
      },
    },
    '/v1/auth/me/webauthn/credentials/{id}': {
      delete: {
        tags: ['Authentication'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' as const } }],
        responses: { '204': { description: 'Deleted' } },
      },
    },
    '/v1/auth/oidc/config': {
      get: {
        tags: ['Authentication'],
        summary: 'Proxied Keycloak OIDC discovery document',
        security: [],
        responses: { '200': { description: 'Essential OIDC endpoints for this realm.' } },
      },
    },
    '/v1/auth/saml/metadata': {
      get: {
        tags: ['Authentication'],
        summary: 'SP EntityDescriptor for partner IdP brokering',
        security: [],
        responses: {
          '200': {
            description: 'application/xml — Keycloak SAML SP descriptor',
            content: { 'application/xml': { schema: { type: 'string' as const } } },
          },
        },
      },
    },
    '/v1/auth/tokens': {
      get: {
        tags: ['Authentication'],
        summary: 'List the caller\'s Personal Access Tokens (metadata only)',
        description: 'Never returns raw token values — only id, name, tokenPrefix, scopes, timestamps.',
        responses: { '200': { description: 'Array of PAT metadata objects' } },
      },
      post: {
        tags: ['Authentication'],
        summary: 'Mint a Personal Access Token (returned exactly once)',
        description:
          'The raw token is returned exactly once in the response body. It ' +
          'is hashed with sha-256 before being written to ' +
          'personal_access_tokens. PATs cannot mint other PATs (the ' +
          '/tokens endpoints require a live JWT session).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                properties: {
                  name: { type: 'string' as const },
                  expiresAt: { type: 'string' as const, format: 'date-time' },
                  scopes: { type: 'array' as const, items: { type: 'string' as const } },
                },
                required: ['name', 'expiresAt'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'PAT created — token returned with tellus_pat_ prefix' },
          '400': { description: 'Invalid expiresAt or request shape' },
        },
      },
    },
    '/v1/auth/pat-scopes': {
      get: {
        tags: ['Authentication'],
        summary: 'Public PAT scope manifest',
        description:
          'Returns the closed enum of PAT scopes plus the route-pattern → ' +
          'required-scope table enforced by the app-wide patSecurityGate. ' +
          'Tooling that mints PATs for third-party apps reads this instead ' +
          'of scraping services/patScopeMap.ts. Public (no auth required).',
        responses: {
          '200': {
            description: 'PatScopeManifest JSON',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: {
                      type: 'object' as const,
                      properties: {
                        scopes: { type: 'array' as const, items: { type: 'string' as const } },
                        unauthenticatedRoutes: {
                          type: 'array' as const,
                          items: { type: 'string' as const },
                        },
                        rules: {
                          type: 'array' as const,
                          items: {
                            type: 'object' as const,
                            properties: {
                              method: { type: 'string' as const, enum: ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                              prefix: { type: 'string' as const },
                              scope: { type: 'string' as const },
                              extraCondition: { type: 'string' as const },
                            },
                            required: ['method', 'prefix', 'scope'],
                          },
                        },
                        fallback: {
                          type: 'object' as const,
                          properties: {
                            GET: { type: 'string' as const },
                            MUTATION: { type: 'string' as const },
                          },
                          required: ['GET', 'MUTATION'],
                        },
                      },
                      required: ['scopes', 'unauthenticatedRoutes', 'rules', 'fallback'],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v1/auth/tokens/{id}': {
      delete: {
        tags: ['Authentication'],
        summary: 'Revoke a Personal Access Token',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '204': { description: 'Revoked' },
          '404': { description: 'Token not found or already revoked' },
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
        description: 'Returns folder metadata plus its children: sub-folders, datasets, and pipelines. The `children.pipelines` array contains pipelines whose `folder_id` matches this folder.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'folderId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'sortBy', in: 'query' as const, required: false, schema: { type: 'string' as const, default: 'name' }, description: 'Sort datasets by this column' },
          { name: 'sortOrder', in: 'query' as const, required: false, schema: { type: 'string' as const, enum: ['asc', 'desc'], default: 'asc' } },
        ],
        responses: {
          '200': {
            description: 'Folder details with children (folders, datasets, pipelines)',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: {
                      type: 'object' as const,
                      properties: {
                        id: { type: 'string' as const, format: 'uuid' },
                        name: { type: 'string' as const },
                        parent_folder_id: { type: 'string' as const, format: 'uuid', nullable: true },
                        child_count: { type: 'integer' as const },
                        dataset_count: { type: 'integer' as const },
                        has_children: { type: 'boolean' as const },
                        children: {
                          type: 'object' as const,
                          properties: {
                            folders: { type: 'array' as const, items: { $ref: '#/components/schemas/Folder' } },
                            datasets: { type: 'array' as const, items: { $ref: '#/components/schemas/Dataset' } },
                            pipelines: { type: 'array' as const, items: { $ref: '#/components/schemas/Pipeline' } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
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
    '/projects/{projectId}/upload': {
      post: {
        tags: ['Uploads'],
        summary: 'Upload files to a project',
        description: 'Upload files directly to a project. An "Uploads" folder is automatically created at the project root if one does not already exist. Files are placed into this folder.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
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
                    description: 'One or more files to upload (max 10). Supported: .csv, .tsv, .txt',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Files uploaded and processing started',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: {
                      type: 'array' as const,
                      items: { $ref: '#/components/schemas/Dataset' },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'No files provided or validation error' },
          '401': { description: 'Authentication required' },
          '404': { description: 'Project not found' },
          '413': { description: 'File too large' },
        },
      },
    },
    '/projects/{projectId}/datasets/all': {
      get: {
        tags: ['Datasets'],
        summary: 'List all datasets in a project',
        description: 'Returns every dataset belonging to the project — from all folders and the project root. Used by the pipeline builder to show available datasets for selection.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'All project datasets',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: {
                      type: 'array' as const,
                      items: { $ref: '#/components/schemas/Dataset' },
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'Authentication required' },
        },
      },
    },
    '/projects/{projectId}/datasets': {
      get: {
        tags: ['Datasets'],
        summary: 'List datasets at the project root level',
        description: 'Returns datasets uploaded directly to the project (not inside any folder). These are files with folder_id = NULL.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'List of project-root datasets',
            content: {
              'application/json': {
                schema: {
                  type: 'array' as const,
                  items: { $ref: '#/components/schemas/Dataset' },
                },
              },
            },
          },
          '401': { description: 'Authentication required' },
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
    '/projects/{projectId}/pipelines': {
      get: {
        tags: ['Pipelines'],
        summary: 'List pipelines for a project',
        description: 'Returns pipelines for a project. Use the `folderId` query param to filter by location: `folderId=null` for project-root pipelines, `folderId=<uuid>` for folder-scoped, or omit for all.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'folderId', in: 'query' as const, required: false, schema: { type: 'string' as const }, description: 'Filter by folder. "null" for root-level, UUID for specific folder, omit for all.' },
        ],
        responses: {
          '200': {
            description: 'List of pipelines',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: {
                      type: 'array' as const,
                      items: { $ref: '#/components/schemas/Pipeline' },
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'Authentication required' },
        },
      },
      post: {
        tags: ['Pipelines'],
        summary: 'Create a new pipeline',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreatePipelineRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Pipeline created',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: { $ref: '#/components/schemas/Pipeline' },
                  },
                },
              },
            },
          },
          '400': { description: 'Validation error' },
          '401': { description: 'Authentication required' },
          '404': { description: 'Project not found' },
          '409': { description: 'Pipeline name already exists in project' },
        },
      },
    },
    '/projects/{projectId}/pipelines/{pipelineId}': {
      get: {
        tags: ['Pipelines'],
        summary: 'Get a pipeline by ID',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'Pipeline details',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: { $ref: '#/components/schemas/Pipeline' },
                  },
                },
              },
            },
          },
          '404': { description: 'Pipeline not found' },
        },
      },
      put: {
        tags: ['Pipelines'],
        summary: 'Update a pipeline',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdatePipelineRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Pipeline updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: { $ref: '#/components/schemas/Pipeline' },
                  },
                },
              },
            },
          },
          '400': { description: 'Validation error' },
          '404': { description: 'Pipeline not found' },
          '409': { description: 'Pipeline name already exists in project' },
        },
      },
      delete: {
        tags: ['Pipelines'],
        summary: 'Delete a pipeline',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '204': { description: 'Pipeline deleted' },
          '404': { description: 'Pipeline not found' },
        },
      },
    },

    /* ── Pipeline Nodes ─────────────────────────────────────────────── */

    '/projects/{projectId}/pipelines/{pipelineId}/nodes': {
      get: {
        tags: ['Pipeline Nodes'],
        summary: 'List all nodes for a pipeline',
        description: 'Returns all nodes belonging to the pipeline with joined dataset metadata (column_count, row_count, name, status). Ordered by creation time ascending.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'List of pipeline nodes',
            headers: { 'X-Total-Count': { schema: { type: 'integer' as const }, description: 'Total number of nodes' } },
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: { type: 'array' as const, items: { $ref: '#/components/schemas/PipelineNode' } },
                  },
                },
              },
            },
          },
          '404': { description: 'Pipeline not found' },
        },
      },
      post: {
        tags: ['Pipeline Nodes'],
        summary: 'Add a single node to a pipeline',
        description: 'Creates a new node in the pipeline. If datasetId is provided, verifies the dataset belongs to the project.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreatePipelineNodeRequest' } } },
        },
        responses: {
          '201': {
            description: 'Node created',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: { $ref: '#/components/schemas/PipelineNode' },
                  },
                },
              },
            },
          },
          '400': { description: 'Validation error' },
          '404': { description: 'Pipeline or dataset not found' },
        },
      },
      delete: {
        tags: ['Pipeline Nodes'],
        summary: 'Delete all nodes for a pipeline',
        description: 'Removes every node from the pipeline graph. Returns the count of deleted nodes.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'All nodes deleted',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: {
                      type: 'object' as const,
                      properties: { deletedCount: { type: 'integer' as const } },
                    },
                  },
                },
              },
            },
          },
          '404': { description: 'Pipeline not found' },
        },
      },
    },
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/bulk': {
      post: {
        tags: ['Pipeline Nodes'],
        summary: 'Bulk-add nodes to a pipeline',
        description: 'Creates 1–50 nodes in a single request. Used by the pipeline builder when the user selects multiple datasets in the Add Data dialog. Validates all dataset references belong to the project before inserting.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/BulkCreatePipelineNodesRequest' } } },
        },
        responses: {
          '201': {
            description: 'All nodes created',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: { type: 'array' as const, items: { $ref: '#/components/schemas/PipelineNode' } },
                  },
                },
              },
            },
          },
          '400': { description: 'Validation error (empty array, invalid fields)' },
          '404': { description: 'Pipeline or one or more datasets not found' },
        },
      },
    },
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}': {
      put: {
        tags: ['Pipeline Nodes'],
        summary: 'Update a pipeline node',
        description: 'Partially updates a node (label, position, type, config). At least one field must be provided.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdatePipelineNodeRequest' } } },
        },
        responses: {
          '200': {
            description: 'Node updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: { $ref: '#/components/schemas/PipelineNode' },
                  },
                },
              },
            },
          },
          '400': { description: 'Validation error' },
          '404': { description: 'Pipeline or node not found' },
        },
      },
      delete: {
        tags: ['Pipeline Nodes'],
        summary: 'Delete a single pipeline node',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '204': { description: 'Node deleted' },
          '404': { description: 'Pipeline or node not found' },
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
    /* ── Transform — Cast ──────────────────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/transforms/cast/preview': {
      post: {
        tags: ['Transforms'],
        summary: 'Preview a Cast transform',
        description:
          'Executes a live SQL CAST against the node\'s backing dataset table and returns preview rows. ' +
          'Follows Palantir Pipeline Builder Cast (castV2) semantics: ' +
          'https://www.palantir.com/docs/foundry/pb-functions-expression/castV2/',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                required: ['expression', 'targetType'],
                properties: {
                  expression: {
                    type: 'string' as const,
                    description: 'Source column name to cast.',
                    example: 'quantity',
                  },
                  targetType: {
                    type: 'string' as const,
                    enum: ['string', 'integer', 'numeric', 'boolean', 'date', 'timestamp'],
                    description: 'The target data type to cast into.',
                    example: 'integer',
                  },
                  outputColumn: {
                    type: 'string' as const,
                    description: 'Destination column name. Defaults to expression column (replace in-place).',
                    example: 'quantity_int',
                  },
                  limit: {
                    type: 'integer' as const,
                    description: 'Maximum rows to return in the preview. Default: 100, max: 5000.',
                    default: 100,
                    minimum: 1,
                    maximum: 5000,
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Cast preview result',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: {
                      type: 'object' as const,
                      properties: {
                        columns: {
                          type: 'array' as const,
                          items: {
                            type: 'object' as const,
                            properties: {
                              name: { type: 'string' as const },
                              type: { type: 'string' as const },
                              isNew: { type: 'boolean' as const },
                            },
                          },
                        },
                        rows: { type: 'array' as const, items: { type: 'object' as const } },
                        rowCount: { type: 'integer' as const },
                        castExpression: { type: 'string' as const, description: 'The SQL expression used.' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid cast (e.g. incompatible types) or missing column' },
          '404': { description: 'Node, pipeline, or dataset not found' },
        },
      },
    },
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/transforms/cast/apply': {
      post: {
        tags: ['Transforms'],
        summary: 'Apply (persist) a Cast transform',
        description:
          'Saves the Cast transform configuration to the pipeline node\'s config.transforms array. ' +
          'Does NOT execute SQL — this is a configuration-only operation. ' +
          'The saved config is used during pipeline builds to materialise the transform.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                required: ['expression', 'targetType'],
                properties: {
                  expression: {
                    type: 'string' as const,
                    description: 'Source column name to cast.',
                    example: 'order_due_date',
                  },
                  targetType: {
                    type: 'string' as const,
                    enum: ['string', 'integer', 'numeric', 'boolean', 'date', 'timestamp'],
                    description: 'The target data type.',
                    example: 'timestamp',
                  },
                  outputColumn: {
                    type: 'string' as const,
                    description: 'Destination column name. Defaults to expression column (replace).',
                    example: 'order_due_date',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Updated pipeline node with the Cast transform in config',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: { $ref: '#/components/schemas/PipelineNode' },
                  },
                },
              },
            },
          },
          '400': { description: 'Validation error' },
          '404': { description: 'Node or pipeline not found' },
        },
      },
    },
    /* ── Transform — Filter ─────────────────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/transforms/filter/preview': {
      post: {
        tags: ['Transforms'],
        summary: 'Preview a Filter transform',
        description:
          'Evaluates filter conditions against the node\'s dataset rows and returns matching/non-matching rows. ' +
          'Supports 9 operators: is_null, is_not_null, eq, neq, starts_with, ends_with, contains, regex_find, regex_match. ' +
          'Conditions can be combined with AND (all) or OR (any) logic. Mode controls keep vs remove.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                required: ['conditions'],
                properties: {
                  mode: {
                    type: 'string' as const,
                    enum: ['keep', 'remove'],
                    default: 'keep',
                    description: '"keep" retains matching rows; "remove" discards them.',
                  },
                  match: {
                    type: 'string' as const,
                    enum: ['all', 'any'],
                    default: 'all',
                    description: '"all" = AND logic; "any" = OR logic across conditions.',
                  },
                  conditions: {
                    type: 'array' as const,
                    minItems: 1,
                    items: {
                      type: 'object' as const,
                      required: ['column', 'operator'],
                      properties: {
                        column: { type: 'string' as const, description: 'Column name to filter on.' },
                        operator: {
                          type: 'string' as const,
                          enum: ['is_null', 'is_not_null', 'eq', 'neq', 'starts_with', 'ends_with', 'contains', 'regex_find', 'regex_match'],
                        },
                        value: { type: 'string' as const, description: 'Comparison value (required for binary operators).' },
                        treatEmptyAsNull: { type: 'boolean' as const, description: 'When true, treat empty string as null (for is_not_null).' },
                      },
                    },
                  },
                  limit: { type: 'integer' as const, default: 500, minimum: 1, maximum: 5000 },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Filter preview result',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: {
                      type: 'object' as const,
                      properties: {
                        columns: { type: 'array' as const, items: { type: 'object' as const, properties: { name: { type: 'string' as const }, type: { type: 'string' as const } } } },
                        rows: { type: 'array' as const, items: { type: 'object' as const } },
                        rowCount: { type: 'integer' as const },
                        totalMatched: { type: 'integer' as const, description: 'Total rows matching (before limit).' },
                        totalRows: { type: 'integer' as const, description: 'Total rows in the dataset.' },
                        filterSummary: { type: 'string' as const },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Validation error (missing column, invalid operator)' },
          '404': { description: 'Node or dataset not found' },
        },
      },
    },
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/transforms/filter/apply': {
      post: {
        tags: ['Transforms'],
        summary: 'Apply (persist) a Filter transform',
        description: 'Saves the Filter transform configuration to the pipeline node. Configuration only — no data is filtered.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                required: ['conditions'],
                properties: {
                  mode: { type: 'string' as const, enum: ['keep', 'remove'], default: 'keep' },
                  match: { type: 'string' as const, enum: ['all', 'any'], default: 'all' },
                  conditions: {
                    type: 'array' as const,
                    minItems: 1,
                    items: {
                      type: 'object' as const,
                      required: ['column', 'operator'],
                      properties: {
                        column: { type: 'string' as const },
                        operator: { type: 'string' as const, enum: ['is_null', 'is_not_null', 'eq', 'neq', 'starts_with', 'ends_with', 'contains', 'regex_find', 'regex_match'] },
                        value: { type: 'string' as const },
                        treatEmptyAsNull: { type: 'boolean' as const },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Updated pipeline node with the Filter transform in config',
            content: { 'application/json': { schema: { type: 'object' as const, properties: { success: { type: 'boolean' as const }, data: { $ref: '#/components/schemas/PipelineNode' } } } } },
          },
          '400': { description: 'Validation error' },
          '404': { description: 'Node or pipeline not found' },
        },
      },
    },
    /* ── Transform — Drop Columns ──────────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/transforms/drop/preview': {
      post: {
        tags: ['Transforms'],
        summary: 'Preview a Drop Columns transform',
        description: 'Removes specified columns from the dataset rows. Supports chaining with prior transforms via priorTransforms.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                required: ['columns'],
                properties: {
                  columns: { type: 'array' as const, items: { type: 'string' as const }, minItems: 1, description: 'Column names to drop.' },
                  limit: { type: 'integer' as const, default: 500, minimum: 1, maximum: 5000 },
                  priorTransforms: { type: 'array' as const, items: { type: 'object' as const }, description: 'Prior transforms in the chain.' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Drop columns preview result',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  properties: {
                    success: { type: 'boolean' as const },
                    data: {
                      type: 'object' as const,
                      properties: {
                        columns: { type: 'array' as const, items: { type: 'object' as const, properties: { name: { type: 'string' as const }, type: { type: 'string' as const } } } },
                        rows: { type: 'array' as const, items: { type: 'object' as const } },
                        rowCount: { type: 'integer' as const },
                        totalRows: { type: 'integer' as const },
                        droppedColumns: { type: 'array' as const, items: { type: 'string' as const } },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Validation error (column not found)' },
          '404': { description: 'Node or dataset not found' },
        },
      },
    },
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/transforms/drop/apply': {
      post: {
        tags: ['Transforms'],
        summary: 'Apply (persist) a Drop Columns transform',
        description: 'Saves the Drop Columns transform configuration to the pipeline node. Configuration only.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                required: ['columns'],
                properties: {
                  columns: { type: 'array' as const, items: { type: 'string' as const }, minItems: 1, description: 'Column names to drop.' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated pipeline node', content: { 'application/json': { schema: { type: 'object' as const, properties: { success: { type: 'boolean' as const }, data: { $ref: '#/components/schemas/PipelineNode' } } } } } },
          '400': { description: 'Validation error' },
          '404': { description: 'Node not found' },
        },
      },
    },
    /* ── Join ──────────────────────────────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/join/preview': {
      post: {
        tags: ['Join'],
        summary: 'Preview a Join transform',
        description: 'Joins two datasets (left from node source, right from rightNodeId). Supports left, right, inner, full_outer, and cross join types. Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/joinV2/',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, required: ['rightNodeId', 'joinType'], properties: {
          rightNodeId: { type: 'string' as const, format: 'uuid', description: 'UUID of the right-side node.' },
          joinType: { type: 'string' as const, enum: ['left', 'right', 'inner', 'full_outer', 'cross'] },
          conditions: { type: 'array' as const, items: { type: 'object' as const, required: ['leftColumn', 'rightColumn'], properties: { leftColumn: { type: 'string' as const }, rightColumn: { type: 'string' as const } } }, description: 'Join conditions (column equality). Required for non-cross joins.' },
          rightPrefix: { type: 'string' as const, default: 'right_', description: 'Prefix for right-side columns when names collide with left-side columns.' },
          limit: { type: 'integer' as const, default: 500 },
          priorTransforms: { type: 'array' as const, items: { type: 'object' as const } },
          leftSelectedColumns: { type: 'array' as const, items: { type: 'string' as const }, description: 'Only include these left columns in the output. If omitted, all left columns are included.' },
          rightSelectedColumns: { type: 'array' as const, items: { type: 'string' as const }, description: 'Only include these right columns in the output. If omitted, all right columns are included.' },
        } } } } },
        responses: {
          '200': { description: 'Join preview', content: { 'application/json': { schema: { type: 'object' as const, properties: { success: { type: 'boolean' as const }, data: { type: 'object' as const, properties: {
            columns: { type: 'array' as const, items: { type: 'object' as const, properties: { name: { type: 'string' as const }, type: { type: 'string' as const }, source: { type: 'string' as const, enum: ['left', 'right'] } } } },
            rows: { type: 'array' as const, items: { type: 'object' as const } },
            rowCount: { type: 'integer' as const }, totalJoined: { type: 'integer' as const },
            leftRowCount: { type: 'integer' as const }, rightRowCount: { type: 'integer' as const },
            joinType: { type: 'string' as const },
          }} } } } } },
          '400': { description: 'Validation error' }, '404': { description: 'Node not found' },
        },
      },
    },
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/join/apply': {
      post: {
        tags: ['Join'],
        summary: 'Apply (persist) a Join transform',
        description: 'Saves the Join configuration to the pipeline node.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, required: ['rightNodeId', 'joinType'], properties: {
          rightNodeId: { type: 'string' as const, format: 'uuid' },
          joinType: { type: 'string' as const, enum: ['left', 'right', 'inner', 'full_outer', 'cross'] },
          conditions: { type: 'array' as const, items: { type: 'object' as const, properties: { leftColumn: { type: 'string' as const }, rightColumn: { type: 'string' as const } } } },
        } } } } },
        responses: {
          '200': { description: 'Updated node', content: { 'application/json': { schema: { type: 'object' as const, properties: { success: { type: 'boolean' as const }, data: { $ref: '#/components/schemas/PipelineNode' } } } } } },
          '400': { description: 'Validation error' }, '404': { description: 'Node not found' },
        },
      },
    },
    /* ── Union by name ─────────────────────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/union/preview': {
      post: {
        tags: ['Union'],
        summary: 'Preview a Union by name transform',
        description: 'Unions two datasets by matching column names (Palantir unionByNameV1). Columns present in both inputs are merged. Columns unique to one side get null in rows from the other. Returns warnings for type mismatches and side-only columns.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' }, description: 'The union node ID (left input resolved from sourceNodeId)' },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, required: ['rightNodeId'], properties: {
          rightNodeId: { type: 'string' as const, format: 'uuid', description: 'UUID of the second input node' },
          limit: { type: 'integer' as const, default: 500, description: 'Max rows to return (1-5000)' },
          priorTransforms: { type: 'array' as const, items: { type: 'object' as const }, description: 'Optional prior transforms to replay on left input' },
        } } } } },
        responses: {
          '200': { description: 'Unioned preview data', content: { 'application/json': { schema: { type: 'object' as const, properties: {
            success: { type: 'boolean' as const },
            data: { type: 'object' as const, properties: {
              columns: { type: 'array' as const, items: { type: 'object' as const, properties: { name: { type: 'string' as const }, type: { type: 'string' as const }, source: { type: 'string' as const, enum: ['both', 'left', 'right'] } } } },
              rows: { type: 'array' as const, items: { type: 'object' as const } },
              rowCount: { type: 'integer' as const },
              totalUnioned: { type: 'integer' as const, description: 'Total rows before limit' },
              leftRowCount: { type: 'integer' as const },
              rightRowCount: { type: 'integer' as const },
              warnings: { type: 'array' as const, items: { type: 'object' as const, properties: { code: { type: 'string' as const }, message: { type: 'string' as const } } } },
            } },
          } } } } },
          '400': { description: 'Validation error or empty inputs' }, '404': { description: 'Node not found' },
        },
      },
    },
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/union/apply': {
      post: {
        tags: ['Union'],
        summary: 'Apply (persist) a Union by name transform',
        description: 'Saves the union configuration (rightNodeId) to the pipeline node.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, required: ['rightNodeId'], properties: {
          rightNodeId: { type: 'string' as const, format: 'uuid', description: 'UUID of the second input node' },
        } } } } },
        responses: {
          '200': { description: 'Updated node', content: { 'application/json': { schema: { type: 'object' as const, properties: { success: { type: 'boolean' as const }, data: { $ref: '#/components/schemas/PipelineNode' } } } } } },
          '400': { description: 'Validation error' }, '404': { description: 'Node not found' },
        },
      },
    },
    /* ── Transform — Rename Columns ─────────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/transforms/rename/preview': {
      post: {
        tags: ['Transforms'],
        summary: 'Preview a Rename Columns transform',
        description: 'Renames specified columns in the dataset. Supports chaining with prior transforms.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                required: ['renames'],
                properties: {
                  renames: {
                    type: 'array' as const, minItems: 1,
                    items: {
                      type: 'object' as const, required: ['from', 'to'],
                      properties: {
                        from: { type: 'string' as const, description: 'Current column name.' },
                        to: { type: 'string' as const, description: 'New column name.' },
                      },
                    },
                  },
                  limit: { type: 'integer' as const, default: 500, minimum: 1, maximum: 5000 },
                  priorTransforms: { type: 'array' as const, items: { type: 'object' as const } },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Rename columns preview',
            content: { 'application/json': { schema: { type: 'object' as const, properties: {
              success: { type: 'boolean' as const },
              data: { type: 'object' as const, properties: {
                columns: { type: 'array' as const, items: { type: 'object' as const, properties: { name: { type: 'string' as const }, type: { type: 'string' as const }, renamed: { type: 'boolean' as const }, originalName: { type: 'string' as const } } } },
                rows: { type: 'array' as const, items: { type: 'object' as const } },
                rowCount: { type: 'integer' as const },
                totalRows: { type: 'integer' as const },
                renames: { type: 'array' as const, items: { type: 'object' as const, properties: { from: { type: 'string' as const }, to: { type: 'string' as const } } } },
              }},
            }} } },
          },
          '400': { description: 'Validation error' },
          '404': { description: 'Node or dataset not found' },
        },
      },
    },
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/transforms/rename/apply': {
      post: {
        tags: ['Transforms'],
        summary: 'Apply (persist) a Rename Columns transform',
        description: 'Saves the Rename Columns configuration to the pipeline node.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' as const, required: ['renames'], properties: {
            renames: { type: 'array' as const, minItems: 1, items: { type: 'object' as const, required: ['from', 'to'], properties: { from: { type: 'string' as const }, to: { type: 'string' as const } } } },
          } } } },
        },
        responses: {
          '200': { description: 'Updated node', content: { 'application/json': { schema: { type: 'object' as const, properties: { success: { type: 'boolean' as const }, data: { $ref: '#/components/schemas/PipelineNode' } } } } } },
          '400': { description: 'Validation error' },
          '404': { description: 'Node not found' },
        },
      },
    },
    /* ── Transform — Normalize Column Names ────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/transforms/normalize/preview': {
      post: {
        tags: ['Transforms'],
        summary: 'Preview a Normalize Column Names transform',
        description: 'Normalizes all column names to lower_snake_case. Optionally removes special characters. Handles duplicate names by appending _1, _2, etc. Reference: https://www.palantir.com/docs/foundry/pb-functions-transform/normalizeColumnNamesV1',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, properties: {
          removeSpecialCharacters: { type: 'boolean' as const, default: false, description: 'When true, strip all non-alphanumeric characters except underscores.' },
          limit: { type: 'integer' as const, default: 500 },
          priorTransforms: { type: 'array' as const, items: { type: 'object' as const } },
        } } } } },
        responses: {
          '200': { description: 'Normalize preview', content: { 'application/json': { schema: { type: 'object' as const, properties: {
            success: { type: 'boolean' as const },
            data: { type: 'object' as const, properties: {
              columns: { type: 'array' as const, items: { type: 'object' as const, properties: { name: { type: 'string' as const }, type: { type: 'string' as const }, normalized: { type: 'boolean' as const }, originalName: { type: 'string' as const } } } },
              rows: { type: 'array' as const, items: { type: 'object' as const } },
              rowCount: { type: 'integer' as const }, totalRows: { type: 'integer' as const },
              removeSpecialCharacters: { type: 'boolean' as const },
            }},
          }} } } },
          '404': { description: 'Node or dataset not found' },
        },
      },
    },
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/transforms/normalize/apply': {
      post: {
        tags: ['Transforms'],
        summary: 'Apply (persist) a Normalize Column Names transform',
        description: 'Saves the Normalize configuration to the pipeline node.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, properties: {
          removeSpecialCharacters: { type: 'boolean' as const, default: false },
        } } } } },
        responses: {
          '200': { description: 'Updated node', content: { 'application/json': { schema: { type: 'object' as const, properties: { success: { type: 'boolean' as const }, data: { $ref: '#/components/schemas/PipelineNode' } } } } } },
          '404': { description: 'Node not found' },
        },
      },
    },
    /* ── Execute Full Transform Chain ─────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/transforms/execute': {
      post: {
        tags: ['Transforms'],
        summary: 'Execute the full transform chain',
        description: 'Runs ALL saved transforms on the entire source dataset. Called when user clicks "Apply All". Returns the complete transformed dataset (all rows, columns after all transforms). The result should be saved as a preview snapshot.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Full chain execution result', content: { 'application/json': { schema: { type: 'object' as const, properties: {
            success: { type: 'boolean' as const },
            data: { type: 'object' as const, properties: {
              columns: { type: 'array' as const, items: { type: 'object' as const, properties: { name: { type: 'string' as const }, type: { type: 'string' as const } } } },
              rows: { type: 'array' as const, items: { type: 'object' as const } },
              rowCount: { type: 'integer' as const },
              transformCount: { type: 'integer' as const },
            }},
          }} } } },
          '404': { description: 'Node or dataset not found' },
        },
      },
    },
    /* ── Deploy Pipeline ─────────────────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/deploy': {
      post: {
        tags: ['Deployment'],
        summary: 'Deploy pipeline (async)',
        description: 'Starts an async deployment: creates a deployment record (status: "running") and returns immediately with the deployment ID. Builds execute in the background. Poll GET /deployments/:deploymentId every 2s to check progress. When all builds complete, the deployment record is updated to "succeeded" or "failed".',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'pipelineId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  outputNodeIds: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'Which output nodes to build. Omit to build all.' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Deployment started — poll GET /deployments/:deploymentId for progress',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: {
                      type: 'object',
                      properties: {
                        deploymentId: { type: 'string', format: 'uuid', description: 'Use this ID to poll for status' },
                        status: { type: 'string', enum: ['running'], description: 'Always "running" on initial response' },
                        startedAt: { type: 'string', format: 'date-time' },
                        outputCount: { type: 'integer', description: 'Number of output nodes being built' },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: 'No output nodes to build' },
          404: { description: 'Pipeline not found' },
        },
      },
    },
    '/projects/{projectId}/pipelines/{pipelineId}/deployments': {
      get: {
        tags: ['Deployment'],
        summary: 'List pipeline deployments',
        description: 'Returns the most recent 50 deployments for a pipeline, ordered by start time descending.',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'pipelineId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'List of deployments' },
        },
      },
    },
    '/projects/{projectId}/pipelines/{pipelineId}/deployments/{deploymentId}': {
      get: {
        tags: ['Deployment'],
        summary: 'Get deployment status (poll endpoint)',
        description: 'Returns the current state of a deployment. Use this endpoint to poll for progress after starting a deployment via POST /deploy. Poll every 2 seconds until status changes from "running" to "succeeded" or "failed". The build_results array is updated incrementally as each output node completes.',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'pipelineId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'deploymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'Deployment state',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        pipeline_id: { type: 'string', format: 'uuid' },
                        project_id: { type: 'string', format: 'uuid' },
                        status: { type: 'string', enum: ['running', 'succeeded', 'failed', 'cancelled'] },
                        triggered_by: { type: 'string', format: 'uuid', nullable: true },
                        started_at: { type: 'string', format: 'date-time' },
                        finished_at: { type: 'string', format: 'date-time', nullable: true },
                        duration_ms: { type: 'integer', nullable: true },
                        error_message: { type: 'string', nullable: true },
                        build_results: {
                          type: 'array',
                          description: 'Updated incrementally as each output builds. Empty while first output is still building.',
                          items: {
                            type: 'object',
                            properties: {
                              nodeId: { type: 'string', format: 'uuid' },
                              nodeLabel: { type: 'string' },
                              datasetId: { type: 'string', format: 'uuid' },
                              datasetName: { type: 'string' },
                              filePath: { type: 'string', description: 'S3 key of the output CSV' },
                              rowCount: { type: 'integer' },
                              columnCount: { type: 'integer' },
                              status: { type: 'string', enum: ['succeeded', 'failed'] },
                              error: { type: 'string' },
                              durationMs: { type: 'integer' },
                            },
                          },
                        },
                        config: {
                          type: 'object',
                          description: 'Deployment configuration (selected outputs)',
                          properties: {
                            selectedOutputs: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  id: { type: 'string' },
                                  label: { type: 'string' },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          404: { description: 'Deployment not found' },
        },
      },
    },
    /* ── Save Pipeline Progress ──────────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/save': {
      post: {
        tags: ['Pipeline'],
        summary: 'Save pipeline progress',
        description: 'Atomic full-state save of the pipeline. Persists all node positions, canvas viewport (zoom/pan), and optional pipeline metadata (name, description, status) in a single database transaction. If any write fails, the entire save is rolled back. This is the primary "Save" action in the Pipeline Builder UI.',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'pipelineId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  positions: {
                    type: 'array',
                    description: 'Node positions — every node currently on the canvas',
                    items: {
                      type: 'object',
                      required: ['nodeId', 'positionX', 'positionY'],
                      properties: {
                        nodeId: { type: 'string', format: 'uuid' },
                        positionX: { type: 'number' },
                        positionY: { type: 'number' },
                      },
                    },
                  },
                  viewport: {
                    type: 'object',
                    description: 'Canvas viewport (zoom + pan)',
                    properties: {
                      x: { type: 'number' },
                      y: { type: 'number' },
                      zoom: { type: 'number', minimum: 0.01, maximum: 10 },
                    },
                    required: ['x', 'y', 'zoom'],
                  },
                  name: { type: 'string', description: 'Pipeline name', maxLength: 255 },
                  description: { type: 'string', description: 'Pipeline description', maxLength: 5000 },
                  status: { type: 'string', enum: ['draft', 'active', 'paused', 'failed', 'archived'] },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Pipeline progress saved successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: {
                      type: 'object',
                      properties: {
                        updatedNodes: { type: 'integer', description: 'Number of node positions updated' },
                        savedAt: { type: 'string', format: 'date-time', description: 'ISO timestamp of the save' },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: 'Validation error' },
          404: { description: 'Pipeline not found' },
        },
      },
    },
    /* ── Output Preview ────────────────────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/output/preview': {
      post: {
        tags: ['Output'],
        summary: 'Preview output node data',
        description: 'Resolves the fully-transformed data from the upstream chain for an output node. Walks the sourceNodeId chain, collects all transforms, reads the source CSV, applies transforms, and returns the result. For join/union upstream nodes, returns their previewSnapshot if available.',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'pipelineId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'nodeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  limit: { type: 'integer', description: 'Max rows to return (default 500)', example: 500 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Resolved output data',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        columns: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' } } } },
                        rows: { type: 'array', items: { type: 'object' } },
                        totalRows: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    /* ── Preview Snapshot ──────────────────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/{nodeId}/preview-snapshot': {
      post: {
        tags: ['Transforms'],
        summary: 'Save a transform preview snapshot',
        description: 'Saves the final transform preview result (columns + rows) to the node. Called when user clicks "Apply All". The snapshot can be retrieved later when the transform node is selected on the canvas.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, required: ['columns', 'rows', 'rowCount'], properties: {
          columns: { type: 'array' as const, items: { type: 'object' as const, properties: { name: { type: 'string' as const }, type: { type: 'string' as const } } } },
          rows: { type: 'array' as const, items: { type: 'object' as const } },
          rowCount: { type: 'integer' as const },
          transforms: { type: 'array' as const, items: { type: 'object' as const }, description: 'The transform chain that produced this snapshot.' },
        } } } } },
        responses: {
          '200': { description: 'Snapshot saved', content: { 'application/json': { schema: { type: 'object' as const, properties: { success: { type: 'boolean' as const }, data: { $ref: '#/components/schemas/PipelineNode' } } } } } },
          '404': { description: 'Node not found' },
        },
      },
      get: {
        tags: ['Transforms'],
        summary: 'Get saved transform preview snapshot',
        description: 'Retrieves the previously saved transform preview snapshot from the node. Returns null if no snapshot exists.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'nodeId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Snapshot data or null', content: { 'application/json': { schema: { type: 'object' as const, properties: {
            success: { type: 'boolean' as const },
            data: { type: 'object' as const, nullable: true, properties: {
              columns: { type: 'array' as const, items: { type: 'object' as const } },
              rows: { type: 'array' as const, items: { type: 'object' as const } },
              rowCount: { type: 'integer' as const },
              savedAt: { type: 'string' as const, format: 'date-time' },
            }},
          }} } } },
          '404': { description: 'Node not found' },
        },
      },
    },
    /* ── Canvas Viewport ─────────────────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/viewport': {
      put: {
        tags: ['Pipelines'],
        summary: 'Save canvas viewport',
        description: 'Persists the canvas zoom level and pan position. Auto-saved when user pans or zooms.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, required: ['x', 'y', 'zoom'], properties: {
          x: { type: 'number' as const, description: 'Pan X offset' },
          y: { type: 'number' as const, description: 'Pan Y offset' },
          zoom: { type: 'number' as const, description: 'Zoom level (1 = 100%)' },
        } } } } },
        responses: { '200': { description: 'Viewport saved' }, '404': { description: 'Pipeline not found' } },
      },
      get: {
        tags: ['Pipelines'],
        summary: 'Get saved canvas viewport',
        description: 'Returns the saved viewport (x, y, zoom) or null if never saved.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: { '200': { description: 'Viewport data or null', content: { 'application/json': { schema: { type: 'object' as const, properties: { success: { type: 'boolean' as const }, data: { type: 'object' as const, nullable: true, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, zoom: { type: 'number' as const } } } } } } } }, '404': { description: 'Pipeline not found' } },
      },
    },
    /* ── Batch Position Update ────────────────────────────────────── */
    '/projects/{projectId}/pipelines/{pipelineId}/nodes/positions': {
      patch: {
        tags: ['Pipeline Nodes'],
        summary: 'Batch update node positions',
        description: 'Persists node positions after drag on the canvas. Accepts an array of {nodeId, positionX, positionY} and updates all in a single transaction. Called automatically when the user stops dragging nodes.',
        parameters: [
          { name: 'projectId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'pipelineId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, required: ['positions'], properties: {
          positions: { type: 'array' as const, minItems: 1, items: { type: 'object' as const, required: ['nodeId', 'positionX', 'positionY'], properties: {
            nodeId: { type: 'string' as const, format: 'uuid' },
            positionX: { type: 'number' as const },
            positionY: { type: 'number' as const },
          } } },
        } } } } },
        responses: {
          '200': { description: 'Positions updated', content: { 'application/json': { schema: { type: 'object' as const, properties: { success: { type: 'boolean' as const }, data: { type: 'object' as const, properties: { updatedCount: { type: 'integer' as const } } } } } } } },
          '400': { description: 'Validation error' },
          '404': { description: 'Pipeline not found' },
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

// Merge Ontology paths/schemas into the spec exported to consumers.
export const openApiSpec = {
  ...baseSpec,
  info: {
    ...baseSpec.info,
    title: 'Tellus Backend API',
    description:
      'Combined Foundry data ingestion + Ontology Manager / Object Explorer API.',
  },
  components: {
    ...baseSpec.components,
    schemas: {
      ...baseSpec.components.schemas,
      ...ontologySchemas,
    },
  },
  paths: {
    ...baseSpec.paths,
    ...ontologyPaths,
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
