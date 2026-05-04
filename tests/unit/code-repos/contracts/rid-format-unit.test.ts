// ---------------------------------------------------------------------------
// tests/unit/code-repos/contracts/rid-format-unit.test.ts
//
// Covers contract IDs:
//   G-C-01 RID format: ri.<service>.<instance>.<type>.<uuidv4>
//   G-C-02 Reserved namespaces stemma, code-repos, jemma, functions, osdk
//   G-C-03 Repository RID: ri.stemma.main.repository.<uuid>
//   G-C-04 JobSpec RID: ri.code-repos.main.job-spec.<uuid>
//   G-C-05 Function-version RID: ri.functions.main.function-version.<uuid>
//   G-C-06 CI run RID: ri.jemma.main.run.<uuid>
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  isRid,
  parseRid,
  mintRepositoryRid,
  mintJobSpecRid,
  mintFunctionVersionRid,
  mintRunRid,
  assertRepositoryRid,
  assertJobSpecRid,
  SERVICE_NAMESPACES,
  UUIDV4_REGEX,
} from "../../../../src/services/codeRepos/contracts/rid";

describe("G-C-01 RID format", () => {
  it("isRid accepts a well-formed RID", () => {
    const rid = "ri.stemma.main.repository.b9b8e3a4-1234-4abc-89ef-0123456789ab";
    expect(isRid(rid)).toBe(true);
  });

  it("rejects empty / non-string", () => {
    expect(isRid("")).toBe(false);
  });

  it("rejects uppercase characters anywhere", () => {
    expect(isRid("RI.stemma.main.repository.b9b8e3a4-1234-4abc-89ef-0123456789ab")).toBe(false);
    expect(isRid("ri.Stemma.main.repository.b9b8e3a4-1234-4abc-89ef-0123456789ab")).toBe(false);
    expect(isRid("ri.stemma.main.repository.B9B8E3A4-1234-4abc-89ef-0123456789ab")).toBe(false);
  });

  it("rejects wrong component count", () => {
    expect(isRid("ri.stemma.main.repository")).toBe(false);
    expect(isRid("ri.stemma.main.repository.b9b8e3a4-1234-4abc-89ef-0123456789ab.extra")).toBe(false);
  });

  it("rejects non-UUIDv4 final segment", () => {
    // Version=3, not 4
    expect(isRid("ri.stemma.main.repository.b9b8e3a4-1234-3abc-89ef-0123456789ab")).toBe(false);
    // No hyphens
    expect(isRid("ri.stemma.main.repository.b9b8e3a412344abc89ef0123456789ab")).toBe(false);
  });

  it("rejects unknown service namespace (G-C-02)", () => {
    expect(isRid("ri.unknownsvc.main.repository.b9b8e3a4-1234-4abc-89ef-0123456789ab")).toBe(false);
  });
});

describe("G-C-02 reserved namespaces", () => {
  it("namespace set is exactly {stemma, code-repos, jemma, functions, osdk}", () => {
    const values = Object.values(SERVICE_NAMESPACES).sort();
    expect(values).toEqual(["code-repos", "functions", "jemma", "osdk", "stemma"]);
  });
});

describe("G-C-03..06 typed RID minters", () => {
  it("mintRepositoryRid → ri.stemma.main.repository.<uuid>", () => {
    const rid = mintRepositoryRid();
    expect(rid).toMatch(/^ri\.stemma\.main\.repository\./);
    const parsed = parseRid(rid);
    expect(parsed).not.toBeNull();
    expect(parsed?.service).toBe("stemma");
    expect(parsed?.instance).toBe("main");
    expect(parsed?.type).toBe("repository");
    expect(UUIDV4_REGEX.test(parsed?.uuid ?? "")).toBe(true);
  });

  it("mintJobSpecRid → ri.code-repos.main.job-spec.<uuid>", () => {
    const rid = mintJobSpecRid();
    expect(rid).toMatch(/^ri\.code-repos\.main\.job-spec\./);
    expect(parseRid(rid)?.type).toBe("job-spec");
  });

  it("mintFunctionVersionRid → ri.functions.main.function-version.<uuid>", () => {
    const rid = mintFunctionVersionRid();
    expect(rid).toMatch(/^ri\.functions\.main\.function-version\./);
    expect(parseRid(rid)?.type).toBe("function-version");
  });

  it("mintRunRid → ri.jemma.main.run.<uuid>", () => {
    const rid = mintRunRid();
    expect(rid).toMatch(/^ri\.jemma\.main\.run\./);
    expect(parseRid(rid)?.type).toBe("run");
  });

  it("two minted RIDs differ (UUID uniqueness)", () => {
    expect(mintRepositoryRid()).not.toBe(mintRepositoryRid());
  });
});

describe("typed RID asserts (cross-task confusion guard)", () => {
  it("assertRepositoryRid throws on a JobSpec RID", () => {
    const jobSpec = mintJobSpecRid();
    expect(() => assertRepositoryRid(jobSpec)).toThrow(/Expected service=stemma/);
  });

  it("assertJobSpecRid throws on a Repository RID", () => {
    const repo = mintRepositoryRid();
    expect(() => assertJobSpecRid(repo)).toThrow(/Expected service=code-repos/);
  });

  it("assertRepositoryRid returns parsed components on a Repository RID", () => {
    const repo = mintRepositoryRid();
    expect(assertRepositoryRid(repo).type).toBe("repository");
  });
});
