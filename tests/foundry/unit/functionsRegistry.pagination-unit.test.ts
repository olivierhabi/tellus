import { describe, expect, it } from "vitest";
import {
  decodeRegistryCursor,
  encodeRegistryCursor,
} from "../../../src/services/functionsRegistry/pagination";

describe("Functions Registry pagination cursor", () => {
  const cursor = {
    publishedAt: "2026-07-20T18:04:01.463Z",
    rid: "ri.function-registry.main.function.cd13c5a9-8cbb-4032-a3f6-150081d6d573",
  };

  it("round-trips the stable keyset", () => {
    expect(decodeRegistryCursor(encodeRegistryCursor(cursor))).toEqual(cursor);
  });

  it.each([
    "not-base64-json",
    Buffer.from("{}", "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ ...cursor, publishedAt: "invalid" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ ...cursor, rid: "not-a-function-rid" }), "utf8").toString("base64url"),
  ])("rejects malformed or incomplete cursors", (value) => {
    expect(decodeRegistryCursor(value)).toBeNull();
  });
});
