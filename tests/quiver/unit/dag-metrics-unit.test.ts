// Quiver B2 C-18 — metrics emission.

import { describe, expect, it } from "vitest";
import { register } from "prom-client";
import { validate } from "../../../src/services/quiver/dag";
import type { AnalysisDocument, Card } from "../../../src/services/quiver/types";

const c = (id: string, type: string, inputs: Record<string, string> = {}): Card =>
  ({ id, type, config: {}, inputs, hidden: false }) as Card;

describe("DagValidator metrics (B2 C-18)", () => {
  it("emits validate_seconds, validate_card_count, cards_per_dag on success", async () => {
    validate({
      cards: { $A: c("$A", "OBJECT_SET") },
      canvases: [],
    });
    const text = await register.metrics();
    expect(text).toContain("tellus_quiver_dag_validate_seconds");
    expect(text).toContain("tellus_quiver_dag_validate_card_count");
    expect(text).toContain("tellus_quiver_cards_per_dag");
  });

  it("increments validate_failure_total on rejection (with bounded error_name label)", async () => {
    // Force an InvalidParameterBinding rejection.
    validate({
      cards: {
        $A: c("$A", "OBJECT_SET"),
        $P: c("$P", "PARAMETER_STRING", { src: "$A" }),
      },
      canvases: [],
    });
    const text = await register.metrics();
    expect(text).toMatch(/tellus_quiver_dag_validate_failure_total\{[^}]*error_name="Tellus:Quiver:InvalidParameterBinding"[^}]*\}\s+\d/);
  });

  it("metric label cardinality is bounded (no per-RID labels) — G-09", async () => {
    const text = await register.metrics();
    // Per-RID would look like rid="ri.quiver..."
    expect(text).not.toMatch(/tellus_quiver_dag_[^{]+\{[^}]*rid=/);
  });
});
