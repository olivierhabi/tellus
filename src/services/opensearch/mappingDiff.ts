// ---------------------------------------------------------------------------
// Mapping Diff Calculator
//
// Compares two OpenSearch index mappings and identifies what changed. Used by
// the updateMapping function (Task 4) to determine which properties need to
// be added, and by the property change handler (Task 19) to detect type
// changes that require a full reindex.
//
// Comparison is recursive to handle nested objects (struct properties in
// Palantir's type system map to OpenSearch "object" type with sub-properties).
// Two field mappings are considered "equal" if they have the same `type`,
// the same `fields` (for text with keyword sub-fields), and the same nested
// `properties` (for object types).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An OpenSearch field mapping — a plain key-value object. */
export type FieldMapping = Record<string, unknown>;

/** A mapping properties block: { propertyName: fieldMapping, ... }. */
export type MappingProperties = Record<string, FieldMapping>;

/** Description of a field whose mapping changed. */
export interface ChangedField {
  from: FieldMapping;
  to: FieldMapping;
}

/** The diff result returned by calculateMappingDiff(). */
export interface MappingDiffResult {
  /** Properties present in desired but not in existing. */
  added: MappingProperties;
  /** Properties present in existing but not in desired. */
  removed: MappingProperties;
  /** Properties present in both but with different mapping definitions. */
  changed: Record<string, ChangedField>;
  /** Properties present in both with identical mapping definitions. */
  unchanged: MappingProperties;
}

// ---------------------------------------------------------------------------
// Deep equality for mapping objects
// ---------------------------------------------------------------------------

/**
 * Recursively compare two values for deep equality. Handles plain objects,
 * arrays, and primitives. This is used instead of JSON.stringify comparison
 * because key ordering in OpenSearch mappings is not guaranteed.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  // Identical references or primitive equality
  if (a === b) return true;

  // Null/undefined checks
  if (a == null || b == null) return a === b;

  // Type mismatch
  if (typeof a !== typeof b) return false;

  // Arrays
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  // Objects
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;

    const aKeys = Object.keys(aObj).sort();
    const bKeys = Object.keys(bObj).sort();

    if (aKeys.length !== bKeys.length) return false;

    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (!deepEqual(aObj[aKeys[i]], bObj[bKeys[i]])) return false;
    }

    return true;
  }

  // Primitives already handled by ===
  return false;
}

// ---------------------------------------------------------------------------
// calculateMappingDiff()
// ---------------------------------------------------------------------------

/**
 * Compare two OpenSearch mapping properties blocks and identify what changed.
 *
 * @param existingMapping - The current index mapping properties (from OpenSearch).
 * @param desiredMapping  - The desired index mapping properties (from generateIndexMapping).
 * @returns A MappingDiffResult with added, removed, changed, and unchanged fields.
 */
export function calculateMappingDiff(
  existingMapping: MappingProperties,
  desiredMapping: MappingProperties
): MappingDiffResult {
  const added: MappingProperties = {};
  const removed: MappingProperties = {};
  const changed: Record<string, ChangedField> = {};
  const unchanged: MappingProperties = {};

  const existingKeys = new Set(Object.keys(existingMapping));
  const desiredKeys = new Set(Object.keys(desiredMapping));

  // -----------------------------------------------------------------------
  // Added: in desired but not in existing
  // -----------------------------------------------------------------------
  for (const key of desiredKeys) {
    if (!existingKeys.has(key)) {
      added[key] = desiredMapping[key];
    }
  }

  // -----------------------------------------------------------------------
  // Removed: in existing but not in desired
  // -----------------------------------------------------------------------
  for (const key of existingKeys) {
    if (!desiredKeys.has(key)) {
      removed[key] = existingMapping[key];
    }
  }

  // -----------------------------------------------------------------------
  // Changed vs Unchanged: in both — compare recursively
  // -----------------------------------------------------------------------
  for (const key of existingKeys) {
    if (!desiredKeys.has(key)) continue;

    const existingField = existingMapping[key];
    const desiredField = desiredMapping[key];

    if (deepEqual(existingField, desiredField)) {
      unchanged[key] = existingField;
    } else {
      changed[key] = {
        from: existingField,
        to: desiredField,
      };
    }
  }

  return { added, removed, changed, unchanged };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { calculateMappingDiff };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/opensearch/mappingDiff.ts)
// ---------------------------------------------------------------------------

function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  console.log("Running mappingDiff self-tests...\n");

  // =======================================================================
  // deepEqual tests
  // =======================================================================

  // --- Primitives ---
  assert(deepEqual(1, 1) === true, "deepEqual: 1 === 1");
  assert(deepEqual(1, 2) === false, "deepEqual: 1 !== 2");
  assert(deepEqual("a", "a") === true, "deepEqual: 'a' === 'a'");
  assert(deepEqual("a", "b") === false, "deepEqual: 'a' !== 'b'");
  assert(deepEqual(true, true) === true, "deepEqual: true === true");
  assert(deepEqual(true, false) === false, "deepEqual: true !== false");
  assert(deepEqual(null, null) === true, "deepEqual: null === null");
  assert(deepEqual(undefined, undefined) === true, "deepEqual: undef === undef");
  assert(deepEqual(null, undefined) === false, "deepEqual: null !== undef");
  assert(deepEqual(0, false) === false, "deepEqual: 0 !== false");
  assert(deepEqual("", false) === false, "deepEqual: '' !== false");

  // --- Arrays ---
  assert(deepEqual([], []) === true, "deepEqual: [] === []");
  assert(deepEqual([1, 2], [1, 2]) === true, "deepEqual: [1,2] === [1,2]");
  assert(deepEqual([1, 2], [2, 1]) === false, "deepEqual: [1,2] !== [2,1]");
  assert(deepEqual([1], [1, 2]) === false, "deepEqual: [1] !== [1,2]");
  assert(deepEqual([1, 2], [1]) === false, "deepEqual: [1,2] !== [1]");

  // --- Objects ---
  assert(deepEqual({}, {}) === true, "deepEqual: {} === {}");
  assert(deepEqual({ a: 1 }, { a: 1 }) === true, "deepEqual: {a:1} === {a:1}");
  assert(deepEqual({ a: 1 }, { a: 2 }) === false, "deepEqual: {a:1} !== {a:2}");
  assert(deepEqual({ a: 1 }, { b: 1 }) === false, "deepEqual: {a:1} !== {b:1}");
  assert(deepEqual({ a: 1 }, { a: 1, b: 2 }) === false, "deepEqual: {a:1} !== {a:1,b:2}");

  // --- Key ordering doesn't matter ---
  assert(
    deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }) === true,
    "deepEqual: key order doesn't matter"
  );

  // --- Nested objects ---
  assert(
    deepEqual(
      { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
      { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } }
    ) === true,
    "deepEqual: nested text+keyword equal"
  );

  assert(
    deepEqual(
      { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
      { type: "text", fields: { keyword: { type: "keyword", ignore_above: 512 } } }
    ) === false,
    "deepEqual: nested text+keyword different ignore_above"
  );

  // --- Mixed types ---
  assert(deepEqual({ a: [1, 2] }, { a: [1, 2] }) === true, "deepEqual: obj with array");
  assert(deepEqual({ a: [1, 2] }, { a: [1, 3] }) === false, "deepEqual: obj with diff array");
  assert(deepEqual([{ a: 1 }], [{ a: 1 }]) === true, "deepEqual: array of obj");
  assert(deepEqual([{ a: 1 }], [{ a: 2 }]) === false, "deepEqual: array of diff obj");

  // =======================================================================
  // calculateMappingDiff tests
  // =======================================================================

  // --- Test 1: Identical mappings → all unchanged ---
  {
    const existing: MappingProperties = {
      empId: { type: "keyword" },
      name: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
      salary: { type: "double" },
    };
    const desired: MappingProperties = {
      empId: { type: "keyword" },
      name: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
      salary: { type: "double" },
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.added).length === 0, "identical: no added");
    assert(Object.keys(diff.removed).length === 0, "identical: no removed");
    assert(Object.keys(diff.changed).length === 0, "identical: no changed");
    assert(Object.keys(diff.unchanged).length === 3, "identical: 3 unchanged");
    assert("empId" in diff.unchanged, "identical: empId unchanged");
    assert("name" in diff.unchanged, "identical: name unchanged");
    assert("salary" in diff.unchanged, "identical: salary unchanged");
  }

  // --- Test 2: New property added ---
  {
    const existing: MappingProperties = {
      empId: { type: "keyword" },
    };
    const desired: MappingProperties = {
      empId: { type: "keyword" },
      department: { type: "keyword" },
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.added).length === 1, "added: 1 added");
    assert("department" in diff.added, "added: department added");
    assert((diff.added.department as { type: string }).type === "keyword", "added: department type");
    assert(Object.keys(diff.unchanged).length === 1, "added: 1 unchanged");
    assert(Object.keys(diff.removed).length === 0, "added: 0 removed");
    assert(Object.keys(diff.changed).length === 0, "added: 0 changed");
  }

  // --- Test 3: Property removed ---
  {
    const existing: MappingProperties = {
      empId: { type: "keyword" },
      department: { type: "keyword" },
    };
    const desired: MappingProperties = {
      empId: { type: "keyword" },
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.removed).length === 1, "removed: 1 removed");
    assert("department" in diff.removed, "removed: department removed");
    assert(Object.keys(diff.added).length === 0, "removed: 0 added");
    assert(Object.keys(diff.unchanged).length === 1, "removed: 1 unchanged");
  }

  // --- Test 4: Property type changed ---
  {
    const existing: MappingProperties = {
      salary: { type: "text" },
    };
    const desired: MappingProperties = {
      salary: { type: "integer" },
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.changed).length === 1, "changed: 1 changed");
    assert("salary" in diff.changed, "changed: salary changed");
    assert(
      (diff.changed.salary.from as { type: string }).type === "text",
      "changed: from type is text"
    );
    assert(
      (diff.changed.salary.to as { type: string }).type === "integer",
      "changed: to type is integer"
    );
    assert(Object.keys(diff.added).length === 0, "changed: 0 added");
    assert(Object.keys(diff.removed).length === 0, "changed: 0 removed");
    assert(Object.keys(diff.unchanged).length === 0, "changed: 0 unchanged");
  }

  // --- Test 5: Mixed — added + removed + changed + unchanged ---
  {
    const existing: MappingProperties = {
      empId: { type: "keyword" },
      salary: { type: "text" },
      oldField: { type: "boolean" },
    };
    const desired: MappingProperties = {
      empId: { type: "keyword" },
      salary: { type: "double" },
      newField: { type: "integer" },
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.added).length === 1, "mixed: 1 added");
    assert("newField" in diff.added, "mixed: newField added");

    assert(Object.keys(diff.removed).length === 1, "mixed: 1 removed");
    assert("oldField" in diff.removed, "mixed: oldField removed");

    assert(Object.keys(diff.changed).length === 1, "mixed: 1 changed");
    assert("salary" in diff.changed, "mixed: salary changed");

    assert(Object.keys(diff.unchanged).length === 1, "mixed: 1 unchanged");
    assert("empId" in diff.unchanged, "mixed: empId unchanged");
  }

  // --- Test 6: Empty existing → everything is added ---
  {
    const diff = calculateMappingDiff(
      {},
      { a: { type: "keyword" }, b: { type: "integer" } }
    );

    assert(Object.keys(diff.added).length === 2, "empty existing: 2 added");
    assert(Object.keys(diff.removed).length === 0, "empty existing: 0 removed");
    assert(Object.keys(diff.changed).length === 0, "empty existing: 0 changed");
    assert(Object.keys(diff.unchanged).length === 0, "empty existing: 0 unchanged");
  }

  // --- Test 7: Empty desired → everything is removed ---
  {
    const diff = calculateMappingDiff(
      { a: { type: "keyword" }, b: { type: "integer" } },
      {}
    );

    assert(Object.keys(diff.added).length === 0, "empty desired: 0 added");
    assert(Object.keys(diff.removed).length === 2, "empty desired: 2 removed");
    assert(Object.keys(diff.changed).length === 0, "empty desired: 0 changed");
    assert(Object.keys(diff.unchanged).length === 0, "empty desired: 0 unchanged");
  }

  // --- Test 8: Both empty → nothing ---
  {
    const diff = calculateMappingDiff({}, {});

    assert(Object.keys(diff.added).length === 0, "both empty: 0 added");
    assert(Object.keys(diff.removed).length === 0, "both empty: 0 removed");
    assert(Object.keys(diff.changed).length === 0, "both empty: 0 changed");
    assert(Object.keys(diff.unchanged).length === 0, "both empty: 0 unchanged");
  }

  // --- Test 9: Nested struct (object) properties — same ---
  {
    const existing: MappingProperties = {
      address: {
        type: "object",
        properties: {
          street: { type: "text" },
          city: { type: "keyword" },
          zip: { type: "keyword" },
        },
      },
    };
    const desired: MappingProperties = {
      address: {
        type: "object",
        properties: {
          street: { type: "text" },
          city: { type: "keyword" },
          zip: { type: "keyword" },
        },
      },
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.unchanged).length === 1, "nested same: 1 unchanged");
    assert("address" in diff.unchanged, "nested same: address unchanged");
    assert(Object.keys(diff.changed).length === 0, "nested same: 0 changed");
  }

  // --- Test 10: Nested struct — sub-property type changed ---
  {
    const existing: MappingProperties = {
      address: {
        type: "object",
        properties: {
          street: { type: "text" },
          zip: { type: "keyword" },
        },
      },
    };
    const desired: MappingProperties = {
      address: {
        type: "object",
        properties: {
          street: { type: "text" },
          zip: { type: "integer" }, // changed!
        },
      },
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.changed).length === 1, "nested changed: 1 changed");
    assert("address" in diff.changed, "nested changed: address changed");
    assert(
      ((diff.changed.address.from as { properties: Record<string, { type: string }> })
        .properties.zip.type) === "keyword",
      "nested changed: from zip is keyword"
    );
    assert(
      ((diff.changed.address.to as { properties: Record<string, { type: string }> })
        .properties.zip.type) === "integer",
      "nested changed: to zip is integer"
    );
  }

  // --- Test 11: Nested struct — sub-property added ---
  {
    const existing: MappingProperties = {
      address: {
        type: "object",
        properties: {
          street: { type: "text" },
        },
      },
    };
    const desired: MappingProperties = {
      address: {
        type: "object",
        properties: {
          street: { type: "text" },
          city: { type: "keyword" }, // new sub-property
        },
      },
    };

    const diff = calculateMappingDiff(existing, desired);

    // The entire address field changed because its properties differ
    assert(Object.keys(diff.changed).length === 1, "nested added sub: 1 changed");
    assert("address" in diff.changed, "nested added sub: address changed");
  }

  // --- Test 12: text with keyword fields — same ---
  {
    const stringMapping = {
      type: "text",
      fields: { keyword: { type: "keyword", ignore_above: 256 } },
    };
    const existing: MappingProperties = { name: { ...stringMapping } };
    const desired: MappingProperties = { name: { ...stringMapping } };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.unchanged).length === 1, "text+keyword same: 1 unchanged");
    assert("name" in diff.unchanged, "text+keyword same: name unchanged");
  }

  // --- Test 13: text with keyword fields — ignore_above changed ---
  {
    const existing: MappingProperties = {
      name: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
    };
    const desired: MappingProperties = {
      name: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 512 } } },
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.changed).length === 1, "text+keyword diff: 1 changed");
    assert("name" in diff.changed, "text+keyword diff: name changed");
  }

  // --- Test 14: date format changed ---
  {
    const existing: MappingProperties = {
      createdAt: { type: "date", format: "yyyy-MM-dd" },
    };
    const desired: MappingProperties = {
      createdAt: { type: "date", format: "yyyy-MM-dd'T'HH:mm:ss" },
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.changed).length === 1, "date format: 1 changed");
    assert("createdAt" in diff.changed, "date format: createdAt changed");
  }

  // --- Test 15: scaled_float scaling_factor changed ---
  {
    const existing: MappingProperties = {
      amount: { type: "scaled_float", scaling_factor: 100 },
    };
    const desired: MappingProperties = {
      amount: { type: "scaled_float", scaling_factor: 10000 },
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.changed).length === 1, "scaling factor: 1 changed");
    assert("amount" in diff.changed, "scaling factor: amount changed");
  }

  // --- Test 16: Same type but extra attribute added ---
  {
    const existing: MappingProperties = {
      name: { type: "keyword" },
    };
    const desired: MappingProperties = {
      name: { type: "keyword", doc_values: false },
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.changed).length === 1, "extra attr: 1 changed");
    assert("name" in diff.changed, "extra attr: name changed");
  }

  // --- Test 17: System fields preserved as unchanged ---
  {
    const systemFields: MappingProperties = {
      __pk: { type: "keyword" },
      __objectType: { type: "keyword" },
      __lastModified: { type: "date" },
      __version: { type: "long" },
      __editedBy: { type: "keyword" },
      __datasourceVersion: { type: "keyword" },
    };

    const existing: MappingProperties = {
      ...systemFields,
      empId: { type: "keyword" },
    };
    const desired: MappingProperties = {
      ...systemFields,
      empId: { type: "keyword" },
      department: { type: "keyword" },
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.unchanged).length === 7, "system: 7 unchanged (6 sys + empId)");
    assert(Object.keys(diff.added).length === 1, "system: 1 added");
    assert("department" in diff.added, "system: department added");
    assert("__pk" in diff.unchanged, "system: __pk unchanged");
    assert("__objectType" in diff.unchanged, "system: __objectType unchanged");
  }

  // --- Test 18: Many properties mixed ---
  {
    const existing: MappingProperties = {
      a: { type: "keyword" },
      b: { type: "text" },
      c: { type: "integer" },
      d: { type: "boolean" },
      e: { type: "double" },
    };
    const desired: MappingProperties = {
      a: { type: "keyword" },   // unchanged
      b: { type: "keyword" },   // changed (text → keyword)
      d: { type: "boolean" },   // unchanged
      f: { type: "float" },     // added
      g: { type: "geo_point" }, // added
    };

    const diff = calculateMappingDiff(existing, desired);

    assert(Object.keys(diff.added).length === 2, "many: 2 added (f, g)");
    assert(Object.keys(diff.removed).length === 2, "many: 2 removed (c, e)");
    assert(Object.keys(diff.changed).length === 1, "many: 1 changed (b)");
    assert(Object.keys(diff.unchanged).length === 2, "many: 2 unchanged (a, d)");

    assert("f" in diff.added, "many: f added");
    assert("g" in diff.added, "many: g added");
    assert("c" in diff.removed, "many: c removed");
    assert("e" in diff.removed, "many: e removed");
    assert("b" in diff.changed, "many: b changed");
    assert("a" in diff.unchanged, "many: a unchanged");
    assert("d" in diff.unchanged, "many: d unchanged");
  }

  // --- Test 19: Return shape ---
  {
    const diff = calculateMappingDiff(
      { a: { type: "keyword" } },
      { a: { type: "keyword" } }
    );

    assert("added" in diff, "shape: has added");
    assert("removed" in diff, "shape: has removed");
    assert("changed" in diff, "shape: has changed");
    assert("unchanged" in diff, "shape: has unchanged");
    assert(typeof diff.added === "object", "shape: added is object");
    assert(typeof diff.removed === "object", "shape: removed is object");
    assert(typeof diff.changed === "object", "shape: changed is object");
    assert(typeof diff.unchanged === "object", "shape: unchanged is object");
  }

  // --- Test 20: Changed field shape has from and to ---
  {
    const diff = calculateMappingDiff(
      { x: { type: "text" } },
      { x: { type: "integer" } }
    );

    const ch = diff.changed.x;
    assert("from" in ch, "changed shape: has from");
    assert("to" in ch, "changed shape: has to");
    assert((ch.from as { type: string }).type === "text", "changed shape: from type");
    assert((ch.to as { type: string }).type === "integer", "changed shape: to type");
  }

  // --- Test 21: Function is synchronous (pure) ---
  {
    const result = calculateMappingDiff({}, {});
    assert(
      !(result instanceof Promise),
      "synchronous: result is not a Promise"
    );
  }

  // --- Test 22: Deeply nested object equality ---
  {
    const existing: MappingProperties = {
      meta: {
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: {
              value: { type: "keyword" },
            },
          },
        },
      },
    };
    const desired: MappingProperties = {
      meta: {
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: {
              value: { type: "keyword" },
            },
          },
        },
      },
    };

    const diff = calculateMappingDiff(existing, desired);
    assert(Object.keys(diff.unchanged).length === 1, "deep nested: 1 unchanged");
    assert("meta" in diff.unchanged, "deep nested: meta unchanged");
  }

  // --- Test 23: Deeply nested object change at leaf ---
  {
    const existing: MappingProperties = {
      meta: {
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: {
              value: { type: "keyword" },
            },
          },
        },
      },
    };
    const desired: MappingProperties = {
      meta: {
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: {
              value: { type: "text" }, // changed at leaf
            },
          },
        },
      },
    };

    const diff = calculateMappingDiff(existing, desired);
    assert(Object.keys(diff.changed).length === 1, "deep nested change: 1 changed");
    assert("meta" in diff.changed, "deep nested change: meta changed");
  }

  // --- Test 24: Removed field preserves its full mapping ---
  {
    const existing: MappingProperties = {
      deletedProp: {
        type: "text",
        fields: { keyword: { type: "keyword", ignore_above: 256 } },
      },
    };
    const desired: MappingProperties = {};

    const diff = calculateMappingDiff(existing, desired);

    assert("deletedProp" in diff.removed, "removed preserves: has deletedProp");
    const rm = diff.removed.deletedProp as { type: string; fields: Record<string, unknown> };
    assert(rm.type === "text", "removed preserves: type is text");
    assert(
      (rm.fields.keyword as { type: string }).type === "keyword",
      "removed preserves: keyword sub-field"
    );
  }

  // --- Test 25: Added field preserves its full mapping ---
  {
    const diff = calculateMappingDiff(
      {},
      {
        newProp: {
          type: "text",
          fields: { keyword: { type: "keyword", ignore_above: 256 } },
        },
      }
    );

    assert("newProp" in diff.added, "added preserves: has newProp");
    const ad = diff.added.newProp as { type: string; fields: Record<string, unknown> };
    assert(ad.type === "text", "added preserves: type is text");
    assert(
      (ad.fields.keyword as { type: string }).type === "keyword",
      "added preserves: keyword sub-field"
    );
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll mappingDiff tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
