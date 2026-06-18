// Quiver branch propagation (G-05, D-11).
//
// Every endpoint that touches OMS/OSS/Codex/MMDP must forward the
// branch verbatim. Header `X-Tellus-Branch` is canonical; query
// `?branch=` is allowed for shareable URLs and converted to the header
// for downstream calls.
// `main` is the default trunk.

import type { Request } from "express";

export const TRUNK = "main" as const;

export function readBranch(req: Pick<Request, "header" | "query">): string {
  const h = req.header("x-tellus-branch");
  if (typeof h === "string" && h.length > 0) return h;
  const q = req.query?.branch;
  if (typeof q === "string" && q.length > 0) return q;
  return TRUNK;
}

/** Headers to forward on every downstream call. */
export function downstreamHeaders(branch: string): Record<string, string> {
  return { "x-tellus-branch": branch };
}
