// Quiver F5/F6 — Card Type Registry endpoint.
//
// Exposes the canonical 26-card type registry to the FE so build-time checks
// can verify every CardPlugin is wired (F5 C-08, F6 C-08). Read-only,
// cacheable, no auth required (registry is non-confidential metadata; the
// same registry is enforced server-side by `assertRegistryIntegrity()`).

import { Router, type Request, type Response } from "express";
import { listCardTypes } from "../../services/quiver/dag";
import { createHash } from "node:crypto";

export const registryRouter = Router();

registryRouter.get("/registry/cards", (_req: Request, res: Response) => {
  const cards = listCardTypes().map((e) => ({
    type: e.type,
    inputs: Object.fromEntries(
      Object.entries(e.inputs).map(([slot, decl]) => [
        slot,
        {
          accepts: [...decl.acceptedTypes],
          optional: !!decl.optional,
          list: !!decl.list,
        },
      ]),
    ),
    output: e.output,
  }));
  // Use a content hash of the serialized registry for the ETag so that
  // changes to card type definitions (not just additions/removals) invalidate caches.
  const contentHash = createHash("sha256")
    .update(JSON.stringify(cards))
    .digest("hex")
    .slice(0, 16);
  res.set("Cache-Control", "public, max-age=300");
  res.set("ETag", `W/"${contentHash}"`);
  res.status(200).json({
    version: 1,
    count: cards.length,
    cards,
  });
});
