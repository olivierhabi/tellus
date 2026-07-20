// ---------------------------------------------------------------------------
// functionObjectType.ts — infer the object type a TypeScript Function binds
// to, for the Workshop function-picker "on {Type}" badge.
//
// Two authoring surfaces back Object Table function-backed columns, and both
// must be detected:
//
//   • v2 — `@osdk/functions` + `@ontology/sdk`. The generated `@ontology/sdk`
//     module is keyed by object-type apiName (see services/functions/
//     ontologyRuntime.ts `buildOntologySdk`: descriptors are
//     `Object.fromEntries(importedTypes.map(t => [t, { apiName: t }]))`), so
//     `import { OlivierOrderJune } from "@ontology/sdk"` binds to apiName
//     `OlivierOrderJune`. The binding shows up as `ObjectSet<X>` /
//     `ObjectSpecifier<X>`.
//
//   • v1 — `@foundry/functions`. String-typed: the object type is addressed by
//     apiName literal, e.g. `Objects.search("OlivierOrderJune")` or the
//     `input.objectType ?? "OlivierOrderJune"` default. No generated SDK.
//
// A function with neither import (e.g. the template-default
// `helloWorld(name: string): string`) is a pure utility → null → the picker
// renders "Utility function".
//
// Detection is a deliberately conservative regex pass over the source — not a
// full TS parse. v2 only returns symbols actually imported from `@ontology/sdk`
// (so generic `ObjectSet<T>` type parameters can't leak); v1 only returns
// string literals from `Objects.search/get` calls or the `objectType ?? "X"`
// default.
// ---------------------------------------------------------------------------

const ONTOLOGY_SDK_IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*["']@ontology\/sdk["']/;
const FOUNDRY_FUNCTIONS_IMPORT_RE = /import\s+[^;]*?\bfrom\s+["']@foundry\/functions["']/;
const OBJECT_SET_ARG_RE = /\b(?:ObjectSet|ObjectSpecifier)<\s*([A-Za-z_$][\w$]*)\s*>/g;
// v1: Objects.search("X") / Objects.get("X", …) — first-arg string literal.
const V1_OBJECTS_CALL_RE = /\bObjects\s*\.\s*(?:search|get)\s*\(\s*["']([A-Za-z_][\w]*)["']/;
// v1: `input.objectType ?? "X"` / `objectType ?? "X"` default apiName.
const V1_OBJECTTYPE_DEFAULT_RE = /objectType\b[^;\n]*?\?\?\s*["']([A-Za-z_][\w]*)["']/;

/**
 * Parse `import { A, B as C } from "@ontology/sdk"` into a map of LOCAL
 * binding → ORIGINAL imported name (the object-type apiName). `A` → `A:A`;
 * `B as C` → `C:B`. The original name is what `@ontology/sdk` is keyed by, so
 * it is the apiName we surface (even when the function renames it locally).
 */
function parseOntologySdkImports(src: string): Map<string, string> {
  const m = ONTOLOGY_SDK_IMPORT_RE.exec(src);
  const out = new Map<string, string>();
  if (!m) return out;
  for (const raw of m[1].split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const asParts = part.split(/\s+as\s+/);
    if (asParts.length === 2) {
      const original = asParts[0].trim();
      const local = asParts[1].trim();
      if (original && local) out.set(local, original);
    } else {
      const name = asParts[0].trim();
      if (name) out.set(name, name);
    }
  }
  return out;
}

/**
 * Infer the object-type apiName a TypeScript Function binds to, from its
 * source. Returns the apiName, or `null` for a pure utility function.
 *
 * Priority:
 *   v2 (`@ontology/sdk` import):
 *     1. `ObjectSet<X>` / `ObjectSpecifier<X>` where `X` resolves (via `as`
 *        alias) to an import — the function's actual bound type.
 *     2. The first `@ontology/sdk` import (a type referenced only via `.apiName`).
 *   v1 (`@foundry/functions` import, no `@ontology/sdk`):
 *     3. `Objects.search("X")` / `Objects.get("X", …)` literal arg.
 *     4. `objectType ?? "X"` default apiName.
 *   5. `null` — pure utility.
 */
export function inferFunctionObjectType(src: string): string | null {
  // v2 typed API (@ontology/sdk).
  const localToOriginal = parseOntologySdkImports(src);
  if (localToOriginal.size > 0) {
    for (const match of src.matchAll(OBJECT_SET_ARG_RE)) {
      const inner = match[1];
      if (localToOriginal.has(inner)) return localToOriginal.get(inner)!;
    }
    return [...localToOriginal.values()][0] ?? null;
  }

  // v1 legacy string-typed API (@foundry/functions): the object type is a
  // string literal — either an Objects.search/get argument or the
  // `objectType ?? "<apiName>"` default.
  if (FOUNDRY_FUNCTIONS_IMPORT_RE.test(src)) {
    const literalCall = V1_OBJECTS_CALL_RE.exec(src);
    if (literalCall) return literalCall[1];
    const defaultMatch = V1_OBJECTTYPE_DEFAULT_RE.exec(src);
    if (defaultMatch) return defaultMatch[1];
  }

  return null;
}
