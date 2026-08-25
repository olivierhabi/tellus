// ---------------------------------------------------------------------------
// Structural signature compatibility (Track 2 item #6).
//
// Replaces verbatim type-text equality in the publish-time backward-
// compatibility check. Type texts are parsed with the TypeScript
// compiler API and reduced to a canonical structural form, so purely
// formatting-level differences never burn a major version:
//
//   Osdk.Instance<Order>      ≡  Osdk.Instance < Order >
//   (string | number)         ≡  string | number
//   string /* the id */       ≡  string
//
// COMPATIBILITY RULES (the documented contract):
//
//   Function removal .............. BREAKING (dropped export).
//   Parameter removal ............. BREAKING (positional callers pass it).
//   Parameter addition, required .. BREAKING (existing callers omit it).
//   Parameter addition, optional .. COMPATIBLE.
//   Parameter reordering .......... BREAKING (the API is positional;
//                                   detected as a name change at an index).
//   Parameter optional→required ... BREAKING (callers may omit it).
//   Parameter required→optional ... COMPATIBLE.
//   Parameter type change ......... equivalent → COMPATIBLE;
//                                   union-widened → COMPATIBLE
//                                   (contravariant position: the function
//                                   now accepts everything it used to);
//                                   anything else → BREAKING.
//   Return type change ............ equivalent → COMPATIBLE;
//                                   union-narrowed → COMPATIBLE
//                                   (covariant position: every value the
//                                   function can now return was already
//                                   allowed before);
//                                   anything else → BREAKING.
//   Union member order/formatting . COMPATIBLE (canonical sort).
//   Union member add/remove ....... variance rule above (widening for
//                                   inputs, narrowing for outputs is the
//                                   compatible direction).
//
// CONSERVATIVE FALLBACK: any type that cannot be parsed, or whose
// canonical forms differ outside the union-variance cases above, is
// BREAKING with an actionable detail line. Type aliases and qualified
// names are compared structurally as written — arbitrary aliases are
// NOT claimed equivalent unless their canonical texts are identical.
// ---------------------------------------------------------------------------

import ts from "typescript";

export interface SignatureParameter {
  name: string;
  type: string;
  optional: boolean;
}

export interface SignatureShape {
  parameters: SignatureParameter[];
  output: string;
}

export type TypeComparison =
  | { kind: "equivalent" }
  | { kind: "widened"; added: string[] }
  | { kind: "narrowed"; removed: string[] }
  | { kind: "changed"; oldCanonical: string; newCanonical: string }
  | { kind: "unparseable"; side: "old" | "new" | "both"; detail: string };

const printer = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  // Comments are trivia, not structure — never let them leak
  // into the canonical form.
  removeComments: true,
});

function parseTypeNode(
  text: string,
): { node: ts.TypeNode; file: ts.SourceFile } | null {
  const file = ts.createSourceFile(
    "__signature__.ts",
    `type __S = ${text};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  // parseDiagnostics is not on the public SourceFile type in
  // every TS 5.x minor — read it defensively.
  const diagnostics = (file as ts.SourceFile & {
    parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;
  const statement = file.statements[0];
  if (!statement || !ts.isTypeAliasDeclaration(statement) || !statement.type) return null;
  return { node: statement.type, file };
}

function entityName(name: ts.EntityName): string {
  if (ts.isIdentifier(name)) return name.text;
  return `${entityName(name.left)}.${name.right.text}`;
}

function literalCanonical(literal: ts.LiteralTypeNode["literal"]): string {
  if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) {
    // Normalize quote style: 'a' ≡ "a".
    return JSON.stringify(literal.text);
  }
  return literal.getText();
}

function memberCanonical(member: ts.TypeElement): string {
  if (ts.isPropertySignature(member)) {
    const name = member.name.getText();
    const optional = member.questionToken ? "?" : "";
    const type = member.type ? emitCanonical(member.type) : "unknown";
    return `${name}${optional}: ${type}`;
  }
  if (ts.isIndexSignatureDeclaration(member)) {
    return printer.printNode(ts.EmitHint.Unspecified, member, member.getSourceFile());
  }
  if (ts.isMethodSignature(member)) {
    const name = member.name.getText();
    const optional = member.questionToken ? "?" : "";
    return `${name}${optional}: ${functionLikeCanonical(member)}`;
  }
  // Call/construct signatures and anything exotic: printer-normalized.
  return printer.printNode(ts.EmitHint.Unspecified, member, member.getSourceFile());
}

function functionLikeCanonical(
  node: ts.FunctionTypeNode | ts.MethodSignature | ts.ConstructorTypeNode,
): string {
  const typeParams = node.typeParameters?.length
    ? `<${node.typeParameters.map((p) => p.getText()).join(", ")}>`
    : "";
  const params = node.parameters
    .map((p) => {
      const name = p.name.getText();
      const optional = p.questionToken ? "?" : "";
      const rest = p.dotDotDotToken ? "..." : "";
      const type = p.type ? emitCanonical(p.type) : "unknown";
      return `${rest}${name}${optional}: ${type}`;
    })
    .join(", ");
  const output = node.type ? emitCanonical(node.type) : "void";
  return `${typeParams}(${params}) => ${output}`;
}

function unwrapParens(node: ts.TypeNode): ts.TypeNode {
  while (ts.isParenthesizedTypeNode(node)) node = node.type;
  return node;
}

/** Canonical structural serialization of a parsed TypeNode. */
function emitCanonical(rawNode: ts.TypeNode): string {
  const node = unwrapParens(rawNode);

  if (ts.isUnionTypeNode(node)) {
    // Union member order is not semantic — canonical sort.
    return node.types.map(emitCanonical).sort().join(" | ");
  }
  if (ts.isIntersectionTypeNode(node)) {
    return node.types.map(emitCanonical).sort().join(" & ");
  }
  if (ts.isArrayTypeNode(node)) {
    return `${emitCanonical(node.elementType)}[]`;
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = entityName(node.typeName);
    // Array<T> ≡ T[]; ReadonlyArray<T> ≡ readonly T[].
    if (name === "Array" && node.typeArguments?.length === 1) {
      return `${emitCanonical(node.typeArguments[0])}[]`;
    }
    if (name === "ReadonlyArray" && node.typeArguments?.length === 1) {
      return `readonly ${emitCanonical(node.typeArguments[0])}[]`;
    }
    const args = node.typeArguments?.length
      ? `<${node.typeArguments.map(emitCanonical).join(", ")}>`
      : "";
    return `${name}${args}`;
  }
  if (ts.isTypeLiteralNode(node)) {
    // Object member order is not semantic — canonical sort.
    const members = node.members.map(memberCanonical).sort();
    return `{ ${members.join("; ")} }`;
  }
  if (ts.isTupleTypeNode(node)) {
    return `[${node.elements.map(emitCanonical).join(", ")}]`;
  }
  if (ts.isNamedTupleMember(node)) {
    const optional = node.questionToken ? "?" : "";
    return `${node.name.text}${optional}: ${emitCanonical(node.type)}`;
  }
  if (ts.isOptionalTypeNode(node)) {
    return `${emitCanonical(node.type)}?`;
  }
  if (ts.isRestTypeNode(node)) {
    return `...${emitCanonical(node.type)}`;
  }
  if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) {
    return functionLikeCanonical(node);
  }
  if (ts.isLiteralTypeNode(node)) {
    return literalCanonical(node.literal);
  }
  if (ts.isTypeOperatorNode(node)) {
    const operator =
      node.operator === ts.SyntaxKind.KeyOfKeyword
        ? "keyof"
        : node.operator === ts.SyntaxKind.ReadonlyKeyword
          ? "readonly"
          : "unique";
    return `${operator} ${emitCanonical(node.type)}`;
  }
  if (ts.isIndexedAccessTypeNode(node)) {
    return `${emitCanonical(node.objectType)}[${emitCanonical(node.indexType)}]`;
  }
  if (ts.isTypeQueryNode(node)) {
    return `typeof ${entityName(node.exprName)}`;
  }
  if (ts.isTemplateLiteralTypeNode(node)) {
    // Re-emit with normalized inner types but fixed structure.
    const head = node.head.text;
    const spans = node.templateSpans
      .map((span) => `\${${emitCanonical(span.type)}}${span.literal.text}`)
      .join("");
    return `\`${head}${spans}\``;
  }
  if (ts.isConditionalTypeNode(node) || ts.isMappedTypeNode(node) || ts.isInferTypeNode(node)) {
    // No member reordering inside these — printer-normalized only.
    return printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());
  }
  // Keywords (string, number, any, unknown, …) and anything else:
  // printer-normalized whitespace.
  return printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());
}

/**
 * Canonical form of a type text, or null when the text does not parse
 * as a TypeScript type. Both sides of a comparison are canonicalized
 * with the same emitter, so quote style, whitespace, parenthesization,
 * comments, and member order never leak into the comparison.
 */
export function canonicalizeTypeText(text: string): string | null {
  const parsed = parseTypeNode(text);
  if (!parsed) return null;
  try {
    return emitCanonical(parsed.node);
  } catch {
    return null;
  }
}

function unionMemberSet(text: string): string[] | null {
  const parsed = parseTypeNode(text);
  if (!parsed) return null;
  const node = unwrapParens(parsed.node);
  if (!ts.isUnionTypeNode(node)) return null;
  return node.types.map(emitCanonical).sort();
}

function difference(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((member) => !set.has(member));
}

/**
 * Structural comparison of two type texts.
 *
 * equivalent — canonical forms identical.
 * widened    — new is a strict union superset of old (or adds members).
 * narrowed   — new is a strict union subset of old (or drops members).
 * changed    — canonical forms differ outside pure union variance.
 * unparseable — a side did not parse; callers must treat conservatively.
 */
export function compareTypeTexts(oldText: string, newText: string): TypeComparison {
  const oldCanonical = canonicalizeTypeText(oldText);
  const newCanonical = canonicalizeTypeText(newText);
  if (oldCanonical === null || newCanonical === null) {
    const side = oldCanonical === null && newCanonical === null
      ? "both"
      : oldCanonical === null
        ? "old"
        : "new";
    return {
      kind: "unparseable",
      side,
      detail: side === "both"
        ? "neither type text parses as a TypeScript type"
        : `${side} type text does not parse as a TypeScript type`,
    };
  }
  if (oldCanonical === newCanonical) return { kind: "equivalent" };

  const oldMembers = unionMemberSet(oldText);
  const newMembers = unionMemberSet(newText);
  if (oldMembers !== null || newMembers !== null) {
    const oldSet = oldMembers ?? [oldCanonical];
    const newSet = newMembers ?? [newCanonical];
    const added = difference(newSet, oldSet);
    const removed = difference(oldSet, newSet);
    if (added.length > 0 && removed.length === 0) return { kind: "widened", added };
    if (removed.length > 0 && added.length === 0) return { kind: "narrowed", removed };
  }
  return { kind: "changed", oldCanonical, newCanonical };
}

/**
 * Structural backward-compatibility comparison of one function's
 * signature across two releases. Returns one line per BREAKING
 * change (empty = compatible). Lines deliberately keep the legacy
 * message shapes ("dropped input x", "output changed", …) so the
 * run-log surface is unchanged.
 */
export function compareSignaturesStructural(
  oldSignature: SignatureShape,
  nextSignature: SignatureShape,
): string[] {
  const breaking: string[] = [];

  // Return type: covariant. Narrowing is safe; anything else breaks.
  const output = compareTypeTexts(oldSignature.output, nextSignature.output);
  if (output.kind === "changed" || output.kind === "widened") {
    breaking.push("output changed");
  } else if (output.kind === "unparseable") {
    breaking.push(`output type could not be compared structurally (${output.detail}); treating as changed`);
  }

  // Positional parameters: contravariant types, name-stable positions.
  oldSignature.parameters.forEach((oldParameter, index) => {
    const parameter = nextSignature.parameters[index];
    if (!parameter) {
      breaking.push(`dropped input ${oldParameter.name}`);
      return;
    }
    if (parameter.name !== oldParameter.name) {
      breaking.push(`reordered or changed input ${oldParameter.name}`);
      return;
    }
    if (!oldParameter.optional && parameter.optional) {
      // required → optional: compatible (callers may still pass it).
    } else if (oldParameter.optional && !parameter.optional) {
      breaking.push(`input ${oldParameter.name} became required`);
    }
    const input = compareTypeTexts(oldParameter.type, parameter.type);
    if (input.kind === "changed" || input.kind === "narrowed") {
      breaking.push(`reordered or changed input ${oldParameter.name}`);
    } else if (input.kind === "unparseable") {
      breaking.push(`input ${oldParameter.name} type could not be compared structurally (${input.detail}); treating as changed`);
    }
  });

  nextSignature.parameters.slice(oldSignature.parameters.length).forEach((parameter) => {
    if (!parameter.optional) breaking.push(`added required input ${parameter.name}`);
  });

  return breaking;
}

/**
 * Normalized representation persisted alongside the legacy textual
 * signature (manifest `signaturesNormalized` field). Consumers can
 * compare either; the textual form remains the compatibility source
 * for manifests published before this field existed.
 */
export function normalizeSignature(signature: SignatureShape): {
  parameters: Array<{ name: string; type: string; optional: boolean }>;
  output: string;
} {
  return {
    parameters: signature.parameters.map((parameter) => ({
      name: parameter.name,
      type: canonicalizeTypeText(parameter.type) ?? parameter.type,
      optional: parameter.optional,
    })),
    output: canonicalizeTypeText(signature.output) ?? signature.output,
  };
}
