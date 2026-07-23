import { describe, expect, it } from "vitest";
import { formatActionType } from "../../../src/routes/actionTypes";

describe("formatActionType", () => {
  it("preserves persisted creation metadata on every read surface", () => {
    const formatted = formatActionType({
      action_type_id: "action-rid",
      api_name: "updateOrder",
      display_name: "Update order",
      description: "",
      icon_name: "array-timestamp",
      icon_color: "#28A39A",
      save_location_rid: "ri.compass.main.project.project-1",
      parameters: [],
      rules: [],
      submission_criteria: null,
      side_effects: null,
      max_affected_objects: 10_000,
      is_enabled: true,
      created_at: "2026-07-23T00:00:00.000Z",
      updated_at: "2026-07-23T00:00:00.000Z",
      created_by: "user-1",
    });

    expect(formatted).toMatchObject({
      rid: "action-rid",
      icon: "array-timestamp",
      iconColor: "#28A39A",
      saveLocationRid: "ri.compass.main.project.project-1",
    });
  });

  it("returns explicit nulls for legacy rows without metadata", () => {
    expect(formatActionType({}).icon).toBeNull();
    expect(formatActionType({}).iconColor).toBeNull();
    expect(formatActionType({}).saveLocationRid).toBeNull();
  });
});
