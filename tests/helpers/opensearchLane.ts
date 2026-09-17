// ---------------------------------------------------------------------------
// tests/helpers/opensearchLane.ts — lane helper for DIRECT OpenSearch REST
// access in vitest/e2e lanes (availability probes and raw-document
// fixtures that intentionally bypass the app layer).
//
// The shared dev cluster runs OpenSearch WITH the security plugin enabled
// (HTTPS + Basic auth on demo certs). This helper returns the base URL
// (OPENSEARCH_URL-overridable, https default) plus the Basic Authorization
// header (OPENSEARCH_USERNAME/OPENSEARCH_PASSWORD-overridable, committed
// demo default otherwise — see docker-compose.yml).
//
// TLS: the helper sets NODE_TLS_REJECT_UNAUTHORIZED=0 for the calling
// process (only when unset) so lanes can talk to the demo self-signed
// cert. LANE-ONLY posture — production app code (src/services/opensearch)
// pins its own explicit TLS options instead.
// ---------------------------------------------------------------------------

export interface OpenSearchLaneTarget {
  base: string;
  headers: Record<string, string>;
}

export function opensearchLaneTarget(): OpenSearchLaneTarget {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const base = process.env.OPENSEARCH_URL ?? "https://localhost:9200";
  const user = process.env.OPENSEARCH_USERNAME ?? "admin";
  const pass =
    process.env.OPENSEARCH_PASSWORD ?? "Str0ng!P@ssw0rd-Tellus-9a7b3Cz";
  return {
    base,
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
    },
  };
}

/** Availability probe: true when the cluster answers the root path OK. */
export async function isOpenSearchAvailable(): Promise<boolean> {
  const { base, headers } = opensearchLaneTarget();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(base, { signal: controller.signal, headers });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}
