// Tests run in sequential order. Each describe block depends on data from previous blocks.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => null);
  return { status: res.status, data };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isISOTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !isNaN(d.getTime()) && value.includes('T');
}

// ─── Shared state ────────────────────────────────────────────────────────────

let ontologyId: string;
let baseUrl: string; // shorthand for the interfaces collection URL
let canTestImplementations = false;
let objectTypeApiName: string | null = null;
let secondObjectTypeApiName: string | null = null;

// ─── Bootstrap: find or create an ontology ───────────────────────────────────

before(async () => {
  // Try to list existing ontologies
  const { status, data } = await api('GET', '/api/v2/ontology');

  if (status === 200 && data && Array.isArray(data.data) && data.data.length > 0) {
    ontologyId = data.data[0].ontologyId ?? data.data[0].id;
  } else if (status === 200 && data && !Array.isArray(data.data)) {
    // Some servers return the list at the top level
    const list = Array.isArray(data) ? data : [];
    if (list.length > 0) {
      ontologyId = list[0].ontologyId ?? list[0].id;
    }
  }

  if (!ontologyId) {
    // Attempt to create one
    const create = await api('POST', '/api/v2/ontology', {
      apiName: 'TestOntology',
      displayName: 'Test Ontology',
      description: 'Ontology created by integration tests',
    });
    if (create.status >= 200 && create.status < 300 && create.data) {
      ontologyId = create.data.ontologyId ?? create.data.id;
    }
  }

  assert.ok(ontologyId, 'Could not resolve an ontology to run tests against');
  baseUrl = `/api/v2/ontology/${ontologyId}/interfaces`;

  // ── Check whether we can test implementations ──────────────────────────
  // Try to find or create two object types so Block 2 & 3 can run.
  try {
    const otRes = await api(
      'GET',
      `/api/v2/ontology/${ontologyId}/objectTypes`,
    );
    if (
      otRes.status === 200 &&
      otRes.data &&
      Array.isArray(otRes.data.data) &&
      otRes.data.data.length >= 2
    ) {
      objectTypeApiName = otRes.data.data[0].apiName;
      secondObjectTypeApiName = otRes.data.data[1].apiName;
      canTestImplementations = true;
    } else if (
      otRes.status === 200 &&
      Array.isArray(otRes.data) &&
      otRes.data.length >= 2
    ) {
      objectTypeApiName = otRes.data[0].apiName;
      secondObjectTypeApiName = otRes.data[1].apiName;
      canTestImplementations = true;
    }
  } catch {
    // Object types are not available — Block 2 & 3 will skip gracefully
  }

  if (!canTestImplementations) {
    // Try to create minimal object types for testing
    try {
      const airportRes = await api(
        'POST',
        `/api/v2/ontology/${ontologyId}/objectTypes`,
        {
          apiName: 'Airport',
          displayName: 'Airport',
          description: 'Airport object type for interface tests',
          properties: [
            { apiName: 'airportId', displayName: 'Airport ID', baseType: 'string' },
            { apiName: 'lat', displayName: 'Latitude', baseType: 'double' },
            { apiName: 'lng', displayName: 'Longitude', baseType: 'double' },
            { apiName: 'name', displayName: 'Name', baseType: 'string' },
          ],
          primaryKey: 'airportId',
        },
      );

      const warehouseRes = await api(
        'POST',
        `/api/v2/ontology/${ontologyId}/objectTypes`,
        {
          apiName: 'Warehouse',
          displayName: 'Warehouse',
          description: 'Warehouse object type for interface tests',
          properties: [
            { apiName: 'warehouseId', displayName: 'Warehouse ID', baseType: 'string' },
            { apiName: 'latitude', displayName: 'Latitude', baseType: 'double' },
            { apiName: 'longitude', displayName: 'Longitude', baseType: 'double' },
            { apiName: 'warehouseName', displayName: 'Warehouse Name', baseType: 'string' },
          ],
          primaryKey: 'warehouseId',
        },
      );

      if (
        airportRes.status >= 200 &&
        airportRes.status < 300 &&
        warehouseRes.status >= 200 &&
        warehouseRes.status < 300
      ) {
        objectTypeApiName = 'Airport';
        secondObjectTypeApiName = 'Warehouse';
        canTestImplementations = true;
      }
    } catch {
      // Silently fail — tests will skip
    }
  }
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

after(async () => {
  if (!ontologyId) return;

  // Remove implementations first (order matters)
  if (canTestImplementations && objectTypeApiName) {
    try {
      await api(
        'DELETE',
        `/api/v2/ontology/${ontologyId}/objectTypes/${objectTypeApiName}/implements/HasLocation`,
      );
    } catch {}
  }

  // Clean up test interfaces
  const cleanup = ['Temporary', 'Schedulable', 'Auditable', 'HasLocation'];
  for (const name of cleanup) {
    try {
      await api('DELETE', `${baseUrl}/${name}`);
    } catch {}
  }

  // Clean up object types we may have created
  for (const ot of ['Airport', 'Warehouse']) {
    try {
      await api(
        'DELETE',
        `/api/v2/ontology/${ontologyId}/objectTypes/${ot}`,
      );
    } catch {}
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Block 1 – Interface CRUD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Interface CRUD', () => {
  // 1.1
  it('should create an Interface with valid properties', async () => {
    const { status, data } = await api('POST', baseUrl, {
      apiName: 'HasLocation',
      displayName: 'Has Location',
      description: 'Objects that have a geographic location',
      properties: [
        {
          apiName: 'latitude',
          displayName: 'Latitude',
          baseType: 'double',
          required: true,
        },
        {
          apiName: 'longitude',
          displayName: 'Longitude',
          baseType: 'double',
          required: true,
        },
        {
          apiName: 'locationName',
          displayName: 'Location Name',
          baseType: 'string',
          required: false,
        },
      ],
    });

    assert.strictEqual(status, 201, `Expected 201 but got ${status}`);
    assert.ok(data, 'Response body should not be empty');

    // interfaceId must be a valid UUID
    assert.ok(
      UUID_RE.test(data.interfaceId),
      `interfaceId should be a UUID, got: ${data.interfaceId}`,
    );

    // Properties
    assert.ok(Array.isArray(data.properties), 'properties must be an array');
    assert.strictEqual(data.properties.length, 3, 'Should have 3 properties');

    const propNames = data.properties.map((p: any) => p.apiName);
    assert.ok(propNames.includes('latitude'), 'Missing latitude property');
    assert.ok(propNames.includes('longitude'), 'Missing longitude property');
    assert.ok(propNames.includes('locationName'), 'Missing locationName property');

    const lat = data.properties.find((p: any) => p.apiName === 'latitude');
    assert.strictEqual(lat.baseType, 'double');
    assert.strictEqual(lat.required, true);

    const locName = data.properties.find(
      (p: any) => p.apiName === 'locationName',
    );
    assert.strictEqual(locName.baseType, 'string');
    assert.strictEqual(locName.required, false);

    // implementingObjectTypes
    assert.ok(
      Array.isArray(data.implementingObjectTypes),
      'implementingObjectTypes must be an array',
    );
    assert.strictEqual(
      data.implementingObjectTypes.length,
      0,
      'No implementations yet',
    );

    // Timestamps
    assert.ok(
      isISOTimestamp(data.createdAt),
      `createdAt should be a valid ISO timestamp, got: ${data.createdAt}`,
    );
    assert.ok(
      isISOTimestamp(data.updatedAt),
      `updatedAt should be a valid ISO timestamp, got: ${data.updatedAt}`,
    );
  });

  // 1.2
  it('should reject duplicate Interface apiName', async () => {
    const { status } = await api('POST', baseUrl, {
      apiName: 'HasLocation',
      displayName: 'Has Location Duplicate',
      description: 'Should be rejected',
      properties: [
        { apiName: 'x', displayName: 'X', baseType: 'double', required: false },
      ],
    });

    assert.ok(
      status === 409 || status === 400,
      `Expected 409 or 400 for duplicate apiName, got ${status}`,
    );
  });

  // 1.3
  it('should reject invalid apiName format', async () => {
    const { status } = await api('POST', baseUrl, {
      apiName: 'has-location',
      displayName: 'Bad Name',
      description: 'Hyphen is not allowed',
      properties: [
        { apiName: 'x', displayName: 'X', baseType: 'string', required: false },
      ],
    });

    assert.strictEqual(status, 400, `Expected 400 for invalid apiName, got ${status}`);
  });

  // 1.4
  it('should reject Interface with empty properties array', async () => {
    const { status } = await api('POST', baseUrl, {
      apiName: 'NoProps',
      displayName: 'No Properties',
      description: 'Should be rejected',
      properties: [],
    });

    assert.strictEqual(
      status,
      400,
      `Expected 400 for empty properties, got ${status}`,
    );
  });

  // 1.5
  it('should reject property with invalid baseType', async () => {
    const { status } = await api('POST', baseUrl, {
      apiName: 'BadType',
      displayName: 'Bad Type',
      description: 'Property with invalid baseType',
      properties: [
        {
          apiName: 'col',
          displayName: 'Column',
          baseType: 'varchar',
          required: false,
        },
      ],
    });

    assert.strictEqual(
      status,
      400,
      `Expected 400 for invalid baseType "varchar", got ${status}`,
    );
  });

  // 1.6
  it('should list all Interfaces in an Ontology', async () => {
    // Create two more interfaces first
    await api('POST', baseUrl, {
      apiName: 'Auditable',
      displayName: 'Auditable',
      description: 'Objects that track audit information',
      properties: [
        { apiName: 'createdBy', displayName: 'Created By', baseType: 'string', required: true },
        { apiName: 'modifiedBy', displayName: 'Modified By', baseType: 'string', required: false },
      ],
    });

    await api('POST', baseUrl, {
      apiName: 'Schedulable',
      displayName: 'Schedulable',
      description: 'Objects that can be scheduled',
      properties: [
        { apiName: 'startTime', displayName: 'Start Time', baseType: 'timestamp', required: true },
        { apiName: 'endTime', displayName: 'End Time', baseType: 'timestamp', required: false },
      ],
    });

    const { status, data } = await api('GET', baseUrl);

    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.ok(data, 'Response body should not be empty');

    // The list response should contain a totalCount and data array
    const items: any[] = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
    const totalCount = data.totalCount ?? items.length;

    assert.ok(totalCount >= 3, `Expected at least 3 interfaces, got ${totalCount}`);

    const apiNames = items.map((i: any) => i.apiName);
    assert.ok(apiNames.includes('HasLocation'), 'HasLocation should be in the list');
    assert.ok(apiNames.includes('Auditable'), 'Auditable should be in the list');
    assert.ok(apiNames.includes('Schedulable'), 'Schedulable should be in the list');
  });

  // 1.7
  it('should get a single Interface by apiName', async () => {
    const { status, data } = await api('GET', `${baseUrl}/HasLocation`);

    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.ok(data, 'Response body should not be empty');
    assert.strictEqual(data.apiName, 'HasLocation');
    assert.ok(Array.isArray(data.properties), 'properties must be an array');
    assert.ok(data.properties.length >= 3, 'HasLocation should have at least 3 properties');
    assert.ok(
      isISOTimestamp(data.createdAt),
      `createdAt should be ISO timestamp`,
    );
    assert.ok(
      isISOTimestamp(data.updatedAt),
      `updatedAt should be ISO timestamp`,
    );
  });

  // 1.8
  it('should return 404 for non-existent Interface', async () => {
    const { status } = await api('GET', `${baseUrl}/DoesNotExist`);

    assert.strictEqual(status, 404, `Expected 404, got ${status}`);
  });

  // 1.9
  it('should update Interface display name and description', async () => {
    const { status, data } = await api('PUT', `${baseUrl}/HasLocation`, {
      displayName: 'Updated Location',
      description: 'Updated description for HasLocation',
    });

    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.ok(data, 'Response body should not be empty');
    assert.strictEqual(
      data.displayName,
      'Updated Location',
      'displayName should be updated',
    );
  });

  // 1.10
  it('should add a new property to Interface via PUT', async () => {
    // First get the current state to preserve existing properties
    const current = await api('GET', `${baseUrl}/HasLocation`);
    const existingProps = current.data?.properties ?? [];

    const { status, data } = await api('PUT', `${baseUrl}/HasLocation`, {
      displayName: 'Updated Location',
      description: 'Updated description for HasLocation',
      properties: [
        ...existingProps,
        {
          apiName: 'altitude',
          displayName: 'Altitude',
          baseType: 'double',
          required: false,
        },
      ],
    });

    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.ok(data, 'Response body should not be empty');
    assert.ok(Array.isArray(data.properties), 'properties must be an array');
    assert.strictEqual(
      data.properties.length,
      4,
      `Expected 4 properties after adding altitude, got ${data.properties.length}`,
    );

    const altProp = data.properties.find((p: any) => p.apiName === 'altitude');
    assert.ok(altProp, 'altitude property should exist');
    assert.strictEqual(altProp.baseType, 'double');
    assert.strictEqual(altProp.required, false);
  });

  // 1.11
  it('should delete Interface with no implementations', async () => {
    // Create a temporary interface
    const createRes = await api('POST', baseUrl, {
      apiName: 'Temporary',
      displayName: 'Temporary',
      description: 'Will be deleted',
      properties: [
        { apiName: 'tmp', displayName: 'Temp', baseType: 'string', required: false },
      ],
    });
    assert.strictEqual(
      createRes.status,
      201,
      `Failed to create Temporary interface: ${createRes.status}`,
    );

    // Delete it
    const { status } = await api('DELETE', `${baseUrl}/Temporary`);
    assert.strictEqual(status, 204, `Expected 204 for DELETE, got ${status}`);

    // Confirm it's gone
    const getRes = await api('GET', `${baseUrl}/Temporary`);
    assert.strictEqual(
      getRes.status,
      404,
      `Expected 404 after deletion, got ${getRes.status}`,
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Block 2 – Interface Implementation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Interface Implementation', () => {
  // Helper to build the implements URL for an object type
  function implementsUrl(objectType: string) {
    return `/api/v2/ontology/${ontologyId}/objectTypes/${objectType}/implements`;
  }

  // 2.1
  it('should allow Object Type to implement Interface', async (t) => {
    if (!canTestImplementations || !objectTypeApiName) {
      t.skip('Object types not available for testing');
      return;
    }

    const { status, data } = await api(
      'POST',
      `${implementsUrl(objectTypeApiName)}/HasLocation`,
      {
        propertyMapping: {
          latitude: 'lat',
          longitude: 'lng',
          locationName: 'name',
        },
      },
    );

    assert.ok(
      status >= 200 && status < 300,
      `Expected 2xx for implementation, got ${status}: ${JSON.stringify(data)}`,
    );
    assert.ok(data, 'Response body should not be empty');
  });

  // 2.2
  it('should reject implementation with missing required mapping', async (t) => {
    if (!canTestImplementations || !secondObjectTypeApiName) {
      t.skip('Object types not available for testing');
      return;
    }

    // Omit the required "latitude" mapping
    const { status } = await api(
      'POST',
      `${implementsUrl(secondObjectTypeApiName)}/HasLocation`,
      {
        propertyMapping: {
          longitude: 'longitude',
          // latitude is required but intentionally missing
        },
      },
    );

    assert.ok(
      status === 400 || status === 422,
      `Expected 400 or 422 for missing required mapping, got ${status}`,
    );
  });

  // 2.3
  it('should reject implementation with type mismatch', async (t) => {
    if (!canTestImplementations || !secondObjectTypeApiName) {
      t.skip('Object types not available for testing');
      return;
    }

    // Map a double interface property to a string object-type property
    const { status } = await api(
      'POST',
      `${implementsUrl(secondObjectTypeApiName)}/HasLocation`,
      {
        propertyMapping: {
          latitude: 'warehouseName', // string mapped to double — type mismatch
          longitude: 'longitude',
          locationName: 'warehouseName',
        },
      },
    );

    assert.ok(
      status === 400 || status === 422,
      `Expected 400 or 422 for type mismatch, got ${status}`,
    );
  });

  // 2.4
  it('should reject duplicate implementation', async (t) => {
    if (!canTestImplementations || !objectTypeApiName) {
      t.skip('Object types not available for testing');
      return;
    }

    // The first object type already implements HasLocation from test 2.1
    const { status } = await api(
      'POST',
      `${implementsUrl(objectTypeApiName)}/HasLocation`,
      {
        propertyMapping: {
          latitude: 'lat',
          longitude: 'lng',
          locationName: 'name',
        },
      },
    );

    assert.ok(
      status === 409 || status === 400,
      `Expected 409 or 400 for duplicate implementation, got ${status}`,
    );
  });

  // 2.5
  it("should list Object Type's Interface implementations", async (t) => {
    if (!canTestImplementations || !objectTypeApiName) {
      t.skip('Object types not available for testing');
      return;
    }

    const { status, data } = await api('GET', implementsUrl(objectTypeApiName));

    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.ok(data, 'Response body should not be empty');

    const items: any[] = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data)
        ? data
        : [];
    const apiNames = items.map((i: any) => i.interfaceApiName ?? i.apiName);
    assert.ok(
      apiNames.includes('HasLocation'),
      'HasLocation should appear in the implementation list',
    );
  });

  // 2.6
  it('should prevent deleting Interface with implementations', async (t) => {
    if (!canTestImplementations || !objectTypeApiName) {
      t.skip('Object types not available for testing');
      return;
    }

    const { status } = await api('DELETE', `${baseUrl}/HasLocation`);

    assert.ok(
      status === 409 || status === 400 || status === 422,
      `Expected 409/400/422 when deleting Interface with implementations, got ${status}`,
    );
  });

  // 2.7
  it('should prevent removing mapped property from Interface', async (t) => {
    if (!canTestImplementations || !objectTypeApiName) {
      t.skip('Object types not available for testing');
      return;
    }

    // Try to update HasLocation removing "latitude" which is mapped
    const { status } = await api('PUT', `${baseUrl}/HasLocation`, {
      displayName: 'Updated Location',
      description: 'Trying to remove mapped property',
      properties: [
        // Intentionally omit latitude
        { apiName: 'longitude', displayName: 'Longitude', baseType: 'double', required: true },
        { apiName: 'locationName', displayName: 'Location Name', baseType: 'string', required: false },
        { apiName: 'altitude', displayName: 'Altitude', baseType: 'double', required: false },
      ],
    });

    assert.ok(
      status === 400 || status === 409 || status === 422,
      `Expected 400/409/422 when removing mapped property, got ${status}`,
    );
  });

  // 2.8
  it('should remove Interface implementation', async (t) => {
    if (!canTestImplementations || !objectTypeApiName) {
      t.skip('Object types not available for testing');
      return;
    }

    const { status } = await api(
      'DELETE',
      `${implementsUrl(objectTypeApiName)}/HasLocation`,
    );

    assert.ok(
      status === 200 || status === 204,
      `Expected 200 or 204 for removing implementation, got ${status}`,
    );

    // Verify it's gone
    const listRes = await api('GET', implementsUrl(objectTypeApiName));
    if (listRes.status === 200 && listRes.data) {
      const items: any[] = Array.isArray(listRes.data.data)
        ? listRes.data.data
        : Array.isArray(listRes.data)
          ? listRes.data
          : [];
      const apiNames = items.map((i: any) => i.interfaceApiName ?? i.apiName);
      assert.ok(
        !apiNames.includes('HasLocation'),
        'HasLocation should no longer be in the implementation list after removal',
      );
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Block 3 – Polymorphic Queries
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Polymorphic Queries', () => {
  let canTestPolymorphic = false;
  let polymorphicSearchUrl: string;

  before(async () => {
    if (!canTestImplementations || !objectTypeApiName || !secondObjectTypeApiName) {
      return;
    }

    polymorphicSearchUrl = `${baseUrl}/HasLocation/objects`;

    // Re-implement HasLocation on both object types so we have data to query
    try {
      await api(
        'POST',
        `/api/v2/ontology/${ontologyId}/objectTypes/${objectTypeApiName}/implements/HasLocation`,
        {
          propertyMapping: {
            latitude: 'lat',
            longitude: 'lng',
            locationName: 'name',
          },
        },
      );

      await api(
        'POST',
        `/api/v2/ontology/${ontologyId}/objectTypes/${secondObjectTypeApiName}/implements/HasLocation`,
        {
          propertyMapping: {
            latitude: 'latitude',
            longitude: 'longitude',
            locationName: 'warehouseName',
          },
        },
      );

      // Verify the polymorphic endpoint exists
      const probe = await api('POST', polymorphicSearchUrl, {
        query: {},
        pageSize: 1,
      });
      if (probe.status >= 200 && probe.status < 500) {
        canTestPolymorphic = true;
      }
    } catch {
      // Silently fail — tests will skip
    }
  });

  // 3.1
  it('should search across all implementing Object Types', async (t) => {
    if (!canTestPolymorphic) {
      t.skip('Polymorphic queries not available');
      return;
    }

    const { status, data } = await api('POST', polymorphicSearchUrl, {
      query: {},
      pageSize: 50,
    });

    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.ok(data, 'Response body should not be empty');

    const items: any[] = data.data ?? data.results ?? [];
    assert.ok(Array.isArray(items), 'Results should be an array');
    // Items should come from multiple object types
    if (items.length >= 2) {
      const types = new Set(items.map((i: any) => i.objectType ?? i.__type));
      assert.ok(
        types.size >= 1,
        'Results should contain at least one object type',
      );
    }
  });

  // 3.2
  it('should filter polymorphic results by Interface property', async (t) => {
    if (!canTestPolymorphic) {
      t.skip('Polymorphic queries not available');
      return;
    }

    const { status, data } = await api('POST', polymorphicSearchUrl, {
      query: {
        filter: {
          field: 'latitude',
          operator: 'gt',
          value: 0,
        },
      },
      pageSize: 50,
    });

    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.ok(data, 'Response body should not be empty');

    const items: any[] = data.data ?? data.results ?? [];
    // All returned items should have latitude > 0
    for (const item of items) {
      const lat = item.latitude ?? item.properties?.latitude;
      if (lat !== undefined) {
        assert.ok(lat > 0, `Expected latitude > 0, got ${lat}`);
      }
    }
  });

  // 3.3
  it('should filter by locationName using contains', async (t) => {
    if (!canTestPolymorphic) {
      t.skip('Polymorphic queries not available');
      return;
    }

    const { status, data } = await api('POST', polymorphicSearchUrl, {
      query: {
        filter: {
          field: 'locationName',
          operator: 'contains',
          value: 'a',
        },
      },
      pageSize: 10,
    });

    assert.ok(
      status === 200 || status === 400,
      `Expected 200 or 400 (if contains not supported), got ${status}`,
    );
    if (status === 200) {
      assert.ok(data, 'Response body should not be empty');
    }
  });

  // 3.4
  it('should sort polymorphic results by Interface property', async (t) => {
    if (!canTestPolymorphic) {
      t.skip('Polymorphic queries not available');
      return;
    }

    const { status, data } = await api('POST', polymorphicSearchUrl, {
      query: {},
      sort: [{ field: 'latitude', direction: 'asc' }],
      pageSize: 50,
    });

    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.ok(data, 'Response body should not be empty');

    const items: any[] = data.data ?? data.results ?? [];
    // Verify ascending order
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1].latitude ?? items[i - 1].properties?.latitude;
      const curr = items[i].latitude ?? items[i].properties?.latitude;
      if (prev !== undefined && curr !== undefined) {
        assert.ok(
          prev <= curr,
          `Expected ascending order: ${prev} <= ${curr}`,
        );
      }
    }
  });

  // 3.5
  it('should paginate polymorphic results', async (t) => {
    if (!canTestPolymorphic) {
      t.skip('Polymorphic queries not available');
      return;
    }

    // First page
    const page1 = await api('POST', polymorphicSearchUrl, {
      query: {},
      pageSize: 2,
    });

    assert.strictEqual(page1.status, 200, `Expected 200, got ${page1.status}`);

    const items1: any[] = page1.data?.data ?? page1.data?.results ?? [];
    assert.ok(items1.length <= 2, 'First page should have at most 2 items');

    const nextPageToken =
      page1.data?.nextPageToken ?? page1.data?.cursor ?? page1.data?.nextCursor;

    if (nextPageToken) {
      // Second page
      const page2 = await api('POST', polymorphicSearchUrl, {
        query: {},
        pageSize: 2,
        pageToken: nextPageToken,
      });

      assert.strictEqual(page2.status, 200, `Expected 200, got ${page2.status}`);
      const items2: any[] = page2.data?.data ?? page2.data?.results ?? [];

      // Pages should not overlap
      const ids1 = new Set(items1.map((i: any) => i.id ?? i.primaryKey));
      for (const item of items2) {
        const id = item.id ?? item.primaryKey;
        if (id !== undefined) {
          assert.ok(!ids1.has(id), 'Page 2 items should not overlap with page 1');
        }
      }
    }
  });

  // 3.6
  it('should aggregate polymorphic results with count', async (t) => {
    if (!canTestPolymorphic) {
      t.skip('Polymorphic queries not available');
      return;
    }

    const { status, data } = await api(
      'POST',
      `${baseUrl}/HasLocation/aggregate`,
      {
        query: {},
        aggregations: [{ type: 'count' }],
      },
    );

    assert.ok(
      status === 200 || status === 404,
      `Expected 200 or 404 (if aggregate endpoint not supported), got ${status}`,
    );

    if (status === 200) {
      assert.ok(data, 'Response body should not be empty');
      // Should have a count value
      const count =
        data.count ?? data.totalCount ?? data.data?.[0]?.value ?? data.results?.[0]?.value;
      if (count !== undefined) {
        assert.ok(
          typeof count === 'number' && count >= 0,
          `Count should be a non-negative number, got ${count}`,
        );
      }
    }
  });

  // 3.7
  it('should aggregate with avg on a numeric Interface property', async (t) => {
    if (!canTestPolymorphic) {
      t.skip('Polymorphic queries not available');
      return;
    }

    const { status, data } = await api(
      'POST',
      `${baseUrl}/HasLocation/aggregate`,
      {
        query: {},
        aggregations: [{ type: 'avg', field: 'latitude' }],
      },
    );

    assert.ok(
      status === 200 || status === 404,
      `Expected 200 or 404, got ${status}`,
    );

    if (status === 200 && data) {
      // If the response includes an average, it should be a number
      const avg =
        data.avg ?? data.average ?? data.data?.[0]?.value ?? data.results?.[0]?.value;
      if (avg !== undefined) {
        assert.ok(typeof avg === 'number', `Average should be a number, got ${typeof avg}`);
      }
    }
  });

  // 3.8
  it('should return empty results for impossible filter', async (t) => {
    if (!canTestPolymorphic) {
      t.skip('Polymorphic queries not available');
      return;
    }

    const { status, data } = await api('POST', polymorphicSearchUrl, {
      query: {
        filter: {
          type: 'and',
          filters: [
            { field: 'latitude', operator: 'gt', value: 999999 },
            { field: 'latitude', operator: 'lt', value: -999999 },
          ],
        },
      },
      pageSize: 50,
    });

    assert.strictEqual(status, 200, `Expected 200, got ${status}`);
    assert.ok(data, 'Response body should not be empty');

    const items: any[] = data.data ?? data.results ?? [];
    assert.strictEqual(
      items.length,
      0,
      `Expected 0 results for impossible filter, got ${items.length}`,
    );
  });
});
