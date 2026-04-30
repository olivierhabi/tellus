// ---------------------------------------------------------------------------
// K8s Service-selector flip — Task B8 / B9 cutover
//
// Replacement pipelines promote the `secondary` Quickwit searcher pool to
// `live`. In-process `promoteSecondary` (searcherPool.ts) updates the
// node's routing table, but production traffic is steered by the
// Kubernetes Service `quickwit-searcher` whose selector pins
// `role: live|secondary`. The cutover is ONE atomic `PATCH
// /api/v1/namespaces/<ns>/services/<name>` payload that swaps the role
// label — a single Kubernetes API call, no race.
//
// Runs in-cluster using the pod's service-account token + CA bundle.
// Out-of-cluster callers pass `host` + `token` explicitly.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { Agent, request as httpsRequest } from "https";
import { URL as NodeURL } from "url";

export interface K8sFlipConfig {
  /** Service name to patch. Default `quickwit-searcher`. */
  service?: string;
  /** Namespace. Default from POD_NAMESPACE env / `default`. */
  namespace?: string;
  /** API server host, e.g. `https://kubernetes.default.svc`. */
  apiServer?: string;
  /** Bearer token. Default reads pod-injected service-account token. */
  token?: string;
  /** Override CA bundle path. Default reads pod CA bundle. */
  caBundlePath?: string;
}

const DEFAULT_SA_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const DEFAULT_CA = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

/**
 * Atomically flip the Service selector so traffic routes to `target`
 * (`live` or `secondary`). Returns the new `role` value once the API
 * server has applied the patch.
 *
 * The patch is a JSON-merge-patch on `spec.selector.role` — that field
 * is the only selector value that ever changes between cutovers, so the
 * patch is minimal and deterministic.
 */
export async function flipSearcherServiceSelector(
  target: "live" | "secondary",
  config: K8sFlipConfig = {}
): Promise<{ role: "live" | "secondary"; resourceVersion: string }> {
  const apiServer =
    config.apiServer ??
    process.env.KUBERNETES_SERVICE_HOST
      ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${
          process.env.KUBERNETES_SERVICE_PORT ?? "443"
        }`
      : "https://kubernetes.default.svc";
  const namespace = config.namespace ?? process.env.POD_NAMESPACE ?? "default";
  const service = config.service ?? "quickwit-searcher";
  const token = config.token ?? readFileSync(DEFAULT_SA_TOKEN, "utf8").trim();
  const caBundlePath = config.caBundlePath ?? DEFAULT_CA;
  let httpsAgent: Agent | undefined;
  try {
    httpsAgent = new Agent({ ca: readFileSync(caBundlePath) });
  } catch {
    // Dev / out-of-cluster — fall back to default TLS trust.
    httpsAgent = undefined;
  }

  const url = `${apiServer}/api/v1/namespaces/${encodeURIComponent(
    namespace
  )}/services/${encodeURIComponent(service)}`;

  // JSON-merge-patch. Only the role label is changed; other selector
  // keys (`app`, `tier`) stay intact because merge-patch does not
  // replace siblings.
  const body = JSON.stringify({
    spec: { selector: { role: target } },
  });

  const res = await nodeFetch(url, {
    method: "PATCH",
    agent: httpsAgent,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/merge-patch+json",
      accept: "application/json",
    },
    body,
  });

  if (res.status < 200 || res.status >= 300) {
    const text = await res.text();
    throw new Error(
      `K8s service flip failed (${res.status}): ${text.slice(0, 400)}`
    );
  }
  const parsed = (await res.json()) as {
    metadata?: { resourceVersion?: string };
    spec?: { selector?: { role?: string } };
  };
  const role = (parsed.spec?.selector?.role ?? target) as "live" | "secondary";
  return {
    role,
    resourceVersion: parsed.metadata?.resourceVersion ?? "",
  };
}

// ESM-friendly HTTPS PATCH helper. `global.fetch` (undici) exposes a
// `dispatcher` knob instead of `agent`, so when we need to attach the
// pod's CA bundle we fall through to the Node https module directly.
async function nodeFetch(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    agent?: Agent;
  }
): Promise<{
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}> {
  return new Promise((resolve, reject) => {
    const u = new NodeURL(url);
    const req = httpsRequest(
      {
        host: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ""),
        method: init.method,
        headers: init.headers,
        agent: init.agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            text: () => Promise.resolve(text),
            json: () => Promise.resolve(JSON.parse(text) as unknown),
          });
        });
      }
    );
    req.on("error", reject);
    req.write(init.body);
    req.end();
  });
}
