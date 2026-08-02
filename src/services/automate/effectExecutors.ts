import { pool } from "../../db";
import {
  getNotificationProvider,
  type NotificationChannel,
} from "../../actions/notificationProviders";
import {
  makeProductionRecipientResolver,
  recipientVisibilityFilter,
} from "../../actions/notificationRecipientFilter";
import { getKeycloakAdminService } from "../keycloakAdminService";
import {
  parseSignatureParameters,
  type SandboxBinding,
} from "../functionRuntime";
import { runSandboxedWithSdkAsync } from "../functionWorkerPool";
import { resolveFunctionSource } from "../functionsRegistry/artifactStore";
import { loadOntologySnapshot } from "../functions/ontologyRuntime";
import {
  isInvocationContract,
  readCanonicalSignature,
  computeSignatureHash,
  runtimeParametersFromCanonical,
  LEGACY_OBJECT_ENVELOPE_V1,
  TYPESCRIPT_V2_POSITIONAL_V2,
  type InvocationContract,
} from "../functions/canonicalSignature";
import {
  ParameterValidationError,
  resolvePositionalArguments,
  unsupportedConfiguredParameters,
} from "../functions/parameterValidation";
import { resolveCompatibleUpgrade } from "../functions/versionResolution";
import {
  executionPolicy,
  isLegacyContractExecutionAllowed,
} from "../functions/executionPolicy";
import {
  functionEffectExecutionsTotal,
  functionLegacyContractExecutionsTotal,
} from "../../metrics/functionInvocation";
import type { EffectDraft, ValueBinding } from "./contracts";
import { isExecutableOwner } from "./permissions";

/**
 * Structured observability for Function-effect execution. NEVER log secret
 * or configured parameter VALUES — names, expected types, source kinds and
 * redacted summaries only.
 */
function functionEffectLog(event: string, fields: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ type: `automate.function.${event}`, ...fields }));
  } catch {
    /* logging must never break execution */
  }
}

function transpileFunction(apiName: string, source: string): string {
  const ts = require("typescript") as typeof import("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      isolatedModules: true,
    },
    fileName: `${apiName}.ts`,
  });
  return (
    output.outputText +
    `\nif (typeof module !== "undefined") { module.exports = ` +
    `(typeof exports[${JSON.stringify(apiName)}] === "function" ` +
    `? exports[${JSON.stringify(apiName)}] : ` +
    `(typeof exports.default === "function" ? exports.default : module.exports)); }\n`
  );
}

export type ExecutableFunctionReference = {
  functionRid: string | null;
  repositoryRid: string | null;
  apiName: string | null;
  branch: string | null;
  version: string | null;
  artifactSha256: string | null;
  autoUpgrade: boolean;
};

interface RegistryVersionRow {
  repository_rid: string;
  api_name: string;
  state: string;
  runtime: string;
  manifest_json: { sources?: Record<string, unknown> };
  artifact_blob_id: string;
  artifact_sha256: string;
  signature: unknown;
  function_kind: string | null;
  semver: string;
  invocation_contract: string | null;
  signature_hash: string | null;
}

const SELECT_VERSION = `
  SELECT function.repository_rid, function.api_name,
         release.state, release.runtime, release.manifest_json,
         release.artifact_blob_id, release.artifact_sha256,
         version.signature, version.function_kind, version.semver,
         version.invocation_contract, version.signature_hash
    FROM function_registry_function function
    JOIN function_registry_function_version version
      ON version.function_rid = function.rid
     AND version.branch = $2
     AND version.semver = $3
    JOIN function_version release
      ON release.rid = version.release_version_rid
   WHERE function.rid = $1`;

function invocationContractOf(row: RegistryVersionRow): InvocationContract {
  // The persisted artifact contract is authoritative; a NULL (unmigrated
  // row) behaves exactly as the backfilled default.
  return isInvocationContract(row.invocation_contract)
    ? row.invocation_contract
    : LEGACY_OBJECT_ENVELOPE_V1;
}

async function loadRegistryVersion(
  functionRid: string,
  branch: string,
  semver: string,
): Promise<RegistryVersionRow | undefined> {
  const result = await pool.query<RegistryVersionRow>(SELECT_VERSION, [
    functionRid,
    branch,
    semver,
  ]);
  return result.rows[0];
}

export async function executeFunctionEffect(input: {
  ontologyId: string;
  ownerUserId: string;
  effect: ExecutableFunctionReference;
  parameters: Record<string, unknown>;
  /**
   * When supplied (runtime effect row), the resolved immutable artifact is
   * pinned ONCE on the row (resolved_function_semver +
   * resolved_artifact_sha256) and every retry re-executes exactly that
   * artifact — auto-upgrade never re-resolves "latest" mid-run.
   */
  effectExecutionId?: string;
  /** Correlation identifiers for legacy/migration observability. Never used
   *  to select execution behavior. */
  automationId?: string;
  effectId?: string;
}): Promise<Record<string, unknown>> {
  const effect = input.effect;
  const [owner, roles] = await Promise.all([
    getKeycloakAdminService().getUserById(input.ownerUserId),
    getKeycloakAdminService().listUserRealmRoles(input.ownerUserId),
  ]);
  if (!isExecutableOwner(owner)) {
    throw Object.assign(new Error("The automation owner is disabled or deleted."), {
      code: "OWNER_PERMISSION_DENIED",
      status: 403,
    });
  }
  const repositoryAccess = await pool.query<{ allowed: boolean }>(
    `SELECT (
       $3::boolean
       OR repository.created_by::text = $2
       OR EXISTS (
         SELECT 1
           FROM folders parent_folder
           JOIN project_members membership
             ON membership.project_id = parent_folder.project_id
          WHERE parent_folder.id::text =
                substring(
                  repository.parent_folder_rid FROM '([0-9a-fA-F-]{36})$'
                )
            AND membership.user_id::text = $2
       )
       OR EXISTS (
         SELECT 1
           FROM projects direct_project
           JOIN project_members membership
             ON membership.project_id = direct_project.id
          WHERE direct_project.id::text =
                substring(repository.project_rid FROM '([0-9a-fA-F-]{36})$')
            AND membership.user_id::text = $2
       )
     ) AS allowed
       FROM code_repository repository
      WHERE repository.rid = $1
        AND repository.state IN ('ACTIVE','ARCHIVED')`,
    [
      effect.repositoryRid,
      input.ownerUserId,
      roles.some((role) => role.toLowerCase() === "tellus-superadmin"),
    ],
  );
  if (repositoryAccess.rows[0]?.allowed !== true) {
    throw Object.assign(
      new Error("The automation owner no longer has access to this Function."),
      { code: "OWNER_PERMISSION_DENIED", status: 403 },
    );
  }
  if (
    !effect.functionRid ||
    !effect.repositoryRid ||
    !effect.apiName ||
    !effect.branch ||
    !effect.version
  ) {
    throw Object.assign(new Error("The Function effect is not fully configured."), {
      code: "FUNCTION_REQUIRED",
      status: 422,
    });
  }
  const pinnedVersion = await loadRegistryVersion(
    effect.functionRid,
    effect.branch,
    effect.version,
  );
  if (!pinnedVersion) {
    throw Object.assign(new Error("The pinned Function version was not found."), {
      code: "FUNCTION_VERSION_NOT_FOUND",
      status: 422,
    });
  }
  if (
    pinnedVersion.repository_rid !== effect.repositoryRid ||
    pinnedVersion.api_name !== effect.apiName ||
    pinnedVersion.artifact_sha256 !== effect.artifactSha256
  ) {
    throw Object.assign(
      new Error("The pinned Function identity or artifact changed."),
      { code: "FUNCTION_VERSION_INCOMPATIBLE", status: 422 },
    );
  }

  // ---------------------------------------------------------------------
  // Immutable-artifact pinning: the version + artifact hash are resolved
  // ONCE per effect execution and persisted on the execution row; every
  // retry reads them back instead of re-resolving "latest"/auto-upgrading.
  // ---------------------------------------------------------------------
  let persistedPin: { semver: string; artifactSha256: string } | null = null;
  if (input.effectExecutionId) {
    const existing = await pool.query<{
      resolved_function_semver: string | null;
      resolved_artifact_sha256: string | null;
    }>(
      `SELECT resolved_function_semver, resolved_artifact_sha256
         FROM automation_effect_execution
        WHERE effect_execution_id = $1`,
      [input.effectExecutionId],
    );
    const row = existing.rows[0];
    if (row?.resolved_function_semver && row?.resolved_artifact_sha256) {
      persistedPin = {
        semver: row.resolved_function_semver,
        artifactSha256: row.resolved_artifact_sha256,
      };
    }
  }

  let version = pinnedVersion;
  if (persistedPin) {
    // Retry (or worker-recovery re-claim): re-execute the SAME artifact.
    if (
      persistedPin.semver !== effect.version ||
      persistedPin.artifactSha256 !== effect.artifactSha256
    ) {
      const pinRow = await loadRegistryVersion(
        effect.functionRid,
        effect.branch,
        persistedPin.semver,
      );
      if (!pinRow || pinRow.artifact_sha256 !== persistedPin.artifactSha256) {
        throw Object.assign(
          new Error("The previously resolved Function artifact is no longer available."),
          { code: "FUNCTION_VERSION_UNAVAILABLE", status: 422 },
        );
      }
      version = pinRow;
    }
  } else if (effect.autoUpgrade) {
    // Semantic-version range resolution: >=pinned <(major+1).0.0, stable
    // candidates only, signature-compatible, same invocation contract.
    const candidates = await pool.query<{
      semver: string;
      signature: unknown;
      invocation_contract: string | null;
    }>(
      `SELECT candidate.semver, candidate.signature, candidate.invocation_contract
         FROM function_registry_function_version candidate
         JOIN function_version release
           ON release.rid = candidate.release_version_rid
        WHERE candidate.function_rid = $1
          AND candidate.branch = $2
          AND candidate.function_kind = $3
          AND release.state = 'AVAILABLE'
          AND release.runtime = 'NODE_20'`,
      [effect.functionRid, effect.branch, pinnedVersion.function_kind],
    );
    const upgrade = resolveCompatibleUpgrade({
      pinnedSemver: effect.version,
      pinnedSignature: pinnedVersion.signature,
      pinnedContract: invocationContractOf(pinnedVersion),
      candidates: candidates.rows.map((row) => ({
        semver: row.semver,
        signature: row.signature,
        invocationContract: invocationContractOf(row as RegistryVersionRow),
      })),
    });
    if (upgrade) {
      const upgraded = await loadRegistryVersion(
        effect.functionRid,
        effect.branch,
        upgrade.semver,
      );
      if (upgraded) version = upgraded;
    }
  }
  functionEffectLog("resolve", {
    functionRid: effect.functionRid,
    apiName: effect.apiName,
    branch: effect.branch,
    configuredVersion: effect.version,
    resolvedVersion: version.semver,
    resolvedArtifactSha256: version.artifact_sha256.slice(0, 12),
    autoUpgrade: effect.autoUpgrade,
    autoUpgraded: version.semver !== effect.version,
    invocationContract: invocationContractOf(version),
  });
  if (
    version.state !== "AVAILABLE" ||
    version.runtime !== "NODE_20" ||
    version.function_kind !== "query"
  ) {
    throw Object.assign(
      new Error(
        "Only available NODE_20 query Functions can run as raw Function effects. " +
          "Ontology edits must use an Action Type.",
      ),
      { code: "FUNCTION_KIND_FORBIDDEN", status: 422 },
    );
  }
  const source = await resolveFunctionSource(version, effect.apiName);
  if (!source) {
    throw Object.assign(new Error("The pinned Function artifact is unavailable."), {
      code: "FUNCTION_VERSION_UNAVAILABLE",
      status: 422,
    });
  }

  // ---------------------------------------------------------------------
  // Invocation contract — execution branches ONLY on the persisted
  // contract. The positional v2 contract validates every configured
  // parameter against the canonical published type model (backend
  // authoritative) and resolves positionally; the legacy contract keeps
  // the pre-contract envelope behavior byte-identical.
  // ---------------------------------------------------------------------
  const contract = invocationContractOf(version);
  const canonical = readCanonicalSignature(version.signature);
  let binding: SandboxBinding;
  let values: Record<string, unknown> = input.parameters;
  if (contract === TYPESCRIPT_V2_POSITIONAL_V2) {
    if (!canonical) {
      throw Object.assign(
        new Error("The published Function signature metadata is unavailable for positional invocation."),
        { code: "FUNCTION_SIGNATURE_UNAVAILABLE", status: 422 },
      );
    }
    // Fail closed on configurations for type kinds with no supported
    // binding surface (stale configs saved before the save-time gate or
    // submitted by hand): ontology object references, object sets, and
    // unrecognised declared types are rejected with a stable code. See
    // UNSUPPORTED_BINDING_TYPE_KINDS in functions/parameterValidation.ts.
    const unsupported = unsupportedConfiguredParameters(
      canonical.parameters,
      new Set(Object.keys(input.parameters)),
    );
    if (unsupported.length > 0) {
      functionEffectLog("unsupported_parameter_type", {
        functionRid: effect.functionRid,
        apiName: effect.apiName,
        version: version.semver,
        parameters: unsupported.map((p) => `${p.name}:${p.type.kind}`),
      });
      throw Object.assign(
        new Error(
          `Function parameter type(s) not configurable in this release: ${unsupported
            .map((p) => `'${p.name}' (${p.type.kind})`)
            .join(", ")}. Use a supported parameter type (see the Automate Function documentation).`,
        ),
        { code: "FUNCTION_PARAMETER_UNSUPPORTED_TYPE", status: 422 },
      );
    }
    try {
      const resolvedArgs = resolvePositionalArguments({
        parameters: canonical.parameters,
        values: input.parameters,
        injectClient: () => ({}), // placeholder; the sandbox injects CLIENT_STUB
      });
      values = resolvedArgs.normalizedValues;
      if (resolvedArgs.unknown.length > 0) {
        functionEffectLog("unknown_parameters", {
          functionRid: effect.functionRid,
          apiName: effect.apiName,
          version: version.semver,
          names: resolvedArgs.unknown,
        });
      }
    } catch (error) {
      if (error instanceof ParameterValidationError) {
        functionEffectLog("validation_failed", {
          functionRid: effect.functionRid,
          apiName: effect.apiName,
          version: version.semver,
          issues: error.issues.map((i) => ({ path: i.path, code: i.code })),
        });
        throw Object.assign(error, { code: error.code, status: error.status });
      }
      throw error;
    }
    binding = {
      contract,
      parameters: runtimeParametersFromCanonical(canonical),
    };
  } else {
    // Legacy contract (deprecated, opt-out): SUM of policy + observability.
    // FUNCTION_LEGACY_CONTRACT_DISABLED=true makes legacy executions a
    // stable rejection; while enabled, every execution is counted
    // (tellus_function_legacy_contract_executions_total) and logged with
    // correlation identifiers — NEVER with parameter values.
    const policy = executionPolicy();
    if (!isLegacyContractExecutionAllowed(policy)) {
      functionEffectLog("legacy_contract_rejected", {
        functionRid: effect.functionRid,
        apiName: effect.apiName,
        version: version.semver,
        automationId: input.automationId ?? null,
        effectId: input.effectId ?? null,
        reason: "FUNCTION_LEGACY_CONTRACT_DISABLED",
      });
      throw Object.assign(
        new Error(
          "This Function version uses the deprecated legacy-object-envelope-v1 " +
            "invocation contract, which is disabled on this deployment (FUNCTION_LEGACY_CONTRACT_DISABLED). " +
            "Republish the Function under the positional v2 contract (see the Automate Function documentation).",
        ),
        { code: "FUNCTION_LEGACY_CONTRACT_DISABLED", status: 422 },
      );
    }
    functionLegacyContractExecutionsTotal.inc({ status: "executing" });
    functionEffectLog("legacy_contract_execution", {
      functionRid: effect.functionRid,
      apiName: effect.apiName,
      version: version.semver,
      artifactSha256: version.artifact_sha256.slice(0, 12),
      automationId: input.automationId ?? null,
      effectId: input.effectId ?? null,
      deprecationDate: policy.legacyDeprecationDate,
      notice:
        "Republish this Function to migrate it onto typescript-v2-positional-v2.",
    });
    binding = {
      contract,
      parameters: parseSignatureParameters(version.signature) ?? undefined,
    };
  }

  const signatureHash =
    version.signature_hash ??
    (canonical ? computeSignatureHash(contract, canonical) : null);
  if (input.effectExecutionId && !persistedPin) {
    await pool.query(
      `UPDATE automation_effect_execution
          SET resolved_function_semver = $2,
              resolved_artifact_sha256 = $3,
              invocation_contract = $4,
              signature_hash = $5,
              updated_at = now()
        WHERE effect_execution_id = $1`,
      [
        input.effectExecutionId,
        version.semver,
        version.artifact_sha256,
        contract,
        signatureHash,
      ],
    );
  }

  const imports = await pool.query<{
    ontology_id: string;
    api_name: string;
    kind: string;
  }>(
    `SELECT ontology_id, api_name, kind
       FROM code_repository_resource_imports
      WHERE repository_rid = $1 AND kind = 'object_type'`,
    [effect.repositoryRid],
  );
  const objectTypes = imports.rows
    .filter((row) => row.ontology_id.includes(input.ontologyId))
    .map((row) => row.api_name);
  const snapshot = await loadOntologySnapshot(pool, {
    ontologyId: input.ontologyId,
    objectTypes,
  });
  const startedAt = Date.now();
  const result = await runSandboxedWithSdkAsync(
    transpileFunction(effect.apiName, source),
    values,
    snapshot,
    binding,
  );
  functionEffectExecutionsTotal.inc({
    contract,
    status: result.status,
  });
  functionEffectLog("executed", {
    functionRid: effect.functionRid,
    apiName: effect.apiName,
    version: version.semver,
    invocationContract: contract,
    status: result.status,
    durationMs: Date.now() - startedAt,
  });
  if (result.status !== "ok") {
    functionEffectLog(result.status === "timeout" ? "timeout" : "failed", {
      functionRid: effect.functionRid,
      apiName: effect.apiName,
      version: version.semver,
      invocationContract: contract,
    });
    throw Object.assign(
      new Error(result.errorMessage ?? "Function execution failed."),
      {
        code:
          result.status === "timeout"
            ? "FUNCTION_EXECUTION_TIMEOUT"
            : "FUNCTION_EXECUTION_FAILED",
        status: result.status === "timeout" ? 504 : 422,
      },
    );
  }
  const serialized = JSON.stringify(result.output ?? null);
  if (Buffer.byteLength(serialized) > 1_048_576) {
    functionEffectLog("output_truncated", {
      functionRid: effect.functionRid,
      apiName: effect.apiName,
      version: version.semver,
      bytes: Buffer.byteLength(serialized),
    });
    throw Object.assign(new Error("Function output exceeds the 1 MiB limit."), {
      code: "FUNCTION_OUTPUT_TOO_LARGE",
      status: 422,
    });
  }
  return {
    result: result.output ?? null,
    logs: result.logs.slice(0, 1_000),
    functionRid: effect.functionRid,
    version: version.semver,
    configuredVersion: effect.version,
    autoUpgraded: version.semver !== effect.version,
    artifactSha256: version.artifact_sha256,
    invocationContract: contract,
    signatureHash,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character]!,
  );
}

export function renderNotificationContent(
  effect: Extract<EffectDraft, { type: "notification" }>,
): { heading: string; message: string; url?: string; locale: string } {
  if (effect.content.kind !== "plain") {
    throw Object.assign(
      new Error("Function-generated notification content is not supported."),
      { code: "NOTIFICATION_FUNCTION_CONTENT_UNAVAILABLE", status: 422 },
    );
  }
  return {
    heading: escapeHtml(
      effect.content.useSystemFallback
        ? "Tellus automation event"
        : effect.content.heading,
    ),
    message: escapeHtml(
      effect.content.useSystemFallback
        ? "An automation condition was met."
        : effect.content.message,
    ),
    ...(effect.content.url ? { url: effect.content.url } : {}),
    locale: effect.locale,
  };
}

export function renderFunctionNotificationResult(
  value: unknown,
  fallbackLocale: string,
): { heading: string; message: string; url?: string; locale: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(
      new Error(
        "The notification Function must return an object with heading and message strings.",
      ),
      { code: "NOTIFICATION_FUNCTION_OUTPUT_INVALID", status: 422 },
    );
  }
  const output = value as Record<string, unknown>;
  if (
    typeof output.heading !== "string" ||
    !output.heading.trim() ||
    output.heading.length > 500 ||
    typeof output.message !== "string" ||
    !output.message.trim() ||
    output.message.length > 20_000
  ) {
    throw Object.assign(
      new Error(
        "The notification Function returned an invalid heading or message.",
      ),
      { code: "NOTIFICATION_FUNCTION_OUTPUT_INVALID", status: 422 },
    );
  }
  let url: string | undefined;
  if (output.url !== undefined && output.url !== null && output.url !== "") {
    if (typeof output.url !== "string" || output.url.length > 2_000) {
      throw Object.assign(
        new Error("The notification Function returned an invalid URL."),
        { code: "NOTIFICATION_FUNCTION_OUTPUT_INVALID", status: 422 },
      );
    }
    try {
      const parsed = new URL(output.url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      url = parsed.toString();
    } catch {
      throw Object.assign(
        new Error(
          "The notification Function URL must be a valid HTTP or HTTPS URL.",
        ),
        { code: "NOTIFICATION_FUNCTION_OUTPUT_INVALID", status: 422 },
      );
    }
  }
  const locale =
    output.locale === undefined
      ? fallbackLocale
      : typeof output.locale === "string" &&
          output.locale.length >= 2 &&
          output.locale.length <= 100
        ? output.locale
        : null;
  if (locale === null) {
    throw Object.assign(
      new Error("The notification Function returned an invalid locale."),
      { code: "NOTIFICATION_FUNCTION_OUTPUT_INVALID", status: 422 },
    );
  }
  return {
    heading: escapeHtml(output.heading),
    message: escapeHtml(output.message),
    ...(url ? { url } : {}),
    locale,
  };
}

export async function renderNotificationEffectContent(input: {
  ontologyId: string;
  ownerUserId: string;
  effect: Extract<EffectDraft, { type: "notification" }>;
  resolveBinding: (binding: ValueBinding) => unknown;
  /** When called from effect execution, pins the content Function artifact
   *  on the execution row (retries reuse the same artifact). */
  effectExecutionId?: string;
}): Promise<{
  heading: string;
  message: string;
  url?: string;
  locale: string;
  generation?: {
    functionRid: string;
    configuredVersion: string;
    executedVersion: string;
    autoUpgraded: boolean;
    logs: unknown;
  };
}> {
  if (input.effect.content.kind === "plain") {
    return renderNotificationContent(input.effect);
  }
  const content = input.effect.content;
  if (
    !content.functionRid ||
    !content.repositoryRid ||
    !content.apiName ||
    !content.branch ||
    !content.version ||
    !content.artifactSha256
  ) {
    throw Object.assign(
      new Error("The notification Function is not fully configured."),
      { code: "FUNCTION_REQUIRED", status: 422 },
    );
  }
  const executed = await executeFunctionEffect({
    ontologyId: input.ontologyId,
    ownerUserId: input.ownerUserId,
    effect: {
      functionRid: content.functionRid,
      repositoryRid: content.repositoryRid,
      apiName: content.apiName,
      branch: content.branch,
      version: content.version,
      artifactSha256: content.artifactSha256,
      autoUpgrade: content.autoUpgrade,
    },
    parameters: Object.fromEntries(
      Object.entries(content.parameters).map(([name, binding]) => [
        name,
        input.resolveBinding(binding),
      ]),
    ),
    effectExecutionId: input.effectExecutionId,
  });
  return {
    ...renderFunctionNotificationResult(executed.result, input.effect.locale),
    generation: {
      functionRid: content.functionRid,
      configuredVersion: content.version,
      executedVersion:
        typeof executed.version === "string"
          ? executed.version
          : content.version,
      autoUpgraded: executed.autoUpgraded === true,
      logs: executed.logs,
    },
  };
}

function dynamicRecipients(
  bindings: ValueBinding[],
  resolve: (binding: ValueBinding) => unknown,
): Array<{ kind: "user" | "group"; id: string }> {
  const output: Array<{ kind: "user" | "group"; id: string }> = [];
  const add = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    if (typeof value === "string" && value.trim()) {
      output.push({ kind: "user", id: value.trim() });
      return;
    }
    if (value && typeof value === "object") {
      const record = value as { kind?: unknown; id?: unknown };
      if (
        (record.kind === "user" || record.kind === "group") &&
        typeof record.id === "string"
      ) {
        output.push({ kind: record.kind, id: record.id });
      }
    }
  };
  bindings.forEach((binding) => add(resolve(binding)));
  return output;
}

export async function expandNotificationRecipients(
  recipients: Array<{ kind: "user" | "group" | "service"; id: string }>,
  listGroupMembers: (groupId: string) => Promise<Array<{
    id: string;
    enabled: boolean;
  }>>,
): Promise<Array<{ kind: "user"; id: string }>> {
  const expandedUsers: Array<{ kind: "user"; id: string }> = [];
  for (const recipient of recipients) {
    if (recipient.kind === "user") {
      expandedUsers.push({ kind: "user", id: recipient.id });
      continue;
    }
    if (recipient.kind === "service") {
      throw Object.assign(
        new Error("Service principals cannot receive notifications."),
        { code: "NOTIFICATION_RECIPIENT_TYPE_UNSUPPORTED", status: 422 },
      );
    }
    const members = await listGroupMembers(recipient.id);
    expandedUsers.push(
      ...members
        .filter((member) => member.enabled)
        .map((member) => ({ kind: "user" as const, id: member.id })),
    );
  }
  const unique = [
    ...new Map(
      expandedUsers.map((recipient) => [recipient.id, recipient]),
    ).values(),
  ];
  if (unique.length > 10_000) {
    throw Object.assign(
      new Error("Notification fan-out exceeds the 10,000-recipient limit."),
      { code: "NOTIFICATION_RECIPIENT_LIMIT_EXCEEDED", status: 422 },
    );
  }
  return unique;
}

export async function executeNotificationEffect(input: {
  ontologyId: string;
  ownerUserId: string;
  effectExecutionId: string;
  effect: Extract<EffectDraft, { type: "notification" }>;
  conditionOutput: Record<string, unknown>;
  resolveBinding: (binding: ValueBinding) => unknown;
}): Promise<Record<string, unknown>> {
  const effect = input.effect;
  const keycloak = getKeycloakAdminService();
  const owner = await keycloak.getUserById(input.ownerUserId);
  if (!isExecutableOwner(owner)) {
    throw Object.assign(
      new Error("The automation owner is disabled or deleted."),
      { code: "OWNER_PERMISSION_DENIED", status: 403 },
    );
  }
  const rendered = await renderNotificationEffectContent({
    ontologyId: input.ontologyId,
    ownerUserId: input.ownerUserId,
    effect,
    resolveBinding: input.resolveBinding,
    effectExecutionId: input.effectExecutionId,
  });
  const { generation, ...renderedContent } = rendered;
  const recipients = [
    ...effect.recipients.static.map((recipient) => ({
      kind: recipient.kind,
      id: recipient.id,
    })),
    ...dynamicRecipients(effect.recipients.dynamic, input.resolveBinding),
  ];
  const unique = await expandNotificationRecipients(
    recipients,
    (groupId) => keycloak.listGroupMembers(groupId),
  );
  const affectedObjects =
    typeof input.conditionOutput.objectTypeId === "string" &&
    typeof input.conditionOutput.objectId === "string"
      ? [
          {
            objectType: input.conditionOutput.objectTypeId,
            primaryKey: input.conditionOutput.objectId,
          },
        ]
      : [];
  const resolver = makeProductionRecipientResolver((email) =>
    keycloak.findUserByEmail(email),
  );
  const deliveries: Array<Record<string, unknown>> = [];
  for (const recipient of unique) {
    const user = await keycloak.getUserById(recipient.id);
    if (!isExecutableOwner(user)) {
      deliveries.push({
        recipientId: recipient.id,
        status: "dropped",
        reason: "user_not_resolved",
      });
      continue;
    }
    const principal = user.email ?? user.username;
    const visible = await recipientVisibilityFilter(
      input.ontologyId,
      affectedObjects,
      { principal, principalKind: "user" },
      resolver,
    );
    if (!visible.ok) {
      deliveries.push({
        recipientId: recipient.id,
        status: "dropped",
        reason: visible.droppedReason,
      });
      continue;
    }
    for (const channel of effect.channels) {
      const provider = getNotificationProvider(channel as NotificationChannel);
      if (!provider) {
        throw Object.assign(
          new Error(`No notification provider exists for '${channel}'.`),
          { code: "NOTIFICATION_PROVIDER_UNAVAILABLE", status: 503 },
        );
      }
      const result = await provider.send({
        templateId: "automate.plain",
        templateParameters: {
          ...renderedContent,
        },
        channel: channel as NotificationChannel,
        recipient: {
          principal,
          principalKind: "user",
          userUuid: visible.resolvedUserId ?? user.id,
        },
        executionId: input.effectExecutionId,
        actionTypeApiName: "tellus-automate",
        ontologyId: input.ontologyId,
      });
      if (!result.ok) {
        throw Object.assign(
          new Error(result.diagnostic ?? "Notification delivery failed."),
          { code: "NOTIFICATION_PROVIDER_FAILED", status: 503 },
        );
      }
      deliveries.push({
        recipientId: recipient.id,
        channel,
        status: "delivered",
        receiptId: result.receiptId,
      });
    }
  }
  return {
    deliveries,
    ...(generation ? { contentGeneration: generation } : {}),
  };
}
