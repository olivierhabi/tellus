// ---------------------------------------------------------------------------
// tests/unit/code-repos/contracts/regex-unit.test.ts
//
// Covers contract IDs:
//   G-C-27 apiName regex
//   G-C-28 apiName reserved words
//   G-C-29 branchName regex + structural rules
//   G-C-30 tagName regex (semver)
//   G-C-31 repositoryName regex
//   G-C-32 filePath constraints
//
// Each contract gets a positive + negative case set. A test failing here
// means the implementation accepts something the spec rejects (or vice
// versa) — i.e., the regex contract is broken.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  validateApiName,
  API_NAME_RESERVED,
  validateBranchName,
  validateTagName,
  stripTagVPrefix,
  validateRepositoryName,
  validateFilePath,
} from "../../../../src/services/codeRepos/contracts/regex";

describe("G-C-27 apiName regex: ^[a-z][a-zA-Z0-9]{0,63}$", () => {
  const accepted = ["a", "abc", "myFunction", "a0", "calculateDaysSalesOutstanding"];
  const rejected = [
    "",                  // empty
    "Abc",               // leading uppercase
    "_abc",              // leading underscore
    "1abc",              // leading digit
    "ab-c",              // hyphen disallowed
    "ab.c",              // dot disallowed
    "a".repeat(65),      // too long
    "abc def",           // space disallowed
  ];

  for (const name of accepted) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      expect(validateApiName(name).ok).toBe(true);
    });
  }
  for (const name of rejected) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      expect(validateApiName(name).ok).toBe(false);
    });
  }
});

describe("G-C-28 apiName reserved-words", () => {
  it("reserved list is exactly the 13 words from spec §1.6", () => {
    expect([...API_NAME_RESERVED].sort()).toEqual(
      [
        "action",
        "branch",
        "function",
        "link",
        "object",
        "ontology",
        "ontologyObject",
        "primaryKey",
        "property",
        "relation",
        "repository",
        "rid",
        "typeId",
      ].sort()
    );
  });

  for (const word of API_NAME_RESERVED) {
    it(`rejects reserved word ${JSON.stringify(word)} (case-insensitive)`, () => {
      expect(validateApiName(word).ok).toBe(false);
      expect(validateApiName(word.toUpperCase()).ok).toBe(false);
    });
  }

  it("does NOT reject look-alike words that aren't reserved", () => {
    // 'objects' is plural — not reserved. 'fn' is unrelated.
    expect(validateApiName("objects").ok).toBe(true);
    expect(validateApiName("fn").ok).toBe(true);
  });
});

describe("G-C-29 branchName: regex + structural rules", () => {
  // Spec §1.6 line 86: `^[a-zA-Z0-9._/-]{1,255}$` — the chars between 0-9 and
  // the closing bracket are `.`, `_`, `/`, `-`. Underscore IS allowed.
  const accepted = [
    "main",
    "develop",
    "feature/foo",
    "release/2026.05",
    "hotfix-1",
    "my_branch_with_underscore",   // _ is in the spec set
    "a.b/c-d_e",                    // mixed allowed chars
  ];

  for (const name of accepted) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      expect(validateBranchName(name).ok).toBe(true);
    });
  }

  it("rejects characters outside the spec set (e.g. space, $)", () => {
    expect(validateBranchName("my branch").ok).toBe(false);
    expect(validateBranchName("my$branch").ok).toBe(false);
    expect(validateBranchName("emoji-\u{1F600}-branch").ok).toBe(false);
  });

  it("rejects empty", () => {
    expect(validateBranchName("").ok).toBe(false);
  });

  it("rejects > 255 chars", () => {
    expect(validateBranchName("a".repeat(256)).ok).toBe(false);
    expect(validateBranchName("a".repeat(255)).ok).toBe(true);
  });

  it("rejects '..' substring", () => {
    expect(validateBranchName("foo..bar").ok).toBe(false);
  });

  it("rejects '@{' substring (Git reflog syntax)", () => {
    expect(validateBranchName("foo@{0}").ok).toBe(false);
  });

  it("rejects backslash", () => {
    expect(validateBranchName("foo\\bar").ok).toBe(false);
  });

  it("rejects leading '-'", () => {
    expect(validateBranchName("-foo").ok).toBe(false);
  });

  it("rejects leading '/'", () => {
    expect(validateBranchName("/foo").ok).toBe(false);
  });

  it("rejects trailing '.lock'", () => {
    expect(validateBranchName("foo.lock").ok).toBe(false);
  });
});

describe("G-C-30 tagName: branchName rules + semver", () => {
  const accepted = ["v1.0.0", "1.0.0", "v0.0.1", "v10.20.30", "v1.0.0-beta.1", "v1.0.0-rc.1"];
  const rejected = [
    "v1",
    "v1.0",
    "v01.0.0",          // leading-zero forbidden by semver
    "release-1",        // not semver
    "1.0.0-",           // empty pre-release
    "v1.0.0..",         // branchName rule violation ('..')
  ];

  for (const t of accepted) {
    it(`accepts ${JSON.stringify(t)}`, () => {
      expect(validateTagName(t).ok).toBe(true);
    });
  }
  for (const t of rejected) {
    it(`rejects ${JSON.stringify(t)}`, () => {
      expect(validateTagName(t).ok).toBe(false);
    });
  }

  it("stripTagVPrefix is idempotent", () => {
    expect(stripTagVPrefix("v1.0.0")).toBe("1.0.0");
    expect(stripTagVPrefix("1.0.0")).toBe("1.0.0");
    expect(stripTagVPrefix(stripTagVPrefix("v1.0.0"))).toBe("1.0.0");
  });
});

describe("G-C-31 repositoryName: ^[\\w][\\w \\-.()]{0,127}$", () => {
  const accepted = [
    "My First Function Gena",
    "repo",
    "abc-def.xyz",
    "_underscore",            // first char \w covers underscore
    "r (with parens)",        // first char is \w; parens valid in tail
  ];
  const rejected = [
    "",                       // empty
    " leading-space",         // leading space disallowed by [\w]
    "-leading-hyphen",        // first char must be \w
    "(beta) thing",           // first char `(` is NOT \w → rejected
    "a".repeat(129),          // > 128 total
    "no/slash",               // slash not in allowed set
    "no\\backslash",
  ];

  for (const n of accepted) {
    it(`accepts ${JSON.stringify(n)}`, () => {
      expect(validateRepositoryName(n).ok).toBe(true);
    });
  }
  for (const n of rejected) {
    it(`rejects ${JSON.stringify(n)}`, () => {
      expect(validateRepositoryName(n).ok).toBe(false);
    });
  }
});

describe("G-C-32 filePath constraints", () => {
  const accepted = [
    "src/index.ts",
    "README.md",
    "deeply/nested/path/file.txt",
    "file..with.dots",        // '..' SUBSTRING ok; only '..' SEGMENT forbidden
  ];
  const rejected = [
    "",
    "/abs/path",              // leading /
    ".git",                   // exactly .git
    ".git/config",            // under .git/
    "a/../b",                 // .. segment
    "a//b",                   // empty segment
    "a/b/",                   // trailing slash → empty segment
    "with\u0000nul",          // NUL byte
    "a".repeat(4096),         // exactly 4096 — spec says < 4096
  ];

  for (const p of accepted) {
    it(`accepts ${JSON.stringify(p)}`, () => {
      expect(validateFilePath(p).ok).toBe(true);
    });
  }
  for (const p of rejected) {
    it(`rejects ${JSON.stringify(p).slice(0, 60)}`, () => {
      expect(validateFilePath(p).ok).toBe(false);
    });
  }

  it("accepts a 4095-byte path (just under the limit)", () => {
    expect(validateFilePath("a".repeat(4095)).ok).toBe(true);
  });
});
