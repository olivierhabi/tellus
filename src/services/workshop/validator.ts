// Workshop B02 — module schema validator + variable-graph compiler.
//
// Spec: tasks/workshop/workshop-tasks.md §B02.
// Decisions: D-03 (Zod-as-contract for the route layer; this module is the
// semantic checker), D-08 (canonical hash for compiled artifacts to make
// repeat compiles deterministic).
//
// Public surface:
//   - validateModule(definition) → ValidationResult — runs JSON Schema
//     conformance and the nine semantic rules; throws WorkshopError on the
//     first violation (errorName per spec).
//   - inProcessValidate(definition) — same as above, used by B01 PUT/POST.
//
// Performance: §B02 SLO is P95 ≤ 80ms. The Ajv compile happens once on
// module load; subsequent calls only invoke the validator function.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  danglingVariableReference,
  duplicateExternalId,
  duplicateVariableId,
  embeddedModuleInterfaceUnsatisfied,
  invalidModuleSchema,
  orphanWidgetReference,
  variableGraphCycle,
  variableTypeMismatch,
} from "./errors";
import { counterValidate, histValidate } from "./metrics";

// ---------------------------------------------------------------------------
// JSON Schema setup — Ajv 2020-12 (transitively present in node_modules).
// ---------------------------------------------------------------------------

interface AjvLike {
  compile(schema: unknown): (data: unknown) => boolean;
}

let ajvValidate: ((data: unknown) => boolean) | null = null;
let ajvErrors: (() => unknown[]) | null = null;

function ensureAjv(): void {
  if (ajvValidate) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Ajv2020 = require("ajv/dist/2020").default as new () => AjvLike & {
    errors?: unknown[];
  };
  const ajv = new Ajv2020();
  const schemaPath = path.resolve(
    __dirname,
    "../../../schemas/workshop-module-v4.json",
  );
  const raw = JSON.parse(readFileSync(schemaPath, "utf8"));
  const fn = ajv.compile(raw);
  ajvValidate = fn;
  ajvErrors = () =>
    ((fn as unknown as { errors?: unknown[] }).errors ?? []) as unknown[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompiledVarNode {
  id: string;
  type: string;
  definitionType: string;
  deps: string[];
}

export interface CompiledWidgetTreeNode {
  kind: "section" | "widget";
  ref: string;
  children?: CompiledWidgetTreeNode[];
}

export interface ValidationResult {
  valid: true;
  compiled: {
    varGraph: CompiledVarNode[];
    widgetTree: CompiledWidgetTreeNode | null;
  };
}

/**
 * Validate the module definition. Throws `WorkshopError` on the FIRST rule
 * violation; the caller is expected to surface that as a 400 Conjure
 * envelope. On success, returns the compiled artifact (topo-sorted variable
 * graph + a resolved widget tree).
 *
 * The contract is "fail fast on first violation" because the editor wires
 * inline error markers from `parameters.path` of the first error and the
 * user fixes them iteratively; reporting all errors at once produces a
 * jarring "wall of errors" UX in practice.
 */
export function validateModule(definition: unknown): ValidationResult {
  const t0 = process.hrtime.bigint();
  let result: "valid" | "invalid" = "valid";
  try {
    return _validateModuleInner(definition);
  } catch (e) {
    result = "invalid";
    throw e;
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    histValidate.observe({ result }, ns / 1e9);
    counterValidate.inc({ result }, 1);
  }
}

function _validateModuleInner(definition: unknown): ValidationResult {
  ensureAjv();
  if (!ajvValidate!(definition)) {
    const issues = ajvErrors ? ajvErrors() : [];
    console.error("[validator-debug] SCHEMA VALIDATION ISSUES:", JSON.stringify(issues, null, 2));
    console.error("[validator-debug] DEFINITION FAILED:", JSON.stringify(definition, null, 2));
    throw invalidModuleSchema(
      "JSON Schema validation failed",
      { issues },
    );
  }
  const def = definition as ModuleDoc;

  // B02 C-04: duplicate variable IDs.
  const seenVarIds = new Set<string>();
  for (const v of def.variables ?? []) {
    if (seenVarIds.has(v.id)) throw duplicateVariableId(v.id);
    seenVarIds.add(v.id);
  }

  // Build variable map for downstream rules.
  const varMap = new Map<string, Variable>();
  for (const v of def.variables ?? []) varMap.set(v.id, v);

  // B02 C-09: external-ID uniqueness across moduleInterface + routing.
  const externalIds = new Set<string>();
  for (const m of def.moduleInterface?.variables ?? []) {
    if (externalIds.has(m.externalId)) {
      throw duplicateExternalId(m.externalId);
    }
    externalIds.add(m.externalId);
  }
  for (const id of def.routing?.promotedExternalIds ?? []) {
    if (externalIds.has(id)) throw duplicateExternalId(id);
    externalIds.add(id);
  }

  // B02 C-07: dangling references in module interface.
  for (const m of def.moduleInterface?.variables ?? []) {
    if (!varMap.has(m.variableId)) {
      throw danglingVariableReference(
        m.variableId,
        `moduleInterface.variables.${m.externalId}`,
      );
    }
  }

  // B02 C-07/C-08: dangling + type-mismatch on widget bindings.
  // B02 C-11: auto-generated active-object variable invariant.
  for (const w of def.widgets ?? []) {
    for (const [slot, varId] of Object.entries(w.inputs ?? {})) {
      if (!varMap.has(varId)) {
        throw danglingVariableReference(
          varId,
          `widgets[${w.id}].inputs.${slot}`,
        );
      }
      checkWidgetInputTypeCompat(w, slot, varMap.get(varId)!);
    }
    for (const [slot, varId] of Object.entries(w.outputs ?? {})) {
      const referenced = varMap.get(varId);
      if (!referenced) {
        throw danglingVariableReference(
          varId,
          `widgets[${w.id}].outputs.${slot}`,
        );
      }
      checkWidgetOutputInvariant(w, slot, referenced);
    }
    if (w.display?.visibilityVariableId) {
      if (!varMap.has(w.display.visibilityVariableId)) {
        throw danglingVariableReference(
          w.display.visibilityVariableId,
          `widgets[${w.id}].display.visibilityVariableId`,
        );
      }
    }
  }

  // B02 C-07/C-08: dangling + type-mismatch on variable constraints.
  for (const v of def.variables ?? []) {
    for (const [i, c] of (v.constraints ?? []).entries()) {
      if (c.kind === "filterByVariable") {
        const filterVarId = (c as { filterVariableId?: unknown })
          .filterVariableId;
        if (typeof filterVarId !== "string") {
          throw invalidModuleSchema(
            "filterByVariable.filterVariableId must be a string",
            { path: `variables[${v.id}].constraints[${i}]` },
          );
        }
        const ref = varMap.get(filterVarId);
        if (!ref) {
          throw danglingVariableReference(
            filterVarId,
            `variables[${v.id}].constraints[${i}].filterVariableId`,
          );
        }
        if (ref.type !== "objectSetFilter") {
          throw variableTypeMismatch(
            "objectSetFilter",
            ref.type,
            `variables[${v.id}].constraints[${i}].filterVariableId`,
          );
        }
        // D-11: filterByVariable host may be `objectSet` or
        // `objectSetFilter` (filter chains via variableTransformation).
        // The target check above keeps the rule meaningful.
        if (v.type !== "objectSet" && v.type !== "objectSetFilter") {
          throw variableTypeMismatch(
            "objectSet|objectSetFilter (constraint host)",
            v.type,
            `variables[${v.id}].constraints[${i}]`,
          );
        }
      }
    }
  }

  // B02 C-06: orphan widget references (every widget id must be referenced
  // by some section.children).
  const widgetTree = buildWidgetTree(def);
  const referencedWidgets = new Set<string>();
  collectReferencedWidgets(widgetTree, referencedWidgets);
  if (def.layout?.header?.widgetId) {
    referencedWidgets.add(def.layout.header.widgetId);
  }
  for (const w of def.widgets ?? []) {
    if (!referencedWidgets.has(w.id)) {
      throw orphanWidgetReference(w.id);
    }
  }

  // B02 C-10: loop/embed coherence — interfaceMapping is required and
  // non-empty when loopConfig.embeddedModuleRid is set.
  for (const s of def.sections ?? []) {
    if (
      s.layout === "loop" &&
      s.loopConfig?.embeddedModuleRid &&
      (!s.loopConfig.interfaceMapping ||
        Object.keys(s.loopConfig.interfaceMapping).length === 0)
    ) {
      throw embeddedModuleInterfaceUnsatisfied(
        s.loopConfig.embeddedModuleRid,
        ["<unspecified>"],
      );
    }
  }

  // B02 C-05: cycle detection on the *definition* graph (constraints
  // only — events form runtime back-edges and are excluded per C-12).
  const varGraph = buildVarDependencyGraph(def);
  const sorted = topoSort(varGraph);
  if (typeof sorted === "object" && "cyclePath" in sorted) {
    throw variableGraphCycle(sorted.cyclePath);
  }

  // B02 C-13: emit compiled artifact in topo order.
  const compiledVarGraph: CompiledVarNode[] = sorted.order.map((id) => {
    const v = varMap.get(id)!;
    return {
      id: v.id,
      type: v.type,
      definitionType: v.definitionType,
      deps: varGraph.get(id) ?? [],
    };
  });

  return {
    valid: true,
    compiled: {
      varGraph: compiledVarGraph,
      widgetTree,
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Variable {
  id: string;
  type: string;
  definitionType: string;
  displayName?: string;
  constraints?: Array<{ kind: string; [k: string]: unknown }>;
}

interface Widget {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  display?: { visibilityVariableId?: string };
}

interface Section {
  id: string;
  layout: "rows" | "columns" | "tabs" | "flow" | "toolbar" | "loop";
  loopConfig?: {
    embeddedModuleRid?: string;
    interfaceMapping?: Record<string, string>;
  };
  children?: Array<{ kind: "section" | "widget"; ref: string }>;
}

interface ModuleDoc {
  schemaVersion: 4;
  variables?: Variable[];
  widgets?: Widget[];
  sections?: Section[];
  moduleInterface?: {
    variables?: Array<{
      externalId: string;
      variableId: string;
      required: boolean;
    }>;
  };
  routing?: { promotedExternalIds?: string[] };
  layout?: {
    rootSection?: string;
    header?: { widgetId: string };
  };
}

function checkWidgetInputTypeCompat(
  w: Widget,
  slot: string,
  variable: Variable,
): void {
  // Minimum type-compatibility matrix per the spec's named widgets. Each
  // entry maps a (widget.type, slot) → expected variable.type. Missing
  // entries are not enforced (yet) — the matrix is incrementally enriched
  // as widgets land in F02..F10.
  const expected = WIDGET_INPUT_TYPES.get(`${w.type}:${slot}`);
  if (!expected) return;
  if (variable.type !== expected) {
    throw variableTypeMismatch(
      expected,
      variable.type,
      `widgets[${w.id}].inputs.${slot}`,
    );
  }
}

function checkWidgetOutputInvariant(
  w: Widget,
  slot: string,
  variable: Variable,
): void {
  const expected = WIDGET_OUTPUT_TYPES.get(`${w.type}:${slot}`);
  if (!expected) return;
  if (variable.type !== expected) {
    throw variableTypeMismatch(
      expected,
      variable.type,
      `widgets[${w.id}].outputs.${slot}`,
    );
  }
  // C-11: active-object output must be definitionType=widgetOutput.
  if (slot === "activeObject" && variable.definitionType !== "widgetOutput") {
    throw variableTypeMismatch(
      "widgetOutput",
      variable.definitionType,
      `widgets[${w.id}].outputs.activeObject (definitionType)`,
    );
  }
}

const WIDGET_INPUT_TYPES = new Map<string, string>([
  ["objectTable:objectSet", "objectSet"],
  // Object List renders an object set as cards; same binding contract as the
  // Object Table (see widgets-object-list docs).
  ["objectList:objectSet", "objectSet"],
  ["filterList:objectSet", "objectSet"],
  ["chartPie:objectSet", "objectSet"],
  ["chartXY:objectSet", "objectSet"],
  // Vega Chart binds an object set as its chart data source (object rows or a
  // group-by aggregation); see widgets-vega-chart docs.
  ["vegaChart:objectSet", "objectSet"],
  ["objectSetTitle:object", "object"],
  ["objectSetTitle:objectSet", "objectSet"],
]);

const WIDGET_OUTPUT_TYPES = new Map<string, string>([
  ["objectTable:activeObject", "object"],
  ["objectTable:selectedObjects", "objectSet"],
  // Object List emits the same selection outputs as the Object Table: a single
  // active object and (with multi-select) the set of selected objects.
  ["objectList:activeObject", "object"],
  ["objectList:selectedObjects", "objectSet"],
  ["filterList:filter", "objectSetFilter"],
  ["chartPie:selectionFilter", "objectSetFilter"],
  ["chartXY:selectionFilter", "objectSetFilter"],
  // Vega Chart forwards a Vega-Lite selection parameter as an object-set
  // filter ("selection as filter"); see widgets-vega-chart docs.
  ["vegaChart:selectionFilter", "objectSetFilter"],
]);

function buildWidgetTree(def: ModuleDoc): CompiledWidgetTreeNode | null {
  if (!def.layout?.rootSection) return null;
  const sectionMap = new Map<string, Section>();
  for (const s of def.sections ?? []) sectionMap.set(s.id, s);
  const visit = (
    sectionId: string,
    seen: Set<string>,
  ): CompiledWidgetTreeNode | null => {
    if (seen.has(sectionId)) {
      // Section reference cycle — not a variable cycle, but still illegal.
      throw orphanWidgetReference(sectionId);
    }
    seen.add(sectionId);
    const s = sectionMap.get(sectionId);
    if (!s) {
      throw invalidModuleSchema(
        `layout references unknown section "${sectionId}"`,
        { sectionId },
      );
    }
    const children: CompiledWidgetTreeNode[] = [];
    for (const c of s.children ?? []) {
      if (c.kind === "section") {
        const sub = visit(c.ref, new Set(seen));
        if (sub) children.push(sub);
      } else {
        children.push({ kind: "widget", ref: c.ref });
      }
    }
    return { kind: "section", ref: s.id, children };
  };
  return visit(def.layout.rootSection, new Set());
}

function collectReferencedWidgets(
  node: CompiledWidgetTreeNode | null,
  acc: Set<string>,
): void {
  if (!node) return;
  if (node.kind === "widget") acc.add(node.ref);
  for (const c of node.children ?? []) collectReferencedWidgets(c, acc);
}

function buildVarDependencyGraph(def: ModuleDoc): Map<string, string[]> {
  const g = new Map<string, string[]>();
  for (const v of def.variables ?? []) {
    const deps: string[] = [];
    for (const c of v.constraints ?? []) {
      if (c.kind === "filterByVariable") {
        const ref = (c as { filterVariableId?: string }).filterVariableId;
        if (typeof ref === "string") deps.push(ref);
      }
    }
    g.set(v.id, deps);
  }
  return g;
}

interface SortedOk {
  order: string[];
}

interface SortedCycle {
  cyclePath: string[];
}

/**
 * Kahn-with-cycle-recovery topological sort. On success returns the topo
 * order. On cycle returns the cycle path (the smallest cycle observable
 * via DFS), suitable for `Tellus:Workshop:VariableGraphCycle.parameters`.
 */
function topoSort(g: Map<string, string[]>): SortedOk | SortedCycle {
  // Edge u → v means "u must come before v". `g.get(v) = [...deps]` lists
  // the u's that v depends on. So v has indegree = |deps that exist in g|.
  // We need a reverse adjacency to walk dependents when v is emitted.
  const reverse = new Map<string, string[]>();
  for (const id of g.keys()) reverse.set(id, []);
  const inDegree = new Map<string, number>();
  for (const id of g.keys()) inDegree.set(id, 0);
  for (const [id, deps] of g) {
    for (const d of deps) {
      if (g.has(d)) {
        reverse.get(d)!.push(id);
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const dependent of reverse.get(id) ?? []) {
      const next = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (order.length === g.size) {
    return { order };
  }
  // Recover a cycle path via DFS.
  const colour = new Map<string, "white" | "gray" | "black">();
  for (const id of g.keys()) colour.set(id, "white");
  const stack: string[] = [];
  const findCycleFrom = (start: string): string[] | null => {
    stack.length = 0;
    const visit = (id: string): string[] | null => {
      if (colour.get(id) === "gray") {
        const idx = stack.indexOf(id);
        return [...stack.slice(idx), id];
      }
      if (colour.get(id) === "black") return null;
      colour.set(id, "gray");
      stack.push(id);
      for (const d of g.get(id) ?? []) {
        if (!g.has(d)) continue;
        const cycle = visit(d);
        if (cycle) return cycle;
      }
      stack.pop();
      colour.set(id, "black");
      return null;
    };
    return visit(start);
  };
  for (const id of g.keys()) {
    if (colour.get(id) === "white") {
      const cycle = findCycleFrom(id);
      if (cycle) return { cyclePath: cycle };
    }
  }
  // Fallback (should not happen if the order check above is correct).
  return { cyclePath: [] };
}
