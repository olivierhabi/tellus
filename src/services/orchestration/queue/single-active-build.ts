// ---------------------------------------------------------------------------
// B4 — Single-active-build lock (spec §B4 line 199; criterion 5).
//
// Ensures that at most one BullMQ job exists per `importRid` at a time.
// Two simultaneous `execute` calls on the same import must coalesce to ONE
// job (the second returns the same buildRid as the first).
//
// Implementation uses Redis SET NX EX with a 1h TTL. If Redis isn't
// available (unit-test profile), falls back to an in-process Map (single-
// process semantics still preserved).
// ---------------------------------------------------------------------------

const TTL_SECONDS = Number(process.env.TELLUS_BUILD_LOCK_TTL_SEC ?? 3600);

type RedisLike = {
  set: (
    key: string,
    value: string,
    options?: { NX?: boolean; EX?: number; PX?: number },
  ) => Promise<string | null>;
  get: (key: string) => Promise<string | null>;
  del: (key: string) => Promise<number>;
};

let redis: RedisLike | null = null;
const memory = new Map<string, { buildRid: string; expiresMs: number }>();

export function setRedisClient(client: RedisLike): void {
  redis = client;
}

/**
 * Acquire the per-import lock. If already held, returns the existing
 * buildRid. Otherwise stores `desiredBuildRid` and returns it.
 *
 * The caller can compare returned vs desired to detect coalescing.
 */
export async function acquireOrJoin(
  importRid: string,
  desiredBuildRid: string,
): Promise<{ buildRid: string; coalesced: boolean }> {
  const key = `tellus:build:lock:${importRid}`;
  if (redis) {
    const ok = await redis.set(key, desiredBuildRid, {
      NX: true,
      EX: TTL_SECONDS,
    });
    if (ok === "OK") return { buildRid: desiredBuildRid, coalesced: false };
    const existing = (await redis.get(key)) ?? desiredBuildRid;
    return { buildRid: existing, coalesced: existing !== desiredBuildRid };
  }
  const now = Date.now();
  const cur = memory.get(key);
  if (cur && cur.expiresMs > now) {
    return { buildRid: cur.buildRid, coalesced: cur.buildRid !== desiredBuildRid };
  }
  memory.set(key, {
    buildRid: desiredBuildRid,
    expiresMs: now + TTL_SECONDS * 1000,
  });
  return { buildRid: desiredBuildRid, coalesced: false };
}

/** Release the lock (call on terminal state). */
export async function release(importRid: string): Promise<void> {
  const key = `tellus:build:lock:${importRid}`;
  if (redis) {
    await redis.del(key);
    return;
  }
  memory.delete(key);
}

/** Test helper: reset state. */
export function _reset(): void {
  memory.clear();
  redis = null;
}
