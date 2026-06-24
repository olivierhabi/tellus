/**
 * B3 — In-process event bus for collab events.
 *
 * The B3 WS endpoint (deferred to a follow-up iteration per D-42) will
 * subscribe to this bus per-(rid). For now the bus exists so submitInstructions
 * can emit events deterministically; tests assert the event shape.
 *
 * Three event kinds per spec §B3 streamCollab returns:
 *   - appliedInstruction
 *   - presenceUpdate
 *   - serverRebase
 */

import { EventEmitter } from "node:events";

export interface AppliedInstructionEvent {
  kind: "appliedInstruction";
  rid: string;
  seq: number;
  appliedBy: string;
  branch: string;
  instructionType: string;
  appliedAtMs: number;
}

export interface PresenceUpdateEvent {
  kind: "presenceUpdate";
  rid: string;
  userSubject: string;
  cursor?: { x: number; y: number };
  selectedCardIds: string[];
}

export interface ServerRebaseEvent {
  kind: "serverRebase";
  rid: string;
  toUserSubject: string;
  /** Original index in the local batch. */
  originalIndex: number;
  reason: "lww" | "tombstone";
  droppedInstructionType: string;
}

export type CollabEvent =
  | AppliedInstructionEvent
  | PresenceUpdateEvent
  | ServerRebaseEvent;

class CollabBus extends EventEmitter {}

export const collabBus = new CollabBus();

export function emitCollab(ev: CollabEvent): void {
  collabBus.emit("collab", ev);
  collabBus.emit(`collab:${ev.rid}`, ev);
}

export function onCollab(rid: string, fn: (ev: CollabEvent) => void): () => void {
  collabBus.on(`collab:${rid}`, fn);
  return () => collabBus.off(`collab:${rid}`, fn);
}
