// ---------------------------------------------------------------------------
// Overlay store singleton / factory — Task B7
//
// Wire-up is lazy: we attempt to connect to Redis on first use, fall back
// to an in-memory store if Redis is disabled (REDIS_URL unset) or
// unreachable. Once the fallback kicks in, it stays — we don't keep
// retrying on every query. A process restart re-tries Redis.
//
// Tests call `setOverlayStoreForTesting` to inject a MemoryOverlayStore
// directly.
// ---------------------------------------------------------------------------

import { OverlayStore } from "./overlayStore";
import { MemoryOverlayStore } from "./memoryStore";
import { RedisOverlayStore, MinimalRedisClient } from "./redisStore";

let store: OverlayStore | null = null;
let connecting: Promise<OverlayStore> | null = null;

export async function getOverlayStore(): Promise<OverlayStore> {
  if (store) return store;
  if (connecting) return connecting;

  connecting = (async () => {
    const url = process.env.REDIS_URL;
    if (!url) {
      console.log("[overlay] REDIS_URL unset — using in-memory overlay store");
      store = new MemoryOverlayStore();
      return store;
    }
    try {
      // Dynamic require so Redis is a soft dep. The `redis` npm package is
      // node-redis v4 compatible.
      const mod = await tryLoadRedis();
      if (!mod) {
        console.warn(
          "[overlay] 'redis' npm package not installed — falling back to in-memory store"
        );
        store = new MemoryOverlayStore();
        return store;
      }
      // F-P4-05: Redis client with bounded connect + socket timeouts.
      // Default node-redis@4 connectTimeout is 5000 ms; set it explicitly
      // so the contract is visible. The reconnect strategy gives up after a
      // few attempts (returning false) so a Redis outage cannot keep a
      // background reconnect loop — and its 'error' event spam — alive for
      // the life of the process. Per the module contract, once we fall back
      // to the in-memory store it stays; a process restart re-tries Redis.
      const MAX_RECONNECT_ATTEMPTS = 3;
      const client = mod.createClient({
        url,
        socket: {
          connectTimeout: 5_000,
          reconnectStrategy: (retries: number) =>
            retries >= MAX_RECONNECT_ATTEMPTS
              ? false
              : Math.min((retries + 1) * 500, 2_000),
        },
      });
      // node-redis emits 'error' on every failed (re)connect attempt. Log
      // only the first so a transient outage doesn't flood the log; the
      // connect() rejection below carries the failure into the fallback path.
      let loggedError = false;
      client.on("error", (err: Error) => {
        if (loggedError) return;
        loggedError = true;
        console.warn(`[overlay] Redis error: ${describeRedisError(err)}`);
      });
      // F-P4-05b: hard deadline on the connect handshake. A paused/frozen
      // Redis container (cgroup freezer) still accepts the TCP SYN at the
      // kernel, so node-redis's `socket.connectTimeout` (which only bounds
      // the SYN/ACK) fires successfully — but the frozen process never
      // answers the AUTH/HELLO command, so `client.connect()` never
      // settles. Because the resulting Promise is cached in `connecting`
      // above, EVERY subsequent read that reaches the overlay would block
      // on it forever. Race the connect against a wall-clock deadline so
      // we fall back to the in-memory store within a bounded time instead
      // of hanging the whole data plane for the process lifetime.
      const CONNECT_DEADLINE_MS = Number(
        process.env.REDIS_CONNECT_DEADLINE_MS ?? 3_000,
      );
      await Promise.race([
        client.connect(),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error("redis connect deadline exceeded")),
            CONNECT_DEADLINE_MS,
          ),
        ),
      ]);
      const adapter: MinimalRedisClient = {
        set: (k, v, o) => client.set(k, v, o as never),
        mGet: (keys) => client.mGet(keys),
        del: (keys) => client.del(keys as never),
        scan: async (cursor, opts) => {
          const res = (await client.scan(cursor as never, opts as never)) as {
            cursor: number | string;
            keys: string[];
          };
          return { cursor: res.cursor, keys: res.keys };
        },
        dbSize: () => client.dbSize(),
      };
      store = new RedisOverlayStore(adapter);
      console.log("[overlay] connected to Redis at", url);
      return store;
    } catch (err) {
      console.warn(
        `[overlay] Redis connect failed (${describeRedisError(err)}) — falling back to in-memory store`
      );
      store = new MemoryOverlayStore();
      return store;
    }
  })();

  const resolved = await connecting;
  connecting = null;
  return resolved;
}

interface RedisClientOptions {
  url: string;
  socket?: {
    connectTimeout?: number;
    reconnectStrategy?: (retries: number) => number | false | Error;
  };
}

interface RedisLikeClientFactory {
  createClient(opts: RedisClientOptions): RedisLikeClient;
}

interface RedisLikeClient {
  connect(): Promise<void>;
  on(event: string, handler: (err: Error) => void): void;
  set(key: string, value: string, opts?: unknown): Promise<unknown>;
  mGet(keys: string[]): Promise<Array<string | null>>;
  del(keys: unknown): Promise<number>;
  scan(cursor: unknown, opts: unknown): Promise<unknown>;
  dbSize(): Promise<number>;
}

async function tryLoadRedis(): Promise<RedisLikeClientFactory | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("redis") as RedisLikeClientFactory;
  } catch {
    return null;
  }
}

// node-redis surfaces connection failures (e.g. ECONNREFUSED) as an
// AggregateError whose own `.message` is empty — the real cause lives in
// `.errors[]`. Unwrap it so the log carries something actionable instead of
// a bare "Redis error:".
function describeRedisError(err: unknown): string {
  const agg = err as { errors?: Array<{ message?: string; code?: string }> } | null;
  if (agg && Array.isArray(agg.errors) && agg.errors.length > 0) {
    const inner = agg.errors[0];
    return inner?.message || inner?.code || "connection failed";
  }
  const e = err as { message?: string; code?: string } | null;
  return e?.message || e?.code || String(err);
}

export function setOverlayStoreForTesting(s: OverlayStore | null): void {
  store = s;
  connecting = null;
}

/**
 * Switch the overlay to the in-memory store for the rest of the process
 * lifetime. Called when a live Redis-backed overlay operation blows its read
 * budget — a connected-but-stuck Redis client would otherwise queue every
 * subsequent read behind the hung operation (accumulating memory and 504-ing
 * every search/list). The overlay is an optimisation (recent-edit visibility
 * within a ~1s SLO); degrading to memory loses only the cross-process
 * recent-edit window, never correctness. A process restart re-tries Redis.
 */
export function markOverlayDegraded(): void {
  if (store instanceof MemoryOverlayStore) return;
  console.warn(
    "[overlay] degrading to in-memory store — a Redis operation exceeded the read budget",
  );
  store = new MemoryOverlayStore();
  connecting = null;
}
