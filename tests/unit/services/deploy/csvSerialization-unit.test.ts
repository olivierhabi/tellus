// ---------------------------------------------------------------------------
// Unit tests for services/deploy/csvSerialization (extracted from
// deploymentService.ts — RFC 4180 CSV wire format for deploy artifacts).
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import {
  escapeCsvField,
  rowsToCsvBuffer,
} from "../../../../src/services/deploy/csvSerialization";

describe("escapeCsvField", () => {
  it("renders null/undefined as empty string", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
  });

  it("renders Date values as ISO-8601", () => {
    expect(escapeCsvField(new Date("2026-01-02T03:04:05.000Z"))).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });

  it("passes through plain values unquoted", () => {
    expect(escapeCsvField("hello")).toBe("hello");
    expect(escapeCsvField(42)).toBe("42");
    expect(escapeCsvField(true)).toBe("true");
  });

  it("quotes fields containing comma, quote, LF or CR (RFC 4180)", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
});

describe("rowsToCsvBuffer", () => {
  it("emits header + one line per row with a trailing newline", () => {
    const buf = rowsToCsvBuffer(
      [
        { name: "id", type: "integer" },
        { name: "name", type: "string" },
      ],
      [
        { id: 1, name: "Olivier" },
        { id: 2, name: "Doe, John" },
      ],
    );
    expect(buf.toString("utf-8")).toBe('id,name\n1,Olivier\n2,"Doe, John"\n');
  });

  it("emits header-only output for an empty row set", () => {
    const buf = rowsToCsvBuffer([{ name: "id", type: "integer" }], []);
    expect(buf.toString("utf-8")).toBe("id\n");
  });

  it("escapes header names the same way as field values", () => {
    const buf = rowsToCsvBuffer([{ name: 'we"ird', type: "string" }], [
      { 'we"ird': "x" },
    ]);
    expect(buf.toString("utf-8")).toBe('"we""ird"\nx\n');
  });

  it("renders missing row keys as empty fields (undefined semantics)", () => {
    const buf = rowsToCsvBuffer(
      [
        { name: "a", type: "string" },
        { name: "b", type: "string" },
      ],
      [{ a: "only-a" }],
    );
    expect(buf.toString("utf-8")).toBe("a,b\nonly-a,\n");
  });
});
