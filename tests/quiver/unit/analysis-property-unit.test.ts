// Quiver B1 — property tests (B1 C-26).
//
// "Random valid AnalysisDocument survives serialize → store → load → equality"
// — the storage round-trip is exercised in integration tests; this unit
// version exercises serialize → parse → equality on the AnalysisDocument
// zod schema with randomized values, ensuring the wire shape is stable.

import { describe, expect, it } from "vitest";
import { AnalysisDocument } from "../../../src/services/quiver/types";

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDoc(seed: number): unknown {
  // Cheap PRNG for deterministic-ish randomness without a dep.
  let s = seed;
  const next = (): number => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  // UUID segment lengths per RFC 9562: 8-4-4-4-12.
  const rid =
    "ri.tellus-quiver.main.analysis." +
    [8, 4, 4, 4, 12]
      .map((n) =>
        Array.from(
          { length: n },
          () => "0123456789abcdef"[Math.floor(next() * 16)],
        ).join(""),
      )
      // segment[2] sets version nibble to 7 (UUIDv7); segment[3] sets variant
      // bits to 10xx (i.e. 8/9/a/b). Keep the rest random.
      .map((seg, i) => {
        if (i === 2) return "7" + seg.slice(1);
        if (i === 3) {
          const variant = "89ab"[Math.floor(next() * 4)];
          return variant + seg.slice(1);
        }
        return seg;
      })
      .join("-");
  return {
    rid,
    parentFolderRid: "ri.compass.main.folder." + Math.floor(next() * 1e6),
    displayName: `q-${Math.floor(next() * 1e6)}`,
    description: next() > 0.5 ? "lorem".repeat(Math.floor(next() * 100)) : null,
    notebookMetadata: {
      defaultLoad: rand(["ALL", "VISIBLE"] as const),
      cardIdCounter: Math.floor(next() * 1000),
      branchRid: next() > 0.7 ? "topic-x" : null,
    },
    cards: {},
    canvases: [],
    parameters: {},
    currentVersion: Math.floor(next() * 100),
    etag: 'W/"' + Math.floor(next() * 1e16).toString(16) + '"',
    createdAt: "2026-05-04T12:00:00.000Z",
    updatedAt: "2026-05-04T12:00:00.000Z",
    createdBy: "ri.multipass.main.user.alice",
    markings: [],
    isDeleted: false,
    deletedAt: null,
  };
}

describe("AnalysisDocument property test (B1 C-26)", () => {
  it("B1 C-26: 100 random valid documents survive parse → JSON → parse equality", () => {
    for (let i = 0; i < 100; i++) {
      const raw = randomDoc(i + 1);
      const a = AnalysisDocument.parse(raw);
      const json = JSON.stringify(a);
      const b = AnalysisDocument.parse(JSON.parse(json));
      expect(b).toEqual(a);
    }
  });
});
