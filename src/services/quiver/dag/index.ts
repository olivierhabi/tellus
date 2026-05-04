// Quiver B2 — DAG core barrel.
export * from "./cardTypeRegistry";
export * from "./topo";
export * from "./validator";

import { listCardTypes } from "./cardTypeRegistry";

/**
 * Boot-time sanity check. Asserts the in-code registry has exactly 26
 * entries (locked in tasks/quiver/registry-fixture.md). Throws if the
 * count drifts so a regression cannot ship silently.
 */
export function assertRegistryIntegrity(): void {
  const types = listCardTypes();
  if (types.length !== 26) {
    throw new Error(
      `Card Type Registry has ${types.length} entries; expected 26. ` +
        `Spec: tasks/quiver/registry-fixture.md.`,
    );
  }
}
