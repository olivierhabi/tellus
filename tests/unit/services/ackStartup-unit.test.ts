// Unit matrix for the LINK_INDEX_ACK_REQUIRED boot precondition (Fix 2).
import { describe, expect, it } from "vitest";
import { assertLinkIndexAckStartupConfig } from "../../../src/services/serving/ackStartup";

describe("assertLinkIndexAckStartupConfig — LINK_INDEX_ACK_REQUIRED boot gate", () => {
  it("flag off ⇒ no-op for ANY serving mode (the contract doesn't vouch anything)", () => {
    expect(() =>
      assertLinkIndexAckStartupConfig({
        LINK_INDEX_ACK_REQUIRED: "false",
        SERVING_STORE_MODE: "legacy",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      assertLinkIndexAckStartupConfig({} as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("flag on + indexed ⇒ ready (the read path goes through the indexed store)", () => {
    expect(() =>
      assertLinkIndexAckStartupConfig({
        LINK_INDEX_ACK_REQUIRED: "true",
        SERVING_STORE_MODE: "indexed",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("flag on + legacy default ⇒ REFUSES boot with a flag-naming, single unambiguous error", () => {
    expect(() =>
      assertLinkIndexAckStartupConfig({
        LINK_INDEX_ACK_REQUIRED: "true",
      } as NodeJS.ProcessEnv),
    ).toThrow(/LINK_INDEX_ACK_REQUIRED requires SERVING_STORE_MODE=indexed/);
  });

  it("flag on + explicit 'legacy' / 'shadow' ⇒ REFUSES (shadow runs the index beside legacy reads)", () => {
    for (const mode of ["legacy", "shadow", "csv", "weird"]) {
      expect(() =>
        assertLinkIndexAckStartupConfig({
          LINK_INDEX_ACK_REQUIRED: "true",
          SERVING_STORE_MODE: mode,
        } as NodeJS.ProcessEnv),
      ).toThrow();
    }
  });

  it("flag on + 'Indexed' (case-insensitive) ⇒ ready (servingFlags lower-cases the env)", () => {
    expect(() =>
      assertLinkIndexAckStartupConfig({
        LINK_INDEX_ACK_REQUIRED: "true",
        SERVING_STORE_MODE: "Indexed",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
