// ---------------------------------------------------------------------------
// B2 unit tests — AES-GCM round-trip + the regression test for criterion 1
// (scan logs/audit output for plaintext bytes).
//
// These tests do NOT require Testcontainers; they exercise the in-memory
// primitives only. The full integration suite (PG-backed vault.repo + audit)
// lives under tests/connectivity/integration/b2-integration.test.ts.
// ---------------------------------------------------------------------------

import { beforeAll, describe, it, expect } from "vitest";
import {
  encrypt,
  decrypt,
  generateDek,
} from "../../../src/services/connectivity/credentials/aesgcm";
import { LocalAesGcmAdapter } from "../../../src/lib/kms/adapters/local-aesgcm";
import { sanitizeForLog } from "../../../src/lib/errors/envelope";

describe("aesgcm primitive", () => {
  it("round-trips plaintext through encrypt/decrypt", () => {
    const dek = generateDek();
    const plaintext = Buffer.from("hunter2-super-secret-password");
    const blob = encrypt(plaintext, dek);
    const back = Buffer.from(decrypt(blob, dek));
    expect(back.equals(plaintext)).toBe(true);
  });

  it("rejects tampered ciphertext (AEAD tag mismatch)", () => {
    const dek = generateDek();
    const blob = encrypt(Buffer.from("data"), dek);
    // Mutate the ciphertext region (after the 29-byte header: 1 ver + 12 iv + 16 tag).
    const mutated = Buffer.from(blob);
    mutated[mutated.length - 1] ^= 0xff;
    expect(() => decrypt(mutated, dek)).toThrow();
  });

  it("rejects wrong DEK", () => {
    const dek = generateDek();
    const dek2 = generateDek();
    const blob = encrypt(Buffer.from("data"), dek);
    expect(() => decrypt(blob, dek2)).toThrow();
  });

  it("rejects undersized DEK (32-byte invariant)", () => {
    expect(() => encrypt(Buffer.from("data"), new Uint8Array(16))).toThrow();
  });
});

describe("LocalAesGcmAdapter (dev KMS)", () => {
  beforeAll(() => {
    // Adapter loads KEK from TELLUS_LOCAL_KEK_B64; provide a deterministic
    // 32-byte test key so this suite stays Docker-free.
    process.env.TELLUS_LOCAL_KEK_B64 = Buffer.alloc(32, 0x7).toString("base64");
  });

  it("wraps then unwraps a DEK identity", async () => {
    const kms = new LocalAesGcmAdapter();
    const dek = generateDek();
    const wrapped = await kms.wrap(dek, { tenant: "rra-default" });
    const back = await kms.unwrap(wrapped, { tenant: "rra-default" });
    expect(Buffer.from(back).equals(Buffer.from(dek))).toBe(true);
  });

  it("tenant binding: unwrap with wrong tenant fails", async () => {
    const kms = new LocalAesGcmAdapter();
    const dek = generateDek();
    const wrapped = await kms.wrap(dek, { tenant: "tenant-a" });
    await expect(kms.unwrap(wrapped, { tenant: "tenant-b" })).rejects.toThrow();
  });
});

describe("regression: no plaintext bytes leak through envelope sanitizer (criterion 1)", () => {
  it("strips credential-shaped keys from error parameters", () => {
    const dirty = {
      connectionRid: "ri.connectivity.main.connection.abc",
      password: "hunter2",
      apiKey: "sk-live-PLAINTEXT",
      sslPassword: "another",
      nested: { secret: "deep-plaintext" },
    };
    const cleaned = sanitizeForLog(dirty);
    const serialized = JSON.stringify(cleaned);
    expect(serialized).not.toMatch(/hunter2/);
    expect(serialized).not.toMatch(/sk-live-PLAINTEXT/);
    expect(serialized).not.toMatch(/deep-plaintext/);
    // Non-credential fields survive.
    expect(serialized).toContain("ri.connectivity.main.connection.abc");
  });
});
