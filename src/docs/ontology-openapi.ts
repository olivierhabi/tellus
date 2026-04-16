/**
 * OpenAPI fragments documenting every Ontology Manager / Object Explorer
 * endpoint consumed by the tellus-fe frontend.
 *
 * Spread into the master spec in `openapi.ts`:
 *
 *     paths: { ...originalPaths, ...ontologyPaths }
 *     schemas: { ...originalSchemas, ...ontologySchemas }
 *
 * This file is intentionally hand-written rather than reflection-generated
 * so we can describe behavior the route handlers don't expose statically
 * (e.g. cardinality enums, status transitions, idempotency).
 */

const STR = { type: 'string' as const };
const INT = { type: 'integer' as const };
const BOOL = { type: 'boolean' as const };
const OBJ = { type: 'object' as const };
const REF_ERR = { $ref: '#/components/schemas/Error' };

export const ontologySchemas = {
  Ontology: {
    type: 'object' as const,
    properties: {
      ontologyId: STR,
      displayName: STR,
      description: { type: 'string' as const, nullable: true },
      createdAt: STR,
      updatedAt: STR,
      createdBy: STR,
      objectTypeCount: INT,
    },
    required: ['ontologyId', 'displayName', 'createdAt', 'updatedAt', 'createdBy'],
  },

  ObjectTypeStatus: {
    type: 'string' as const,
    enum: ['active', 'experimental', 'endorsed', 'deprecated'],
  },

  ObjectTypeListItem: {
    type: 'object' as const,
    properties: {
      apiName: STR,
      displayName: STR,
      status: { $ref: '#/components/schemas/ObjectTypeStatus' },
      propertyCount: INT,
      datasourceName: { type: 'string' as const, nullable: true },
      indexStatus: STR,
      icon: { type: 'string' as const, nullable: true },
      iconColor: { type: 'string' as const, nullable: true },
      createdAt: STR,
      updatedAt: STR,
    },
    required: ['apiName', 'displayName', 'status', 'propertyCount', 'indexStatus'],
  },

  PropertyDefinition: {
    type: 'object' as const,
    properties: {
      apiName: STR,
      displayName: STR,
      description: { type: 'string' as const, nullable: true },
      baseType: {
        type: 'string' as const,
        enum: [
          'string', 'integer', 'long', 'double', 'float', 'boolean',
          'date', 'timestamp', 'geopoint', 'geoshape', 'vector',
          'attachment', 'timeseries', 'mediaReference', 'struct',
        ],
      },
      isRequired: BOOL,
      isPrimaryKey: BOOL,
      isTitle: BOOL,
      visibility: { type: 'string' as const, enum: ['prominent', 'normal', 'hidden'] },
      columnName: { type: 'string' as const, nullable: true },
    },
    required: ['apiName', 'displayName', 'baseType'],
  },

  ObjectTypeVisibility: {
    type: 'string' as const,
    enum: ['prominent', 'normal', 'hidden'],
  },

  BackingDatasource: {
    type: 'object' as const,
    description:
      'Backing datasource record as returned by `formatDatasource` on ' +
      'the backend. `datasetId` is derived: set directly when the row ' +
      'was bound via the legacy Ontology-dataset path, or parsed from ' +
      'the `#foundry-dataset:<uuid>` tag embedded in `filePath` when ' +
      'bound via the foundry-dataset bridge.',
    nullable: true,
    properties: {
      datasourceId: { type: 'string' as const, nullable: true },
      name: { type: 'string' as const, nullable: true },
      datasetId: { type: 'string' as const, nullable: true },
      datasetName: { type: 'string' as const, nullable: true },
      filePath: STR,
      fileFormat: { type: 'string' as const, enum: ['csv', 'json', 'parquet'] },
      columnMapping: {
        type: 'object' as const,
        additionalProperties: STR,
        description: 'propertyApiName → dataset column name mapping',
      },
      primaryKeyColumn: STR,
      rowCount: { type: 'integer' as const, nullable: true },
      columnNames: {
        type: 'array' as const,
        nullable: true,
        items: STR,
      },
      schemaHash: { type: 'string' as const, nullable: true },
      lastScannedAt: { type: 'string' as const, nullable: true },
      registeredAt: STR,
    },
  },

  ObjectType: {
    type: 'object' as const,
    properties: {
      objectTypeId: STR,
      /**
       * Backend-derived kebab-case slug of apiName surfaced on the
       * overview card; always a pure projection, never persisted.
       */
      displayId: { type: 'string' as const, nullable: true },
      /**
       * Deterministic Palantir-style RID:
       * `ri.ontology.<ontologyId>.object-type.<objectTypeId>`. Derived
       * at response time — not stored in the database.
       */
      rid: { type: 'string' as const, nullable: true },
      apiName: STR,
      /**
       * Set when the wizard's `onConflict: "rename"` path fired — the
       * ORIGINAL apiName the caller requested, stored so the overview
       * card can surface a red "Invalid" badge until a rename resolves
       * the collision. Cleared by any subsequent PUT that changes
       * `apiName`.
       */
      requestedApiName: { type: 'string' as const, nullable: true },
      displayName: STR,
      pluralName: { type: 'string' as const, nullable: true },
      description: { type: 'string' as const, nullable: true },
      aliases: {
        type: 'array' as const,
        items: STR,
        description: 'Alternative names the object type answers to',
      },
      pointOfContact: { type: 'string' as const, nullable: true },
      contributors: { type: 'array' as const, items: STR },
      visibility: { $ref: '#/components/schemas/ObjectTypeVisibility' },
      icon: STR,
      iconColor: STR,
      status: { $ref: '#/components/schemas/ObjectTypeStatus' },
      editsViaActionsOnly: BOOL,
      maxProperties: INT,
      primaryKey: { type: 'string' as const, nullable: true },
      titleProperty: { type: 'string' as const, nullable: true },
      properties: {
        type: 'object' as const,
        additionalProperties: { $ref: '#/components/schemas/PropertyDefinition' },
      },
      backingDatasource: { $ref: '#/components/schemas/BackingDatasource' },
      indexingState: {
        type: 'object' as const,
        nullable: true,
        properties: {
          status: STR,
          objectsIndexed: INT,
          objectsFailed: INT,
          editsPending: INT,
          lastIndexedAt: { type: 'string' as const, nullable: true },
          lastIndexDurationMs: { type: 'integer' as const, nullable: true },
          errorMessage: { type: 'string' as const, nullable: true },
          indexName: { type: 'string' as const, nullable: true },
        },
      },
      linkTypes: {
        type: 'array' as const,
        items: { $ref: '#/components/schemas/LinkType' },
      },
      createdAt: STR,
      updatedAt: STR,
    },
    required: ['objectTypeId', 'apiName', 'displayName', 'status'],
  },

  /**
   * Request body for `POST /v1/ontologies/:id/objectTypes/batch`.
   * Atomically creates the object type, every property, and sets
   * the primary key + title property in a single transaction.
   */
  CreateObjectTypeBatchBody: {
    type: 'object' as const,
    required: ['apiName', 'displayName', 'properties', 'primaryKeyProperty'],
    properties: {
      apiName: STR,
      displayName: STR,
      description: { type: 'string' as const, nullable: true },
      icon: STR,
      iconColor: STR,
      status: { $ref: '#/components/schemas/ObjectTypeStatus' },
      onConflict: {
        type: 'string' as const,
        enum: ['fail', 'rename'],
        default: 'fail',
        description:
          "What to do when the requested apiName already exists in the " +
          "ontology. `fail` returns 409 OBJECT_TYPE_ALREADY_EXISTS. " +
          "`rename` suffixes the name with `_2`, `_3`, … until free and " +
          "stores the original in `requestedApiName` — lets wizards " +
          "persist the user's 4-step work instead of losing it on a " +
          "collision.",
      },
      properties: {
        type: 'array' as const,
        minItems: 1,
        items: {
          type: 'object' as const,
          required: ['apiName', 'displayName', 'baseType'],
          properties: {
            apiName: STR,
            displayName: STR,
            baseType: STR,
            description: { type: 'string' as const, nullable: true },
            isRequired: BOOL,
            ordinal: INT,
          },
        },
      },
      primaryKeyProperty: {
        type: 'string' as const,
        description: 'Must match one of the `properties[].apiName` values',
      },
      titleProperty: { type: 'string' as const, nullable: true },
    },
  },

  /**
   * Request body for `PUT /v1/ontologies/:id/objectTypes/:apiName`.
   * Every field is optional — send only what you want to change.
   * When `apiName` is present, the backend ALSO clears any lingering
   * `requestedApiName` conflict marker in the same UPDATE.
   */
  UpdateObjectTypeBody: {
    type: 'object' as const,
    properties: {
      apiName: { type: 'string' as const, description: 'Rename the object type (triggers DUPLICATE_API_NAME on collision)' },
      displayName: STR,
      pluralName: { type: 'string' as const, nullable: true },
      description: { type: 'string' as const, nullable: true },
      aliases: { type: 'array' as const, items: STR },
      pointOfContact: { type: 'string' as const, nullable: true },
      contributors: { type: 'array' as const, items: STR },
      visibility: { $ref: '#/components/schemas/ObjectTypeVisibility' },
      editsViaActionsOnly: BOOL,
      icon: STR,
      iconColor: STR,
      status: { $ref: '#/components/schemas/ObjectTypeStatus' },
    },
  },

  /**
   * Request body for `POST /v1/ontologies/:id/objectTypes/:apiName/datasource`.
   * Three mutually-exclusive binding modes, in priority order: foundry
   * bridge, legacy ontology-dataset, and raw filesystem.
   */
  RegisterBackingDatasourceBody: {
    type: 'object' as const,
    required: ['columnMapping', 'primaryKeyColumn'],
    properties: {
      foundryDatasetId: {
        type: 'string' as const,
        description:
          'UUID in `foundry_datasets` (the table the upload pipeline ' +
          'writes to). Bridged directly into `backing_datasource` via ' +
          '`registerWithFoundryDataset` without any filesystem round-trip.',
      },
      datasetId: {
        type: 'string' as const,
        description:
          "UUID in the Ontology `dataset` table. Legacy path — requires " +
          "a committed `dataset_transaction` pointing to a file on disk.",
      },
      filePath: {
        type: 'string' as const,
        description: 'Legacy filesystem path, relative to DATA_DIR',
      },
      datasetName: { type: 'string' as const },
      fileFormat: { type: 'string' as const, enum: ['csv', 'json', 'jsonl', 'tsv'] },
      columnMapping: {
        type: 'object' as const,
        additionalProperties: STR,
        description: 'propertyApiName → dataset column name. Every property on the object type should appear here.',
      },
      primaryKeyColumn: {
        type: 'string' as const,
        description: 'Dataset column name (NOT propertyApiName) that holds the primary key',
      },
    },
  },

  LinkCardinality: {
    type: 'string' as const,
    enum: ['ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_ONE', 'MANY_TO_MANY'],
  },

  LinkType: {
    type: 'object' as const,
    properties: {
      linkTypeId: STR,
      apiName: STR,
      displayName: STR,
      description: { type: 'string' as const, nullable: true },
      cardinality: { $ref: '#/components/schemas/LinkCardinality' },
      sourceObjectType: STR,
      targetObjectType: STR,
      sourcePropertyId: { type: 'string' as const, nullable: true },
      targetPropertyId: { type: 'string' as const, nullable: true },
      isBidirectional: BOOL,
      createdAt: STR,
      updatedAt: STR,
    },
    required: ['linkTypeId', 'apiName', 'displayName', 'cardinality', 'sourceObjectType', 'targetObjectType'],
  },

  ActionTypeParameter: {
    type: 'object' as const,
    properties: {
      apiName: STR,
      displayName: STR,
      type: STR,
      required: BOOL,
    },
    required: ['apiName', 'displayName', 'type'],
  },

  ActionTypeRule: {
    type: 'object' as const,
    properties: {
      type: { type: 'string' as const, enum: ['createObject', 'modifyObject', 'deleteObject', 'addLink', 'removeLink'] },
      objectType: STR,
    },
    required: ['type'],
  },

  ActionType: {
    type: 'object' as const,
    properties: {
      actionTypeId: STR,
      apiName: STR,
      displayName: STR,
      description: { type: 'string' as const, nullable: true },
      parameters: { type: 'array' as const, items: { $ref: '#/components/schemas/ActionTypeParameter' } },
      rules: { type: 'array' as const, items: { $ref: '#/components/schemas/ActionTypeRule' } },
      maxAffectedObjects: INT,
      isEnabled: BOOL,
      createdAt: STR,
      updatedAt: STR,
    },
    required: ['actionTypeId', 'apiName', 'displayName', 'parameters', 'rules'],
  },

  ListEnvelope: {
    type: 'object' as const,
    properties: {
      data: { type: 'array' as const, items: OBJ },
      totalCount: INT,
      pageSize: INT,
      nextPageToken: { type: 'string' as const, nullable: true },
    },
    required: ['data', 'totalCount'],
  },
};

/* ------------------------------------------------------------------ */
/*  Reusable response objects                                         */
/* ------------------------------------------------------------------ */

const ok = (description: string, schema: any) => ({
  description,
  content: { 'application/json': { schema } },
});

const errorResponses = {
  '400': { description: 'Validation error', content: { 'application/json': { schema: REF_ERR } } },
  '404': { description: 'Not found', content: { 'application/json': { schema: REF_ERR } } },
};

/* ------------------------------------------------------------------ */
/*  Path definitions                                                   */
/* ------------------------------------------------------------------ */

const ontologyIdParam = {
  name: 'ontologyId',
  in: 'path' as const,
  required: true,
  schema: STR,
  description: 'RID of the ontology',
};

const apiNameParam = {
  name: 'apiName',
  in: 'path' as const,
  required: true,
  schema: STR,
  description: 'camelCase API name',
};

export const ontologyPaths = {
  /* ----------------------------- Ontologies ---------------------------- */

  '/v1/ontologies': {
    get: {
      tags: ['Ontology Manager'],
      summary: 'List all ontologies',
      responses: {
        '200': ok('Paginated list', { $ref: '#/components/schemas/ListEnvelope' }),
      },
    },
    post: {
      tags: ['Ontology Manager'],
      summary: 'Create an ontology',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { displayName: STR, description: STR }, required: ['displayName'] } } },
      },
      responses: {
        '201': ok('Created', { $ref: '#/components/schemas/Ontology' }),
        ...errorResponses,
      },
    },
  },

  '/v1/ontologies/{ontologyId}': {
    get: {
      tags: ['Ontology Manager'],
      summary: 'Get a single ontology',
      parameters: [ontologyIdParam],
      responses: {
        '200': ok('Ontology detail', { $ref: '#/components/schemas/Ontology' }),
        ...errorResponses,
      },
    },
    put: {
      tags: ['Ontology Manager'],
      summary: 'Update ontology metadata',
      parameters: [ontologyIdParam],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, properties: { displayName: STR, description: STR } } } } },
      responses: { '200': ok('Updated', { $ref: '#/components/schemas/Ontology' }), ...errorResponses },
    },
    delete: {
      tags: ['Ontology Manager'],
      summary: 'Delete an ontology',
      parameters: [ontologyIdParam],
      responses: { '204': { description: 'Deleted' }, ...errorResponses },
    },
  },

  /* ----------------------------- Object types -------------------------- */

  '/v1/ontologies/{ontologyId}/objectTypes': {
    get: {
      tags: ['Object Types'],
      summary: 'List object types in an ontology',
      parameters: [
        ontologyIdParam,
        { name: 'pageSize', in: 'query' as const, schema: { type: 'integer' as const, default: 100 } },
        { name: 'pageToken', in: 'query' as const, schema: STR },
      ],
      responses: { '200': ok('Paginated object types', { $ref: '#/components/schemas/ListEnvelope' }), ...errorResponses },
    },
    post: {
      tags: ['Object Types'],
      summary: 'Create an object type (metadata only — no properties)',
      description:
        'Creates a bare object type row. Use `POST .../objectTypes/batch` ' +
        'when you need to create an object type WITH properties in a ' +
        'single atomic call — this endpoint silently drops any ' +
        '`properties`, `primaryKeyProperty`, or `titleProperty` fields ' +
        'in the request body.',
      parameters: [ontologyIdParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object' as const,
              properties: {
                apiName: { ...STR, description: 'PascalCase identifier, alphanumeric only' },
                displayName: STR,
                description: STR,
                icon: STR,
                iconColor: STR,
                status: { $ref: '#/components/schemas/ObjectTypeStatus' },
              },
              required: ['apiName', 'displayName'],
            },
          },
        },
      },
      responses: {
        '201': ok('Created', { $ref: '#/components/schemas/ObjectType' }),
        '409': {
          description:
            'OBJECT_TYPE_ALREADY_EXISTS — the apiName collides with an ' +
            'existing object type in this ontology.',
          content: { 'application/json': { schema: REF_ERR } },
        },
        ...errorResponses,
      },
    },
  },

  /* ----------------------------- Batch create + foundry dataset bridge -- */

  '/v1/ontologies/{ontologyId}/objectTypes/batch': {
    post: {
      tags: ['Object Types'],
      summary:
        'Atomically create an object type + properties + primary key + title property',
      description:
        'Used by the "Create a new object type" wizard. Everything ' +
        'happens inside one database transaction, so a failure on any ' +
        'step rolls back the entire create. Pass `onConflict: "rename"` ' +
        'to survive apiName collisions — the backend suffixes `_2`, ' +
        '`_3`, … until a free name is found and records the ORIGINAL ' +
        'apiName in `requestedApiName` on the response, which the ' +
        'overview page surfaces as a red "Invalid" badge the user can ' +
        'resolve with an inline rename.',
      parameters: [ontologyIdParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateObjectTypeBatchBody' },
          },
        },
      },
      responses: {
        ...errorResponses,
        '201': ok('Created', { $ref: '#/components/schemas/ObjectType' }),
        '400': {
          description:
            'REQUIRED_FIELD_MISSING | PRIMARY_KEY_NOT_SET | VALIDATION_FAILED',
          content: { 'application/json': { schema: REF_ERR } },
        },
        '409': {
          description:
            'OBJECT_TYPE_ALREADY_EXISTS when `onConflict === "fail"` and ' +
            'the apiName is taken. `onConflict === "rename"` never ' +
            'returns 409 unless the rename loop hits its 1000-try cap.',
          content: { 'application/json': { schema: REF_ERR } },
        },
      },
    },
  },

  '/v1/ontologies/{ontologyId}/objectTypes/by-id/{objectTypeId}': {
    get: {
      tags: ['Object Types'],
      summary: 'Get an object type by UUID (stable across renames)',
      description:
        'Mirrors GET `.../objectTypes/{apiName}` but keyed on ' +
        '`objectTypeId` (UUID). The overview editor at ' +
        '`/ontology/{objectTypeId}/overview` uses this endpoint so the ' +
        'URL stays stable even when the user renames the object type ' +
        'in place.',
      parameters: [
        ontologyIdParam,
        {
          name: 'objectTypeId',
          in: 'path' as const,
          required: true,
          schema: STR,
          description: 'Object type UUID (objectTypeId from the DB)',
        },
      ],
      responses: {
        '200': ok('Object type detail', {
          type: 'object' as const,
          properties: { objectType: { $ref: '#/components/schemas/ObjectType' } },
        }),
        ...errorResponses,
      },
    },
  },

  '/v1/ontologies/{ontologyId}/objectTypes/{apiName}': {
    get: {
      tags: ['Object Types'],
      summary: 'Get an object type with its properties, datasource, indexing state, and link types',
      parameters: [ontologyIdParam, apiNameParam],
      responses: {
        '200': ok('Object type detail', {
          type: 'object' as const,
          properties: { objectType: { $ref: '#/components/schemas/ObjectType' } },
        }),
        ...errorResponses,
      },
    },
    put: {
      tags: ['Object Types'],
      summary: 'Update object type metadata (also supports apiName rename)',
      description:
        'Every field in `UpdateObjectTypeBody` is optional — send only ' +
        'what you want to change. When `apiName` is present, the backend ' +
        'validates the new value (PascalCase, alphanumeric only) and ' +
        'clears any lingering `requestedApiName` marker in the same ' +
        'UPDATE, resolving a wizard-rename conflict in one round trip. ' +
        'Collisions surface as `409 DUPLICATE_API_NAME`.',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateObjectTypeBody' },
          },
        },
      },
      responses: {
        '200': ok('Updated', { $ref: '#/components/schemas/ObjectType' }),
        '409': {
          description:
            'DUPLICATE_API_NAME — the new apiName collides with another ' +
            'object type in this ontology.',
          content: { 'application/json': { schema: REF_ERR } },
        },
        ...errorResponses,
      },
    },
    delete: {
      tags: ['Object Types'],
      summary: 'Delete an object type and all its properties',
      parameters: [ontologyIdParam, apiNameParam],
      responses: { '204': { description: 'Deleted' }, ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/objectTypes/{apiName}/changeStatus': {
    post: {
      tags: ['Object Types'],
      summary: 'Change the lifecycle status of an object type',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { status: { $ref: '#/components/schemas/ObjectTypeStatus' } }, required: ['status'] } } },
      },
      responses: { '200': ok('Updated', { $ref: '#/components/schemas/ObjectType' }), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/objectTypes/{apiName}/clone': {
    post: {
      tags: ['Object Types'],
      summary: 'Clone an object type with a new apiName',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, properties: { newApiName: STR, newDisplayName: STR }, required: ['newApiName'] } } } },
      responses: { '201': ok('Cloned', { $ref: '#/components/schemas/ObjectType' }), ...errorResponses },
    },
  },

  /* ----------------------------- Properties ---------------------------- */

  '/v1/ontologies/{ontologyId}/objectTypes/{apiName}/properties': {
    get: {
      tags: ['Properties'],
      summary: 'List properties on an object type',
      parameters: [ontologyIdParam, apiNameParam],
      responses: { '200': ok('Property list', { type: 'array' as const, items: { $ref: '#/components/schemas/PropertyDefinition' } }), ...errorResponses },
    },
    post: {
      tags: ['Properties'],
      summary: 'Create a property on an object type',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/PropertyDefinition' } } },
      },
      responses: { '201': ok('Created', { $ref: '#/components/schemas/PropertyDefinition' }), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/objectTypes/{apiName}/properties/{propApiName}': {
    put: {
      tags: ['Properties'],
      summary: 'Update a property',
      parameters: [
        ontologyIdParam, apiNameParam,
        { name: 'propApiName', in: 'path' as const, required: true, schema: STR },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PropertyDefinition' } } } },
      responses: { '200': ok('Updated', { $ref: '#/components/schemas/PropertyDefinition' }), ...errorResponses },
    },
    delete: {
      tags: ['Properties'],
      summary: 'Delete a property',
      parameters: [
        ontologyIdParam, apiNameParam,
        { name: 'propApiName', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '204': { description: 'Deleted' }, ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/objectTypes/{apiName}/primaryKey': {
    post: {
      tags: ['Properties'],
      summary: 'Set a property as the primary key',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { propertyApiName: STR }, required: ['propertyApiName'] } } },
      },
      responses: { '200': { description: 'Primary key set' }, ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/objectTypes/{apiName}/titleProperty': {
    post: {
      tags: ['Properties'],
      summary: 'Set a property as the object title',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { propertyApiName: STR }, required: ['propertyApiName'] } } },
      },
      responses: { '200': { description: 'Title property set' }, ...errorResponses },
    },
  },

  /* ----------------------------- Link types ---------------------------- */

  '/v1/ontologies/{ontologyId}/linkTypes': {
    get: {
      tags: ['Link Types'],
      summary: 'List link types',
      parameters: [ontologyIdParam],
      responses: { '200': ok('Paginated link types', { $ref: '#/components/schemas/ListEnvelope' }) },
    },
    post: {
      tags: ['Link Types'],
      summary: 'Create a link type',
      parameters: [ontologyIdParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object' as const,
              properties: {
                apiName: STR,
                displayName: STR,
                description: STR,
                cardinality: { $ref: '#/components/schemas/LinkCardinality' },
                sourceObjectTypeApiName: STR,
                targetObjectTypeApiName: STR,
                sourcePropertyApiName: STR,
                targetPropertyApiName: STR,
                isBidirectional: BOOL,
              },
              required: ['apiName', 'displayName', 'cardinality', 'sourceObjectTypeApiName', 'targetObjectTypeApiName'],
            },
          },
        },
      },
      responses: { '201': ok('Created', { $ref: '#/components/schemas/LinkType' }), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/linkTypes/{apiName}': {
    get: {
      tags: ['Link Types'],
      summary: 'Get a link type',
      parameters: [ontologyIdParam, apiNameParam],
      responses: { '200': ok('Link type', { $ref: '#/components/schemas/LinkType' }), ...errorResponses },
    },
    put: {
      tags: ['Link Types'],
      summary: 'Update a link type',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LinkType' } } } },
      responses: { '200': ok('Updated', { $ref: '#/components/schemas/LinkType' }), ...errorResponses },
    },
    delete: {
      tags: ['Link Types'],
      summary: 'Delete a link type',
      parameters: [ontologyIdParam, apiNameParam],
      responses: { '204': { description: 'Deleted' }, ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/linkTypes/{apiName}/resolve': {
    post: {
      tags: ['Link Types'],
      summary: 'Resolve link instances around a source object',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { sourcePrimaryKey: STR, pageSize: INT }, required: ['sourcePrimaryKey'] } } },
      },
      responses: { '200': ok('Resolved links', OBJ), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/linkTypes/{apiName}/searchAround': {
    post: {
      tags: ['Link Types'],
      summary: 'Search around an object — return all related objects via this link type',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, properties: { sourcePrimaryKey: STR }, required: ['sourcePrimaryKey'] } } } },
      responses: { '200': ok('Linked objects', OBJ) },
    },
  },

  /* ----------------------------- Action types -------------------------- */

  '/v1/ontologies/{ontologyId}/actionTypes': {
    get: {
      tags: ['Action Types'],
      summary: 'List action types',
      parameters: [ontologyIdParam],
      responses: { '200': ok('List', { type: 'array' as const, items: { $ref: '#/components/schemas/ActionType' } }) },
    },
    post: {
      tags: ['Action Types'],
      summary: 'Create an action type',
      parameters: [ontologyIdParam],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionType' } } } },
      responses: { '201': ok('Created', { $ref: '#/components/schemas/ActionType' }), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/actions/{actionTypeApiName}/apply': {
    post: {
      tags: ['Action Types'],
      summary: 'Execute an action with parameters (transactional)',
      parameters: [
        ontologyIdParam,
        { name: 'actionTypeApiName', in: 'path' as const, required: true, schema: STR },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, properties: { parameters: OBJ }, required: ['parameters'] } } } },
      responses: {
        '200': ok('Applied', { type: 'object' as const, properties: { executionId: STR, result: OBJ } }),
        ...errorResponses,
      },
    },
  },

  '/v1/ontologies/{ontologyId}/actions/{actionTypeApiName}/applyBatch': {
    post: {
      tags: ['Action Types'],
      summary: 'Apply an action to up to 100 parameter sets in one transaction',
      parameters: [
        ontologyIdParam,
        { name: 'actionTypeApiName', in: 'path' as const, required: true, schema: STR },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, properties: { requests: { type: 'array' as const, items: { type: 'object' as const, properties: { parameters: OBJ } } } } } } } },
      responses: { '200': ok('Batch applied', OBJ), ...errorResponses },
    },
  },

  /* ----------------------------- Objects (data plane) ------------------ */

  '/v1/objects/{objectType}/search': {
    post: {
      tags: ['Objects'],
      summary: 'Search instances of an object type',
      description:
        'Filter, sort and paginate object instances. The body uses Palantir-style `$`-prefixed control fields (`$pageSize`, `$pageToken`, `$orderBy`, `$select`) and a `where` clause for predicates.',
      parameters: [{ name: 'objectType', in: 'path' as const, required: true, schema: STR }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object' as const,
              properties: {
                where: { ...OBJ, description: 'Predicate object — keys are property apiNames' },
                $orderBy: { type: 'array' as const, items: { type: 'object' as const, properties: { field: STR, direction: { type: 'string' as const, enum: ['asc', 'desc'] } } } },
                $pageSize: INT,
                $pageToken: STR,
                $select: { type: 'array' as const, items: STR },
              },
            },
          },
        },
      },
      responses: { '200': ok('Search results', { type: 'object' as const, properties: { data: { type: 'array' as const, items: OBJ }, nextPageToken: { type: 'string' as const, nullable: true } } }) },
    },
  },

  '/v1/objects/{objectType}/{primaryKey}': {
    get: {
      tags: ['Objects'],
      summary: 'Get a single object instance by primary key',
      parameters: [
        { name: 'objectType', in: 'path' as const, required: true, schema: STR },
        { name: 'primaryKey', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '200': ok('Object instance', OBJ), ...errorResponses },
    },
  },

  '/v1/objects/{objectType}/aggregate': {
    post: {
      tags: ['Objects'],
      summary: 'Run aggregations (count/sum/avg/min/max group by) over object instances',
      parameters: [{ name: 'objectType', in: 'path' as const, required: true, schema: STR }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { aggregations: { type: 'array' as const, items: OBJ }, groupBy: { type: 'array' as const, items: STR } } } } },
      },
      responses: { '200': ok('Aggregated results', OBJ) },
    },
  },

  /* ----------------------------- Interfaces ---------------------------- */

  '/v1/ontology/{ontologyId}/interfaces': {
    get: {
      tags: ['Interfaces'],
      summary: 'List interface types',
      parameters: [ontologyIdParam],
      responses: { '200': ok('Interface list', { type: 'array' as const, items: OBJ }) },
    },
    post: {
      tags: ['Interfaces'],
      summary: 'Create an interface',
      parameters: [ontologyIdParam],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const, properties: { apiName: STR, displayName: STR, properties: { type: 'array' as const, items: { $ref: '#/components/schemas/PropertyDefinition' } } }, required: ['apiName', 'displayName'] } } } },
      responses: { '201': ok('Created', OBJ), ...errorResponses },
    },
  },

  /* ----------------------------- Edits / audit ------------------------- */

  '/v1/ontology/{ontologyId}/objectTypes/{apiName}/edits': {
    get: {
      tags: ['Edits'],
      summary: 'List unsaved/pending edits for an object type',
      parameters: [ontologyIdParam, apiNameParam],
      responses: { '200': ok('Edit list', { type: 'array' as const, items: OBJ }) },
    },
  },

  '/v1/audit': {
    get: {
      tags: ['Audit'],
      summary: 'Global audit log',
      parameters: [
        { name: 'ontologyId', in: 'query' as const, schema: STR },
        { name: 'limit', in: 'query' as const, schema: { type: 'integer' as const, default: 50 } },
      ],
      responses: { '200': ok('Audit entries', { type: 'array' as const, items: OBJ }) },
    },
  },

  /* ----------------------------- Indexing & reindex -------------------- */

  '/v1/ontology/{ontologyId}/objectTypes/{apiName}/reindex': {
    post: {
      tags: ['Indexing'],
      summary: 'Trigger a reindex for an object type',
      parameters: [ontologyIdParam, apiNameParam],
      responses: { '202': { description: 'Reindex triggered' }, ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/objectTypes/{apiName}/index': {
    get: {
      tags: ['Indexing'],
      summary: 'Get current indexing status for an object type',
      parameters: [ontologyIdParam, apiNameParam],
      responses: { '200': ok('Indexing state', OBJ) },
    },
  },

  /* ----------------------------- Backing datasources ------------------- */

  '/v1/ontologies/{ontologyId}/objectTypes/{apiName}/datasource': {
    post: {
      tags: ['Backing Datasource'],
      summary: 'Register a backing datasource for an object type',
      description:
        'Three mutually-exclusive binding modes — the backend picks ' +
        'whichever one the body supplies:\n\n' +
        '• `foundryDatasetId` → bridges a `foundry_datasets` row ' +
        '(written by `POST /projects/:id/upload`) into ' +
        '`backing_datasource` via `registerWithFoundryDataset`. Zero ' +
        'filesystem access; columns come from `dataset_columns`. This ' +
        "is the path the wizard's Step 1 picker uses.\n\n" +
        '• `datasetId` → legacy Ontology-dataset path that requires a ' +
        'committed `dataset_transaction` pointing at a file on disk.\n\n' +
        '• `filePath` → legacy filesystem path relative to `DATA_DIR`.\n\n' +
        'On success the backend reindexes the object type automatically.',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/RegisterBackingDatasourceBody' },
          },
        },
      },
      responses: {
        '201': ok('Registered', {
          type: 'object' as const,
          properties: {
            backingDatasource: { $ref: '#/components/schemas/BackingDatasource' },
            message: STR,
          },
        }),
        '409': {
          description:
            'DATASOURCE_ALREADY_REGISTERED — the object type already has ' +
            'a backing datasource.',
          content: { 'application/json': { schema: REF_ERR } },
        },
        ...errorResponses,
      },
    },
    get: {
      tags: ['Backing Datasource'],
      summary: 'Get the registered backing datasource for an object type',
      parameters: [ontologyIdParam, apiNameParam],
      responses: {
        '200': ok('Backing datasource', { $ref: '#/components/schemas/BackingDatasource' }),
        ...errorResponses,
      },
    },
    delete: {
      tags: ['Backing Datasource'],
      summary: 'Unregister the backing datasource',
      parameters: [ontologyIdParam, apiNameParam],
      responses: {
        '204': { description: 'Unregistered' },
        ...errorResponses,
      },
    },
  },

  '/v1/ontologies/{ontologyId}/objectTypes/{apiName}/datasource/scan': {
    post: {
      tags: ['Backing Datasource'],
      summary: 'Re-scan the datasource and refresh column metadata',
      parameters: [ontologyIdParam, apiNameParam],
      responses: {
        '200': ok('Rescanned', { $ref: '#/components/schemas/BackingDatasource' }),
        ...errorResponses,
      },
    },
  },

  /* ----------------------------- Bulk properties ---------------------- */

  '/v1/ontologies/{ontologyId}/objectTypes/{apiName}/properties/batch': {
    post: {
      tags: ['Properties'],
      summary: 'Create multiple properties on an object type in one call',
      description:
        'Inserts every property atomically inside a single transaction — ' +
        'either all succeed or none do. Each property is validated ' +
        'individually (camelCase apiName, enum baseType).',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object' as const,
              required: ['properties'],
              properties: {
                properties: {
                  type: 'array' as const,
                  minItems: 1,
                  items: { $ref: '#/components/schemas/PropertyDefinition' },
                },
              },
            },
          },
        },
      },
      responses: {
        '201': ok('Created', {
          type: 'array' as const,
          items: { $ref: '#/components/schemas/PropertyDefinition' },
        }),
        '409': {
          description: 'PROPERTY_ALREADY_EXISTS — one of the apiNames collides',
          content: { 'application/json': { schema: REF_ERR } },
        },
        ...errorResponses,
      },
    },
  },

  /* ----------------------------- Search -------------------------------- */

  '/v1/search': {
    get: {
      tags: ['Search'],
      summary: 'Cross-ontology global search across resources and instances',
      parameters: [
        { name: 'q', in: 'query' as const, required: true, schema: STR, description: 'Free-text query' },
      ],
      responses: { '200': ok('Search hits', { type: 'array' as const, items: OBJ }) },
    },
  },

  /* ----------------------------- Branches ----------------------------- */

  '/v1/ontologies/{ontologyId}/branches': {
    get: {
      tags: ['Branches'],
      summary: 'List branches for an ontology',
      parameters: [
        ontologyIdParam,
        { name: 'status', in: 'query' as const, schema: { type: 'string' as const, enum: ['OPEN', 'MERGED', 'CLOSED'] }, description: 'Filter by branch status' },
      ],
      responses: { '200': ok('Branch list', { type: 'object' as const, properties: { data: { type: 'array' as const, items: OBJ }, totalCount: INT } }), ...errorResponses },
    },
    post: {
      tags: ['Branches'],
      summary: 'Create a new branch (max 50 open per ontology)',
      parameters: [ontologyIdParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { name: STR, parentBranchName: STR, description: STR }, required: ['name'] } } },
      },
      responses: { '201': ok('Created', { type: 'object' as const, properties: { branch: OBJ, description: { type: 'string' as const, nullable: true } } }), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/branches/{branchName}': {
    get: {
      tags: ['Branches'],
      summary: 'Get branch detail with proposals',
      parameters: [
        ontologyIdParam,
        { name: 'branchName', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '200': ok('Branch detail', { type: 'object' as const, properties: { branch: OBJ, proposals: { type: 'array' as const, items: OBJ } } }), ...errorResponses },
    },
    delete: {
      tags: ['Branches'],
      summary: 'Close a branch (soft-delete)',
      parameters: [
        ontologyIdParam,
        { name: 'branchName', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '204': { description: 'Branch closed' }, ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/branches/{branchName}/merge': {
    post: {
      tags: ['Branches'],
      summary: 'Merge branch into parent (requires at least one approved proposal)',
      parameters: [
        ontologyIdParam,
        { name: 'branchName', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '200': ok('Merged', { type: 'object' as const, properties: { branchId: STR, status: STR } }), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/branches/{branchName}/proposals': {
    post: {
      tags: ['Branches'],
      summary: 'Open a new proposal on a branch',
      parameters: [
        ontologyIdParam,
        { name: 'branchName', in: 'path' as const, required: true, schema: STR },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { title: STR, description: STR }, required: ['title'] } } },
      },
      responses: { '201': ok('Proposal created', OBJ), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/branches/{branchName}/proposals/{proposalId}/approve': {
    post: {
      tags: ['Branches'],
      summary: 'Approve an open proposal',
      parameters: [
        ontologyIdParam,
        { name: 'branchName', in: 'path' as const, required: true, schema: STR },
        { name: 'proposalId', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '200': ok('Approved', OBJ), ...errorResponses },
    },
  },

  /* ----------------------------- Groups ------------------------------ */

  '/v1/ontologies/{ontologyId}/groups': {
    get: {
      tags: ['Groups'],
      summary: 'List object type groups with member counts',
      parameters: [ontologyIdParam],
      responses: { '200': ok('Group list', { type: 'object' as const, properties: { data: { type: 'array' as const, items: OBJ }, totalCount: INT } }) },
    },
    post: {
      tags: ['Groups'],
      summary: 'Create an object type group',
      parameters: [ontologyIdParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { apiName: STR, displayName: STR, description: STR, icon: { ...STR, default: 'folder' } }, required: ['apiName', 'displayName'] } } },
      },
      responses: { '201': ok('Created', OBJ), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/groups/graph': {
    get: {
      tags: ['Groups'],
      summary: 'Cytoscape-style group→objectType graph (max 200 nodes)',
      parameters: [ontologyIdParam],
      responses: { '200': ok('Graph', { type: 'object' as const, properties: { nodes: { type: 'array' as const, items: OBJ }, edges: { type: 'array' as const, items: OBJ }, truncated: BOOL } }) },
    },
  },

  '/v1/ontologies/{ontologyId}/groups/{groupApiName}/counts': {
    get: {
      tags: ['Groups'],
      summary: 'Cached OpenSearch doc counts per object type in a group (60 s TTL)',
      parameters: [
        ontologyIdParam,
        { name: 'groupApiName', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '200': ok('Counts', { type: 'object' as const, properties: { counts: OBJ, cachedTtlMs: INT } }) },
    },
  },

  '/v1/ontologies/{ontologyId}/groups/{groupApiName}/members': {
    post: {
      tags: ['Groups'],
      summary: 'Add an object type to a group (idempotent)',
      parameters: [
        ontologyIdParam,
        { name: 'groupApiName', in: 'path' as const, required: true, schema: STR },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { objectTypeApiName: STR }, required: ['objectTypeApiName'] } } },
      },
      responses: { '204': { description: 'Member added' }, ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/groups/{groupApiName}': {
    delete: {
      tags: ['Groups'],
      summary: 'Delete a group',
      parameters: [
        ontologyIdParam,
        { name: 'groupApiName', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '204': { description: 'Deleted' }, ...errorResponses },
    },
  },

  /* ----------------------------- Functions --------------------------- */

  '/v1/ontologies/{ontologyId}/functions': {
    get: {
      tags: ['Functions'],
      summary: 'List functions with version counts and invocation stats',
      parameters: [ontologyIdParam],
      responses: { '200': ok('Function list', { type: 'object' as const, properties: { data: { type: 'array' as const, items: OBJ }, totalCount: INT } }) },
    },
    post: {
      tags: ['Functions'],
      summary: 'Register a new function and publish its first version',
      parameters: [ontologyIdParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { apiName: STR, displayName: STR, description: STR, runtime: { ...STR, default: 'typescript' }, sourceCode: STR, inputSchema: OBJ, outputSchema: OBJ }, required: ['apiName', 'displayName', 'sourceCode'] } } },
      },
      responses: { '201': ok('Created', { type: 'object' as const, properties: { function: OBJ, versions: { type: 'array' as const, items: OBJ } } }), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/functions/{apiName}': {
    get: {
      tags: ['Functions'],
      summary: 'Get function detail with version history',
      parameters: [ontologyIdParam, apiNameParam],
      responses: { '200': ok('Function detail', { type: 'object' as const, properties: { function: OBJ, versions: { type: 'array' as const, items: OBJ } } }), ...errorResponses },
    },
    delete: {
      tags: ['Functions'],
      summary: 'Delete a function',
      parameters: [ontologyIdParam, apiNameParam],
      responses: { '204': { description: 'Deleted' }, ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/functions/{apiName}/versions': {
    post: {
      tags: ['Functions'],
      summary: 'Publish a new version of a function',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { sourceCode: STR, inputSchema: OBJ, outputSchema: OBJ }, required: ['sourceCode'] } } },
      },
      responses: { '201': ok('Version published', OBJ), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/functions/{apiName}/invoke': {
    post: {
      tags: ['Functions'],
      summary: 'Execute the latest version in a sandboxed runtime (5 s timeout)',
      parameters: [ontologyIdParam, apiNameParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { input: {} } } } },
      },
      responses: {
        '200': ok('Invocation result', { type: 'object' as const, properties: { output: {}, durationMs: INT, logs: { type: 'array' as const, items: STR } } }),
        '408': { description: 'FUNCTION_TIMEOUT', content: { 'application/json': { schema: REF_ERR } } },
        ...errorResponses,
      },
    },
  },

  /* ----------------------------- Explorations ------------------------ */

  '/v1/ontologies/{ontologyId}/explorations': {
    get: {
      tags: ['Explorations'],
      summary: 'List saved explorations (own + shared/public)',
      parameters: [ontologyIdParam],
      responses: { '200': ok('Exploration list', { type: 'object' as const, properties: { data: { type: 'array' as const, items: OBJ }, totalCount: INT } }) },
    },
    post: {
      tags: ['Explorations'],
      summary: 'Create a saved exploration',
      parameters: [ontologyIdParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { title: STR, description: STR, config: OBJ, visibility: { ...STR, default: 'private' } }, required: ['title'] } } },
      },
      responses: { '201': ok('Created', OBJ), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/explorations/{id}': {
    get: {
      tags: ['Explorations'],
      summary: 'Get a single exploration',
      parameters: [
        ontologyIdParam,
        { name: 'id', in: 'path' as const, required: true, schema: STR, description: 'Exploration UUID' },
      ],
      responses: { '200': ok('Exploration', OBJ), ...errorResponses },
    },
    put: {
      tags: ['Explorations'],
      summary: 'Update an exploration (owner only)',
      parameters: [
        ontologyIdParam,
        { name: 'id', in: 'path' as const, required: true, schema: STR },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { title: STR, description: STR, config: OBJ, visibility: STR } } } },
      },
      responses: { '200': ok('Updated', OBJ), ...errorResponses },
    },
    delete: {
      tags: ['Explorations'],
      summary: 'Delete an exploration (owner only)',
      parameters: [
        ontologyIdParam,
        { name: 'id', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '204': { description: 'Deleted' }, ...errorResponses },
    },
  },

  /* ----------------------------- Exports ----------------------------- */

  '/v1/ontologies/{ontologyId}/exports': {
    get: {
      tags: ['Exports'],
      summary: 'List export jobs for the current user (last 100)',
      parameters: [ontologyIdParam],
      responses: { '200': ok('Export jobs', { type: 'object' as const, properties: { data: { type: 'array' as const, items: OBJ }, totalCount: INT } }) },
    },
    post: {
      tags: ['Exports'],
      summary: 'Enqueue a new async export job',
      parameters: [ontologyIdParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { objectTypeApiName: STR, format: { type: 'string' as const, enum: ['csv', 'xlsx', 'jsonl'], default: 'csv' }, query: OBJ } } } },
      },
      responses: { '202': ok('Export job enqueued', OBJ), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/exports/{jobId}': {
    get: {
      tags: ['Exports'],
      summary: 'Poll export job status',
      parameters: [
        ontologyIdParam,
        { name: 'jobId', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '200': ok('Export job', { type: 'object' as const, properties: { status: STR, row_count: INT, download_url: { type: 'string' as const, nullable: true }, expires_at: { type: 'string' as const, nullable: true } } }), ...errorResponses },
    },
  },

  /* ----------------------------- Summary ----------------------------- */

  '/v1/ontologies/{ontologyId}/summary': {
    get: {
      tags: ['Summary'],
      summary: 'Home page bundle — object types, groups, favorites, recent activity',
      parameters: [ontologyIdParam],
      responses: { '200': ok('Summary', { type: 'object' as const, properties: { objectTypes: { type: 'array' as const, items: OBJ }, groups: { type: 'array' as const, items: OBJ }, favorites: { type: 'array' as const, items: OBJ }, recent: { type: 'array' as const, items: OBJ } } }) },
    },
  },

  '/v1/ontologies/{ontologyId}/summary/{apiName}': {
    get: {
      tags: ['Summary'],
      summary: 'Lightweight single-type summary for preview popovers',
      parameters: [ontologyIdParam, apiNameParam],
      responses: { '200': ok('Type summary', { type: 'object' as const, properties: { api_name: STR, display_name: STR, description: { type: 'string' as const, nullable: true }, icon: STR, icon_color: STR, status: STR, property_count: INT } }), ...errorResponses },
    },
  },

  /* ----------------------------- Geo --------------------------------- */

  '/v1/ontologies/{ontologyId}/geo/{objectTypeApiName}/geohash': {
    post: {
      tags: ['Geo'],
      summary: 'Geohash bucket aggregation for map rendering',
      parameters: [
        ontologyIdParam,
        { name: 'objectTypeApiName', in: 'path' as const, required: true, schema: STR },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { geopointProperty: STR, zoom: { ...INT, default: 4 }, filter: { type: 'array' as const, items: OBJ } }, required: ['geopointProperty'] } } },
      },
      responses: { '200': ok('Geohash buckets', { type: 'object' as const, properties: { precision: INT, buckets: { type: 'array' as const, items: OBJ }, geopointProperty: STR } }) },
    },
  },

  '/v1/ontologies/{ontologyId}/geo/{objectTypeApiName}/choropleth': {
    post: {
      tags: ['Geo'],
      summary: 'Country/state term aggregation for choropleth maps',
      parameters: [
        ontologyIdParam,
        { name: 'objectTypeApiName', in: 'path' as const, required: true, schema: STR },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { regionProperty: STR, level: { type: 'string' as const, enum: ['country', 'state'], default: 'country' }, filter: { type: 'array' as const, items: OBJ } }, required: ['regionProperty'] } } },
      },
      responses: { '200': ok('Choropleth regions', { type: 'object' as const, properties: { level: STR, regions: { type: 'array' as const, items: OBJ }, regionProperty: STR } }) },
    },
  },

  /* ----------------------------- Comparisons ------------------------- */

  '/v1/ontologies/{ontologyId}/comparisons/aggregate': {
    post: {
      tags: ['Comparisons'],
      summary: 'Dual-set aggregation comparison via OpenSearch msearch',
      parameters: [ontologyIdParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { objectTypeApiName: STR, sharedFilter: { type: 'array' as const, items: OBJ }, setA: { type: 'object' as const, properties: { filter: { type: 'array' as const, items: OBJ }, label: STR, color: STR } }, setB: { type: 'object' as const, properties: { filter: { type: 'array' as const, items: OBJ }, label: STR, color: STR } }, aggregation: { type: 'object' as const, properties: { type: { type: 'string' as const, enum: ['terms', 'histogram', 'date_histogram'] }, field: STR }, required: ['type', 'field'] } }, required: ['objectTypeApiName', 'aggregation'] } } },
      },
      responses: { '200': ok('Comparison result', { type: 'object' as const, properties: { palette: OBJ, setA: { type: 'object' as const, properties: { label: STR, buckets: { type: 'array' as const, items: OBJ } } }, setB: { type: 'object' as const, properties: { label: STR, buckets: { type: 'array' as const, items: OBJ } } }, aggregation: OBJ } }) },
    },
  },

  /* ----------------------------- Migrations -------------------------- */

  '/v1/ontologies/{ontologyId}/migrations': {
    get: {
      tags: ['Migrations'],
      summary: 'List recent migration jobs (last 100)',
      parameters: [ontologyIdParam],
      responses: { '200': ok('Migration list', { type: 'object' as const, properties: { data: { type: 'array' as const, items: OBJ }, totalCount: INT } }) },
    },
  },

  '/v1/ontologies/{ontologyId}/migrations/plan': {
    post: {
      tags: ['Migrations'],
      summary: 'Classify proposed schema operations as breaking/non-breaking',
      parameters: [ontologyIdParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { operations: { type: 'array' as const, items: STR } }, required: ['operations'] } } },
      },
      responses: { '200': ok('Migration plan', { type: 'object' as const, properties: { breaking: { type: 'array' as const, items: STR }, nonBreaking: { type: 'array' as const, items: STR }, unknown: { type: 'array' as const, items: STR }, requiresMigration: BOOL } }) },
    },
  },

  '/v1/ontologies/{ontologyId}/migrations/execute': {
    post: {
      tags: ['Migrations'],
      summary: 'Execute a migration — reindex into a new versioned index and swap alias',
      parameters: [ontologyIdParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { objectTypeApiName: STR, operations: { type: 'array' as const, items: STR } }, required: ['objectTypeApiName', 'operations'] } } },
      },
      responses: { '200': ok('Migration result', { type: 'object' as const, properties: { jobId: STR, status: STR, newIndex: STR, previousIndex: { type: 'string' as const, nullable: true } } }), ...errorResponses },
    },
  },

  /* ----------------------------- Governance -------------------------- */

  '/v1/ontologies/{ontologyId}/governance/lineage/{objectTypeApiName}': {
    get: {
      tags: ['Governance'],
      summary: 'Lineage DAG for an object type (max 5 hops)',
      parameters: [
        ontologyIdParam,
        { name: 'objectTypeApiName', in: 'path' as const, required: true, schema: STR },
        { name: 'depth', in: 'query' as const, schema: INT, description: 'Number of hops (max 5)' },
      ],
      responses: { '200': ok('Lineage graph', OBJ), ...errorResponses },
    },
  },

  '/v1/ontologies/{ontologyId}/governance/pii-scans/{objectTypeApiName}': {
    get: {
      tags: ['Governance'],
      summary: 'List historical PII scan results',
      parameters: [
        ontologyIdParam,
        { name: 'objectTypeApiName', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '200': ok('PII scan history', { type: 'object' as const, properties: { data: { type: 'array' as const, items: OBJ }, totalCount: INT } }) },
    },
    post: {
      tags: ['Governance'],
      summary: 'Trigger a PII scan on object type data',
      parameters: [
        ontologyIdParam,
        { name: 'objectTypeApiName', in: 'path' as const, required: true, schema: STR },
      ],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' as const, properties: { samples: { type: 'array' as const, items: OBJ } } } } },
      },
      responses: { '200': ok('Scan results', { type: 'object' as const, properties: { matches: { type: 'array' as const, items: OBJ }, suggestionCount: INT, sampleSize: INT, scannedFromIndex: BOOL } }) },
    },
  },

  '/v1/ontologies/{ontologyId}/governance/usage/{objectTypeApiName}': {
    get: {
      tags: ['Governance'],
      summary: '30-day read/write usage sparkline',
      parameters: [
        ontologyIdParam,
        { name: 'objectTypeApiName', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '200': ok('Usage series', { type: 'object' as const, properties: { series: { type: 'array' as const, items: { type: 'object' as const, properties: { day: STR, reads: INT, writes: INT } } } } }) },
    },
  },

  '/v1/ontologies/{ontologyId}/governance/usage/refresh': {
    post: {
      tags: ['Governance'],
      summary: 'Refresh the usage_event_daily materialized view',
      parameters: [ontologyIdParam],
      responses: { '200': ok('Refreshed', { type: 'object' as const, properties: { refreshedAt: STR } }) },
    },
  },

  /* ----------------------------- Object Views ------------------------ */

  '/v1/ontology/{ontologyId}/objectTypes/{objectTypeApiName}/objects/{primaryKey}/view': {
    get: {
      tags: ['Object Views'],
      summary: 'Enriched single-object view with properties, interfaces, and link summary',
      parameters: [
        ontologyIdParam,
        { name: 'objectTypeApiName', in: 'path' as const, required: true, schema: STR },
        { name: 'primaryKey', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '200': ok('Object view', OBJ), ...errorResponses },
    },
  },

  '/v1/ontology/{ontologyId}/objectTypes/{objectTypeApiName}/objects/{primaryKey}/linked': {
    get: {
      tags: ['Object Views'],
      summary: 'Grouped linked objects for every link type involving this object',
      parameters: [
        ontologyIdParam,
        { name: 'objectTypeApiName', in: 'path' as const, required: true, schema: STR },
        { name: 'primaryKey', in: 'path' as const, required: true, schema: STR },
        { name: 'linkType', in: 'query' as const, schema: STR, description: 'Filter to specific link type' },
        { name: 'pageSize', in: 'query' as const, schema: { ...INT, default: 100 }, description: '1–1000' },
        { name: 'pageToken', in: 'query' as const, schema: STR },
      ],
      responses: { '200': ok('Linked objects', OBJ), ...errorResponses },
    },
  },

  '/v1/ontology/{ontologyId}/objectTypes/{objectTypeApiName}/objects/batchView': {
    post: {
      tags: ['Object Views'],
      summary: 'Batch-fetch enriched views for up to 100 objects',
      parameters: [
        ontologyIdParam,
        { name: 'objectTypeApiName', in: 'path' as const, required: true, schema: STR },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { primaryKeys: { type: 'array' as const, items: STR, minItems: 1, maxItems: 100 }, include: { type: 'array' as const, items: { type: 'string' as const, enum: ['properties', 'links', 'interfaces'] } } }, required: ['primaryKeys'] } } },
      },
      responses: { '200': ok('Batch views', { type: 'object' as const, properties: { objectType: STR, views: { type: 'array' as const, items: OBJ }, totalRequested: INT, totalResolved: INT } }), ...errorResponses },
    },
  },

  '/v1/objects/{objectType}/{primaryKey}/view': {
    get: {
      tags: ['Object Views'],
      summary: 'Enriched object view (auto-resolves ontologyId from object type)',
      parameters: [
        { name: 'objectType', in: 'path' as const, required: true, schema: STR },
        { name: 'primaryKey', in: 'path' as const, required: true, schema: STR },
      ],
      responses: { '200': ok('Object view', OBJ), ...errorResponses },
    },
  },

  '/v1/objects/{objectType}/{primaryKey}/linked': {
    get: {
      tags: ['Object Views'],
      summary: 'Linked objects (auto-resolves ontologyId from object type)',
      parameters: [
        { name: 'objectType', in: 'path' as const, required: true, schema: STR },
        { name: 'primaryKey', in: 'path' as const, required: true, schema: STR },
        { name: 'linkType', in: 'query' as const, schema: STR },
        { name: 'pageSize', in: 'query' as const, schema: INT },
        { name: 'pageToken', in: 'query' as const, schema: STR },
      ],
      responses: { '200': ok('Linked objects', OBJ), ...errorResponses },
    },
  },

  '/v1/objects/{objectType}/batchView': {
    post: {
      tags: ['Object Views'],
      summary: 'Batch object views (auto-resolves ontologyId from object type)',
      parameters: [
        { name: 'objectType', in: 'path' as const, required: true, schema: STR },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' as const, properties: { primaryKeys: { type: 'array' as const, items: STR, minItems: 1, maxItems: 100 }, include: { type: 'array' as const, items: STR } }, required: ['primaryKeys'] } } },
      },
      responses: { '200': ok('Batch views', OBJ), ...errorResponses },
    },
  },

  /* ----------------------------- Bulk Actions ------------------------ */

  '/v1/search/picker': {
    get: {
      tags: ['Search'],
      summary: 'Resource picker for the "Create object type" wizard',
      description:
        'Scope-filtered, type-filtered search surface optimised for the ' +
        'modal picker in tellus-fe. Returns a flat list of resources ' +
        '(projects, folders, datasets, pipelines, modules, aip_logic) ' +
        'keyed on a stable `id` that the wizard forwards to the backing ' +
        'datasource binder.',
      parameters: [
        { name: 'q', in: 'query' as const, schema: STR, description: 'Optional free-text query' },
        {
          name: 'scope',
          in: 'query' as const,
          schema: { type: 'string' as const, enum: ['all', 'yours', 'shared', 'recent', 'favorites'] },
          description: 'Which slice of the catalog to search',
        },
        {
          name: 'types',
          in: 'query' as const,
          schema: STR,
          description:
            'Comma-separated list of resource types to include: ' +
            'project, folder, dataset, pipeline, module, aip_logic',
        },
        { name: 'limit', in: 'query' as const, schema: INT, description: 'Max results, default 100' },
      ],
      responses: {
        '200': ok('Picker hits', {
          type: 'object' as const,
          properties: {
            results: {
              type: 'array' as const,
              items: {
                type: 'object' as const,
                properties: {
                  id: STR,
                  name: STR,
                  resourceType: { type: 'string' as const, enum: ['project', 'folder', 'dataset', 'pipeline', 'module', 'aip_logic'] },
                  path: STR,
                  hasChildren: BOOL,
                  projectId: STR,
                  updatedAt: STR,
                },
              },
            },
            typeCounts: OBJ,
            meta: {
              type: 'object' as const,
              properties: { page: INT, limit: INT, total: INT, totalPages: INT },
            },
          },
        }),
      },
    },
  },
};
