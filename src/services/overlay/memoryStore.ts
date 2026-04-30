// ---------------------------------------------------------------------------
// In-process overlay store — Task B7
//
// Used in development, tests, and any deployment where Redis isn't wired
// up. Semantics mirror the Redis implementation: TTL eviction, MGET,
// pseudo-SCAN over a single Object Type. Safe to use in production as a
// last resort — it just doesn't scale past one indexer replica.
// ---------------------------------------------------------------------------

import { OverlayRecord, OverlayStore, parseOverlayKey } from "./overlayStore";

interface Entry {
  record: OverlayRecord;
  expiresAt: number;
}

export class MemoryOverlayStore implements OverlayStore {
  private entries = new Map<string, Entry>();
  private nowFn: () => number;

  constructor(nowFn: () => number = () => Date.now()) {
    this.nowFn = nowFn;
  }

  async put(key: string, record: OverlayRecord, ttlSeconds: number): Promise<void> {
    this.entries.set(key, {
      record,
      expiresAt: this.nowFn() + ttlSeconds * 1000,
    });
  }

  async mget(keys: string[]): Promise<Array<OverlayRecord | null>> {
    const now = this.nowFn();
    return keys.map((k) => {
      const entry = this.entries.get(k);
      if (!entry) return null;
      if (entry.expiresAt <= now) {
        this.entries.delete(k);
        return null;
      }
      return entry.record;
    });
  }

  async scan(objectType: string): Promise<OverlayRecord[]> {
    const now = this.nowFn();
    const out: OverlayRecord[] = [];
    for (const [k, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(k);
        continue;
      }
      const parsed = parseOverlayKey(k);
      if (parsed && parsed.objectType === objectType) {
        out.push(entry.record);
      }
    }
    return out;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async size(): Promise<number> {
    this.sweepExpired();
    return this.entries.size;
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  private sweepExpired(): void {
    const now = this.nowFn();
    for (const [k, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(k);
    }
  }
}
