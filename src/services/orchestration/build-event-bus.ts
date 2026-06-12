// ---------------------------------------------------------------------------
// Build event bus — Redis pub/sub fan-out for live build progress + cancel.
//
// WHY: the SSE endpoint was tailing the durable `orchestration_build_events`
// table on a 1s poll. That is correct and resumable, but adds ~1s of latency
// and one query/second per open connection. This bus publishes each persisted
// event to Redis so SSE clients on ANY app instance receive it within
// milliseconds, and lets a cancel request reach whichever instance actually
// runs the worker.
//
// DURABILITY IS UNCHANGED: the DB remains the source of truth. Redis pub/sub is
// at-most-once and lossy, so it is used ONLY as a low-latency hint — the SSE
// handler still backfills from the DB on connect (resume via Last-Event-ID) and
// keeps a slower DB reconciliation poll as a safety net. If Redis is
// unavailable the bus degrades to a no-op and SSE falls back to a faster DB
// tail; nothing breaks.
//
// One shared subscriber connection fans out to all in-process listeners (keyed
// by buildRid), so N SSE clients cost ONE Redis subscription, not N.
// ---------------------------------------------------------------------------

import { createClient } from "redis";
import { logger } from "../../logging/pino";

type RedisClient = ReturnType<typeof createClient>;

export interface BuildEventMessage {
  buildRid: string;
  /** Append-only event id (the SSE cursor); absent for synthetic snapshots. */
  id?: number;
  kind: string;
  ts: string;
  data?: unknown;
}

const CH_EVENTS = "tellus:build:events";
const CH_CANCEL = "tellus:build:cancel";
const MAX_RECONNECT_ATTEMPTS = 3;

let pub: RedisClient | null = null;
let sub: RedisClient | null = null;
let initPromise: Promise<boolean> | null = null;

const eventHandlers = new Map<string, Set<(m: BuildEventMessage) => void>>();
const cancelHandlers = new Set<(buildRid: string) => void>();

function makeClient(url: string): RedisClient {
  return createClient({
    url,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: (retries: number) =>
        retries >= MAX_RECONNECT_ATTEMPTS ? false : Math.min((retries + 1) * 500, 2_000),
    },
  });
}

async function init(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.info("[build-bus] REDIS_URL unset — live build pub/sub disabled (DB-tail fallback)");
    return false;
  }
  try {
    pub = makeClient(url);
    sub = makeClient(url);
    // node-redis floods 'error' on each reconnect; swallow (connect() rejection
    // below drives the fallback, and pub/publish failures are caught per-call).
    pub.on("error", () => {});
    sub.on("error", () => {});
    await pub.connect();
    await sub.connect();

    await sub.subscribe(CH_EVENTS, (raw: string) => {
      let msg: BuildEventMessage;
      try {
        msg = JSON.parse(raw) as BuildEventMessage;
      } catch {
        return;
      }
      const set = eventHandlers.get(msg.buildRid);
      if (!set) return;
      for (const h of set) {
        try {
          h(msg);
        } catch {
          /* a listener must not break fan-out */
        }
      }
    });
    await sub.subscribe(CH_CANCEL, (raw: string) => {
      for (const h of cancelHandlers) {
        try {
          h(raw);
        } catch {
          /* ignore */
        }
      }
    });

    logger.info("[build-bus] connected — live build pub/sub enabled");
    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[build-bus] Redis unavailable — falling back to DB-tail SSE",
    );
    try {
      await pub?.quit();
    } catch {
      /* ignore */
    }
    try {
      await sub?.quit();
    } catch {
      /* ignore */
    }
    pub = null;
    sub = null;
    return false;
  }
}

/** Lazily connect the bus once; resolves whether it is available. */
export function ensureBus(): Promise<boolean> {
  if (!initPromise) initPromise = init();
  return initPromise;
}

/** Publish a build event to all subscribers across instances. Best-effort. */
export async function publishBuildEvent(msg: BuildEventMessage): Promise<void> {
  if (!(await ensureBus()) || !pub) return;
  try {
    await pub.publish(CH_EVENTS, JSON.stringify(msg));
  } catch {
    /* lossy by design; the SSE DB reconcile is the safety net */
  }
}

/** Register a live-event listener for one build. Returns an unsubscribe. */
export function subscribeBuildEvents(
  buildRid: string,
  handler: (m: BuildEventMessage) => void,
): () => void {
  let set = eventHandlers.get(buildRid);
  if (!set) {
    set = new Set();
    eventHandlers.set(buildRid, set);
  }
  set.add(handler);
  void ensureBus();
  return () => {
    const s = eventHandlers.get(buildRid);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) eventHandlers.delete(buildRid);
  };
}

/** Ask the instance running `buildRid` to abort its worker. Best-effort. */
export async function publishCancelRequest(buildRid: string): Promise<void> {
  if (!(await ensureBus()) || !pub) return;
  try {
    await pub.publish(CH_CANCEL, buildRid);
  } catch {
    /* ignore */
  }
}

/** React to cross-instance cancel requests (the dispatcher registers here). */
export function onCancelRequest(handler: (buildRid: string) => void): () => void {
  cancelHandlers.add(handler);
  void ensureBus();
  return () => cancelHandlers.delete(handler);
}

/** Test/shutdown: close connections + drop listeners. */
export async function shutdownBus(): Promise<void> {
  eventHandlers.clear();
  cancelHandlers.clear();
  try {
    await pub?.quit();
  } catch {
    /* ignore */
  }
  try {
    await sub?.quit();
  } catch {
    /* ignore */
  }
  pub = null;
  sub = null;
  initPromise = null;
}
