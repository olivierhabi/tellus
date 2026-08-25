import { describe, it, expect, vi } from "vitest";
import { parseNotificationSpecs, sendNotifications } from "../../../src/actions/sideEffectNotifier";

describe("sideEffectNotifier", () => {
  describe("parseNotificationSpecs", () => {
    it("returns [] for null/empty sideEffects", () => {
      expect(parseNotificationSpecs(null)).toEqual([]);
      expect(parseNotificationSpecs(undefined)).toEqual([]);
      expect(parseNotificationSpecs({})).toEqual([]);
    });

    it("extracts notifications from side_effects.notifications array", () => {
      const sideEffects = {
        notifications: [
          { type: "email" as const, recipients: ["user@example.com"] },
          { type: "push" as const, recipients: ["admin@example.com"] },
        ],
      };
      const specs = parseNotificationSpecs(sideEffects);
      expect(specs).toHaveLength(2);
      expect(specs[0].type).toBe("email");
      expect(specs[0].recipients).toContain("user@example.com");
    });

    it("skips invalid notification specs", () => {
      const sideEffects = {
        notifications: [
          { type: "email" as const, recipients: ["valid@example.com"] },
          { type: "invalid" as const, recipients: ["test@example.com"] },
          { type: "push" as const, recipients: [] },
        ],
      };
      const specs = parseNotificationSpecs(sideEffects);
      expect(specs).toHaveLength(1);
      expect(specs[0].type).toBe("email");
    });
  });

  describe("sendNotifications", () => {
    it("returns [] when no notifications configured", async () => {
      const payload = {
        executionId: "exec-1",
        actionTypeApiName: "testAction",
        ontologyId: "ont-1",
        result: "success",
        executedBy: "tester",
        affectedObjects: [],
        timestamp: new Date().toISOString(),
      };

      const results = await sendNotifications(null, payload);
      expect(results).toEqual([]);
    });

    it("logs mock notifications to console", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const sideEffects = {
        notifications: [
          { type: "email" as const, recipients: ["user@example.com"], subject: "Test" },
        ],
      };

      const payload = {
        executionId: "exec-2",
        actionTypeApiName: "testAction",
        ontologyId: "ont-1",
        result: "success",
        executedBy: "tester",
        affectedObjects: [],
        timestamp: new Date().toISOString(),
      };

      const results = await sendNotifications(sideEffects, payload);
      
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(true);
      expect(results[0].type).toBe("email");
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[MOCK NOTIFICATION]")
      );

      consoleSpy.mockRestore();
    });

    it("handles multiple notification types", async () => {
      const sideEffects = {
        notifications: [
          { type: "email" as const, recipients: ["user@example.com"] },
          { type: "push" as const, recipients: ["admin@example.com"] },
          { type: "slack" as const, recipients: ["channel-123"] },
        ],
      };

      const payload = {
        executionId: "exec-3",
        actionTypeApiName: "bulkAction",
        ontologyId: "ont-1",
        result: "success",
        executedBy: "tester",
        affectedObjects: [{ objectType: "Order", primaryKey: "O-1", operation: "update" }],
        timestamp: new Date().toISOString(),
      };

      const results = await sendNotifications(sideEffects, payload);
      
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.ok)).toBe(true);
    });
  });
});
