import type { Pool, PoolClient } from "pg";
import { pool } from "../db";
import { runSandboxedWithSdkAsync } from "../services/functionWorkerPool";
import { parseSignatureParameters } from "../services/functionRuntime";
import {
  isInvocationContract,
  readCanonicalSignature,
  runtimeParametersFromCanonical,
} from "../services/functions/canonicalSignature";
import { resolveFunctionSource } from "../services/functionsRegistry/artifactStore";
import {
  applyEdits,
  loadOntologySnapshot,
  type OntologyEdit,
  type OntologyObject,
} from "../services/functions/ontologyRuntime";
import { OntologyError } from "../utils/queryErrors";
import type { ValueSource } from "./actionRules.types";

export interface FunctionActionBinding {
  functionRid: string;
  repositoryRid: string;
  apiName: string;
  branch: string;
  semver: string;
  autoUpgrade?: boolean;
  inputs?: Record<string, ValueSource>;
}

export interface FunctionActionParameterDefinition {
  apiName: string;
  type: string;
  objectType?: string;
}

export interface FunctionActionAffectedObject {
  objectType: string;
  primaryKey: string;
  operation: "create" | "update" | "delete";
}

export interface FunctionActionExecutionResult {
  affectedObjects: FunctionActionAffectedObject[];
  logs: string[];
}

function isOntologyEdit(value: unknown): value is OntologyEdit {
  return (
    !!value &&
    typeof value === "object" &&
    ["create", "update", "delete", "link", "unlink"].includes(
      String((value as { op?: unknown }).op ?? ""),
    )
  );
}

export function transpileFunction(apiName: string, source: string): string {
  const ts = require("typescript") as typeof import("typescript");
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      isolatedModules: true,
    },
    fileName: `${apiName}.ts`,
  });
  return (
    out.outputText +
    `\nif (typeof module !== "undefined") {` +
    ` module.exports = ` +
    `(typeof exports[${JSON.stringify(apiName)}] === "function" ? exports[${JSON.stringify(apiName)}]` +
    ` : (typeof exports.default === "function" ? exports.default : module.exports));` +
    `}\n`
  );
}

function hydrateArguments(
  raw: Record<string, unknown>,
  definitions: FunctionActionParameterDefinition[],
  snapshot: Awaited<ReturnType<typeof loadOntologySnapshot>>,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...raw };
  for (const definition of definitions) {
    if (definition.type !== "object_reference" || !definition.objectType) continue;
    const value = raw[definition.apiName];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const object = snapshot.byType
      .get(definition.objectType)
      ?.get(String(value)) as OntologyObject | undefined;
    if (!object) {
      throw new OntologyError(
        `Object '${definition.objectType}:${String(value)}' was not found for Function parameter '${definition.apiName}'.`,
        "OBJECT_NOT_FOUND",
        404,
        {
          parameter: definition.apiName,
          objectType: definition.objectType,
          primaryKey: String(value),
        },
      );
    }
    args[definition.apiName] = object;
  }
  return args;
}

export async function executeFunctionAction(
  options: {
    ontologyId: string;
    binding: FunctionActionBinding;
    parameters: Record<string, unknown>;
    parameterDefinitions: FunctionActionParameterDefinition[];
    executedBy: string;
    maxAffectedObjects: number;
    /** Action provenance written into the ontology_edit WAL so the
     * function's edits are indistinguishable from declarative-Action edits
     * downstream (serving projector, Action Log feeds). Optional for
     * preview/invoke callers; Action execution MUST supply both. */
    actionTypeApiName?: string;
    executionId?: string;
    preCommitHook?: (
      client: PoolClient,
      affectedObjects: FunctionActionAffectedObject[],
    ) => Promise<void>;
  },
  db: Pool = pool,
): Promise<FunctionActionExecutionResult> {
  const { binding } = options;
  const resolved = await db.query<{
    repository_rid: string;
    api_name: string;
    state: string;
    runtime: string;
    manifest_json: { sources?: Record<string, unknown> };
    artifact_blob_id: string;
    signature: unknown;
    function_kind: string | null;
    invocation_contract: string | null;
  }>(
    `SELECT f.repository_rid, f.api_name, fv.state, fv.runtime, fv.manifest_json,
            fv.artifact_blob_id, v.signature, v.function_kind,
            v.invocation_contract
       FROM function_registry_function f
       JOIN function_registry_function_version v
         ON v.function_rid = f.rid
        AND v.branch = $2
        AND v.semver = $3
       JOIN function_version fv ON fv.rid = v.release_version_rid
      WHERE f.rid = $1`,
    [binding.functionRid, binding.branch, binding.semver],
  );
  const version = resolved.rows[0];
  if (!version) {
    throw new OntologyError(
      `Published Function version '${binding.semver}' was not found.`,
      "FUNCTION_VERSION_NOT_FOUND",
      422,
      { functionRid: binding.functionRid, branch: binding.branch, semver: binding.semver },
    );
  }
  if (
    version.repository_rid !== binding.repositoryRid ||
    version.api_name !== binding.apiName
  ) {
    throw new OntologyError(
      "Persisted Function binding does not match the Function Registry identity.",
      "FUNCTION_BINDING_MISMATCH",
      422,
    );
  }
  if (version.state !== "AVAILABLE" || version.runtime !== "NODE_20") {
    throw new OntologyError(
      `Function version is not executable (state=${version.state}, runtime=${version.runtime}).`,
      "FUNCTION_VERSION_UNAVAILABLE",
      422,
    );
  }
  // Broker checkpoint (Phase 5) — program authorization: only a
  // version whose PUBLISHED contract is edit-kind may back an Action.
  // Fail closed for query / unknown / NULL (legacy unclassified).
  if (version.function_kind !== "edit") {
    throw new OntologyError(
      `Published Function '${binding.apiName}@${binding.semver}' is not an edit Function (kind=${version.function_kind ?? "NULL"}).`,
      "FUNCTION_KIND_FORBIDDEN",
      422,
      { functionRid: binding.functionRid, semver: binding.semver },
    );
  }
  // Source resolution (Track 2 #8): historical versions carry
  // sources inline in the manifest; new versions reference a
  // content-addressed artifact blob. resolveFunctionSource
  // serves both.
  let source: string | null;
  try {
    source = await resolveFunctionSource(version, binding.apiName);
  } catch (error) {
    throw new OntologyError(
      `Published artifact for Function '${binding.apiName}' is unreadable: ${(error as Error).message}`,
      "FUNCTION_VERSION_UNAVAILABLE",
      422,
    );
  }
  if (typeof source !== "string" || source.length === 0) {
    throw new OntologyError(
      `Published source for Function '${binding.apiName}' is unavailable.`,
      "FUNCTION_VERSION_UNAVAILABLE",
      422,
    );
  }

  const imports = await db.query<{
    ontology_id: string;
    api_name: string;
    kind: string;
  }>(
    `SELECT ontology_id, api_name, kind
       FROM code_repository_resource_imports
      WHERE repository_rid = $1 AND kind IN ('object_type', 'link_type')`,
    [binding.repositoryRid],
  );
  const importedTypes = imports.rows
    .filter(
      (row) => row.kind === "object_type" && row.ontology_id.includes(options.ontologyId),
    )
    .map((row) => row.api_name);
  const importedLinkTypes = imports.rows
    .filter(
      (row) => row.kind === "link_type" && row.ontology_id.includes(options.ontologyId),
    )
    .map((row) => row.api_name);
  const snapshot = await loadOntologySnapshot(db, {
    ontologyId: options.ontologyId,
    objectTypes: importedTypes,
    // Parity with the code-repository invoke path: only the repo's declared
    // link-type imports become traversable accessors in the sandbox.
    linkTypes: importedLinkTypes,
  });
  const args = hydrateArguments(options.parameters, options.parameterDefinitions, snapshot);
  // Phase 4: the pinned version's published signature (written by the
  // shared publish-time analysis) is the PRIMARY parameter-binding
  // source. Absent or malformed metadata falls back safely to the
  // legacy fn.toString() parser inside the runtime.
  const signatureParams = parseSignatureParameters(version.signature);
  const invocationContract = isInvocationContract(version.invocation_contract)
    ? version.invocation_contract
    : "legacy-object-envelope-v1";
  const sandbox = await runSandboxedWithSdkAsync(
    transpileFunction(binding.apiName, source),
    args,
    snapshot,
    {
      contract: invocationContract,
      parameters:
        runtimeParametersFromCanonical(readCanonicalSignature(version.signature)) ??
        signatureParams ??
        undefined,
    },
  );
  if (sandbox.status !== "ok") {
    throw new OntologyError(
      sandbox.errorMessage ?? "Function execution failed.",
      sandbox.status === "timeout" ? "FUNCTION_EXECUTION_TIMEOUT" : "FUNCTION_EXECUTION_FAILED",
      sandbox.status === "timeout" ? 504 : 422,
      { functionRid: binding.functionRid, semver: binding.semver },
    );
  }
  const returned =
    Array.isArray(sandbox.output) && sandbox.output.every(isOntologyEdit)
      ? (sandbox.output as OntologyEdit[])
      : [];
  const edits = returned.length > 0 ? returned : sandbox.edits;
  if (edits.length > options.maxAffectedObjects) {
    throw new OntologyError(
      `Function produced ${edits.length} edits, exceeding the Action Type limit of ${options.maxAffectedObjects}.`,
      "SCALE_LIMIT_EXCEEDED",
      422,
    );
  }
  // Broker checkpoint (Phase 5) — operation authorization: the
  // sandbox may be pure compute, but its EDITS are privileged. An
  // edit may only target an object type the repository DECLARED as
  // an import for this ontology (the same allowlist that scopes
  // reads). Anything else rejects the whole action — partial
  // application would be worse than none.
  const allowedTypes = new Set(importedTypes);
  const outOfScope = [
    ...new Set(
      edits
        .filter(
          (edit) =>
            "objectType" in edit &&
            typeof edit.objectType === "string" &&
            !allowedTypes.has(edit.objectType),
        )
        .map((edit) => (edit as { objectType: string }).objectType),
    ),
  ];
  if (outOfScope.length > 0) {
    throw new OntologyError(
      `Function emitted edits for undeclared object type(s): ${outOfScope.join(", ")}.`,
      "FUNCTION_EDIT_SCOPE_VIOLATION",
      422,
      { functionRid: binding.functionRid, semver: binding.semver, objectTypes: outOfScope },
    );
  }
  // Link / unlink edits carry no direct objectType — they must NOT
  // bypass the scope check. Authorize them against (a) the link type
  // being a DECLARED import of the repository for this ontology, and
  // (b) both endpoint object types of that link type being declared
  // object-type imports. Unresolvable or ambiguous link metadata
  // fails closed. Any violation rejects the WHOLE batch before
  // applyEdits — no partial mutations commit.
  const linkOps = edits.filter(
    (edit): edit is Extract<OntologyEdit, { op: "link" | "unlink" }> =>
      edit.op === "link" || edit.op === "unlink",
  );
  if (linkOps.length > 0) {
    const declaredLinkTypes = new Set(importedLinkTypes);
    const distinctLinkTypes = [...new Set(linkOps.map((e) => e.linkType))];
    const undeclaredLinkTypes = distinctLinkTypes.filter(
      (lt) => !declaredLinkTypes.has(lt),
    );
    if (undeclaredLinkTypes.length > 0) {
      throw new OntologyError(
        `Function emitted link edits over undeclared link type(s): ${undeclaredLinkTypes.join(", ")}.`,
        "FUNCTION_EDIT_SCOPE_VIOLATION",
        422,
        {
          functionRid: binding.functionRid,
          semver: binding.semver,
          linkTypes: undeclaredLinkTypes,
        },
      );
    }
    // Resolve endpoint object types from the ontology's link-type
    // metadata (link_types.a/b_object_type_rid → object_types).
    const resolved = await db.query<{
      api_name: string;
      a_api_name: string;
      b_api_name: string;
    }>(
      `SELECT DISTINCT lt.api_name, ao.api_name AS a_api_name, bo.api_name AS b_api_name
         FROM link_types lt
         JOIN object_types ao ON ao.rid = lt.a_object_type_rid
         JOIN object_types bo ON bo.rid = lt.b_object_type_rid
        WHERE lt.api_name = ANY($1)
          AND lt.ontology_rid LIKE '%' || $2 || '%'`,
      [distinctLinkTypes, options.ontologyId],
    );
    const endpointsByLinkType = new Map<string, Set<string>>();
    for (const row of resolved.rows) {
      const set = endpointsByLinkType.get(row.api_name) ?? new Set<string>();
      set.add(row.a_api_name);
      set.add(row.b_api_name);
      endpointsByLinkType.set(row.api_name, set);
    }
    // Fail closed when a link type is missing from ontology metadata
    // (unresolvable) or maps to more than two distinct endpoint object
    // types (ambiguous across branch variants).
    const unresolved = distinctLinkTypes.filter((lt) => {
      const endpoints = endpointsByLinkType.get(lt);
      return !endpoints || endpoints.size === 0 || endpoints.size > 2;
    });
    if (unresolved.length > 0) {
      throw new OntologyError(
        `Link type(s) could not be resolved unambiguously in ontology metadata: ${unresolved.join(", ")}.`,
        "FUNCTION_LINK_TYPE_UNRESOLVED",
        422,
        {
          functionRid: binding.functionRid,
          semver: binding.semver,
          linkTypes: unresolved,
        },
      );
    }
    const outOfScopeEndpoints = [
      ...new Set(
        distinctLinkTypes.flatMap((lt) =>
          [...endpointsByLinkType.get(lt)!].filter(
            (endpoint) => !allowedTypes.has(endpoint),
          ),
        ),
      ),
    ];
    if (outOfScopeEndpoints.length > 0) {
      throw new OntologyError(
        `Function emitted link edits whose endpoint object type(s) are undeclared: ${outOfScopeEndpoints.join(", ")}.`,
        "FUNCTION_EDIT_SCOPE_VIOLATION",
        422,
        {
          functionRid: binding.functionRid,
          semver: binding.semver,
          objectTypes: outOfScopeEndpoints,
          linkTypes: distinctLinkTypes,
        },
      );
    }
  }
  const affectedObjects: FunctionActionAffectedObject[] = edits
    .filter(
      (edit): edit is Extract<OntologyEdit, { op: "create" | "update" | "delete" }> =>
        edit.op === "create" || edit.op === "update" || edit.op === "delete",
    )
    .map((edit) => ({
      objectType: edit.objectType,
      primaryKey: edit.primaryKey,
      operation: edit.op,
    }));
  await applyEdits(db, {
    ontologyId: options.ontologyId,
    edits,
    actorUserId: options.executedBy,
    actionTypeApiName: options.actionTypeApiName ?? null,
    executionId: options.executionId ?? null,
    ...(options.preCommitHook
      ? {
          preCommitHook: (client) =>
            options.preCommitHook!(client, affectedObjects),
        }
      : {}),
  });
  return { affectedObjects, logs: sandbox.logs };
}
