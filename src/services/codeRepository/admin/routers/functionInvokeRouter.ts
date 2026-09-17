// ---------------------------------------------------------------------------
// Function-invoke router — extracted from admin/routes.ts.
//
//   POST /:rid/functions/invoke  — invoke a working-tree function
//
// Mounted by codeRepositoryRouter() in ../routes.ts in the original
// registration order.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { codeReposError } from "../../errors";
import { isRid } from "../../../codeRepos/contracts/rid";
import { runSandboxedWithSdkAsync } from "../../../functionWorkerPool";
import type { SandboxBinding } from "../../../functionRuntime";
import { authorizePublish } from "../../../functions/executionPolicy";
import {
  applyEdits,
  normalizeOntologyId,
  type OntologyEdit,
  type OntologySnapshot,
} from "../../../functions/ontologyRuntime";
import {
  deriveSignatureFromSource,
  sendError,
  unwrapObjectSetRows,
} from "../routeHelpers";
import {
  loadInvokeSnapshot,
  parseInvokeBody,
  resolveInvokeSource,
  transpileForInvoke,
} from "./functionInvokePhases";
import type { CodeRepositoryRouteContext } from "../routeContext";

export function createFunctionInvokeRouter(ctx: CodeRepositoryRouteContext): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /:rid/functions/invoke  — invoke a working-tree function
  //
  // Reads `src/functions/<apiName>.ts` from the active branch, transpiles
  // TypeScript → CommonJS via the `typescript` package, and executes inside
  // a hardened `vm` sandbox (functionRuntime.ts) with a 5 s CPU cap and no
  // host access. Body: `{ apiName: string, args?: object, branch?: string,
  // source?: "working_tree" | "published" }`. Response:
  //   { status: "ok"|"error"|"timeout", output, durationMs, logs[],
  //     errorMessage? }
  //
  // The orchestration lives here; the self-contained phases (body parsing,
  // source resolution, transpile, snapshot load) live in
  // ./functionInvokePhases.ts.
  // -------------------------------------------------------------------------

  router.post("/:rid/functions/invoke", ctx.auth, async (req, res, next) => {
    try {
      // Wall-clock origin for performance.phases (all phase times use
      // Date.now() — never performance.now() — because the sandbox runs in a
      // worker thread whose perf-hooks time origin differs).
      const t0 = Date.now();
      const phases: Array<{
        name: string;
        startOffsetMs: number;
        durationMs: number;
        depth?: number;
        calls?: number;
      }> = [];
      const rid = req.params.rid;
      if (!isRid(rid)) return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));

      // Body validation first — must precede file lookup so malformed
      // input returns a clean 4xx regardless of whether the function exists.
      const parsedBody = parseInvokeBody(req.body);
      if (parsedBody.kind === 'invalid') {
        return sendError(res, codeReposError(parsedBody.errorName, parsedBody.parameters));
      }
      const { apiName } = parsedBody.body;
      const body = parsedBody.body;

      // Publish-authorization gate (vuln-0042): the working-tree invoke
      // executes caller-supplied TypeScript (inlineSource or committed tree)
      // through the worker_threads+vm pool — which is NOT an untrusted-code
      // sandbox (constructor-chain escapes are documented). Execution is at
      // least as powerful as publishing a Function, so it must clear the same
      // authorizePublish() boundary as POST /:rid/tags: the Keycloak publish
      // role, an active function_publish_grants row, or open-development.
      // Without this gate, an unauthenticated caller (via the removed dev
      // fallback) reached arbitrary code execution with zero credentials.
      const publishPrincipal = req.codeReposPrincipal;
      if (!publishPrincipal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      const publishDecision = await authorizePublish(ctx.pool, {
        localUserId: publishPrincipal.userId,
        keycloakSub: publishPrincipal.keycloakSub,
        roles: publishPrincipal.roles,
        repositoryRid: rid,
        releaseTag: null,
      });
      if (!publishDecision.allowed) {
        if (publishDecision.auditFailed) {
          return sendError(res, codeReposError("CodeRepos:Internal", { reason: "publish-audit-unavailable" }));
        }
        return sendError(res, codeReposError("CodeRepos:PermissionDenied", { reason: publishDecision.reason }));
      }

      // Resolve the repo + branch, then the function source (inline,
      // published artifact, or committed working tree).
      const resolved = await resolveInvokeSource(ctx, {
        rid,
        bodyBranch: body.branch,
        apiName,
        source: body.source,
        inlineSource: body.inlineSource,
        inlineSourcePath: body.inlineSourcePath,
        semver: body.semver,
      });
      if (resolved.kind === 'error') {
        return sendError(res, codeReposError(resolved.errorName, resolved.parameters));
      }
      const { source, runtime, branch } = resolved;
      const resolvedPath = resolved.resolvedPath;
      void resolvedPath; // surface for future telemetry; not used in response today

      // Transpile TS → CommonJS via the isolated-module path (fast, no
      // type-check diagnostics blocking execution). Content-addressed by
      // (apiName, source) so a repeated invoke (the common case — Workshop
      // re-invokes the same committed function on every render + retry) skips
      // the transpile entirely.
      const transpiledResult = transpileForInvoke(apiName, source);
      if (transpiledResult.kind === 'invalid') {
        return sendError(res, codeReposError(transpiledResult.errorName, transpiledResult.parameters));
      }
      const transpiled = transpiledResult.transpiled;

      const input = (body.args ?? {}) as unknown;

      // ---- Ontology SDK injection (snapshot isolation) ------------------
      // Materialise a consistent view of the Ontology from the repo's imported
      // object types and inject `Objects`/`Edits` so the function can read and
      // express edits exactly like a Foundry TS Function v2. The snapshot is
      // built BEFORE the sandbox runs (the sandbox is synchronous).
      const imports = await ctx.pool.query<{ ontology_id: string; api_name: string; kind: string }>(
        `SELECT ontology_id, api_name, kind FROM code_repository_resource_imports
          WHERE repository_rid = $1 AND kind IN ('object_type', 'link_type')`,
        [rid],
      );
      let ontologyId: string | null = null;
      const importedTypes: string[] = [];
      const importedLinkTypes: string[] = [];
      for (const row of imports.rows) {
        const norm = normalizeOntologyId(row.ontology_id);
        if (norm) ontologyId = norm;
        if (row.kind === "link_type") importedLinkTypes.push(row.api_name);
        else importedTypes.push(row.api_name);
      }
      // Snapshot load is the single most expensive step on this path (up to a
      // 200k-row SELECT). Cached per (ontology, imported types) with a short
      // TTL so the burst of invokes one table render fires reuses one load.
      // The request's abort signal cancels the SELECT if the budget is
      // exceeded, instead of letting it run to completion after we 504.
      let snapshot: OntologySnapshot | undefined;
      let snapshotStartAt = Date.now();
      try {
        const loaded = await loadInvokeSnapshot(ctx.pool, {
          ontologyId,
          importedTypes,
          importedLinkTypes,
          timeoutSignal: (req as unknown as { timeoutSignal?: AbortSignal }).timeoutSignal,
        });
        snapshot = loaded.snapshot;
        snapshotStartAt = loaded.startedAt;
      } catch (err) {
        // The request-budget middleware may have already 504'd (aborting the
        // SELECT). Don't double-send; otherwise surface a 500.
        if (res.headersSent || res.writableEnded) return;
        const msg = err instanceof Error ? err.message : String(err);
        return sendError(
          res,
          codeReposError('CodeRepos:Internal', {
            reason: 'ontology-snapshot-load-failed',
            message: msg,
          }),
        );
      }

      if (ontologyId) {
        // The one real object-loading I/O phase of this pipeline (a cached
        // hit measures ~0 ms — the bar collapses, which is truthful).
        phases.push({
          name: "Load ontology snapshot",
          startOffsetMs: snapshotStartAt - t0,
          durationMs: Date.now() - snapshotStartAt,
        });
      }
      const resolvedSnapshot: OntologySnapshot = snapshot ?? {
        byType: new Map(),
        ontologyId: "",
        objectCount: 0,
        objectTypes: [] as string[],
        // No imports → no declared types → empty descriptor map (a function
        // in a repo that imports nothing has no `@ontology/sdk` types).
        importedTypes: [] as readonly string[],
      };
      // Invocation contract: when the function's annotation-derived signature
      // has ≥2 parameters, bind them POSITIONALLY by name — the tester must
      // match how published functions/Actions invoke (typescript-v2-positional-
      // v2), NOT the legacy "(CLIENT_STUB first) + envelope" heuristic, which
      // produced a throwing client-stub as the FIRST argument for ordinary
      // multi-parameter functions (e.g. `range(start, end)` got `start =
      // stub`, crashing at first property access). 0–1-parameter functions
      // keep the legacy envelope (fn(bag)) — preserving every existing
      // single-envelope caller (Workshop function columns, Live Preview).
      let binding: SandboxBinding | undefined;
      {
        const sig = deriveSignatureFromSource(resolvedPath ?? `${apiName}.ts`, source);
        if (sig !== null && sig.parameters.length >= 2) {
          binding = {
            contract: "typescript-v2-positional-v2",
            parameters: sig.parameters.map((p) => ({
              name: p.name,
              optional: p.optional,
              position: p.position,
              injected: p.typeModel.kind === "client" ? ("client" as const) : undefined,
            })),
          };
        }
      }
      // Execute the sandboxed function OFF the main event loop (a worker
      // pool) so a long-running function cannot starve concurrent request
      // handling (e.g. object-search reads → 504). Falls back to inline
      // sync execution if the pool is unavailable. Edits are collected by
      // the SDK during execution and returned with the result.
      const execStartAt = Date.now();
      const result = await runSandboxedWithSdkAsync(transpiled, input, resolvedSnapshot, binding);
      phases.push({
        name: "Execute function",
        startOffsetMs: execStartAt - t0,
        durationMs: Date.now() - execStartAt,
      });
      // Child phases: the object types the function loaded DURING execution,
      // indented under "Execute function" (Foundry: "Load objects from
      // arguments" bars nested inside the execution window).
      for (const load of result.objectLoads ?? []) {
        phases.push({
          name: `Load objects: ${load.objectType}`,
          startOffsetMs: load.firstStartAt - t0,
          durationMs: load.totalDurationMs,
          depth: 1,
          calls: load.calls,
        });
      }
      // Resource-imports scoping is enforced fail-silently above (only imported
      // object types are loaded into the snapshot, so Objects.search on a
      // non-imported type returns an empty ObjectSet). To turn that silent empty
      // into an actionable UX, diff the types the function actually queried
      // (recorded by the SDK) against the repo's imported object types and
      // surface the difference as a warning field on the response. The FE renders
      // an amber "accessed but not imported" banner with an "Open Resource
      // imports" action. Computed regardless of run status so a function that
      // queried a non-imported type then threw/timeout still surfaces it.
      const importedTypeSet = new Set(importedTypes);
      const unimportedAccessedTypes = (result.requestedTypes ?? []).filter(
        (t) => !importedTypeSet.has(t),
      );
      // Foundry TS v2: an edit function RETURNS `batch.getEdits()`. Prefer the
      // returned edit array; fall back to the ambient `Edits` side-channel
      // (v1-style functions that mutate via Edits.update and return a value).
      const isEdit = (x: unknown): x is OntologyEdit =>
        !!x && typeof x === "object" &&
        ["create", "update", "delete", "link", "unlink"].includes((x as { op?: unknown }).op as string);
      const returnedEdits: OntologyEdit[] =
        Array.isArray(result.output) && result.output.length > 0 && result.output.every(isEdit)
          ? (result.output as OntologyEdit[])
          : [];
      const sideChannelEdits = result.status === "ok" ? (result.edits ?? []) : [];
      const collectedEdits: OntologyEdit[] =
        result.status === "ok" ? (returnedEdits.length > 0 ? returnedEdits : sideChannelEdits) : [];

      // Edits do NOT persist on a plain invoke (Foundry: preview is read-only).
      // The caller opts in via `applyEdits: true`, simulating a function-backed
      // Action committing the batch to the Ontology system-of-record.
      let editsApplied: { created: number; updated: number; deleted: number; linked: number; unlinked: number } | null = null;
      if (result.status === "ok" && collectedEdits.length > 0 && body.applyEdits === true && ontologyId) {
        const editsStartAt = Date.now();
        try {
          editsApplied = await applyEdits(ctx.pool, {
            ontologyId,
            edits: collectedEdits,
            actorUserId: (req as { codeReposPrincipal?: { userId?: string } }).codeReposPrincipal?.userId ?? null,
          });
        } catch (e) {
          return sendError(res, codeReposError("CodeRepos:Internal", {
            reason: "edit-apply-failed",
            message: (e as Error)?.message ?? "unknown",
          }));
        }
        phases.push({
          name: "Apply edits",
          startOffsetMs: editsStartAt - t0,
          durationMs: Date.now() - editsStartAt,
        });
      }

      // Partition captured logs into stdout/stderr (the runtime tags
      // error frames with a `[err] ` prefix; everything else is stdout).
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      for (const line of result.logs) {
        if (line.startsWith("[err] ")) stderrLines.push(line.slice(6));
        else stdoutLines.push(line);
      }

      if (result.status === "timeout") {
        return res
          .status(504)
          .type("application/json")
          .send(
            JSON.stringify({
              apiName,
              result: null,
              durationMs: result.durationMs,
              stdout: stdoutLines.join("\n"),
              stderr:
                (result.errorMessage ?? "Execution exceeded 5 s cap.") +
                (stderrLines.length > 0 ? "\n" + stderrLines.join("\n") : ""),
              status: "timeout",
              unimportedAccessedTypes,
              performance: { phases },
            }),
          );
      }

      if (result.status === "error") {
        return res
          .status(200)
          .type("application/json")
          .send(
            JSON.stringify({
              apiName,
              result: null,
              durationMs: result.durationMs,
              stdout: stdoutLines.join("\n"),
              stderr:
                (result.errorMessage ?? "") +
                (stderrLines.length > 0 ? "\n" + stderrLines.join("\n") : ""),
              status: "error",
              unimportedAccessedTypes,
              performance: { phases },
            }),
          );
      }

      // Stringify the result so the wire shape is always a string per the
      // FE contract; objects/numbers/booleans are JSON.stringified.
      // A returned ObjectSet must be serialized as its row ARRAY — never as
      // the internal `{"rows":[...]}` representation (Palantir object
      // collections are array/`data`-shaped; the FE renders arrays as result
      // tables). Duck-typed, not instanceof: worker results cross postMessage
      // (structured clone), which strips the ObjectSet prototype. The
      // single-key shape cannot collide with the edit-batch contract (edits
      // are `Object.isArray(output) && every(isEdit)` — a {rows:[...]}
      // wrapper is never an array).
      const outputForWire = unwrapObjectSetRows(result.output);
      const serialized =
        typeof outputForWire === "string"
          ? outputForWire
          : outputForWire === undefined
            ? ""
            : JSON.stringify(outputForWire);

      return res
        .status(200)
        .type("application/json")
        .send(
          JSON.stringify({
            apiName,
            result: serialized,
            durationMs: result.durationMs,
            stdout: stdoutLines.join("\n"),
            stderr: stderrLines.join("\n"),
            status: "ok",
            // Ontology integration surface (Foundry parity B7):
            edits: collectedEdits,
            editsApplied,
            ontology: {
              ontologyId: ontologyId ?? null,
              objectsLoaded: resolvedSnapshot.objectCount,
              objectTypes: resolvedSnapshot.objectTypes,
            },
            unimportedAccessedTypes,
            performance: { phases },
          }),
        );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
