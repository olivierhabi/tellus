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
} from "../functionRuntime";
import { runSandboxedWithSdkAsync } from "../functionWorkerPool";
import { resolveFunctionSource } from "../functionsRegistry/artifactStore";
import { loadOntologySnapshot } from "../functions/ontologyRuntime";
import type { EffectDraft, ValueBinding } from "./contracts";
import { isExecutableOwner } from "./permissions";

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

export async function executeFunctionEffect(input: {
  ontologyId: string;
  ownerUserId: string;
  effect: ExecutableFunctionReference;
  parameters: Record<string, unknown>;
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
  const resolved = await pool.query<{
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
  }>(
    `SELECT function.repository_rid, function.api_name,
            release.state, release.runtime, release.manifest_json,
            release.artifact_blob_id, release.artifact_sha256,
            version.signature, version.function_kind, version.semver
       FROM function_registry_function function
       JOIN function_registry_function_version version
         ON version.function_rid = function.rid
        AND version.branch = $2
        AND version.semver = $3
       JOIN function_version release
         ON release.rid = version.release_version_rid
      WHERE function.rid = $1`,
    [effect.functionRid, effect.branch, effect.version],
  );
  const pinnedVersion = resolved.rows[0];
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
  let version = pinnedVersion;
  if (effect.autoUpgrade) {
    const compatible = await pool.query<typeof pinnedVersion>(
      `SELECT function.repository_rid, function.api_name,
              release.state, release.runtime, release.manifest_json,
              release.artifact_blob_id, release.artifact_sha256,
              candidate.signature, candidate.function_kind, candidate.semver
         FROM function_registry_function function
         JOIN function_registry_function_version candidate
           ON candidate.function_rid = function.rid
          AND candidate.branch = $2
         JOIN function_version release
           ON release.rid = candidate.release_version_rid
        WHERE function.rid = $1
          AND candidate.signature = $3::jsonb
          AND candidate.function_kind = $4
          AND release.state = 'AVAILABLE'
          AND release.runtime = 'NODE_20'
        ORDER BY string_to_array(
          split_part(candidate.semver, '-', 1), '.'
        )::int[] DESC, candidate.created_at DESC
        LIMIT 1`,
      [
        effect.functionRid,
        effect.branch,
        JSON.stringify(pinnedVersion.signature),
        pinnedVersion.function_kind,
      ],
    );
    version = compatible.rows[0] ?? pinnedVersion;
  }
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
  const result = await runSandboxedWithSdkAsync(
    transpileFunction(effect.apiName, source),
    input.parameters,
    snapshot,
    parseSignatureParameters(version.signature) ?? undefined,
  );
  if (result.status !== "ok") {
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
