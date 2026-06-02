// Unit tests for the single-active-build coalescing lock (spec §B4 criterion 5).
//
// The lock guarantees at most one in-flight build per importRid: a second
// `execute` while a build is running must COALESCE onto the first build's rid,
// and the lock must be RELEASABLE so a later execute (after the build ends)
// starts a fresh build. These are deterministic here; the live e2e cannot
// assert coalescing reliably because dev builds finish in milliseconds.
import { beforeEach, describe, it, expect } from "vitest";
import {
  acquireOrJoin,
  release,
  _reset,
} from "../../../src/services/orchestration/queue/single-active-build";

const IMP_A = "ri.magritte.main.extract.aaaaaaaa";
const IMP_B = "ri.magritte.main.extract.bbbbbbbb";

describe("single-active-build lock (in-memory profile)", () => {
  beforeEach(() => {
    _reset();
  });

  it("first acquire wins; a concurrent acquire coalesces onto it", async () => {
    const first = await acquireOrJoin(IMP_A, "build-1");
    expect(first).toEqual({ buildRid: "build-1", coalesced: false });

    const second = await acquireOrJoin(IMP_A, "build-2");
    expect(second).toEqual({ buildRid: "build-1", coalesced: true });
  });

  it("a repeat acquire with the SAME desired rid is not flagged coalesced", async () => {
    await acquireOrJoin(IMP_A, "build-1");
    const again = await acquireOrJoin(IMP_A, "build-1");
    expect(again).toEqual({ buildRid: "build-1", coalesced: false });
  });

  it("release frees the lock so the next execute starts a fresh build", async () => {
    await acquireOrJoin(IMP_A, "build-1");
    await release(IMP_A);
    const next = await acquireOrJoin(IMP_A, "build-2");
    expect(next).toEqual({ buildRid: "build-2", coalesced: false });
  });

  it("locks are isolated per import", async () => {
    await acquireOrJoin(IMP_A, "build-A");
    const b = await acquireOrJoin(IMP_B, "build-B");
    expect(b).toEqual({ buildRid: "build-B", coalesced: false });
  });
});
