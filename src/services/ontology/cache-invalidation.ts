/**
 * B10 — Ontology cache invalidation.
 * Publishes binding-change events on the local EventEmitter for the same process,
 * and (when REDIS_URL is set) on `tellus.ontology.changes` Redis pub/sub for the rest
 * of the cluster — Quiver and Object Explorer subscribe and bust their schema caches.
 */
import { EventEmitter } from "events";

export type OntologyChangeEvent =
  | { kind: "binding.created"; rid: string; object_type_rid: string }
  | { kind: "binding.updated"; rid: string; object_type_rid: string }
  | { kind: "binding.deleted"; rid: string; object_type_rid: string }
  | { kind: "link-type.added"; rid: string };

export const ontologyBus = new EventEmitter();

let redisPub: any | null = null;
let redisSub: any | null = null;

export async function initOntologyPubSub(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  try {
    const { Redis } = await import("ioredis");
    redisPub = new Redis(url);
    redisSub = new Redis(url);
    await redisSub.subscribe("tellus.ontology.changes");
    redisSub.on("message", (_ch: string, payload: string) => {
      try {
        const evt = JSON.parse(payload) as OntologyChangeEvent;
        ontologyBus.emit(evt.kind, evt);
      } catch {
        /* ignore malformed */
      }
    });
  } catch {
    // ioredis not installed in test environments; in-process bus still works.
    redisPub = null;
    redisSub = null;
  }
}

export async function publishOntologyChange(evt: OntologyChangeEvent): Promise<void> {
  ontologyBus.emit(evt.kind, evt);
  if (redisPub) {
    await redisPub.publish("tellus.ontology.changes", JSON.stringify(evt));
  }
}

export function onOntologyChange(
  kind: OntologyChangeEvent["kind"],
  fn: (evt: OntologyChangeEvent) => void,
): () => void {
  ontologyBus.on(kind, fn);
  return () => ontologyBus.off(kind, fn);
}
