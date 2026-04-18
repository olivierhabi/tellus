// ---------------------------------------------------------------------------
// objectDataStore.ts — unit tests for `deriveSchemaStatus`
//
// Locks the 6-state → 3-label mapping the UI's Schema badge depends on.
// This is a pure function; the table below is the source of truth for
// what each `object_type_active_index_version.state` renders as.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  deriveSchemaStatus,
  IndexVersionRow,
} from "../../../src/routes/objectDataStore";

// Helper: build a row with defaults so each test only highlights the
// state under assertion.
function row(state: IndexVersionRow["state"]): IndexVersionRow {
  return {
    active_version: 1,
    pending_version: null,
    state,
    updated_at: "2026-04-18T00:00:00.000Z",
  };
}

describe("deriveSchemaStatus — pure-function contract", () => {
  it("treats a missing row as 'up_to_date' (steady state — never started a replacement)", () => {
    expect(deriveSchemaStatus(null)).toBe("up_to_date");
  });

  describe("states that map to 'up_to_date'", () => {
    it("LIVE", () => {
      expect(deriveSchemaStatus(row("LIVE"))).toBe("up_to_date");
    });
    it("CUTOVER_COMPLETE", () => {
      expect(deriveSchemaStatus(row("CUTOVER_COMPLETE"))).toBe("up_to_date");
    });
    it("OLD_INDEX_DROPPED", () => {
      expect(deriveSchemaStatus(row("OLD_INDEX_DROPPED"))).toBe("up_to_date");
    });
  });

  describe("states that map to 'migrating' (UI shows amber badge)", () => {
    it("REPLACEMENT_BACKFILL", () => {
      expect(deriveSchemaStatus(row("REPLACEMENT_BACKFILL"))).toBe("migrating");
    });
    it("REPLACEMENT_SOAK", () => {
      expect(deriveSchemaStatus(row("REPLACEMENT_SOAK"))).toBe("migrating");
    });
    it("CUTOVER_PENDING", () => {
      expect(deriveSchemaStatus(row("CUTOVER_PENDING"))).toBe("migrating");
    });
  });

  describe("states that map to 'out_of_date' (UI shows red badge)", () => {
    it("ROLLED_BACK", () => {
      expect(deriveSchemaStatus(row("ROLLED_BACK"))).toBe("out_of_date");
    });
  });

  it("covers every ReplacementState value (no silent gap)", () => {
    // Exhaustiveness guard: if someone adds a new value to the
    // ReplacementState union without updating the switch, the compiler
    // should fail. This runtime test catches the case where TS strict
    // mode isn't enough (e.g. the new value is type-asserted at a call
    // site). We enumerate every current value and expect a defined
    // mapping — `undefined` would fail the assertion.
    const allStates: IndexVersionRow["state"][] = [
      "LIVE",
      "REPLACEMENT_BACKFILL",
      "REPLACEMENT_SOAK",
      "CUTOVER_PENDING",
      "CUTOVER_COMPLETE",
      "OLD_INDEX_DROPPED",
      "ROLLED_BACK",
    ];
    for (const state of allStates) {
      const status = deriveSchemaStatus(row(state));
      expect(["up_to_date", "migrating", "out_of_date"]).toContain(status);
    }
  });
});
