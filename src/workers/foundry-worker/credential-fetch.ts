// ---------------------------------------------------------------------------
// B4 — Worker credential fetch (spec §B4 line 201).
//
// Runs INSIDE the child_process sandbox. Uses the workload JWT injected in
// env.TELLUS_WORKLOAD_JWT to call the orchestration server's internal
// unwrap endpoint:
//   POST /api/v2/connectivity/internal/credentials/unwrap
//
// Body: { connectionRid, name }
// Returns: { version, fields }  (fields contain user/password/TLS pems)
//
// JWT scope is `connectivity:credential-unwrap` with claim
// `connection_rid` exactly matching the requested connectionRid.
// ---------------------------------------------------------------------------

const URL_BASE =
  process.env.TELLUS_INTERNAL_URL ?? "http://127.0.0.1:8080";
const TIMEOUT_MS = 15_000;

export interface CredentialFields {
  user: string;
  password: string;
  serverCaPem?: string;
  clientCertPem?: string;
  clientKeyPem?: string;
}

export interface CredentialFetchResult {
  version: number;
  fields: CredentialFields;
}

export async function fetchCredential(
  connectionRid: string,
  name = "default",
): Promise<CredentialFetchResult> {
  const jwt = process.env.TELLUS_WORKLOAD_JWT;
  if (!jwt) {
    throw new Error("worker missing TELLUS_WORKLOAD_JWT in env");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${URL_BASE}/api/v2/connectivity/internal/credentials/unwrap`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ connectionRid, name }),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      // Drain the error body for diagnostics; never log credentials.
      const body = await res.text().catch(() => "");
      throw new Error(
        `credential unwrap failed status=${res.status} body=${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as CredentialFetchResult;
    return json;
  } finally {
    clearTimeout(t);
  }
}
