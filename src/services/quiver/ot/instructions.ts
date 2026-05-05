/**
 * B3 — `Instruction` discriminated union (12 variants per spec §B3).
 *
 * Validation via zod; the BE accepts only well-formed instructions and
 * returns `Tellus:Quiver:MalformedInstruction` (B3 C-14) on parse failure.
 */

import { z } from "zod";

const positionSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});

const sizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

// RFC 6902 JSON Patch operation; reused for updateCardConfig.
const jsonPatchOpSchema = z.object({
  op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
  path: z.string(),
  value: z.unknown().optional(),
  from: z.string().optional(),
});

const cardSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  inputs: z.record(z.string(), z.string()).default({}),
  config: z.record(z.string(), z.unknown()).default({}),
  hidden: z.boolean().default(false),
});

const canvasSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ordering: z.array(z.string()).default([]),
  placements: z
    .record(
      z.string(),
      z.object({ position: positionSchema, size: sizeSchema }),
    )
    .default({}),
});

export const instructionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("addCard"), card: cardSchema }),
  z.object({
    kind: z.literal("updateCardConfig"),
    cardId: z.string().min(1),
    configJsonPatch: z.array(jsonPatchOpSchema),
    baseCardVersion: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("bindInput"),
    cardId: z.string().min(1),
    slot: z.string().min(1),
    sourceCardId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("unbindInput"),
    cardId: z.string().min(1),
    slot: z.string().min(1),
  }),
  z.object({ kind: z.literal("deleteCard"), cardId: z.string().min(1) }),
  z.object({ kind: z.literal("addCanvas"), canvas: canvasSchema }),
  z.object({ kind: z.literal("deleteCanvas"), canvasId: z.string().min(1) }),
  z.object({
    kind: z.literal("renameCanvas"),
    canvasId: z.string().min(1),
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal("placeCardOnCanvas"),
    cardId: z.string().min(1),
    canvasId: z.string().min(1),
    position: positionSchema,
    size: sizeSchema,
  }),
  z.object({
    kind: z.literal("removeCardFromCanvas"),
    cardId: z.string().min(1),
    canvasId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("reorderCanvasCards"),
    canvasId: z.string().min(1),
    ordering: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("updateParameter"),
    parameterId: z.string().min(1),
    valueJson: z.unknown(),
  }),
  z.object({
    kind: z.literal("setHidden"),
    cardId: z.string().min(1),
    hidden: z.boolean(),
  }),
]);

export type Instruction = z.infer<typeof instructionSchema>;
export type Card = z.infer<typeof cardSchema>;
export type Canvas = z.infer<typeof canvasSchema>;
export type Position = z.infer<typeof positionSchema>;
export type Size = z.infer<typeof sizeSchema>;
export type JsonPatchOp = z.infer<typeof jsonPatchOpSchema>;

export const instructionListSchema = z.array(instructionSchema);

/**
 * Stable enum-list of every instruction kind. Used by transformer to
 * exhaustively match (compile-time check via `Instruction["kind"]`).
 */
export const INSTRUCTION_KINDS = [
  "addCard",
  "updateCardConfig",
  "bindInput",
  "unbindInput",
  "deleteCard",
  "addCanvas",
  "deleteCanvas",
  "renameCanvas",
  "placeCardOnCanvas",
  "removeCardFromCanvas",
  "reorderCanvasCards",
  "updateParameter",
  "setHidden",
] as const;

export type InstructionKind = (typeof INSTRUCTION_KINDS)[number];
