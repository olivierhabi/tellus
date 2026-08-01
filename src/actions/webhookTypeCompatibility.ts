import type { WebhookParameterTypeValue } from "../services/connectivity/webhooks/contracts";

export interface ActionParameterContract {
  apiName: string;
  type: string;
  required?: boolean;
}

const INTEGER_ACTION_TYPES = new Set(["byte", "short", "integer"]);
const LONG_ACTION_TYPES = new Set(["byte", "short", "integer", "long"]);
const DOUBLE_ACTION_TYPES = new Set([
  "byte",
  "short",
  "integer",
  "long",
  "float",
  "double",
]);

export function isActionParameterCompatibleWithWebhook(
  parameter: ActionParameterContract,
  target: WebhookParameterTypeValue,
): boolean {
  const source = parameter.type.toLowerCase();
  switch (target.kind) {
    case "attachment":
      return source === "attachment";
    case "boolean":
      return source === "boolean";
    case "integer":
      return INTEGER_ACTION_TYPES.has(source);
    case "long":
      return LONG_ACTION_TYPES.has(source);
    case "double":
      return DOUBLE_ACTION_TYPES.has(source);
    case "string":
      return source === "string";
    case "date":
      return source === "date";
    case "timestamp":
      return source === "timestamp";
    case "list": {
      let expected: string | undefined;
      switch (target.elementType.kind) {
        case "string":
          expected = "string_array";
          break;
        case "boolean":
          expected = "boolean_array";
          break;
        case "integer":
          expected = "integer_array";
          break;
        case "double":
          expected = "double_array";
          break;
        case "timestamp":
          expected = "timestamp_array";
          break;
        default:
          expected = undefined;
      }
      return expected !== undefined && source === expected;
    }
    case "record":
      // Legacy action `struct` parameters have no persisted field contract,
      // so structural compatibility cannot be proven at authoring time.
      return false;
    default:
      return false;
  }
}

export function isStaticWebhookValueCompatible(
  value: unknown,
  target: WebhookParameterTypeValue,
  nullable: boolean,
): boolean {
  if (value === null) return nullable;
  switch (target.kind) {
    case "attachment":
      return typeof value === "string" && value.length > 0;
    case "boolean":
      return typeof value === "boolean";
    case "integer":
    case "long":
      return typeof value === "number" && Number.isInteger(value);
    case "double":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return (
        typeof value === "string" &&
        (!target.allowedValues ||
          target.allowedValues.length === 0 ||
          target.allowedValues.includes(value))
      );
    case "date":
      return (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
        !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      );
    case "timestamp":
      return (
        typeof value === "string" &&
        !Number.isNaN(Date.parse(value))
      );
    case "list":
      return (
        Array.isArray(value) &&
        value.every((entry) =>
          isStaticWebhookValueCompatible(entry, target.elementType, false),
        )
      );
    case "record": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const record = value as Record<string, unknown>;
      const fields = new Map(
        target.fields.map((field) => [field.id, field]),
      );
      if (Object.keys(record).some((key) => !fields.has(key))) return false;
      return target.fields.every((field) => {
        const fieldValue = record[field.id];
        if (fieldValue === undefined || fieldValue === null) {
          return !field.required;
        }
        return isStaticWebhookValueCompatible(
          fieldValue,
          field.type,
          !field.required,
        );
      });
    }
    default:
      return false;
  }
}
