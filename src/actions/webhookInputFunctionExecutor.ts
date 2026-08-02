import type { Pool } from "pg";
import { pool } from "../db";
import { runSandboxedWithSdkAsync } from "../services/functionWorkerPool";
import { parseSignatureParameters } from "../services/functionRuntime";
import {
  isInvocationContract,
  readCanonicalSignature,
  runtimeParametersFromCanonical,
} from "../services/functions/canonicalSignature";
import { resolveFunctionSource } from "../services/functionsRegistry/artifactStore";
import { loadOntologySnapshot } from "../services/functions/ontologyRuntime";
import { OntologyError } from "../utils/queryErrors";
import { transpileFunction } from "./functionActionExecutor";

export interface WebhookInputFunctionBinding {
  functionRid: string;
  repositoryRid: string;
  apiName: string;
  branch: string;
  semver: string;
}

/** Execute a pinned, published query Function for webhook payload derivation. */
export async function executeWebhookInputFunction(
  options: {
    ontologyId: string;
    binding: WebhookInputFunctionBinding;
    arguments: Record<string, unknown>;
  },
  db: Pool = pool,
): Promise<unknown> {
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
    `SELECT f.repository_rid, f.api_name, fv.state, fv.runtime,
            fv.manifest_json, fv.artifact_blob_id, v.signature, v.function_kind,
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
    );
  }
  if (
    version.repository_rid !== binding.repositoryRid ||
    version.api_name !== binding.apiName
  ) {
    throw new OntologyError(
      "Webhook Function binding does not match the Function Registry identity.",
      "FUNCTION_BINDING_MISMATCH",
      422,
    );
  }
  if (
    version.state !== "AVAILABLE" ||
    version.runtime !== "NODE_20" ||
    version.function_kind !== "query"
  ) {
    throw new OntologyError(
      `Webhook input Function is not callable (state=${version.state}, runtime=${version.runtime}, kind=${version.function_kind ?? "unknown"}).`,
      "FUNCTION_VERSION_UNAVAILABLE",
      422,
    );
  }

  const source = await resolveFunctionSource(version, binding.apiName);
  if (!source) {
    throw new OntologyError(
      `Published source for Function '${binding.apiName}' is unavailable.`,
      "FUNCTION_VERSION_UNAVAILABLE",
      422,
    );
  }
  const imports = await db.query<{ ontology_id: string; api_name: string }>(
    `SELECT ontology_id, api_name
       FROM code_repository_resource_imports
      WHERE repository_rid = $1 AND kind = 'object_type'`,
    [binding.repositoryRid],
  );
  const importedTypes = imports.rows
    .filter((row) => row.ontology_id.includes(options.ontologyId))
    .map((row) => row.api_name);
  const snapshot = await loadOntologySnapshot(db, {
    ontologyId: options.ontologyId,
    objectTypes: importedTypes,
  });
  const signatureParameters = parseSignatureParameters(version.signature);
  const invocationContract = isInvocationContract(version.invocation_contract)
    ? version.invocation_contract
    : "legacy-object-envelope-v1";
  const sandbox = await runSandboxedWithSdkAsync(
    transpileFunction(binding.apiName, source),
    options.arguments,
    snapshot,
    {
      contract: invocationContract,
      parameters:
        runtimeParametersFromCanonical(readCanonicalSignature(version.signature)) ??
        signatureParameters ??
        undefined,
    },
  );
  if (sandbox.status !== "ok") {
    throw new OntologyError(
      sandbox.errorMessage ?? "Webhook input Function execution failed.",
      sandbox.status === "timeout"
        ? "FUNCTION_EXECUTION_TIMEOUT"
        : "FUNCTION_EXECUTION_FAILED",
      sandbox.status === "timeout" ? 504 : 422,
      { functionRid: binding.functionRid, semver: binding.semver },
    );
  }
  if (sandbox.edits.length > 0) {
    throw new OntologyError(
      "A webhook input Function must not emit Ontology edits.",
      "FUNCTION_KIND_FORBIDDEN",
      422,
    );
  }
  return sandbox.output;
}
