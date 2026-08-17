/**
 * Compatibility checks for system-provided action-rule values.
 *
 * Parameter values carry a declared type, but system values do not; these
 * checks therefore protect the persisted Action Type contract at save time.
 */
export function validateSystemValueSourceForProperty(
  value: unknown,
  path: string,
  propertyBaseType: string | undefined,
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const source = value as Record<string, unknown>;
  if (
    source.source === "currentTimestamp" &&
    propertyBaseType !== "date" &&
    propertyBaseType !== "timestamp"
  ) {
    return [
      `${path} maps Current timestamp to '${propertyBaseType ?? "unknown"}'. Current timestamp is only compatible with date or timestamp properties.`,
    ];
  }
  return [];
}
