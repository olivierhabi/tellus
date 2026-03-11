// ---------------------------------------------------------------------------
// Reindex Trigger for Property Changes
//
// When a property is added, modified, or deleted on an object type, the
// OpenSearch index mapping might need to be updated. This module determines
// what action is recommended based on the type of property change.
//
// In Palantir, "changes that require Object Storage to unregister and
// reregister the backing datasources of an object type will make the objects
// of that type unavailable in user applications during that reindex time."
//
// IMPORTANT: This function is ADVISORY ONLY. It returns the recommended
// action but does NOT call updateMapping(), recreateIndex(), or any other
// side-effect function directly. The caller is responsible for executing
// the recommended action. This makes the function a pure decision function
// with no side effects.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The four valid change types for property mutations. */
export type ChangeType = "added" | "modified" | "deleted" | "primary_key_changed";

/** Property descriptor passed to handlePropertyChange(). */
export interface PropertyChange {
  /** The API name of the property being changed. */
  apiName: string;
  /** The previous base type (required when changeType is "modified"). */
  oldType?: string;
  /** The new base type (required when changeType is "modified"). */
  newType?: string;
  /** Whether this property is (or was) the primary key. */
  isPrimaryKey?: boolean;
}

/** Result when a mapping update is recommended (no reindex needed). */
export interface MappingUpdateResult {
  action: "mapping_update_recommended";
  reindexRequired: false;
  message: string;
}

/** Result when a full reindex is required. */
export interface ReindexRequiredResult {
  action: "reindex_required";
  reindexRequired: true;
  reason: string;
  destructive?: true;
}

/** Result when no action is needed. */
export interface NoActionResult {
  action: "no_action";
  reindexRequired: false;
  note: string;
}

export type HandlePropertyChangeResult =
  | MappingUpdateResult
  | ReindexRequiredResult
  | NoActionResult;

// ---------------------------------------------------------------------------
// Valid change types
// ---------------------------------------------------------------------------

const VALID_CHANGE_TYPES: ReadonlySet<string> = new Set([
  "added",
  "modified",
  "deleted",
  "primary_key_changed",
]);

// ---------------------------------------------------------------------------
// handlePropertyChange()
// ---------------------------------------------------------------------------

/**
 * Determine the recommended action when a property on an object type changes.
 *
 * This is a pure decision function — it has no side effects and does not
 * interact with OpenSearch or PostgreSQL. The caller should inspect the
 * returned action and execute accordingly (e.g. call updateMapping(),
 * recreateIndex(), or trigger a full reindex).
 *
 * @param objectTypeApiName - The API name of the object type.
 * @param changeType        - One of "added", "modified", "deleted", "primary_key_changed".
 * @param property          - Descriptor with apiName and optional type info.
 * @returns A result object describing the recommended action.
 * @throws If changeType is invalid or required fields are missing.
 */
export function handlePropertyChange(
  objectTypeApiName: string,
  changeType: string,
  property: PropertyChange
): HandlePropertyChangeResult {
  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  if (!VALID_CHANGE_TYPES.has(changeType)) {
    throw new Error(
      `Invalid changeType: '${changeType}'. Must be one of: added, modified, deleted, primary_key_changed`
    );
  }

  if (changeType === "modified") {
    if (!property.oldType || !property.newType) {
      throw new Error(
        "property.oldType and property.newType are required when changeType is 'modified'"
      );
    }
  }

  // -----------------------------------------------------------------------
  // Decision logic
  // -----------------------------------------------------------------------

  switch (changeType as ChangeType) {
    case "added":
      return {
        action: "mapping_update_recommended",
        reindexRequired: false,
        message:
          `New property '${property.apiName}' can be added to the OpenSearch mapping ` +
          `without reindexing. Call updateMapping() from Task 4.`,
      };

    case "modified":
      return {
        action: "reindex_required",
        reindexRequired: true,
        reason:
          `Property type changed from '${property.oldType}' to '${property.newType}'. ` +
          `This requires a full reindex.`,
      };

    case "deleted":
      return {
        action: "no_action",
        reindexRequired: false,
        note:
          "Deleted properties remain in OpenSearch mapping but will no longer be " +
          "populated on new indexes. No reindex needed.",
      };

    case "primary_key_changed":
      return {
        action: "reindex_required",
        reindexRequired: true,
        reason:
          "Primary key property changed. This is a destructive change that requires a full reindex.",
        destructive: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { handlePropertyChange };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/propertyChangeHandler.ts)
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

  console.log("Running propertyChangeHandler self-tests...\n");

  // =======================================================================
  // Test 1: "added" — mapping update recommended
  // =======================================================================
  {
    const result = handlePropertyChange("Employee", "added", {
      apiName: "middleName",
    });

    assert(result.action === "mapping_update_recommended", "added: action");
    assert(result.reindexRequired === false, "added: reindexRequired is false");
    assert(
      "message" in result,
      "added: has 'message' field"
    );
    assert(
      (result as MappingUpdateResult).message.includes("middleName"),
      "added: message includes property apiName"
    );
    assert(
      (result as MappingUpdateResult).message.includes("updateMapping()"),
      "added: message mentions updateMapping()"
    );
    assert(
      (result as MappingUpdateResult).message.includes("without reindexing"),
      "added: message says 'without reindexing'"
    );
  }

  // =======================================================================
  // Test 2: "modified" — reindex required
  // =======================================================================
  {
    const result = handlePropertyChange("Employee", "modified", {
      apiName: "salary",
      oldType: "String",
      newType: "Double",
    });

    assert(result.action === "reindex_required", "modified: action");
    assert(result.reindexRequired === true, "modified: reindexRequired is true");
    assert("reason" in result, "modified: has 'reason' field");

    const reason = (result as ReindexRequiredResult).reason;
    assert(reason.includes("String"), "modified: reason includes oldType 'String'");
    assert(reason.includes("Double"), "modified: reason includes newType 'Double'");
    assert(reason.includes("full reindex"), "modified: reason mentions 'full reindex'");
  }

  // =======================================================================
  // Test 3: "deleted" — no action
  // =======================================================================
  {
    const result = handlePropertyChange("Employee", "deleted", {
      apiName: "middleName",
    });

    assert(result.action === "no_action", "deleted: action");
    assert(result.reindexRequired === false, "deleted: reindexRequired is false");
    assert("note" in result, "deleted: has 'note' field");

    const note = (result as NoActionResult).note;
    assert(
      note.includes("remain in OpenSearch mapping"),
      "deleted: note explains mapping retention"
    );
    assert(
      note.includes("No reindex needed"),
      "deleted: note says 'No reindex needed'"
    );
  }

  // =======================================================================
  // Test 4: "primary_key_changed" — reindex required + destructive
  // =======================================================================
  {
    const result = handlePropertyChange("Employee", "primary_key_changed", {
      apiName: "employeeId",
      isPrimaryKey: true,
    });

    assert(result.action === "reindex_required", "pk changed: action");
    assert(result.reindexRequired === true, "pk changed: reindexRequired is true");
    assert("reason" in result, "pk changed: has 'reason' field");

    const r = result as ReindexRequiredResult;
    assert(r.reason.includes("Primary key"), "pk changed: reason mentions 'Primary key'");
    assert(r.reason.includes("destructive"), "pk changed: reason mentions 'destructive'");
    assert(r.destructive === true, "pk changed: destructive is true");
  }

  // =======================================================================
  // Test 5: Invalid changeType — throws
  // =======================================================================
  {
    let threwError = false;
    let errorMsg = "";
    try {
      handlePropertyChange("Employee", "renamed", {
        apiName: "foo",
      });
    } catch (err) {
      threwError = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    assert(threwError === true, "invalid type: throws error");
    assert(
      errorMsg === "Invalid changeType: 'renamed'. Must be one of: added, modified, deleted, primary_key_changed",
      `invalid type: error message (got: '${errorMsg}')`
    );
  }

  // =======================================================================
  // Test 6: "modified" without oldType — throws
  // =======================================================================
  {
    let threwError = false;
    let errorMsg = "";
    try {
      handlePropertyChange("Employee", "modified", {
        apiName: "salary",
        newType: "Double",
      });
    } catch (err) {
      threwError = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    assert(threwError === true, "no oldType: throws error");
    assert(
      errorMsg === "property.oldType and property.newType are required when changeType is 'modified'",
      `no oldType: error message (got: '${errorMsg}')`
    );
  }

  // =======================================================================
  // Test 7: "modified" without newType — throws
  // =======================================================================
  {
    let threwError = false;
    let errorMsg = "";
    try {
      handlePropertyChange("Employee", "modified", {
        apiName: "salary",
        oldType: "String",
      });
    } catch (err) {
      threwError = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    assert(threwError === true, "no newType: throws error");
    assert(
      errorMsg === "property.oldType and property.newType are required when changeType is 'modified'",
      `no newType: error message (got: '${errorMsg}')`
    );
  }

  // =======================================================================
  // Test 8: "modified" without both oldType and newType — throws
  // =======================================================================
  {
    let threwError = false;
    try {
      handlePropertyChange("Employee", "modified", {
        apiName: "salary",
      });
    } catch {
      threwError = true;
    }

    assert(threwError === true, "no both types: throws error");
  }

  // =======================================================================
  // Test 9: "added" with different property names
  // =======================================================================
  {
    const r1 = handlePropertyChange("Taxpayer", "added", {
      apiName: "taxId",
    });
    assert(
      (r1 as MappingUpdateResult).message.includes("taxId"),
      "added taxpayer: message includes 'taxId'"
    );

    const r2 = handlePropertyChange("Business", "added", {
      apiName: "registrationDate",
    });
    assert(
      (r2 as MappingUpdateResult).message.includes("registrationDate"),
      "added business: message includes 'registrationDate'"
    );
  }

  // =======================================================================
  // Test 10: "modified" with various type combinations
  // =======================================================================
  {
    const r1 = handlePropertyChange("Employee", "modified", {
      apiName: "age",
      oldType: "Integer",
      newType: "String",
    });
    const reason1 = (r1 as ReindexRequiredResult).reason;
    assert(reason1.includes("Integer"), "modified types 1: includes 'Integer'");
    assert(reason1.includes("String"), "modified types 1: includes 'String'");

    const r2 = handlePropertyChange("Employee", "modified", {
      apiName: "createdAt",
      oldType: "String",
      newType: "Timestamp",
    });
    const reason2 = (r2 as ReindexRequiredResult).reason;
    assert(reason2.includes("String"), "modified types 2: includes 'String'");
    assert(reason2.includes("Timestamp"), "modified types 2: includes 'Timestamp'");
  }

  // =======================================================================
  // Test 11: "modified" does NOT have destructive flag
  // =======================================================================
  {
    const result = handlePropertyChange("Employee", "modified", {
      apiName: "salary",
      oldType: "String",
      newType: "Double",
    });

    assert(
      !("destructive" in result),
      "modified: does NOT have 'destructive' field"
    );
  }

  // =======================================================================
  // Test 12: "primary_key_changed" has destructive flag but "modified" doesn't
  // =======================================================================
  {
    const pk = handlePropertyChange("Employee", "primary_key_changed", {
      apiName: "employeeId",
    });
    const mod = handlePropertyChange("Employee", "modified", {
      apiName: "salary",
      oldType: "String",
      newType: "Double",
    });

    assert(
      "destructive" in pk && (pk as ReindexRequiredResult).destructive === true,
      "destructive: pk_changed has destructive=true"
    );
    assert(
      !("destructive" in mod),
      "destructive: modified has no destructive field"
    );
  }

  // =======================================================================
  // Test 13: Various invalid changeType values
  // =======================================================================
  {
    const invalidTypes = [
      "create", "update", "remove", "add", "modify", "delete",
      "ADDED", "Modified", "DELETED", "", " ",
    ];

    for (const ct of invalidTypes) {
      let threw = false;
      try {
        handlePropertyChange("Employee", ct, { apiName: "foo" });
      } catch {
        threw = true;
      }
      assert(threw === true, `invalid '${ct}': throws`);
    }
  }

  // =======================================================================
  // Test 14: Return shapes — discriminated union fields
  // =======================================================================
  {
    const added = handlePropertyChange("X", "added", { apiName: "a" });
    assert(added.action === "mapping_update_recommended", "shape added: action");
    assert("message" in added, "shape added: has message");
    assert(!("reason" in added), "shape added: no reason");
    assert(!("note" in added), "shape added: no note");
    assert(!("destructive" in added), "shape added: no destructive");

    const modified = handlePropertyChange("X", "modified", {
      apiName: "a",
      oldType: "A",
      newType: "B",
    });
    assert(modified.action === "reindex_required", "shape modified: action");
    assert("reason" in modified, "shape modified: has reason");
    assert(!("message" in modified), "shape modified: no message");
    assert(!("note" in modified), "shape modified: no note");

    const deleted = handlePropertyChange("X", "deleted", { apiName: "a" });
    assert(deleted.action === "no_action", "shape deleted: action");
    assert("note" in deleted, "shape deleted: has note");
    assert(!("message" in deleted), "shape deleted: no message");
    assert(!("reason" in deleted), "shape deleted: no reason");

    const pkChanged = handlePropertyChange("X", "primary_key_changed", {
      apiName: "a",
    });
    assert(pkChanged.action === "reindex_required", "shape pk: action");
    assert("reason" in pkChanged, "shape pk: has reason");
    assert("destructive" in pkChanged, "shape pk: has destructive");
    assert(!("message" in pkChanged), "shape pk: no message");
    assert(!("note" in pkChanged), "shape pk: no note");
  }

  // =======================================================================
  // Test 15: objectTypeApiName is accepted (function doesn't use it
  //          internally but accepts it for logging/audit purposes)
  // =======================================================================
  {
    // Should not throw regardless of object type name
    const r1 = handlePropertyChange("Taxpayer", "added", { apiName: "a" });
    const r2 = handlePropertyChange("CustomsDeclaration", "deleted", { apiName: "b" });
    const r3 = handlePropertyChange("RealEstateProperty", "primary_key_changed", { apiName: "c" });

    assert(r1.action === "mapping_update_recommended", "apiName Taxpayer: works");
    assert(r2.action === "no_action", "apiName CustomsDeclaration: works");
    assert(r3.action === "reindex_required", "apiName RealEstateProperty: works");
  }

  // =======================================================================
  // Test 16: "modified" with empty string oldType/newType — throws
  //          (empty strings are falsy)
  // =======================================================================
  {
    let threw1 = false;
    try {
      handlePropertyChange("X", "modified", {
        apiName: "a",
        oldType: "",
        newType: "String",
      });
    } catch {
      threw1 = true;
    }
    assert(threw1, "modified empty oldType: throws");

    let threw2 = false;
    try {
      handlePropertyChange("X", "modified", {
        apiName: "a",
        oldType: "String",
        newType: "",
      });
    } catch {
      threw2 = true;
    }
    assert(threw2, "modified empty newType: throws");
  }

  // =======================================================================
  // Test 17: "added" result is consistent for same inputs
  // =======================================================================
  {
    const r1 = handlePropertyChange("E", "added", { apiName: "x" });
    const r2 = handlePropertyChange("E", "added", { apiName: "x" });

    assert(r1.action === r2.action, "idempotent added: same action");
    assert(
      (r1 as MappingUpdateResult).message === (r2 as MappingUpdateResult).message,
      "idempotent added: same message"
    );
  }

  // =======================================================================
  // Test 18: "deleted" result is the same regardless of property details
  // =======================================================================
  {
    const r1 = handlePropertyChange("E", "deleted", { apiName: "x" });
    const r2 = handlePropertyChange("E", "deleted", {
      apiName: "y",
      isPrimaryKey: true,
    });

    assert(r1.action === r2.action, "deleted consistency: same action");
    assert(
      (r1 as NoActionResult).note === (r2 as NoActionResult).note,
      "deleted consistency: same note"
    );
  }

  // =======================================================================
  // Test 19: "primary_key_changed" without isPrimaryKey — still works
  //          (isPrimaryKey is optional metadata, not required for the decision)
  // =======================================================================
  {
    const result = handlePropertyChange("E", "primary_key_changed", {
      apiName: "newPk",
    });

    assert(result.action === "reindex_required", "pk no flag: action correct");
    assert(
      (result as ReindexRequiredResult).destructive === true,
      "pk no flag: destructive is true"
    );
  }

  // =======================================================================
  // Test 20: "added" with isPrimaryKey flag — still returns mapping_update
  //          (the isPrimaryKey flag is informational, doesn't change decision)
  // =======================================================================
  {
    const result = handlePropertyChange("E", "added", {
      apiName: "newId",
      isPrimaryKey: true,
    });

    assert(
      result.action === "mapping_update_recommended",
      "added pk: action is still mapping_update_recommended"
    );
    assert(result.reindexRequired === false, "added pk: reindexRequired is false");
  }

  // =======================================================================
  // Test 21: Error message for invalid changeType includes the bad value
  // =======================================================================
  {
    const badValues = ["foo_bar", "123", "reindex"];
    for (const bad of badValues) {
      let errorMsg = "";
      try {
        handlePropertyChange("X", bad, { apiName: "a" });
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
      }
      assert(
        errorMsg.includes(`'${bad}'`),
        `error includes '${bad}': ${errorMsg.substring(0, 60)}`
      );
    }
  }

  // =======================================================================
  // Test 22: "modified" reason string format matches spec exactly
  // =======================================================================
  {
    const result = handlePropertyChange("E", "modified", {
      apiName: "salary",
      oldType: "String",
      newType: "Double",
    });
    const reason = (result as ReindexRequiredResult).reason;

    assert(
      reason === "Property type changed from 'String' to 'Double'. This requires a full reindex.",
      `modified reason format: (got: '${reason}')`
    );
  }

  // =======================================================================
  // Test 23: "added" message format matches spec exactly
  // =======================================================================
  {
    const result = handlePropertyChange("E", "added", {
      apiName: "middleName",
    });
    const msg = (result as MappingUpdateResult).message;

    assert(
      msg === "New property 'middleName' can be added to the OpenSearch mapping without reindexing. Call updateMapping() from Task 4.",
      `added message format: (got: '${msg}')`
    );
  }

  // =======================================================================
  // Test 24: "deleted" note format matches spec exactly
  // =======================================================================
  {
    const result = handlePropertyChange("E", "deleted", {
      apiName: "middleName",
    });
    const note = (result as NoActionResult).note;

    assert(
      note === "Deleted properties remain in OpenSearch mapping but will no longer be populated on new indexes. No reindex needed.",
      `deleted note format: (got: '${note}')`
    );
  }

  // =======================================================================
  // Test 25: "primary_key_changed" reason format matches spec exactly
  // =======================================================================
  {
    const result = handlePropertyChange("E", "primary_key_changed", {
      apiName: "pk",
    });
    const reason = (result as ReindexRequiredResult).reason;

    assert(
      reason === "Primary key property changed. This is a destructive change that requires a full reindex.",
      `pk reason format: (got: '${reason}')`
    );
  }

  // =======================================================================
  // Test 26: Function is synchronous — returns directly, not a Promise
  // =======================================================================
  {
    const result = handlePropertyChange("E", "added", { apiName: "x" });
    // If it were async, result would be a Promise
    assert(
      !(result instanceof Promise),
      "synchronous: result is not a Promise"
    );
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll propertyChangeHandler tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
