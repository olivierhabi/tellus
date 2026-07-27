// ---------------------------------------------------------------------------
// Unit tests for src/actions/notificationProviders.ts (Phase 6.4 portions)
// + src/models/notificationInbox.ts.
//
// Mocks `../db` (for the model) + `../models/notificationInbox` (for the
// InApp provider). Each test drives the InApp provider's send + asserts
// the structured NotificationDeliveryResult.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/models/notificationInbox", () => ({
  insertNotification: vi.fn(),
}));
vi.mock("../../../src/services/webhookSafeTransport", () => ({
  assertEgressUrl: vi.fn(() => ({ kind: "ok" })),
  deriveIdempotencyKey: vi.fn(() => "idem-key-stub"),
  DEFAULT_EGRESS_POLICY: { httpsRequired: true },
}));

import { inAppNotificationProvider, emailNotificationProvider } from "../../../src/actions/notificationProviders";
import { insertNotification } from "../../../src/models/notificationInbox";

const mockedInsert = insertNotification as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedInsert.mockReset();
  mockedInsert.mockResolvedValue({
    notification_id: "uuid-1",
    recipient_user_id: "user-uuid-1",
    template_id: "tpl",
    template_parameters: {},
    channel: "in_app",
    action_type_api_name: "at1",
    execution_id: "exec-1",
    ontology_id: "ont-1",
    created_at: "2026-07-25T00:00:00Z",
    read_at: null,
  });
});

describe("inAppNotificationProvider (Phase 6.4 real storage)", () => {
  it("inserts a notification_inbox row when recipient.userUuid is set", async () => {
    const r = await inAppNotificationProvider.send({
      templateId: "tpl",
      templateParameters: { x: 1 },
      channel: "in_app",
      recipient: { principal: "alice@test", principalKind: "user", userUuid: "user-uuid-1" },
      executionId: "exec-1",
      actionTypeApiName: "at1",
      ontologyId: "ont-1",
    });
    expect(r.ok).toBe(true);
    expect(r.receiptId).toBe("inapp:uuid-1");
    expect(mockedInsert).toHaveBeenCalledWith(expect.objectContaining({
      recipientUserId: "user-uuid-1",
      templateId: "tpl",
      channel: "in_app",
      actionTypeApiName: "at1",
      executionId: "exec-1",
      ontologyId: "ont-1",
    }));
  });

  it("skips with stub receipt when recipient.userUuid is undefined (recipient-data-filter allowed affectedObjects=[]) ", async () => {
    const r = await inAppNotificationProvider.send({
      templateId: "tpl",
      templateParameters: {},
      channel: "in_app",
      recipient: { principal: "alice@test", principalKind: "user" },
      executionId: "exec-1",
      actionTypeApiName: "at1",
      ontologyId: "ont-1",
    });
    expect(r.ok).toBe(true);
    expect(r.receiptId).toContain("inapp:skipped:");
    expect(mockedInsert).not.toHaveBeenCalled();
  });

  it("throws on model-layer PG failure so the worker retries via the bounded backoff", async () => {
    mockedInsert.mockRejectedValue(new Error("PG down"));
    await expect(inAppNotificationProvider.send({
      templateId: "tpl",
      templateParameters: {},
      channel: "in_app",
      recipient: { principal: "alice@test", principalKind: "user", userUuid: "user-uuid-1" },
      executionId: "exec-1",
      actionTypeApiName: "at1",
      ontologyId: "ont-1",
    })).rejects.toThrow(/notification_inbox row/);
  });
});

describe("emailNotificationProvider (Phase 6.4 real HTTP transport)", () => {
  it("stub-logs when EMAIL_PROVIDER_URL is unset", async () => {
    delete process.env.EMAIL_PROVIDER_URL;
    const r = await emailNotificationProvider.send({
      templateId: "tpl",
      templateParameters: {},
      channel: "email",
      recipient: { principal: "alice@test", principalKind: "user" },
      executionId: "exec-1",
      actionTypeApiName: "at1",
      ontologyId: "ont-1",
    });
    expect(r.ok).toBe(true);
    expect(r.receiptId ?? "").toMatch(/^email-stub:/);
  });

  it("throws a structured 'SMTP needs nodemailer' error when URL is smtps://", async () => {
    process.env.EMAIL_PROVIDER_URL = "smtps://smtp.sendgrid.net:587";
    await expect(emailNotificationProvider.send({
      templateId: "tpl",
      templateParameters: {},
      channel: "email",
      recipient: { principal: "alice@test", principalKind: "user" },
      executionId: "exec-1",
      actionTypeApiName: "at1",
      ontologyId: "ont-1",
    })).rejects.toThrow(/nodemailer/);
    delete process.env.EMAIL_PROVIDER_URL;
  });
});
