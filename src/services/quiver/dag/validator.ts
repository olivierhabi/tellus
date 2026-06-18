// Quiver B2 — DAG validator.
//
// Implements the six validator rules from quiver-tasks.md §B2:
//   1. Type compatibility on every input edge (covariant).
//   2. Acyclicity.
//   3. Parameter cards have no inputs.
//   4. canvas.ordering[] only references existing card IDs.
//   5. Total cards ≤ 500 (soft warn at 200).
//   6. Total canvases ≤ 50.
//
// validate() returns a structured ValidationResult; never throws on
// rule violations (throws only on programmer errors).

import type { AnalysisDocument, Card, CardId, Canvas } from "../types";
import {
  cardLimitExceeded,
  canvasLimitExceeded,
  cardTypeInputMismatch,
  cyclicDag,
  invalidParameterBinding,
  isQuiverError,
  type QuiverError,
} from "../errors";
import { getCardType, isOutputAcceptable } from "./cardTypeRegistry";
import { buildDag, topologicalOrder, type Dag } from "./topo";
import {
  cardsPerDag,
  dagValidateCardCount,
  dagValidateFailureTotal,
  dagValidateSeconds,
} from "../metrics";

export interface ValidationOk {
  valid: true;
  dag: Dag;
  topologicalOrder: CardId[];
  warnings: string[];
}

export interface ValidationFail {
  valid: false;
  errorCode: string;
  errorName: string;
  parameters: Record<string, unknown>;
  warnings: string[];
}

export type ValidationResult = ValidationOk | ValidationFail;

const SOFT_CARDS = 200;
const HARD_CARDS = 500;
const HARD_CANVASES = 50;

const PARAMETER_TYPES = new Set<string>([
  "PARAMETER_STRING",
  "PARAMETER_NUMBER",
  "PARAMETER_DATETIME",
  "PARAMETER_BOOLEAN",
]);

export function validate(
  doc: Pick<AnalysisDocument, "cards" | "canvases">,
): ValidationResult {
  const t0 = process.hrtime.bigint();
  const result = validateInner(doc);
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;
  const cardCount = Object.keys(doc.cards).length;
  dagValidateCardCount.observe(cardCount);
  cardsPerDag.set(cardCount);
  if (result.valid) {
    dagValidateSeconds.labels({ result: "ok" }).observe(elapsed);
  } else {
    dagValidateSeconds.labels({ result: "fail" }).observe(elapsed);
    dagValidateFailureTotal.labels({ error_name: result.errorName }).inc();
  }
  return result;
}

function validateInner(
  doc: Pick<AnalysisDocument, "cards" | "canvases">,
): ValidationResult {
  const warnings: string[] = [];

  // Rule 5/6: counts.
  const cardCount = Object.keys(doc.cards).length;
  if (cardCount > HARD_CARDS) {
    return failFromError(cardLimitExceeded({ count: cardCount, limit: HARD_CARDS }), warnings);
  }
  if (cardCount > SOFT_CARDS) {
    warnings.push(`card count ${cardCount} exceeds soft limit ${SOFT_CARDS}`);
  }
  const canvasCount = doc.canvases.length;
  if (canvasCount > HARD_CANVASES) {
    return failFromError(canvasLimitExceeded({ count: canvasCount, limit: HARD_CANVASES }), warnings);
  }

  // Rule 4: canvas.ordering must only reference existing cards.
  for (const canvas of doc.canvases) {
    for (const id of canvas.ordering) {
      if (!doc.cards[id]) {
        return {
          valid: false,
          errorCode: "INVALID_ARGUMENT",
          errorName: "Tellus:Quiver:InvalidCanvasOrdering",
          parameters: { canvasId: canvas.id, unknownCardId: id },
          warnings,
        };
      }
    }
  }

  // Rule 3: parameter cards have no inputs.
  for (const id of Object.keys(doc.cards)) {
    const card = doc.cards[id];
    if (PARAMETER_TYPES.has(card.type)) {
      if (Object.keys(card.inputs ?? {}).length > 0) {
        return failFromError(
          invalidParameterBinding({ cardId: id, type: card.type, reason: "parameter cards must have no inputs" }),
          warnings,
        );
      }
    }
  }

  // Rule 1: every binding's accepted types include upstream output.
  for (const id of Object.keys(doc.cards)) {
    const card = doc.cards[id];
    const decl = getCardType(card.type);
    if (!decl) {
      return {
        valid: false,
        errorCode: "INVALID_ARGUMENT",
        errorName: "Tellus:Quiver:UnknownCardType",
        parameters: { cardId: id, type: card.type },
        warnings,
      };
    }
    for (const slot of Object.keys(card.inputs ?? {})) {
      const upstreamId = card.inputs[slot];
      const upstream = doc.cards[upstreamId];
      if (!upstream) {
        return {
          valid: false,
          errorCode: "INVALID_ARGUMENT",
          errorName: "Tellus:Quiver:UnknownCardInBinding",
          parameters: { cardId: id, slot, upstreamId },
          warnings,
        };
      }
      const slotDecl = decl.inputs[slot];
      if (!slotDecl) {
        return failFromError(
          cardTypeInputMismatch({
            cardId: id,
            slot,
            expected: "<undeclared>",
            actual: slotDecl,
            reason: `card type ${card.type} has no slot named '${slot}'`,
          }),
          warnings,
        );
      }
      const upstreamDecl = getCardType(upstream.type);
      if (!upstreamDecl) continue; // already caught above on upstream
      if (
        !isOutputAcceptable(upstreamDecl.output, slotDecl.acceptedTypes) &&
        upstreamDecl.output !== "ANY"
      ) {
        return failFromError(
          cardTypeInputMismatch({
            cardId: id,
            slot,
            expected: slotDecl.acceptedTypes,
            actual: upstreamDecl.output,
            upstreamId,
          }),
          warnings,
        );
      }
    }
  }

  // Rule 2: acyclic via Kahn's. (Self-edges already caught in buildDag.)
  let dag: Dag;
  try {
    dag = buildDag(doc.cards);
  } catch (e) {
    return failFromError(e, warnings);
  }
  let order: string[];
  try {
    order = topologicalOrder(dag);
  } catch (e) {
    if (isQuiverError(e) && e.envelope.errorName.endsWith("CyclicDag")) {
      return failFromError(e, warnings);
    }
    throw e;
  }

  return { valid: true, dag, topologicalOrder: order, warnings };
}

function failFromError(e: unknown, warnings: string[]): ValidationFail {
  if (isQuiverError(e)) {
    return {
      valid: false,
      errorCode: e.envelope.errorCode,
      errorName: e.envelope.errorName,
      parameters: e.envelope.parameters,
      warnings,
    };
  }
  return {
    valid: false,
    errorCode: "INTERNAL",
    errorName: "Tellus:Quiver:Internal",
    parameters: { message: e instanceof Error ? e.message : String(e) },
    warnings,
  };
}
