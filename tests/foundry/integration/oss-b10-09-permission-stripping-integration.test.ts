import { describe, expect, it } from "vitest";
import { PermissionStripper } from "../../../src/services/oss/permissionStripper";

const svc = new PermissionStripper();

describe("B10.09 — permission stripping (mandatory_control)", () => {
  it("strips DENY hits, keeps ALLOW hits in original order", async () => {
    const r = await svc.strip({
      principalId: 'u1',
      operationId: 'compass:view-resource',
      hits: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      ridResolver: (h) => `ri.compass.main.object.${h.id}`,
      evaluateFn: async (inputs) => {
        const m = new Map();
        for (const i of inputs) {
          const dec = i.resourceRid.endsWith('.b') ? 'DENY' : 'ALLOW';
          m.set(`${i.principalId}|${i.operationId}|${i.resourceRid}`, { decision: dec });
        }
        return m;
      },
    });
    expect(r.allowed.map((h) => h.id)).toEqual(['a', 'c']);
    expect(r.denied).toBe(1);
  });

  it("empty hits returns immediately without calling evaluateFn", async () => {
    let called = 0;
    const r = await svc.strip({
      principalId: 'u1', operationId: 'op', hits: [], ridResolver: () => 'x',
      evaluateFn: async () => { called++; return new Map(); },
    });
    expect(r.allowed).toEqual([]);
    expect(r.denied).toBe(0);
    expect(called).toBe(0);
  });

  it("missing decision treated as DENY (mandatory deny)", async () => {
    const r = await svc.strip({
      principalId: 'u1', operationId: 'op',
      hits: [{ id: 'a' }, { id: 'b' }],
      ridResolver: (h) => `ri.x.${h.id}`,
      evaluateFn: async () => new Map(), // returns empty Map → all DENY-by-default
    });
    expect(r.allowed.length).toBe(0);
    expect(r.denied).toBe(2);
  });

  it("all ALLOW returns all hits unchanged", async () => {
    const r = await svc.strip({
      principalId: 'u1', operationId: 'op',
      hits: [{ id: 'a' }, { id: 'b' }],
      ridResolver: (h) => `ri.x.${h.id}`,
      evaluateFn: async (inp) => {
        const m = new Map();
        for (const i of inp) m.set(`${i.principalId}|${i.operationId}|${i.resourceRid}`, { decision: 'ALLOW' });
        return m;
      },
    });
    expect(r.allowed.length).toBe(2);
    expect(r.denied).toBe(0);
  });
});
