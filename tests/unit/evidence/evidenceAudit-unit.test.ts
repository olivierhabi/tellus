// ---------------------------------------------------------------------------
// Evidence audit — pure unit lane (file-based only, no PG/Docker/network).
//
// (a) secret scan over the COMMITTED .migration-evidence/ tree must be clean
//     — committing credentials becomes a CI-visible failure;
// (b) manifest builder against a temp fixture dir — schema + sha256 correctness;
// (c) incident validator must pass on the committed incident artifacts;
// (d) redactSensitive redacts JWT / credentialed PG URL / Authorization
//     header / PEM key — idempotently.
// ---------------------------------------------------------------------------

import { describe, expect, it, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { scanDirectory, scanFile } from "../../../scripts/evidence/scan-secrets";
import { buildManifest, CHECKSUM_FILENAME, MANIFEST_FILENAME } from "../../../scripts/evidence/build-manifest";
import { validateIncidents } from "../../../scripts/evidence/validate-incidents";
import { redactSensitive, redactObject } from "../../../scripts/evidence/redact";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const EVIDENCE_ROOT = path.join(REPO_ROOT, ".migration-evidence");

describe("evidence audit", () => {
  it("(a) committed .migration-evidence tree contains no secrets", () => {
    const findings = scanDirectory(EVIDENCE_ROOT);
    expect(
      findings.map((f) => `${f.file}:${f.line} [${f.pattern}]`),
    ).toEqual([]);
  });

  it("(a) scanner flags planted credentials in a fixture file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-scan-"));
    try {
      const bad = path.join(dir, "bad.txt");
      fs.writeFileSync(
        bad,
        [
          "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
          "Authorization: Bearer abcdef123456",
          "DATABASE_URL=postgres://user:hunter2@localhost/db",
          "aws key AKIAIOSFODNN7EXAMPLE",
          "-----BEGIN PRIVATE KEY-----\nMIIB...\n-----END PRIVATE KEY-----",
        ].join("\n"),
      );
      const patterns = scanFile(bad).map((f) => f.pattern);
      expect(patterns).toEqual(
        expect.arrayContaining([
          "jwt",
          "bearer-token",
          "authorization-header",
          "credentialed-postgres-url",
          "aws-access-key",
          "private-key-block",
        ]),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(a) scanner does not flag Temporal base64 history payloads (no dots)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-scan-b64-"));
    try {
      const ok = path.join(dir, "history.json");
      fs.writeFileSync(ok, JSON.stringify({ payload: "eyJjcmVhdGVkIjoiMjAyNi0wNy0zMVQxNTozNTo0MCJ9" }));
      expect(scanFile(ok)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("(b) manifest builder", () => {
    let dir: string;
    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    function fixture(): string {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-manifest-"));
      fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
      fs.writeFileSync(path.join(dir, "b.txt"), "bravo\n");
      fs.writeFileSync(path.join(dir, "a.txt"), "alpha\n");
      fs.writeFileSync(path.join(dir, "sub", "c.json"), "{}");
      return dir;
    }

    it("produces schemaVersion-1 manifest with correct sha256/size entries, sorted by path, excluding itself", () => {
      const root = fixture();
      const manifest = buildManifest(root, "2026-08-01T00:00:00.000Z");

      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.generatedAtUtc).toBe("2026-08-01T00:00:00.000Z");
      expect(manifest.gitCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof manifest.gitStatus).toBe("string");

      const paths = manifest.files.map((f) => f.path);
      expect(paths).toEqual(["a.txt", "b.txt", "sub/c.json"]);
      expect(paths).not.toContain(MANIFEST_FILENAME);

      for (const entry of manifest.files) {
        const abs = path.join(root, entry.path);
        expect(entry.sha256).toBe(
          crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
        );
        expect(entry.sizeBytes).toBe(fs.statSync(abs).size);
        expect(entry.modifiedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
        expect(entry.generatedAtUtc).toBe("2026-08-01T00:00:00.000Z");
        expect(entry.sourceCommand).toMatch(/^(git show [0-9a-f]{40}:|read )/);
        expect(entry.exitCode).toBe(0);
        expect(entry.schemaVersion).toBe(1);
      }
    });

    it("writeManifest excludes the manifest file itself from entries", () => {
      const root = fixture();
      const first = buildManifest(root);
      fs.writeFileSync(path.join(root, MANIFEST_FILENAME), JSON.stringify(first, null, 2));
      fs.writeFileSync(path.join(root, CHECKSUM_FILENAME), "stale checksum\n");
      const second = buildManifest(root);
      expect(second.files.map((f) => f.path)).toEqual(first.files.map((f) => f.path));
    });
  });

  it("(c) incident record and migration mapping validate against the committed tree", () => {
    expect(validateIncidents(EVIDENCE_ROOT)).toEqual([]);
  });

  describe("(d) redactSensitive", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

    it("redacts a JWT idempotently", () => {
      const once = redactSensitive(`auth=${jwt}`);
      expect(once).toBe("auth=<REDACTED:JWT>");
      expect(redactSensitive(once)).toBe(once);
    });

    it("redacts a postgres URL with credentials idempotently", () => {
      const once = redactSensitive("postgres://alice:s3cr3t@db.internal:5432/tellus");
      expect(once).toBe("postgres://<REDACTED>@db.internal:5432/tellus");
      expect(redactSensitive(once)).toBe(once);
    });

    it("redacts an Authorization header idempotently", () => {
      const once = redactSensitive(`Authorization: Bearer ${jwt}`);
      expect(once).toBe("Authorization: <REDACTED>");
      expect(redactSensitive(once)).toBe(once);
    });

    it("redacts a PEM private key block idempotently", () => {
      const once = redactSensitive(`key: ${pem}`);
      expect(once).toBe("key: <REDACTED:PRIVATE_KEY>");
      expect(redactSensitive(once)).toBe(once);
    });

    it("redacts a mixed blob in one pass, idempotently", () => {
      const blob = `hdr Authorization: Bearer ${jwt}\ndb postgres://u:p@h/d\n${pem}`;
      const once = redactSensitive(blob);
      expect(once).not.toContain("s3cr3t");
      expect(once).not.toContain(jwt);
      expect(once).not.toContain("MIIEvw");
      expect(once).not.toContain("u:p@");
      expect(redactSensitive(once)).toBe(once);
    });

    it("redactObject replaces sensitive keys wholesale and deep-redacts values", () => {
      const out = redactObject({
        nested: { password: "hunter2", keep: "fine", conn: "postgres://u:p@h/d" },
        list: [jwt],
        n: 42,
      });
      expect(out.nested.password).toBe("<REDACTED>");
      expect(out.nested.keep).toBe("fine");
      expect(out.nested.conn).toBe("postgres://<REDACTED>@h/d");
      expect(out.list[0]).toBe("<REDACTED:JWT>");
      expect(out.n).toBe(42);
      expect(redactObject(out)).toEqual(out);
    });

    it("honours a configurable value denylist for PII literals", () => {
      const once = redactSensitive("customer 231427fc-62a0-4fb2-b675-0656c60badff seen twice 231427fc-62a0-4fb2-b675-0656c60badff", {
        valueDenylist: ["231427fc-62a0-4fb2-b675-0656c60badff"],
      });
      expect(once).toBe("customer <REDACTED:DENYLISTED_VALUE> seen twice <REDACTED:DENYLISTED_VALUE>");
      expect(redactSensitive(once, { valueDenylist: ["231427fc-62a0-4fb2-b675-0656c60badff"] })).toBe(once);
    });
  });
});
