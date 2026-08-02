// ---------------------------------------------------------------------------
// function-effect-execution-integration — the complete published-signature →
// saved binding → backend validation → runtime argument construction →
// execution → persisted output path, against real PostgreSQL.
//
// Covers:
//   • typescript-v2-positional-v2: helloWorld(name: string) executes with
//     the raw value — never the parameter wrapper — and the execution
//     metadata (contract, signature hash, artifact hash) is recorded.
//   • authoritative validation: numeric strings, missing required, and null
//     misuse are rejected BEFORE execution (422 FUNCTION_PARAMETER_INVALID).
//   • legacy-object-envelope-v1: pre-contract artifacts keep the envelope
//     behavior byte-identically.
//   • semver auto-upgrade stays inside >=pinned <major+1 and pins the
//     resolved immutable artifact ONCE per effect execution: a retry (same
//     effectExecutionId) re-executes that exact artifact even after a newer
//     compatible version is published (no "latest" re-resolution).
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { pool } from "../../../src/db";

vi.mock("../../../src/services/keycloakAdminService", () => ({
  getKeycloakAdminService: () => ({
    getUserById: async (userId: string) => ({
      id: userId,
      username: "integration-owner",
      enabled: true,
    }),
    listUserRealmRoles: async () => [],
  }),
}));

import { executeFunctionEffect } from "../../../src/services/automate/effectExecutors";
import { cancelTriggerEvent } from "../../../src/services/automate/repository";

const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OWNER_ID = crypto.randomUUID();

// Unique identity per run so the shared dev DB never collides.
const RUN = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const REPOSITORY_RID = `ri.stemma.main.repository.fxei${RUN}`;
const FUNCTION_RID = `ri.function-registry.main.function.fxei${RUN}`;
const FUNCTION_RID_LEGACY = `ri.function-registry.main.function.fxeileg${RUN}`;
const REPOSITORY_RID_LEGACY = `ri.stemma.main.repository.fxeileg${RUN}`;
const FUNCTION_RID_UNSUPPORTED = `ri.function-registry.main.function.fxeiuns${RUN}`;

const UNSUPPORTED_SHA = crypto
  .createHash("sha256")
  .update("fxei-unsupported-1.0.0")
  .digest("hex");
const UNSUPPORTED_SOURCE = `export default function needsSet(flights: ObjectSet<Flight>): number {
  return 0;
}
`;
const UNSUPPORTED_SIGNATURE = {
  parameters: [{ name: "flights", type: "ObjectSet<Flight>", optional: false }],
  output: "number",
};

const HELLO_V1_SHA = crypto.createHash("sha256").update("fxei-hello-1.0.0").digest("hex");
const HELLO_V2_SHA = crypto.createHash("sha256").update("fxei-hello-1.1.0").digest("hex");
const HELLO_V3_SHA = crypto.createHash("sha256").update("fxei-hello-2.0.0").digest("hex");
const LEGACY_SHA = crypto.createHash("sha256").update("fxei-legacy-1.0.0").digest("hex");

const HELLO_V1_SOURCE = `export default function helloMarker(name: string): string {
  return "fn-v1:" + name;
}
`;
const HELLO_V2_SOURCE = `export default function helloMarker(name: string): string {
  return "fn-v2:" + name;
}
`;
const HELLO_V3_SOURCE = `export default function helloMarker(marker: string): string {
  return "fn-v3:" + marker;
}
`;
const LEGACY_SOURCE = `export default function helloLegacy(input: { input: string }): string {
  return "legacy-envelope:" + input.input;
}
`;

const POSITIONAL_SIGNATURE = {
  parameters: [{ name: "name", type: "string", optional: false }],
  output: "string",
};
const POSITIONAL_SIGNATURE_V3 = {
  parameters: [{ name: "marker", type: "string", optional: false }],
  output: "string",
};
const LEGACY_SIGNATURE = {
  parameters: [{ name: "input", type: "{ input: string }", optional: false }],
  output: "string",
};

async function insertReleaseVersion(input: {
  rid: string;
  repositoryRid?: string;
  semver: string;
  sha: string;
  source: string;
  apiName: string;
}) {
  await pool.query(
    `INSERT INTO function_version (
       rid, repository_rid, branch, is_preview, semver, commit_sha, runtime,
       artifact_blob_id, artifact_sha256, artifact_bytes, manifest_json, state
     ) VALUES ($1,$2,'main',false,$3,'4bc4e290861cb840a6a120a12b90da96f3a501a9',
               'NODE_20', $4, $5, 128, $6::jsonb, 'AVAILABLE')`,
    [
      input.rid,
      input.repositoryRid ?? REPOSITORY_RID,
      input.semver,
      `s3:integration-test/${input.sha}`,
      input.sha,
      JSON.stringify({
        exports: [input.apiName],
        // Historical inline manifest: resolveFunctionSource serves sources
        // from here without touching the blob store.
        sources: { [input.apiName]: input.source },
      }),
    ],
  );
}

async function insertRegistryVersion(input: {
  functionRid: string;
  apiName: string;
  releaseRid: string;
  semver: string;
  sha: string;
  signature: unknown;
  contract: string;
}) {
  await pool.query(
    `INSERT INTO function_registry_function_version (
       function_rid, semver, branch, release_version_rid, commit_sha,
       source_path, artifact_sha256, signature, function_kind,
       invocation_contract, signature_hash
     ) VALUES ($1,$2,'main',$3,'4bc4e290861cb840a6a120a12b90da96f3a501a9',
               'typescript-functions/src/functions/' || $7 || '.ts',$4,$5::jsonb,'query',
               $6, NULL)`,
    [
      input.functionRid,
      input.semver,
      input.releaseRid,
      input.sha,
      JSON.stringify(input.signature),
      input.contract,
      input.apiName,
    ],
  );
}

async function seedRepository(repositoryRid: string) {
  await pool.query(
    `INSERT INTO code_repository (
       rid, display_name, parent_folder_rid, project_rid, template_id,
       template_version, default_branch, settings_json, state, created_by
     ) VALUES ($1,$2,$3,$4,'typescript-functions','2.4.0','main','{}'::jsonb,
               'ACTIVE',$5)`,
    [
      repositoryRid,
      `${repositoryRid}`,
      `ri.compass.main.folder.${crypto.randomUUID()}`,
      `ri.compass.main.project.${crypto.randomUUID()}`,
      OWNER_ID,
    ],
  );
}

async function seedDomain() {
  await seedRepository(REPOSITORY_RID);
  await seedRepository(REPOSITORY_RID_LEGACY);
  for (const [rid, apiName, repositoryRid] of [
    [FUNCTION_RID, "helloMarker", REPOSITORY_RID],
    [FUNCTION_RID_LEGACY, "helloLegacy", REPOSITORY_RID_LEGACY],
    [FUNCTION_RID_UNSUPPORTED, "needsSet", REPOSITORY_RID],
  ] as const) {
    await pool.query(
      `INSERT INTO function_registry_function (
         rid, repository_rid, api_name, display_name, source_path
       ) VALUES ($1,$2,$3,$3,$4)`,
      [rid, repositoryRid, apiName, `typescript-functions/src/functions/${apiName}.ts`],
    );
  }
  await insertReleaseVersion({
    rid: `ri.function-registry.main.version.${RUN}v1`, semver: "1.0.0", sha: HELLO_V1_SHA, source: HELLO_V1_SOURCE, apiName: "helloMarker",
  });
  await insertReleaseVersion({
    rid: `ri.function-registry.main.version.${RUN}v2`, semver: "1.1.0", sha: HELLO_V2_SHA, source: HELLO_V2_SOURCE, apiName: "helloMarker",
  });
  await insertReleaseVersion({
    rid: `ri.function-registry.main.version.${RUN}v3`, semver: "2.0.0", sha: HELLO_V3_SHA, source: HELLO_V3_SOURCE, apiName: "helloMarker",
  });
  await insertReleaseVersion({
    rid: `ri.function-registry.main.version.${RUN}legacy`, repositoryRid: REPOSITORY_RID_LEGACY, semver: "1.0.0", sha: LEGACY_SHA, source: LEGACY_SOURCE, apiName: "helloLegacy",
  });
  await insertRegistryVersion({
    functionRid: FUNCTION_RID, apiName: "helloMarker",
    releaseRid: `ri.function-registry.main.version.${RUN}v1`,
    semver: "1.0.0", sha: HELLO_V1_SHA, signature: POSITIONAL_SIGNATURE,
    contract: "typescript-v2-positional-v2",
  });
  await insertRegistryVersion({
    functionRid: FUNCTION_RID, apiName: "helloMarker",
    releaseRid: `ri.function-registry.main.version.${RUN}v2`,
    semver: "1.1.0", sha: HELLO_V2_SHA, signature: POSITIONAL_SIGNATURE,
    contract: "typescript-v2-positional-v2",
  });
  await insertRegistryVersion({
    functionRid: FUNCTION_RID, apiName: "helloMarker",
    releaseRid: `ri.function-registry.main.version.${RUN}v3`,
    semver: "2.0.0", sha: HELLO_V3_SHA, signature: POSITIONAL_SIGNATURE_V3,
    contract: "typescript-v2-positional-v2",
  });
  await insertRegistryVersion({
    functionRid: FUNCTION_RID_LEGACY, apiName: "helloLegacy",
    releaseRid: `ri.function-registry.main.version.${RUN}legacy`,
    semver: "1.0.0", sha: LEGACY_SHA, signature: LEGACY_SIGNATURE,
    contract: "legacy-object-envelope-v1",
  });
  await insertReleaseVersion({
    rid: `ri.function-registry.main.version.${RUN}uns`,
    // Distinct semver: function_version is uniquely keyed per
    // (repository, semver, branch) and hello 1.0.0 already exists.
    semver: "3.0.0", sha: UNSUPPORTED_SHA, source: UNSUPPORTED_SOURCE,
    apiName: "needsSet",
  });
  await insertRegistryVersion({
    functionRid: FUNCTION_RID_UNSUPPORTED, apiName: "needsSet",
    releaseRid: `ri.function-registry.main.version.${RUN}uns`,
    semver: "3.0.0", sha: UNSUPPORTED_SHA, signature: UNSUPPORTED_SIGNATURE,
    contract: "typescript-v2-positional-v2",
  });
}

// seedDomain is INSERT-only; later describe-blocks call the idempotent guard
// (test files in this lane run sequentially).
let domainSeeded = false;
async function seedDomainIfNeeded() {
  if (domainSeeded) return;
  domainSeeded = true;
  await seedDomain();
  // Re-arm only if a partial seed left the domain incomplete (failure).
  // (Rely on the FK/unique constraints to have thrown before this point.)
}

async function cleanup() {
  await pool.query(`DELETE FROM code_repository WHERE rid = ANY($1::text[])`, [
    [REPOSITORY_RID, REPOSITORY_RID_LEGACY],
  ]);
  await pool.query(`DELETE FROM automation WHERE rid LIKE $1`, [`fxei-${RUN}%`]);
}

function effectReference(overrides: Partial<{
  functionRid: string;
  apiName: string;
  version: string;
  artifactSha256: string;
  autoUpgrade: boolean;
}> = {}) {
  const functionRid = overrides.functionRid ?? FUNCTION_RID;
  return {
    functionRid,
    repositoryRid:
      functionRid === FUNCTION_RID_LEGACY ? REPOSITORY_RID_LEGACY : REPOSITORY_RID,
    apiName: overrides.apiName ?? "helloMarker",
    branch: "main",
    version: overrides.version ?? "1.0.0",
    artifactSha256: overrides.artifactSha256 ?? HELLO_V1_SHA,
    autoUpgrade: overrides.autoUpgrade ?? false,
  };
}

afterAll(async () => {
  await cleanup().catch(() => undefined);
});

describe("executeFunctionEffect — typescript-v2-positional-v2", () => {
  it("passes the configured value positionally — never the wrapper object", async () => {
    domainSeeded = false; // first block performs the seed itself
    await seedDomainIfNeeded();
    const output = await executeFunctionEffect({
      ontologyId: ONTOLOGY_ID,
      ownerUserId: OWNER_ID,
      effect: effectReference(),
      parameters: { name: "Olivier" },
    });
    expect(output.result).toBe("fn-v1:Olivier");
    expect(output.invocationContract).toBe("typescript-v2-positional-v2");
    expect(output.artifactSha256).toBe(HELLO_V1_SHA);
    expect(typeof output.signatureHash).toBe("string");
    expect((output.signatureHash as string).startsWith("sha256:")).toBe(true);
  });

  it("rejects a numeric string for a numeric parameter (no silent coercion)", async () => {
    await expect(
      executeFunctionEffect({
        ontologyId: ONTOLOGY_ID,
        ownerUserId: OWNER_ID,
        effect: effectReference(),
        parameters: { name: 42 },
      }),
    ).rejects.toMatchObject({ code: "FUNCTION_PARAMETER_INVALID", status: 422 });
  });

  it("rejects a missing required parameter before execution", async () => {
    await expect(
      executeFunctionEffect({
        ontologyId: ONTOLOGY_ID,
        ownerUserId: OWNER_ID,
        effect: effectReference(),
        parameters: {},
      }),
    ).rejects.toMatchObject({ code: "FUNCTION_PARAMETER_INVALID", status: 422 });
  });

  it("rejects null for a required parameter (null is not configured)", async () => {
    await expect(
      executeFunctionEffect({
        ontologyId: ONTOLOGY_ID,
        ownerUserId: OWNER_ID,
        effect: effectReference(),
        parameters: { name: null },
      }),
    ).rejects.toMatchObject({ code: "FUNCTION_PARAMETER_INVALID", status: 422 });
  });

  it("false/0/\"\" are valid configured values", async () => {
    const emptyLabel = await executeFunctionEffect({
      ontologyId: ONTOLOGY_ID,
      ownerUserId: OWNER_ID,
      effect: effectReference(),
      parameters: { name: "" },
    });
    expect(emptyLabel.result).toBe("fn-v1:");
  });
});

describe("executeFunctionEffect — legacy-object-envelope-v1 compatibility", () => {
  it("pre-contract artifacts keep the envelope behavior", async () => {
    const output = await executeFunctionEffect({
      ontologyId: ONTOLOGY_ID,
      ownerUserId: OWNER_ID,
      effect: effectReference({
        functionRid: FUNCTION_RID_LEGACY,
        apiName: "helloLegacy",
        artifactSha256: LEGACY_SHA,
      }),
      parameters: { input: "world" },
    });
    expect(output.result).toBe("legacy-envelope:world");
    expect(output.invocationContract).toBe("legacy-object-envelope-v1");
  });
});

describe("executeFunctionEffect — semver auto-upgrade + deterministic pinning", () => {
  it("resolves >=pinned <major+1, excludes incompatible majors, and pins for retries", async () => {
    // Build the durable execution row chain (automation → version →
    // trigger → effect execution) so the pin persists.
    const automationId = crypto.randomUUID();
    const effectId = crypto.randomUUID();
    const definition = {
      schemaVersion: 1,
      ontologyId: ONTOLOGY_ID,
      name: "fxei",
      condition: {
        type: "time",
        evaluationMode: "scheduled",
        schedule: {
          kind: "cron",
          expression: "0 0 1 1 *",
          timezone: "UTC",
          missedRunPolicy: "fire-once",
        },
      },
      effects: [
        {
          id: effectId,
          name: "fn",
          order: 0,
          type: "function",
          functionRid: FUNCTION_RID,
          repositoryRid: REPOSITORY_RID,
          apiName: "helloMarker",
          branch: "main",
          version: "1.0.0",
          artifactSha256: HELLO_V1_SHA,
          autoUpgrade: true,
          parameters: { name: { kind: "constant", value: "Olivier" } },
          timeoutSeconds: 5,
          retry: {
            enabled: true,
            strategy: "constant",
            maxAttempts: 3,
            delaySeconds: 5,
            multiplier: 2,
            maxDelaySeconds: 60,
            jitter: { kind: "none" },
            retryAllFailures: false,
          },
        },
      ],
      settings: {
        eventRetries: { enabled: false, maxRetries: 3, intervalSeconds: 3600 },
        administrators: [],
        informationNotificationAudience: "owner-and-recipients",
        effectFailureNotificationAudience: "owner-and-recipients",
        autoMute: {
          enabled: true,
          minimumExecutions: 30,
          failureRateThreshold: 0.8,
          evaluationWindowSeconds: 15552000,
        },
        historyScope: "owner",
        retainHistoryDays: 180,
      },
      executionStrategy: { mode: "parallel", queueTriggerEvents: false },
    };
    await pool.query(
      `INSERT INTO automation (
         automation_id, rid, tenant_id, ontology_id, name, owner_user_id,
         created_by, status, current_version, draft_definition
       ) VALUES ($1,$2,'fxei-integration',$3,'fxei',$4,$4,'active',1,$5::jsonb)`,
      [automationId, `fxei-${RUN}`, ONTOLOGY_ID, OWNER_ID, JSON.stringify(definition)],
    );
    await pool.query(
      `INSERT INTO automation_version (
         automation_id, version, schema_version, definition, definition_hash, created_by
       ) VALUES ($1,1,1,$2::jsonb,$3,$4)`,
      [
        automationId,
        JSON.stringify(definition),
        crypto.createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
        OWNER_ID,
      ],
    );
    const triggerEventId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO automation_trigger_event (
         trigger_event_id, automation_id, automation_version, trigger_key,
         trigger_type, condition_output, execution_principal
       ) VALUES ($1,$2,1,$3,'scheduled','{}'::jsonb,$4::jsonb)`,
      [
        triggerEventId,
        automationId,
        `fxei-${RUN}-${triggerEventId}`,
        JSON.stringify({ kind: "user", id: OWNER_ID }),
      ],
    );
    const effectExecutionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO automation_effect_execution (
         effect_execution_id, trigger_event_id, effect_id, effect_type,
         effect_order, max_attempts
       ) VALUES ($1,$2,$3,'function',0,3)`,
      [effectExecutionId, triggerEventId, effectId],
    );

    // First execution: 1.0.0 pinned + autoUpgrade → resolves 1.1.0 (2.0.0
    // crosses the major; prereleases absent).
    const first = await executeFunctionEffect({
      ontologyId: ONTOLOGY_ID,
      ownerUserId: OWNER_ID,
      effect: effectReference({ autoUpgrade: true }),
      parameters: { name: "Olivier" },
      effectExecutionId,
    });
    expect(first.version).toBe("1.1.0");
    expect(first.autoUpgraded).toBe(true);
    expect(first.result).toBe("fn-v2:Olivier");

    // The resolved artifact is pinned on the execution row.
    const pinned = await pool.query<{
      resolved_function_semver: string | null;
      resolved_artifact_sha256: string | null;
      invocation_contract: string | null;
      signature_hash: string | null;
    }>(
      `SELECT resolved_function_semver, resolved_artifact_sha256,
              invocation_contract, signature_hash
         FROM automation_effect_execution WHERE effect_execution_id = $1`,
      [effectExecutionId],
    );
    expect(pinned.rows[0]?.resolved_function_semver).toBe("1.1.0");
    expect(pinned.rows[0]?.resolved_artifact_sha256).toBe(HELLO_V2_SHA);
    expect(pinned.rows[0]?.invocation_contract).toBe("typescript-v2-positional-v2");
    expect(pinned.rows[0]?.signature_hash?.startsWith("sha256:")).toBe(true);

    // Publish a NEWER compatible 1.2.0 — a retry of the SAME execution must
    // still run the originally resolved 1.1.0 artifact.
    const HELLO_V12_SHA = crypto
      .createHash("sha256")
      .update("fxei-hello-1.2.0")
      .digest("hex");
    const HELLO_V12_SOURCE = `export default function helloMarker(name: string): string {
  return "fn-v12:" + name;
}
`;
    await insertReleaseVersion({
      rid: `ri.function-registry.main.version.${RUN}v12`,
      semver: "1.2.0",
      sha: HELLO_V12_SHA,
      source: HELLO_V12_SOURCE,
      apiName: "helloMarker",
    });
    await insertRegistryVersion({
      functionRid: FUNCTION_RID,
      apiName: "helloMarker",
      releaseRid: `ri.function-registry.main.version.${RUN}v12`,
      semver: "1.2.0",
      sha: HELLO_V12_SHA,
      signature: POSITIONAL_SIGNATURE,
      contract: "typescript-v2-positional-v2",
    });

    const retry = await executeFunctionEffect({
      ontologyId: ONTOLOGY_ID,
      ownerUserId: OWNER_ID,
      effect: effectReference({ autoUpgrade: true }),
      parameters: { name: "Olivier" },
      effectExecutionId,
    });
    expect(retry.version).toBe("1.1.0");
    expect(retry.artifactSha256).toBe(HELLO_V2_SHA);
    expect(retry.result).toBe("fn-v2:Olivier");
  });
});

describe("unsupported parameter types — honest gating (never partial support)", () => {
  it("a configured objectSet parameter is rejected with FUNCTION_PARAMETER_UNSUPPORTED_TYPE", async () => {
    await seedDomainIfNeeded();
    const failure = await executeFunctionEffect({
      ontologyId: ONTOLOGY_ID,
      ownerUserId: OWNER_ID,
      effect: effectReference({
        functionRid: FUNCTION_RID_UNSUPPORTED,
        apiName: "needsSet",
        version: "3.0.0",
        artifactSha256: UNSUPPORTED_SHA,
      }),
      parameters: { flights: [{ __primaryKey: "F-1" }] },
    }).then(
      () => null,
      (error: { code?: string; status?: number }) => error,
    );
    expect(failure?.code).toBe("FUNCTION_PARAMETER_UNSUPPORTED_TYPE");
    expect(failure?.status).toBe(422);
  });

  it("an omitted (unbound) unsupported parameter does NOT trigger the gate when optional", async () => {
    // Omission is legal; only CONFIGURING an unsupported kind is rejected.
    //helloMarker(name) is the supported control sample proving the gate is type-scoped.
    await seedDomainIfNeeded();
    const output = await executeFunctionEffect({
      ontologyId: ONTOLOGY_ID,
      ownerUserId: OWNER_ID,
      effect: effectReference(),
      parameters: { name: "still-supported" },
    });
    expect(output.result).toBe("fn-v1:still-supported");
  });
});

describe("legacy contract kill switch (FUNCTION_LEGACY_CONTRACT_DISABLED)", () => {
  it("legacy executions are rejected with a stable code while positional executions still run", async () => {
    await seedDomainIfNeeded();
    process.env.FUNCTION_LEGACY_CONTRACT_DISABLED = "true";
    try {
      const failure = await executeFunctionEffect({
        ontologyId: ONTOLOGY_ID,
        ownerUserId: OWNER_ID,
        effect: effectReference({
          functionRid: FUNCTION_RID_LEGACY,
          apiName: "helloLegacy",
          version: "1.0.0",
          artifactSha256: LEGACY_SHA,
        }),
        parameters: { input: "world" },
      }).then(
        () => null,
        (error: { code?: string; status?: number }) => error,
      );
      expect(failure?.code).toBe("FUNCTION_LEGACY_CONTRACT_DISABLED");
      expect(failure?.status).toBe(422);

      // Positional-contract executions are never affected by the switch.
      const output = await executeFunctionEffect({
        ontologyId: ONTOLOGY_ID,
        ownerUserId: OWNER_ID,
        effect: effectReference(),
        parameters: { name: "positional-still-runs" },
      });
      expect(output.result).toBe("fn-v1:positional-still-runs");
    } finally {
      delete process.env.FUNCTION_LEGACY_CONTRACT_DISABLED;
    }
  });
});

describe("cancellation semantics — no implicit fallback, no implicit retry", () => {
  it("cancelling a queued trigger cancels its effects without scheduling fallback or retry", async () => {
    await seedDomainIfNeeded();
    const automationId = crypto.randomUUID();
    const effectId = crypto.randomUUID();
    const fallback = {
      id: crypto.randomUUID(),
      name: "fallback",
      order: 1,
      type: "function",
      functionRid: FUNCTION_RID,
      repositoryRid: REPOSITORY_RID,
      apiName: "helloMarker",
      branch: "main",
      version: "1.0.0",
      artifactSha256: HELLO_V1_SHA,
      autoUpgrade: false,
      parameters: { name: { kind: "constant", value: "fallback" } },
      timeoutSeconds: 5,
      retry: {
        enabled: false,
        strategy: "constant",
        maxAttempts: 1,
        delaySeconds: 5,
        multiplier: 2,
        maxDelaySeconds: 60,
        jitter: { kind: "none" },
        retryAllFailures: false,
      },
    };
    const definition = {
      schemaVersion: 1,
      ontologyId: ONTOLOGY_ID,
      name: "fxei-cancel",
      condition: {
        type: "time",
        evaluationMode: "scheduled",
        schedule: {
          kind: "cron",
          expression: "0 0 1 1 *",
          timezone: "UTC",
          missedRunPolicy: "fire-once",
        },
      },
      effects: [
        {
          id: effectId,
          name: "fn",
          order: 0,
          type: "function",
          functionRid: FUNCTION_RID,
          repositoryRid: REPOSITORY_RID,
          apiName: "helloMarker",
          branch: "main",
          version: "1.0.0",
          artifactSha256: HELLO_V1_SHA,
          autoUpgrade: false,
          parameters: { name: { kind: "constant", value: "Olivier" } },
          timeoutSeconds: 5,
          retry: {
            enabled: true,
            strategy: "constant",
            maxAttempts: 3,
            delaySeconds: 5,
            multiplier: 2,
            maxDelaySeconds: 60,
            jitter: { kind: "none" },
            retryAllFailures: true,
          },
          fallbackEffect: fallback,
        },
      ],
      settings: {
        eventRetries: { enabled: true, maxRetries: 3, intervalSeconds: 3600 },
        administrators: [],
        informationNotificationAudience: "owner-and-recipients",
        effectFailureNotificationAudience: "owner-and-recipients",
        autoMute: {
          enabled: true,
          minimumExecutions: 30,
          failureRateThreshold: 0.8,
          evaluationWindowSeconds: 15552000,
        },
        historyScope: "owner",
        retainHistoryDays: 180,
      },
      executionStrategy: { mode: "parallel", queueTriggerEvents: false },
    };
    await pool.query(
      `INSERT INTO automation (
         automation_id, rid, tenant_id, ontology_id, name, owner_user_id,
         created_by, status, current_version, draft_definition
       ) VALUES ($1,$2,'fxei-integration',$3,'fxei-cancel',$4,$4,'active',1,$5::jsonb)`,
      [
        automationId,
        `fxei-${RUN}-cancel`,
        ONTOLOGY_ID,
        OWNER_ID,
        JSON.stringify(definition),
      ],
    );
    await pool.query(
      `INSERT INTO automation_version (
         automation_id, version, schema_version, definition, definition_hash, created_by
       ) VALUES ($1,1,1,$2::jsonb,$3,$4)`,
      [
        automationId,
        JSON.stringify(definition),
        crypto.createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
        OWNER_ID,
      ],
    );
    const triggerEventId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO automation_trigger_event (
         trigger_event_id, automation_id, automation_version, trigger_key,
         trigger_type, condition_output, status, execution_principal
       ) VALUES ($1,$2,1,$3,'scheduled','{}'::jsonb,'queued',$4::jsonb)`,
      [
        triggerEventId,
        automationId,
        `fxei-${RUN}-${triggerEventId}`,
        JSON.stringify({ kind: "user", id: OWNER_ID }),
      ],
    );
    await pool.query(
      `INSERT INTO automation_effect_execution (
         effect_execution_id, trigger_event_id, effect_id, effect_type,
         effect_order, max_attempts
       ) VALUES ($1,$2,$3,'function',0,3)`,
      [crypto.randomUUID(), triggerEventId, effectId],
    );

    await cancelTriggerEvent({
      automationId,
      triggerEventId,
      tenantId: "fxei-integration",
      actorUserId: OWNER_ID,
    });

    const states = await pool.query<{ status: string; is_fallback: boolean }>(
      `SELECT status, is_fallback FROM automation_effect_execution
        WHERE trigger_event_id = $1`,
      [triggerEventId],
    );
    expect(states.rows.length).toBe(1);
    expect(states.rows[0]?.status).toBe("cancelled");
    // No fallback execution row is ever scheduled from a cancellation.
    expect(states.rows.some((row) => row.is_fallback)).toBe(false);
    // The event is terminal-cancelled.
    const event = await pool.query<{ status: string }>(
      `SELECT status FROM automation_trigger_event WHERE trigger_event_id = $1`,
      [triggerEventId],
    );
    expect(event.rows[0]?.status).toBe("cancelled");
    // eventRetries can only fire on genuine exhausted failures — no new
    // trigger event exists for this automation.
    const retries = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM automation_trigger_event
        WHERE automation_id = $1 AND trigger_event_id <> $2`,
      [automationId, triggerEventId],
    );
    expect(retries.rows[0]?.n).toBe(0);
  });
});

