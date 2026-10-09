// Pins the invariant checker's locator grammar to the changelog's strict
// parser (parseFoundryMarker) and the expected-violation model of the
// simulated fleet. DB behaviour is covered by
// tests/funnel/integration/funnel-fleet-sim.lane.test.ts.
import { describe, expect, it } from "vitest";
import { classifyLocator, INVARIANT_SEVERITY } from "../../../src/services/funnel/funnelInvariants";
import { parseFoundryMarker } from "../../../src/services/funnel/temporal/activities";
import { generateHealthyRows } from "../../../scripts/sim/tellusFleetSim";

const U1 = "7ff4f9f6-de66-4dec-b117-19176feb66db";
const U2 = "7e7c2da4-a837-498c-974a-d8d167b568ac";
const CASES = [
  `gate4/accounts.csv#foundry-dataset:${U1}#object-type:${U2}`,
  `a/b/c.tsv#foundry-dataset:${U1.toUpperCase()}#object-type:${U2}`,
  `#foundry-dataset:${U1}#object-type:${U2}`,
  `gate4/accounts.csv#foundry-dataset:not-a-uuid#object-type:${U2}`,
  `gate4/accounts.csv#foundry-dataset:${U1}`,
  `gate4/accounts.csv#foundry-dataset:${U1}#object-type:${U2}#extra`,
  `gate4/accounts.csv`,
];

describe("classifyLocator mirrors parseFoundryMarker", () => {
  for (const c of CASES) {
    it(c, () => {
      let parsed: string | null = null;
      try {
        parsed = parseFoundryMarker(c).s3Key;
      } catch {
        parsed = null;
      }
      const got = classifyLocator(c, true);
      if (parsed === null) expect(got.kind).toBe("malformed");
      else expect(got).toEqual({ kind: "foundry", key: parsed });
    });
  }

  it("plain paths without the bridge id are legacy-local, with it they are malformed", () => {
    expect(classifyLocator("data/x.csv")).toEqual({ kind: "legacy-local" });
    expect(classifyLocator("data/x.csv", true).kind).toBe("malformed");
  });

  it("every code has a severity", () => {
    expect(Object.values(INVARIANT_SEVERITY).every((s) => s === "error" || s === "warn")).toBe(true);
  });
});

describe("simulator data model", () => {
  it("is deterministic and last-wins", () => {
    const a = generateHealthyRows(1_000, 0.2, 7);
    const b = generateHealthyRows(1_000, 0.2, 7);
    expect(a.rows).toEqual(b.rows);
    expect(a.lastWins.size).toBeLessThan(1_000);
    const last = new Map<string, string[]>();
    for (const r of a.rows) last.set(r[1], r);
    expect([...a.lastWins.entries()]).toEqual([...last.entries()]);
  });
});
