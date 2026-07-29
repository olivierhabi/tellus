// ---------------------------------------------------------------------------
// verify-production-mode.mjs — Phase 5 closeout: compiled-code (dist/)
// production behavior proofs. Run with:
//
//   NODE_ENV=production node scripts/verify-production-mode.mjs
//
// Proves, against the COMPILED JavaScript (not tsx source):
//   A. A valid edit Function executes in a compiled worker_thread
//      (no tsx loader — production worker path).
//   B. Worker construction carries the memory cap + env whitelist.
//   C. The broker rejects a query-kind function (program authz).
//   D. The broker rejects an edit targeting an undeclared object type
//      (operation authz) — nothing persists.
//   E. The broker rejects a link edit over an undeclared link type
//      — nothing persists.
// Exits non-zero on any failed check.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";

const { runSandboxedWithSdkAsync, workerOptions } = await import(
  "../dist/services/functionWorkerPool.js"
);
const { buildOntologySdk } = await import(
  "../dist/services/functions/ontologyRuntime.js"
);
const { executeFunctionAction } = await import(
  "../dist/actions/functionActionExecutor.js"
);

console.log("[prod-verify] NODE_ENV =", process.env.NODE_ENV);
assert.equal(process.env.NODE_ENV, "production", "must run under NODE_ENV=production");

// ---- B. worker construction ------------------------------------------------
const opts = workerOptions();
assert.ok(
  opts.resourceLimits.maxOldGenerationSizeMb >= 64,
  "worker memory cap active",
);
assert.deepEqual(
  Object.keys(opts.env).sort(),
  ["HOME", "NODE_ENV", "PATH", "TZ"],
  "worker env whitelist exact",
);
console.log(
  `[prod-verify] B OK — worker memory cap ${opts.resourceLimits.maxOldGenerationSizeMb}MB, env whitelist ${Object.keys(opts.env).sort().join(",")}`,
);

// ---- A. valid function in a compiled worker --------------------------------
const VALID_SRC = `
export default function applyPatch(client: unknown, order: any): unknown[] {
  return [{ op: "update", objectType: "Order", primaryKey: order.$primaryKey, patch: { status: "paid" } }];
}
`;
// Same transpile the executor performs (typescript is a runtime dep).
import ts from "typescript";
function transpile(apiName, source) {
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
    `\nif (typeof module !== "undefined") { module.exports = ` +
    `(typeof exports[${JSON.stringify(apiName)}] === "function" ? exports[${JSON.stringify(apiName)}]` +
    ` : (typeof exports.default === "function" ? exports.default : module.exports)); }\n`
  );
}

const order = { $apiName: "Order", $primaryKey: "o-1", $title: "o-1", status: "open" };
const snapshot = {
  byType: new Map([["Order", new Map([["o-1", order]])]]),
  ontologyId: "prod-verify",
  objectCount: 1,
  objectTypes: ["Order"],
  importedTypes: ["Order"],
};
const valid = await runSandboxedWithSdkAsync(
  transpile("applyPatch", VALID_SRC),
  { order },
  snapshot,
  [
    { name: "client", optional: false },
    { name: "order", optional: false },
  ],
);
assert.equal(valid.status, "ok", `valid function must execute: ${valid.errorMessage ?? ""}`);
assert.equal(valid.edits.length ?? 0, 0, "edits come via return value here");
assert.ok(Array.isArray(valid.output) && valid.output[0]?.objectType === "Order");
console.log("[prod-verify] A OK — valid function executed in compiled worker, output edit on Order");

// ---- C/D/E. broker rejections via the compiled executor --------------------
const ONTOLOGY_ID = "00000000-0000-0000-0000-00000000000prod".slice(0, 36);
const ONT_UUID = "00000000-0000-0000-0000-0000000000aa";

function fakeDb({ functionKind, source, importedTypes = ["Order"], importedLinkTypes = [], linkMetadata = [] }) {
  const calls = [];
  return {
    calls,
    async query(textOrConfig, values) {
      const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
      calls.push(text.trim().slice(0, 60));
      if (text.includes("function_registry_function_version")) {
        return {
          rows: [{
            repository_rid: "ri.stemma.main.repository.orders",
            api_name: "doEdit",
            state: "AVAILABLE",
            runtime: "NODE_20",
            manifest_json: { sources: { doEdit: source } },
            signature: {
              parameters: [
                { name: "client", type: "Client", optional: false },
                { name: "order", type: "Osdk.Instance<Order>", optional: false },
              ],
              output: "Edits.Object<Order>[]",
            },
            function_kind: functionKind,
          }],
        };
      }
      if (text.includes("code_repository_resource_imports")) {
        return {
          rows: [
            ...importedTypes.map((api_name) => ({
              ontology_id: `ri.ontology.main.ontology.${ONT_UUID}`,
              api_name,
              kind: "object_type",
            })),
            ...importedLinkTypes.map((api_name) => ({
              ontology_id: `ri.ontology.main.ontology.${ONT_UUID}`,
              api_name,
              kind: "link_type",
            })),
          ],
        };
      }
      if (text.includes("FROM object_instances")) {
        return {
          rows: [{
            object_type_api_name: "Order",
            primary_key: "o-1",
            properties: { status: "open" },
          }],
        };
      }
      if (text.includes("FROM link_types")) {
        return { rows: linkMetadata };
      }
      // applyEdits must never be reached in rejection cases — any other
      // query failing loudly proves the broker stopped the batch.
      throw new Error(`unexpected query (persistence attempted?): ${text.slice(0, 80)}`);
    },
  };
}

const binding = {
  functionRid: "ri.function-registry.main.function.do-edit",
  repositoryRid: "ri.stemma.main.repository.orders",
  apiName: "doEdit",
  branch: "main",
  semver: "1.0.0",
};
const invokeArgs = {
  ontologyId: ONT_UUID,
  binding,
  parameters: { order: "o-1" },
  parameterDefinitions: [{ apiName: "order", type: "object_reference", objectType: "Order" }],
  executedBy: "prod-verify",
  maxAffectedObjects: 10,
};

// C — query-kind program rejection.
await assert.rejects(
  executeFunctionAction(invokeArgs, fakeDb({ functionKind: "query", source: VALID_SRC })),
  (err) => err.code === "FUNCTION_KIND_FORBIDDEN" && err.statusCode === 422,
);
console.log("[prod-verify] C OK — query-kind function rejected (FUNCTION_KIND_FORBIDDEN)");

// D — undeclared object-type edit rejection, nothing persists.
const BOOM_SRC = `
export default function doEdit(client: unknown, order: any): unknown[] {
  return [{ op: "update", objectType: "AuditLog", primaryKey: "a-1", patch: { x: 1 } }];
}
`;
const dbD = fakeDb({ functionKind: "edit", source: BOOM_SRC });
await assert.rejects(
  executeFunctionAction(invokeArgs, dbD),
  (err) =>
    err.code === "FUNCTION_EDIT_SCOPE_VIOLATION" &&
    err.details?.objectTypes?.includes("AuditLog"),
);
console.log("[prod-verify] D OK — undeclared-type edit rejected, no persistence attempted");

// E — undeclared link type rejection, nothing persists.
const LINK_SRC = `
export default function doEdit(client: unknown, order: any): unknown[] {
  return [{ op: "link", linkType: "order-to-audit", sourcePrimaryKey: order.$primaryKey, targetPrimaryKey: "a-1" }];
}
`;
const dbE = fakeDb({ functionKind: "edit", source: LINK_SRC });
await assert.rejects(
  executeFunctionAction(invokeArgs, dbE),
  (err) =>
    err.code === "FUNCTION_EDIT_SCOPE_VIOLATION" &&
    err.details?.linkTypes?.includes("order-to-audit"),
);
console.log("[prod-verify] E OK — undeclared link type rejected, no persistence attempted");

console.log("[prod-verify] ALL PRODUCTION-MODE CHECKS PASSED");
process.exit(0);
