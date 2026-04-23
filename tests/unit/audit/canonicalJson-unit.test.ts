// ---------------------------------------------------------------------------
// tests/unit/audit/canonicalJson-unit.test.ts
//
// Tests the deterministic JSON serializer used by the audit hash chain
// (F-P3-11, migration 036, src/services/audit/canonicalJson.ts).
//
// The critical invariant: structurally equivalent inputs must produce
// byte-identical output. A non-deterministic serializer would break the
// forward-walk verifier and render the entire audit tamper-evidence
// mechanism useless.
//
// Negative tests cover every CanonicalJsonError exit the serializer
// advertises. The "key-reorder" test is the explicit pre-fix negative:
// against a naive `JSON.stringify(value)` baseline the key-reordered
// variant would produce a different hash.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  canonicalSha256Hex,
  CanonicalJsonError,
} from "../../../src/services/audit/canonicalJson";

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

describe("canonicalJson — positive determinism", () => {
  it("produces byte-identical output for key-reordered objects", () => {
    const a = { foo: 1, bar: 2, baz: 3 };
    const b = { baz: 3, foo: 1, bar: 2 };
    const c = { bar: 2, baz: 3, foo: 1 };
    const ca = canonicalJson(a);
    const cb = canonicalJson(b);
    const cc = canonicalJson(c);
    expect(ca).toBe(cb);
    expect(cb).toBe(cc);
    expect(ca).toBe('{"bar":2,"baz":3,"foo":1}');
    // And the sha256 is identical too — the primary hash-chain invariant.
    expect(sha(ca)).toBe(sha(cb));
  });

  it("preserves array order (arrays are ordered, not sets)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, 2, 3])).toBe("[1,2,3]");
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it("nested objects: keys sorted at every level", () => {
    const v = {
      outer: {
        z: 1,
        a: { nested_z: 3, nested_a: 4 },
        m: [2, 1],
      },
    };
    expect(canonicalJson(v)).toBe(
      '{"outer":{"a":{"nested_a":4,"nested_z":3},"m":[2,1],"z":1}}',
    );
  });

  it("normalizes -0 to 0", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(0)).toBe("0");
    expect(sha(canonicalJson(-0))).toBe(sha(canonicalJson(0)));
  });

  it("integer vs float rendering matches V8 shortest round-trip", () => {
    expect(canonicalJson(1)).toBe("1");
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson(1e21)).toBe("1e+21");
    expect(canonicalJson(0.1)).toBe("0.1");
  });

  it("skips undefined properties to match JSON.stringify elision", () => {
    const a = { x: 1, y: undefined };
    const b = { x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("null is encoded as 'null'", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson({ x: null })).toBe('{"x":null}');
  });

  it("booleans encoded as lowercase literals", () => {
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
  });

  it("empty object + empty array", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });

  it("strings with control characters are JSON-escaped", () => {
    expect(canonicalJson("a\nb\tc")).toBe('"a\\nb\\tc"');
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
  });
});

describe("canonicalJson — negative (CanonicalJsonError)", () => {
  it("rejects NaN", () => {
    expect(() => canonicalJson(NaN)).toThrow(CanonicalJsonError);
  });

  it("rejects +Infinity / -Infinity", () => {
    expect(() => canonicalJson(Infinity)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(-Infinity)).toThrow(CanonicalJsonError);
  });

  it("rejects undefined as a direct argument", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
  });

  it("rejects BigInt", () => {
    expect(() => canonicalJson(10n as unknown)).toThrow(CanonicalJsonError);
  });

  it("rejects Symbol", () => {
    expect(() => canonicalJson(Symbol("s") as unknown)).toThrow(CanonicalJsonError);
  });

  it("rejects function", () => {
    expect(() => canonicalJson(() => 1)).toThrow(CanonicalJsonError);
  });

  it("rejects Date (caller must ISO-string explicitly)", () => {
    expect(() => canonicalJson(new Date("2026-04-23T00:00:00Z"))).toThrow(
      CanonicalJsonError,
    );
  });

  it("rejects Map / Set / Buffer (non-plain prototype)", () => {
    expect(() => canonicalJson(new Map() as unknown)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Set() as unknown)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Buffer.from("x") as unknown)).toThrow(CanonicalJsonError);
  });

  it("detects circular references", () => {
    const o: Record<string, unknown> = { x: 1 };
    o.self = o;
    expect(() => canonicalJson(o)).toThrow(CanonicalJsonError);
  });

  it("rejects depth > MAX_DEPTH=64", () => {
    let nested: unknown = 1;
    for (let i = 0; i < 70; i++) nested = { next: nested };
    expect(() => canonicalJson(nested)).toThrow(CanonicalJsonError);
  });

  it("CanonicalJsonError exposes .code and .path", () => {
    try {
      canonicalJson({ a: NaN });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CanonicalJsonError);
      expect((err as CanonicalJsonError).code).toBe("CANONICAL_JSON_ERROR");
      expect((err as CanonicalJsonError).path).toBe("$.a");
    }
  });
});

describe("canonicalSha256Hex — sha256 convenience", () => {
  it("matches sha256(canonicalJson(x))", () => {
    const x = { z: 1, a: "hello" };
    const direct = sha(canonicalJson(x));
    const convenience = canonicalSha256Hex(x);
    expect(convenience).toBe(direct);
  });

  it("is deterministic across key-reorder", () => {
    expect(canonicalSha256Hex({ a: 1, b: 2 })).toBe(
      canonicalSha256Hex({ b: 2, a: 1 }),
    );
  });

  it("F-P3-11 negative: naive JSON.stringify would NOT satisfy this invariant", () => {
    // Pre-canonicalJson behaviour: use raw JSON.stringify. Different key
    // insertion orders produce different bytes — this is the bug the
    // canonical serializer closes.
    const a = { foo: 1, bar: 2 };
    const b = { bar: 2, foo: 1 };
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    // But canonicalJson does satisfy it.
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});
