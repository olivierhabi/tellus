// B9.04 — MergeChanges phase: deduplicate the Change stream from the
// changelog phase by primary_key, keeping only the last version per PK.
// DELETE wins over UPSERT at the same version (Foundry semantics).
import type { Change } from "./b9Changelog";

export interface MergedChange extends Change {}

export class B9MergeChanges {
  /**
   * Collapse a sequence of Changes by primary_key.  For each PK the
   * record with the highest version is kept.  When versions are equal,
   * a DELETE supersedes an UPSERT.
   */
  merge(changes: Change[]): MergedChange[] {
    const map = new Map<string, MergedChange>();
    for (const c of changes) {
      const cur = map.get(c.primaryKey);
      if (!cur) { map.set(c.primaryKey, c); continue; }
      if (c.version > cur.version) { map.set(c.primaryKey, c); continue; }
      if (c.version === cur.version && c.operation === 'DELETE' && cur.operation !== 'DELETE') {
        map.set(c.primaryKey, c);
      }
    }
    return Array.from(map.values());
  }
}
export const b9MergeChanges = new B9MergeChanges();
