// ---------------------------------------------------------------------------
// GET /connector-types
//
// Returns the master list of connector types from the database.  Consumed by
// the /data-connection/new-source page so the source picker is data-driven
// rather than hardcoded.
// ---------------------------------------------------------------------------

import type { Request, Response } from "express";
import { listEnabled } from "../store/connector-types.repo";

export async function listConnectorTypes(req: Request, res: Response) {
  const types = await listEnabled();
  res.status(200).json({ types });
}
