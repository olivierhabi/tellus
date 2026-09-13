import type { ValueSource } from "./actionRules.types";
import { OntologyError } from "../utils/queryErrors";

export interface FunctionInputParameterDefinition {
  apiName: string;
  type: string;
  objectType?: string;
}

export interface ResolveFunctionInputOptions {
  inputs?: Readonly<Record<string, ValueSource>>;
  resolvedParameters: Readonly<Record<string, unknown>>;
  parameterDefinitions: ReadonlyArray<FunctionInputParameterDefinition>;
  currentUserId?: string;
  executedBy: string;
  objectFetcher: (
    objectType: string,
    primaryKey: string,
  ) => Promise<Record<string, unknown> | null>;
  now?: () => Date;
}

function primaryKeyFromReference(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["primaryKey", "$primaryKey", "id"]) {
    const candidate = record[key];
    if (typeof candidate === "string" || typeof candidate === "number") {
      return String(candidate);
    }
  }
  return null;
}

function readObjectProperty(
  object: Record<string, unknown>,
  path: string,
): unknown {
  const segments = path.split("/").filter(Boolean);
  let current: unknown = object;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export async function resolveFunctionInputs(
  options: ResolveFunctionInputOptions,
): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = { ...options.resolvedParameters };
  if (!options.inputs) return args;

  const definitions = new Map(
    options.parameterDefinitions.map((definition) => [
      definition.apiName,
      definition,
    ]),
  );

  for (const [functionInput, source] of Object.entries(options.inputs)) {
    switch (source.source) {
      case "parameter":
        args[functionInput] = options.resolvedParameters[source.param];
        break;
      case "static":
        args[functionInput] = source.value;
        break;
      case "currentTimestamp":
        args[functionInput] = (options.now ?? (() => new Date()))().toISOString();
        break;
      case "currentUser":
        args[functionInput] = options.currentUserId ?? options.executedBy;
        break;
      case "objectProperty": {
        const definition = definitions.get(source.param);
        if (definition?.type !== "object_reference" || !definition.objectType) {
          throw new OntologyError(
            `Function input '${functionInput}' maps object property '${source.path}' from non-object parameter '${source.param}'.`,
            "FUNCTION_INPUT_MAPPING_INVALID",
            422,
          );
        }
        const primaryKey = primaryKeyFromReference(
          options.resolvedParameters[source.param],
        );
        if (!primaryKey) {
          throw new OntologyError(
            `Function input '${functionInput}' could not resolve object parameter '${source.param}'.`,
            "FUNCTION_INPUT_MAPPING_INVALID",
            422,
          );
        }
        const object = await options.objectFetcher(
          definition.objectType,
          primaryKey,
        );
        if (!object) {
          throw new OntologyError(
            `Object '${definition.objectType}:${primaryKey}' was not found while resolving Function input '${functionInput}'.`,
            "OBJECT_NOT_FOUND",
            404,
          );
        }
        const value = readObjectProperty(object, source.path);
        if (value === undefined) {
          throw new OntologyError(
            `Property '${source.path}' was not found on '${definition.objectType}' while resolving Function input '${functionInput}'.`,
            "FUNCTION_INPUT_MAPPING_INVALID",
            422,
          );
        }
        args[functionInput] = value;
        break;
      }
      case "generatedSequence":
      case "writebackResponse":
        throw new OntologyError(
          `Function input '${functionInput}' uses unsupported source '${source.source}'.`,
          "FUNCTION_INPUT_MAPPING_INVALID",
          422,
        );
      default: {
        const exhaustive: never = source;
        throw new OntologyError(
          `Unsupported Function input source '${String((exhaustive as { source?: unknown }).source ?? "unknown")}'.`,
          "FUNCTION_INPUT_MAPPING_INVALID",
          422,
        );
      }
    }
  }
  return args;
}
