// B9 — Tool registry + authorization filter (B9 C-05, C-07).

import { describe, it, expect } from "vitest";
import {
  buildAuthorizedManifest,
  fullToolManifest,
} from "../../../src/services/quiver/aip/tools";
import type {
  AuthPort,
  UserSubject,
} from "../../../src/services/quiver/aip/types";

const allowAll: AuthPort = {
  async canApplyAction() {
    return true;
  },
  async isAuthorized() {
    return true;
  },
};

const denyApply: AuthPort = {
  async canApplyAction() {
    return false;
  },
  async isAuthorized() {
    return true;
  },
};

const u: UserSubject = {
  userRid: "ri.multipass.main.user.alice",
  orgRid: "ri.multipass.main.org.test",
  groups: [],
};

describe("B9 — tool registry", () => {
  it("B9 C-05: manifest exposes exactly the 6 named tools", () => {
    const names = fullToolManifest().map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "apply_action",
        "command",
        "function_call",
        "object_query",
        "ontology_context",
        "update_application_variable",
      ].sort(),
    );
  });

  it("B9 C-07: apply_action removed when no candidate actionTypeRid", async () => {
    const { manifest, removed } = await buildAuthorizedManifest({
      user: u,
      branch: "trunk",
      auth: allowAll,
    });
    expect(removed).toContain("apply_action");
    expect(manifest.find((t) => t.name === "apply_action")).toBeUndefined();
    expect(manifest.length).toBe(5);
  });

  it("B9 C-07: apply_action removed when canApplyAction returns false", async () => {
    const { manifest, removed } = await buildAuthorizedManifest({
      user: u,
      branch: "trunk",
      candidateActionTypeRid: "ri.action.x",
      auth: denyApply,
    });
    expect(removed).toContain("apply_action");
    expect(manifest.find((t) => t.name === "apply_action")).toBeUndefined();
  });

  it("B9 C-07: apply_action retained when canApplyAction returns true", async () => {
    const { manifest, removed } = await buildAuthorizedManifest({
      user: u,
      branch: "trunk",
      candidateActionTypeRid: "ri.action.x",
      auth: allowAll,
    });
    expect(removed).not.toContain("apply_action");
    expect(manifest.find((t) => t.name === "apply_action")).toBeDefined();
    expect(manifest.length).toBe(6);
  });

  it("B9 C-07: branch is forwarded on canApplyAction", async () => {
    const seen: string[] = [];
    const auth: AuthPort = {
      async canApplyAction(input) {
        seen.push(input.branch);
        return true;
      },
      async isAuthorized() {
        return true;
      },
    };
    await buildAuthorizedManifest({
      user: u,
      branch: "feature-x",
      candidateActionTypeRid: "ri.action.y",
      auth,
    });
    expect(seen).toEqual(["feature-x"]);
  });
});
