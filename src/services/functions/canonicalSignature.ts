// ---------------------------------------------------------------------------
// canonicalSignature.ts — THE canonical published-function contract.
//
// One signature model is shared by every layer:
//   • publication     (functionsPublish/service.ts — written once, immutable)
//   • registry        (function_registry_function_version.signature jsonb)
//   • Automate config (functionsRegistry/admin/routes.ts canonicalParameters)
//   • validation      (automate/validation.ts + parameterValidation.ts)
//   • runtime         (functionRuntime.ts buildSandboxCallArgs)
//   • version compat  (functions/versionResolution.ts)
//
// Parameter order comes EXCLUSIVELY from immutable published metadata
// (`position`, written at publish time; legacy rows upgrade to array index).
// Nothing in the system may derive invocation behavior from object-key
// order, runtime source parsing, transpiled arity, or fn.length.
// ---------------------------------------------------------------------------

import { createHash } from "crypto";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Invocation contract — persisted per published immutable version
// (function_registry_function_version.invocation_contract).
//
//  legacy-object-envelope-v1   — the pre-contract behavior, preserved
//                                verbatim for every artifact published before
//                                this column existed (deterministic backfill):
//                                ≥2 simple declared params → (CLIENT_STUB,
//                                ...rest bound by name); 0–1 params → the
//                                whole resolved bindings object is passed as
//                                the single argument fn(bag).
//  typescript-v2-positional-v2 — the standard TypeScript contract: every
//                                declared parameter is resolved BY PUBLISHED
//                                NAME and invoked POSITIONALLY in PUBLISHED
//                                ORDER. A parameter whose published type is
//                                `Client` is an injected dependency (Foundry
//                                edit convention); no other injection exists.
// ---------------------------------------------------------------------------

export const LEGACY_OBJECT_ENVELOPE_V1 = "legacy-object-envelope-v1" as const;
export const TYPESCRIPT_V2_POSITIONAL_V2 = "typescript-v2-positional-v2" as const;

export type InvocationContract =
  | typeof LEGACY_OBJECT_ENVELOPE_V1
  | typeof TYPESCRIPT_V2_POSITIONAL_V2;

export const INVOCATION_CONTRACTS: readonly InvocationContract[] = [
  LEGACY_OBJECT_ENVELOPE_V1,
  TYPESCRIPT_V2_POSITIONAL_V2,
];

export function isInvocationContract(value: unknown): value is InvocationContract {
  return (
    value === LEGACY_OBJECT_ENVELOPE_V1 || value === TYPESCRIPT_V2_POSITIONAL_V2
  );
}

// ---------------------------------------------------------------------------
// Canonical recursive function type model.
//
// Extensible by design: interface/principal/media/attachment kinds are
// declared (marked unsupported for execution validation today) so published
// metadata stays descriptive while the runtime fails closed — never guess.
// ---------------------------------------------------------------------------

export type FunctionType =
  | { kind: "string" }
  | { kind: "boolean" }
  | { kind: "integer" }
  | { kind: "long" }
  | { kind: "float" }
  | { kind: "double" }
  | { kind: "date" }
  | { kind: "timestamp" }
  | { kind: "optional"; value: FunctionType; allowsNull: boolean }
  | { kind: "list"; element: FunctionType }
  | { kind: "map"; key: FunctionType; value: FunctionType }
  | { kind: "struct"; fields: StructField[] }
  | { kind: "ontologyObject"; objectTypeApiName: string | null }
  | { kind: "objectSet"; objectTypeApiName: string | null }
  /** Injected runtime dependency (e.g. the Foundry v2 edit `client`). Never user-bound. */
  | { kind: "client" }
  /** Declared but not yet validatable/executable (interfaces, principals,
   *  media, attachments, unions, any). Values pass through unvalidated;
   *  documented, never coerced. */
  | { kind: "unsupported"; typeText: string };

export interface StructField {
  name: string;
  type: FunctionType;
}

// ---------------------------------------------------------------------------
// Published parameter — every layer consumes this exact shape.
// ---------------------------------------------------------------------------

export interface PublishedParameter {
  name: string;
  /** Immutable published ordinal. Execution order; NEVER object-key order. */
  position: number;
  /** Canonical recursive type model (drives UI editors + validation). */
  type: FunctionType;
  /** Verbatim published TypeScript type text (display + structural compat). */
  typeText: string;
  /** `?` marker, default initializer, or `| undefined` union. */
  optional: boolean;
  /** Declared a default initializer — omission applies the JS default. */
  hasDefault: boolean;
}

export interface CanonicalSignature {
  /** Schema marker for the canonical form; legacy rows upgrade on read. */
  contractVersion: 2;
  parameters: PublishedParameter[];
  /** Verbatim return-type text. */
  output: string;
}

// ---------------------------------------------------------------------------
// Canonical type derivation from the TypeScript AST (publish time, shared
// analysis) and from stored type text (legacy rows, upgrade-on-read).
// ---------------------------------------------------------------------------

function unsupported(typeText: string): FunctionType {
  return { kind: "unsupported", typeText };
}

function identifierText(node: ts.TypeNode | undefined): string | null {
  if (node && ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    return node.typeName.text;
  }
  return null;
}

function canonicalTypeFromTypeNode(node: ts.TypeNode | undefined): FunctionType {
  if (!node) return unsupported("<missing>");
  if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: "string" };
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return { kind: "boolean" };
  if (node.kind === ts.SyntaxKind.NumberKeyword) return { kind: "double" };
  if (ts.isParenthesizedTypeNode(node)) return canonicalTypeFromTypeNode(node.type);
  if (ts.isLiteralTypeNode(node)) {
    if (ts.isStringLiteral(node.literal)) return { kind: "string" };
    if (ts.isNumericLiteral(node.literal)) return { kind: "double" };
    if (
      node.literal.kind === ts.SyntaxKind.TrueKeyword ||
      node.literal.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return { kind: "boolean" };
    }
    return unsupported(node.getText());
  }
  if (ts.isArrayTypeNode(node)) {
    return { kind: "list", element: canonicalTypeFromTypeNode(node.elementType) };
  }
  if (ts.isUnionTypeNode(node)) {
    let sawNull = false;
    let sawUndefined = false;
    const members: ts.TypeNode[] = [];
    for (const member of node.types) {
      if (member.kind === ts.SyntaxKind.NullKeyword) sawNull = true;
      else if (member.kind === ts.SyntaxKind.UndefinedKeyword) sawUndefined = true;
      else if (
        ts.isLiteralTypeNode(member) &&
        member.literal.kind === ts.SyntaxKind.NullKeyword
      ) {
        sawNull = true;
      } else members.push(member);
    }
    if (members.length === 1 && (sawNull || sawUndefined)) {
      return {
        kind: "optional",
        value: canonicalTypeFromTypeNode(members[0]),
        allowsNull: sawNull,
      };
    }
    return unsupported(node.getText());
  }
  if (ts.isTypeLiteralNode(node)) {
    const fields: StructField[] = [];
    for (const member of node.members) {
      if (ts.isPropertySignature(member) && member.type) {
        const name = member.name.getText().replace(/^['"]|['"]$/g, "");
        let fieldType = canonicalTypeFromTypeNode(member.type);
        if (member.questionToken && fieldType.kind !== "optional") {
          fieldType = { kind: "optional", value: fieldType, allowsNull: false };
        }
        fields.push({ name, type: fieldType });
      } else if (
        ts.isIndexSignatureDeclaration(member) &&
        member.parameters.length === 1 &&
        member.type
      ) {
        return {
          kind: "map",
          key: canonicalTypeFromTypeNode(member.parameters[0].type),
          value: canonicalTypeFromTypeNode(member.type),
        };
      }
    }
    return { kind: "struct", fields };
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = identifierText(node);
    const args = node.typeArguments ?? [];
    switch (name) {
      case "Array":
      case "ReadonlyArray":
        return args.length === 1
          ? { kind: "list", element: canonicalTypeFromTypeNode(args[0]) }
          : unsupported(node.getText());
      case "Record":
        return args.length === 2
          ? {
              kind: "map",
              key: canonicalTypeFromTypeNode(args[0]),
              value: canonicalTypeFromTypeNode(args[1]),
            }
          : unsupported(node.getText());
      case "Date":
        return { kind: "date" };
      case "Timestamp":
        return { kind: "timestamp" };
      case "Integer":
      case "Short":
      case "Byte":
        return { kind: "integer" };
      case "Long":
        return { kind: "long" };
      case "Float":
        return { kind: "float" };
      case "Double":
        return { kind: "double" };
      case "Client":
        return { kind: "client" };
      case "Promise":
        return args.length === 1
          ? canonicalTypeFromTypeNode(args[0])
          : unsupported(node.getText());
      default:
        break;
    }
    if (
      ts.isQualifiedName(node.typeName) &&
      ts.isIdentifier(node.typeName.left) &&
      node.typeName.left.text === "Osdk" &&
      node.typeName.right.text === "Instance"
    ) {
      return { kind: "ontologyObject", objectTypeApiName: typeArgText(args[0]) };
    }
    if (name === "ObjectSet") {
      return { kind: "objectSet", objectTypeApiName: typeArgText(args[0]) };
    }
    return unsupported(node.getText());
  }
  return unsupported(node.getText());
}

function typeArgText(node: ts.TypeNode | undefined): string | null {
  if (!node) return null;
  const text = node.getText().trim();
  return text.length > 0 ? text : null;
}

/** Publish-time mapping: canonical model for an annotated parameter type. */
export function canonicalTypeOfParameter(node: ts.TypeNode | undefined): FunctionType {
  return canonicalTypeFromTypeNode(node);
}

/**
 * Read-time mapping for legacy persisted signatures whose parameters carry
 * only verbatim type text. Best-effort, deterministic, never coercive:
 * unmappable text yields `{kind:"unsupported"}` (pass-through).
 */
export function canonicalTypeFromText(text: string): FunctionType {
  const trimmed = text.trim();
  if (trimmed.length === 0) return unsupported(text);
  try {
    const file = ts.createSourceFile(
      "__canonical_type__.ts",
      `type __T = ${trimmed};`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const alias = file.statements.find(ts.isTypeAliasDeclaration);
    if (!alias) return unsupported(text);
    return canonicalTypeFromTypeNode(alias.type);
  } catch {
    return unsupported(text);
  }
}

// ---------------------------------------------------------------------------
// Reading published signature metadata (v2 + legacy upgrade-on-read).
// ---------------------------------------------------------------------------

function isFunctionType(value: unknown): value is FunctionType {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

/**
 * Upgrade ANY persisted signature jsonb (v2 canonical or legacy text-only)
 * to the canonical model. Returns null when the metadata is absent/malformed
 * — legacy-contract callers then fall back to the legacy fn.toString() path
 * (preserved behavior); positional callers fail closed.
 */
export function readCanonicalSignature(raw: unknown): CanonicalSignature | null {
  if (!raw || typeof raw !== "object") return null;
  const parameters = (raw as { parameters?: unknown }).parameters;
  if (!Array.isArray(parameters)) return null;
  const parsed: PublishedParameter[] = [];
  for (let index = 0; index < parameters.length; index++) {
    const entry = parameters[index] as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") return null;
    const name = entry.name;
    if (typeof name !== "string" || name.length === 0) return null;
    const position =
      typeof entry.position === "number" && Number.isInteger(entry.position)
        ? entry.position
        : index;
    const optional = entry.optional === true;
    const hasDefault = entry.hasDefault === true || (entry.hasDefault !== false && optional && entry.initializer === true);
    const typeText = typeof entry.type === "string" ? entry.type : "";
    const type = isFunctionType(entry.typeModel)
      ? entry.typeModel
      : canonicalTypeFromText(typeText || "any");
    parsed.push({ name, position, type, typeText, optional, hasDefault });
  }
  const output = (raw as { output?: unknown }).output;
  return {
    contractVersion: 2,
    parameters: parsed,
    output: typeof output === "string" ? output : "",
  };
}

/** Canonical parameters sorted in immutable published order. */
export function positionalParameters(
  signature: CanonicalSignature,
): PublishedParameter[] {
  return [...signature.parameters].sort((a, b) => a.position - b.position);
}

/**
 * The runtime-binding view of a canonical signature (structurally the
 * functionRuntime.SignatureParameter shape; redeclared to avoid a runtime↔
 * validator import cycle): name, immutable position, optionality, and the
 * injected-client flag derived from the PUBLISHED TYPE (never arity).
 */
export interface RuntimeParameterView {
  name: string;
  position: number;
  optional: boolean;
  injected?: "client";
}

export function runtimeParametersFromCanonical(
  signature: CanonicalSignature | null,
): RuntimeParameterView[] | undefined {
  if (!signature) return undefined;
  return positionalParameters(signature).map((parameter) => ({
    name: parameter.name,
    position: parameter.position,
    optional: parameter.optional,
    injected: parameter.type.kind === "client" ? ("client" as const) : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Signature hash — "sha256:<hex>" over the canonical form (new publishes).
// Legacy rows are backfilled with a deterministic SQL-domain hash
// ("legacy-md5:<hex>", see migration 156); the hash is persisted for audit
// and per-execution pinning observability, never for equality-based upgrade
// decisions (those use isSignatureUpgradeCompatible on the canonical model).
// ---------------------------------------------------------------------------

function canonicalTypeForHash(type: FunctionType): unknown {
  switch (type.kind) {
    case "optional":
      return {
        kind: "optional",
        value: canonicalTypeForHash(type.value),
        allowsNull: type.allowsNull,
      };
    case "list":
      return { kind: "list", element: canonicalTypeForHash(type.element) };
    case "map":
      return {
        kind: "map",
        key: canonicalTypeForHash(type.key),
        value: canonicalTypeForHash(type.value),
      };
    case "struct":
      return {
        kind: "struct",
        fields: type.fields.map((field) => ({
          name: field.name,
          type: canonicalTypeForHash(field.type),
        })),
      };
    default:
      return type.kind === "unsupported"
        ? { kind: "unsupported", typeText: type.typeText }
        : { kind: type.kind };
  }
}

export function computeSignatureHash(
  contract: InvocationContract,
  signature: CanonicalSignature,
): string {
  const canonical = {
    contract,
    parameters: positionalParameters(signature).map((parameter) => ({
      name: parameter.name,
      position: parameter.position,
      optional: parameter.optional,
      hasDefault: parameter.hasDefault,
      type: canonicalTypeForHash(parameter.type),
    })),
    output: signature.output,
  };
  return (
    "sha256:" +
    createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
  );
}

// ---------------------------------------------------------------------------
// Upgrade compatibility (semantic auto-upgrade).
//
// Compatible:  identical parameters (name/position/type) plus ONLY appended
//              optional/default parameters; required → optional relaxation.
// Breaking:    renames, removal, reorder, type change, optional → required,
//              newly REQUIRED appended parameters, contract change (checked
//              by the caller).
// ---------------------------------------------------------------------------

export function canonicalTypeEquals(a: FunctionType, b: FunctionType): boolean {
  return (
    JSON.stringify(canonicalTypeForHash(a)) ===
    JSON.stringify(canonicalTypeForHash(b))
  );
}

export function isSignatureUpgradeCompatible(
  pinned: CanonicalSignature,
  candidate: CanonicalSignature,
): boolean {
  const pinnedOrdered = positionalParameters(pinned);
  const candidateOrdered = positionalParameters(candidate);
  if (candidateOrdered.length < pinnedOrdered.length) return false;
  for (const pinnedParam of pinnedOrdered) {
    const candidateParam = candidateOrdered.find(
      (p) => p.position === pinnedParam.position,
    );
    if (!candidateParam) return false;
    if (candidateParam.name !== pinnedParam.name) return false;
    if (!canonicalTypeEquals(candidateParam.type, pinnedParam.type)) {
      return false;
    }
    // optional → required is breaking; required → optional is compatible.
    if (pinnedParam.optional && !candidateParam.optional) return false;
  }
  // Anything appended beyond the pinned parameters must be safely omittable.
  return candidateOrdered
    .slice(pinnedOrdered.length)
    .every((p) => p.optional || p.hasDefault);
}
