// Quiver F5/F6 — Card Type Registry endpoint.
//
// Exposes the canonical 26-card type registry to the FE so build-time checks
// can verify every CardPlugin is wired (F5 C-08, F6 C-08). Read-only,
// cacheable, no auth required (registry is non-confidential metadata; the
// same registry is enforced server-side by `assertRegistryIntegrity()`).

import { Router, type Request, type Response } from "express";
import { listCardTypes } from "../../services/quiver/dag";

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
  res.set("Cache-Control", "public, max-age=300");
  res.set("ETag", `W/"quiver-registry-v${cards.length}"`);
  res.status(200).json({
    version: 1,
    count: cards.length,
    cards,
  });
});
