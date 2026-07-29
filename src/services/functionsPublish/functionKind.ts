// ---------------------------------------------------------------------------
// functionKind — declared-contract classification for TypeScript v2
// Functions.
//
// Edit-capability is a DECLARED contract, never inferred from body content
// (the Foundry precedent: TS v1 @OntologyEditFunction/@Edits decorators, TS
// v2 the `Edits` type from @osdk/functions). This module derives the kind
// from the function's DECLARED return type only:
//
//   A function is edit-capable iff its declared return type resolves —
//   through single-file type aliases and the bounded wrapper grammar
//   `T[]` / `Array<T>` / `ReadonlyArray<T>` / `Promise<T>` — to the type
//   reference `Edits.Object<T>`, where `Edits` is imported (possibly
//   aliased) from `@osdk/functions`.
//
// NEVER inspected: function body calls, returned object literals,
// createEditBatch usage, getEdits() usage, source-text markers.
//
// Fail-closed for malformed/contradictory declarations: these throw
// InvalidEditDeclarationError (the publish pipeline turns this into a
// FunctionsPublishError and FAILS the release; the backfill records the
// row as 'unknown'):
//   * an Edits-shaped type without an Edits import from @osdk/functions
//     (missing import or a local fake declaration named `Edits`);
//   * a circular local type-alias chain;
//   * a union mixing edit and non-edit outputs;
//   * an unsupported wrapper around an otherwise edit-looking type
//     (Map<…, Edits.Object<T>>, bare `Edits`, tuples, etc.).
//
// A valid ordinary return type (no Edits reference anywhere) is "query".
// ---------------------------------------------------------------------------

import ts from "typescript";

export type FunctionKind = "edit" | "query";

/** Thrown for malformed/contradictory edit declarations (fail closed). */
export class InvalidEditDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEditDeclarationError";
  }
}

const OSDK_FUNCTIONS_SPECIFIER = "@osdk/functions";
const EDITS_EXPORTED_NAME = "Edits";
const EDITS_NAMESPACE_MEMBER = "Object";
const SUPPORTED_WRAPPERS: ReadonlySet<string> = new Set([
  "Array",
  "ReadonlyArray",
  "Promise",
]);
const MAX_RESOLUTION_DEPTH = 16;

/** Local names bound to the `Edits` symbol via an @osdk/functions import. */
function collectEditsImportBindings(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== OSDK_FUNCTIONS_SPECIFIER) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      // `import { Edits }` → name Edits; `import { Edits as X }` → name X.
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === EDITS_EXPORTED_NAME) names.add(element.name.text);
    }
  }
  return names;
}

/** Single-file top-level `type X = …` aliases. */
function collectTypeAliases(file: ts.SourceFile): Map<string, ts.TypeNode> {
  const aliases = new Map<string, ts.TypeNode>();
  for (const statement of file.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      aliases.set(statement.name.text, statement.type);
    }
  }
  return aliases;
}

/** Leftmost identifier of a type entity (`Edits.Object<T>` → `Edits`). */
function leftmostIdentifier(entity: ts.EntityName): string {
  return ts.isIdentifier(entity) ? entity.text : leftmostIdentifier(entity.left);
}

/** Does any type reference in this subtree mention `Edits` (imported or not)? */
function subtreeMentionsEdits(node: ts.Node, editsNames: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isTypeReferenceNode(current)) {
      const leftmost = leftmostIdentifier(current.typeName);
      if (leftmost === EDITS_EXPORTED_NAME || editsNames.has(leftmost)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

type Resolution = "edit" | "no-edits";

function resolveTypeNode(
  node: ts.TypeNode,
  aliases: ReadonlyMap<string, ts.TypeNode>,
  editsNames: ReadonlySet<string>,
  seenAliases: ReadonlySet<string>,
  path: string,
  depth: number,
): Resolution {
  if (depth > MAX_RESOLUTION_DEPTH) {
    throw new InvalidEditDeclarationError(
      `${path}: return type alias chain is too deep (possible circular declaration)`,
    );
  }

  if (ts.isParenthesizedTypeNode(node)) {
    return resolveTypeNode(node.type, aliases, editsNames, seenAliases, path, depth + 1);
  }

  if (ts.isArrayTypeNode(node)) {
    // T[]
    return resolveTypeNode(node.elementType, aliases, editsNames, seenAliases, path, depth + 1);
  }

  if (ts.isUnionTypeNode(node)) {
    // Any edit-looking member makes the union ambiguous — fail closed.
    if (node.types.some((member) => subtreeMentionsEdits(member, editsNames))) {
      throw new InvalidEditDeclarationError(
        `${path}: ambiguous union return type containing an edit output`,
      );
    }
    return "no-edits";
  }

  if (ts.isTypeReferenceNode(node)) {
    const { typeName } = node;

    // Qualified: X.Object<T> — the only accepted edit form.
    if (ts.isQualifiedName(typeName)) {
      const leftmost = leftmostIdentifier(typeName);
      if (editsNames.has(leftmost)) {
        if (
          ts.isIdentifier(typeName.left) &&
          typeName.right.text === EDITS_NAMESPACE_MEMBER &&
          node.typeArguments?.length === 1
        ) {
          return "edit";
        }
        throw new InvalidEditDeclarationError(
          `${path}: unsupported edit type form '${node.getText()}' — declare the return type as ${leftmost}.Object<T>[]`,
        );
      }
      if (leftmost === EDITS_EXPORTED_NAME) {
        throw new InvalidEditDeclarationError(
          `${path}: return type references Edits, but Edits is not imported from '${OSDK_FUNCTIONS_SPECIFIER}'`,
        );
      }
      if (subtreeMentionsEdits(node, editsNames)) {
        throw new InvalidEditDeclarationError(
          `${path}: unsupported wrapper around an edit type ('${node.getText()}')`,
        );
      }
      return "no-edits";
    }

    // Bare identifier.
    const name = typeName.text;
    if (editsNames.has(name)) {
      throw new InvalidEditDeclarationError(
        `${path}: unsupported edit type form '${name}' — declare the return type as ${name}.Object<T>[]`,
      );
    }
    if (name === EDITS_EXPORTED_NAME) {
      throw new InvalidEditDeclarationError(
        `${path}: return type references Edits, but Edits is not imported from '${OSDK_FUNCTIONS_SPECIFIER}'`,
      );
    }
    if (SUPPORTED_WRAPPERS.has(name)) {
      if (node.typeArguments?.length !== 1) {
        throw new InvalidEditDeclarationError(
          `${path}: malformed ${name}<> wrapper in the return type`,
        );
      }
      return resolveTypeNode(node.typeArguments[0], aliases, editsNames, seenAliases, path, depth + 1);
    }
    const alias = aliases.get(name);
    if (alias) {
      if (seenAliases.has(name)) {
        throw new InvalidEditDeclarationError(
          `${path}: circular type-alias chain involving '${name}'`,
        );
      }
      return resolveTypeNode(
        alias,
        aliases,
        editsNames,
        new Set([...seenAliases, name]),
        path,
        depth + 1,
      );
    }
    if (subtreeMentionsEdits(node, editsNames)) {
      throw new InvalidEditDeclarationError(
        `${path}: unsupported wrapper around an edit type ('${node.getText()}')`,
      );
    }
    return "no-edits";
  }

  // Any other type node (literal, tuple, function, …).
  if (subtreeMentionsEdits(node, editsNames)) {
    throw new InvalidEditDeclarationError(
      `${path}: unsupported wrapper around an edit type ('${node.getText()}')`,
    );
  }
  return "no-edits";
}

/**
 * Classify a default-exported v2 function declaration from its declared
 * return type. Throws InvalidEditDeclarationError for malformed or
 * contradictory edit declarations (caller fails the publish / records
 * 'unknown' in the backfill).
 */
export function classifyFunctionKind(
  file: ts.SourceFile,
  declaration: ts.FunctionDeclaration,
  path: string,
): FunctionKind {
  if (!declaration.type) {
    throw new InvalidEditDeclarationError(
      `${path}: function must declare an explicit return type`,
    );
  }
  const editsNames = collectEditsImportBindings(file);
  const aliases = collectTypeAliases(file);
  const resolution = resolveTypeNode(
    declaration.type,
    aliases,
    editsNames,
    new Set(),
    path,
    0,
  );
  return resolution === "edit" ? "edit" : "query";
}
