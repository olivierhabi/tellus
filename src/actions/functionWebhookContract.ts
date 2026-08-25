import ts from "typescript";
import type { WebhookParameterTypeValue } from "../services/connectivity/webhooks/contracts";

export interface PublishedFunctionParameter {
  name: string;
  type: string;
  optional: boolean;
}

export interface PublishedFunctionSignature {
  parameters: PublishedFunctionParameter[];
  output: string;
}

export interface FunctionWebhookContractResult {
  compatible: boolean;
  errors: string[];
  repeated: boolean;
}

interface ParsedType {
  type: WebhookParameterTypeValue;
  nullable: boolean;
}

const NUMERIC_RANK = new Map([
  ["integer", 0],
  ["long", 1],
  ["double", 2],
]);

function parseNamedType(name: string): WebhookParameterTypeValue | null {
  switch (name.toLowerCase()) {
    case "attachment":
      return { kind: "attachment" };
    case "boolean":
      return { kind: "boolean" };
    case "byte":
    case "short":
    case "integer":
    case "int":
      return { kind: "integer" };
    case "long":
    case "bigint":
      return { kind: "long" };
    case "number":
    case "float":
    case "double":
      return { kind: "double" };
    case "string":
      return { kind: "string" };
    case "date":
    case "localdate":
      return { kind: "date" };
    case "datetime":
    case "timestamp":
    case "instant":
      return { kind: "timestamp" };
    default:
      return null;
  }
}

function parseNode(node: ts.TypeNode): ParsedType | null {
  if (node.kind === ts.SyntaxKind.StringKeyword) {
    return { type: { kind: "string" }, nullable: false };
  }
  if (node.kind === ts.SyntaxKind.BooleanKeyword) {
    return { type: { kind: "boolean" }, nullable: false };
  }
  if (node.kind === ts.SyntaxKind.NumberKeyword) {
    return { type: { kind: "double" }, nullable: false };
  }
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    return {
      type: { kind: "string", allowedValues: [node.literal.text] },
      nullable: false,
    };
  }
  if (ts.isUnionTypeNode(node)) {
    const valueNodes = node.types.filter(
      (part) =>
        part.kind !== ts.SyntaxKind.NullKeyword &&
        part.kind !== ts.SyntaxKind.UndefinedKeyword &&
        part.kind !== ts.SyntaxKind.VoidKeyword,
    );
    const nullable = valueNodes.length !== node.types.length;
    if (
      valueNodes.length > 0 &&
      valueNodes.every(
        (part) => ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal),
      )
    ) {
      return {
        type: {
          kind: "string",
          allowedValues: valueNodes.map(
            (part) => (part as ts.LiteralTypeNode).literal as ts.StringLiteral,
          ).map((literal) => literal.text),
        },
        nullable,
      };
    }
    if (valueNodes.length !== 1) return null;
    const parsed = parseNode(valueNodes[0]);
    return parsed ? { ...parsed, nullable: parsed.nullable || nullable } : null;
  }
  if (ts.isArrayTypeNode(node)) {
    const element = parseNode(node.elementType);
    return element
      ? { type: { kind: "list", elementType: element.type }, nullable: false }
      : null;
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    if (
      (name === "Array" || name === "ReadonlyArray" || name === "List") &&
      node.typeArguments?.length === 1
    ) {
      const element = parseNode(node.typeArguments[0]);
      return element
        ? { type: { kind: "list", elementType: element.type }, nullable: false }
        : null;
    }
    const named = parseNamedType(name);
    return named ? { type: named, nullable: false } : null;
  }
  if (ts.isTypeLiteralNode(node)) {
    const fields: Array<{
      id: string;
      required: boolean;
      type: WebhookParameterTypeValue;
    }> = [];
    for (const member of node.members) {
      if (
        !ts.isPropertySignature(member) ||
        !member.type ||
        (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))
      ) {
        return null;
      }
      const parsed = parseNode(member.type);
      if (!parsed) return null;
      fields.push({
        id: member.name.text,
        required: !member.questionToken && !parsed.nullable,
        type: parsed.type,
      });
    }
    return { type: { kind: "record", fields }, nullable: false };
  }
  return null;
}

export function parsePublishedFunctionType(typeText: string): ParsedType | null {
  const source = ts.createSourceFile(
    "webhook-function-contract.ts",
    `type __WebhookOutput = ${typeText};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = source.statements.find(ts.isTypeAliasDeclaration);
  return declaration ? parseNode(declaration.type) : null;
}

function compatibleType(
  source: WebhookParameterTypeValue,
  target: WebhookParameterTypeValue,
): boolean {
  const sourceRank = NUMERIC_RANK.get(source.kind);
  const targetRank = NUMERIC_RANK.get(target.kind);
  if (sourceRank !== undefined && targetRank !== undefined) {
    return sourceRank <= targetRank;
  }
  if (source.kind !== target.kind) return false;
  if (source.kind === "string" && target.kind === "string") {
    if (!target.allowedValues?.length) return true;
    return (
      !!source.allowedValues?.length &&
      source.allowedValues.every((value) => target.allowedValues?.includes(value))
    );
  }
  if (source.kind === "list" && target.kind === "list") {
    return compatibleType(source.elementType, target.elementType);
  }
  if (source.kind === "record" && target.kind === "record") {
    const sourceFields = new Map(source.fields.map((field) => [field.id, field]));
    return target.fields.every((targetField) => {
      const sourceField = sourceFields.get(targetField.id);
      return (
        !!sourceField &&
        (!targetField.required || sourceField.required) &&
        compatibleType(sourceField.type, targetField.type)
      );
    });
  }
  return true;
}

export function validateFunctionWebhookContract(
  signature: PublishedFunctionSignature,
  webhookInputs: ReadonlyArray<{
    id: string;
    required: boolean;
    type: WebhookParameterTypeValue;
  }>,
  resultMode: "single" | "list",
): FunctionWebhookContractResult {
  const parsed = parsePublishedFunctionType(signature.output);
  if (!parsed) {
    return {
      compatible: false,
      repeated: false,
      errors: [
        `Function return type '${signature.output}' is unsupported or opaque.`,
      ],
    };
  }
  const repeated = parsed.type.kind === "list";
  const payloadType: WebhookParameterTypeValue =
    parsed.type.kind === "list" ? parsed.type.elementType : parsed.type;
  const errors: string[] = [];
  if (resultMode === "single" && repeated) {
    errors.push("A writeback or single-payload mapping cannot use a list-returning Function.");
  }
  if (resultMode === "list" && !repeated) {
    errors.push("Repeated side-effect execution requires a list-returning Function.");
  }
  if (payloadType.kind !== "record") {
    errors.push("Function return type must be a record containing webhook input fields.");
  } else {
    const outputFields = new Map(payloadType.fields.map((field) => [field.id, field]));
    for (const input of webhookInputs) {
      const field = outputFields.get(input.id);
      if (!field) {
        if (input.required) {
          errors.push(`Function output is missing required webhook field '${input.id}'.`);
        }
        continue;
      }
      if (input.required && !field.required) {
        errors.push(`Function output field '${input.id}' is optional but the webhook input is required.`);
      }
      if (!compatibleType(field.type, input.type)) {
        errors.push(`Function output field '${input.id}' is incompatible with webhook type '${input.type.kind}'.`);
      }
    }
  }
  return { compatible: errors.length === 0, errors, repeated };
}
