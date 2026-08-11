export type PropertyMarking = {
  api_name: string;
  column_name?: string | null;
  marking_required: string[] | string | null;
};

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Remove every flat or backing-column representation the caller cannot read. */
export function omitUnauthorizedProperties(
  properties: Record<string, unknown>,
  markings: readonly PropertyMarking[],
  grantedMarkings: ReadonlySet<string>,
  markingBypass = false,
): string[] {
  if (markingBypass) return [];
  const omitted: string[] = [];
  for (const row of markings) {
    const required = Array.isArray(row.marking_required)
      ? row.marking_required
      : typeof row.marking_required === "string" && row.marking_required
        ? [row.marking_required]
        : [];
    if (required.length === 0 || required.every((marking) => grantedMarkings.has(marking))) continue;
    const aliases = new Set([row.api_name, snakeCase(row.api_name)]);
    if (row.column_name) aliases.add(row.column_name);
    let found = false;
    for (const property of aliases) {
      if (!Object.prototype.hasOwnProperty.call(properties, property)) continue;
      delete properties[property];
      found = true;
    }
    if (found) omitted.push(row.api_name);
  }
  return omitted;
}
