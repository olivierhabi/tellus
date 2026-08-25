const FUNCTION_RID_RE = /^ri\.function-registry\.main\.function\.[0-9a-f-]{36}$/i;

export interface RegistryCursor {
  readonly publishedAt: string;
  readonly rid: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function encodeRegistryCursor(cursor: RegistryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeRegistryCursor(value: string): RegistryCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!isObjectRecord(parsed)) return null;
    if (typeof parsed.publishedAt !== "string" || Number.isNaN(Date.parse(parsed.publishedAt))) return null;
    if (typeof parsed.rid !== "string" || !FUNCTION_RID_RE.test(parsed.rid)) return null;
    return { publishedAt: parsed.publishedAt, rid: parsed.rid };
  } catch {
    return null;
  }
}

export function isFunctionRegistryRid(value: string): boolean {
  return FUNCTION_RID_RE.test(value);
}
