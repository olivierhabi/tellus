import { appError } from "../utils/appError";

const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ICEBERG_URI = /^iceberg:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/;

/**
 * Validate the canonical locator stored on foundry_datasets.
 *
 * Funnel sources are either an Iceberg URI or a MinIO object key. MinIO keys
 * are intentionally not URLs, but they must be a non-absolute, hierarchical
 * key. A UUID is an identifier, never a readable datasource locator.
 */
export function assertCanonicalFoundryPath(value: unknown): asserts value is string {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path) {
    throw appError("DATASOURCE_PATH_INVALID", "The linked dataset has no canonical file path.");
  }
  if (BARE_UUID.test(path)) {
    throw appError(
      "DATASOURCE_PATH_INVALID",
      `The linked dataset canonical file path '${path}' is a bare UUID, not a readable datasource locator.`,
    );
  }
  if (path.startsWith("iceberg://")) {
    if (!ICEBERG_URI.test(path) || path.includes("..")) {
      throw appError("DATASOURCE_PATH_INVALID", `The linked dataset canonical Iceberg URI '${path}' is invalid.`);
    }
    return;
  }
  if (
    path.startsWith("/") ||
    !path.includes("/") ||
    path.includes("#") ||
    path.split("/").includes("..") ||
    /[\0\r\n]/.test(path)
  ) {
    throw appError(
      "DATASOURCE_PATH_INVALID",
      `The linked dataset canonical object-store key '${path}' is invalid.`,
    );
  }
}

/** Defense-in-depth at the funnel boundary, independent of binding writes. */
export function assertFunnelReadablePath(path: string): void {
  if (BARE_UUID.test(path.trim())) {
    throw new Error(
      `Invalid funnel backing source '${path}': a bare dataset UUID cannot be used as a file path.`,
    );
  }
}

