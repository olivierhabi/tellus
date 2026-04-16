/**
 * /api/v2/iceberg — backend-facing Iceberg / Nessie endpoints used by
 * the integration tests. Wraps `services/nessieService.ts`.
 *
 *   GET  /api/v2/iceberg/config       → Nessie /config + tellus warehouse URI
 *   GET  /api/v2/iceberg/branches     → list of Nessie branches
 *   GET  /api/v2/iceberg/entries      → entries on `main` (namespaces + tables)
 *   POST /api/v2/iceberg/namespace    → create a namespace (idempotent)
 *   POST /api/v2/iceberg/table        → register an Iceberg table reference
 *
 * The bash + Cypress verification scripts call these to prove the
 * "Iceberg as primary table format" piece of the spec is wired all the
 * way through, not just a docker container.
 */

import { Router, type Request, type Response } from "express";
import {
  createIcebergTableRef,
  createNamespace,
  getConfig,
  listBranches,
  listEntries,
} from "../services/nessieService";

const router = Router();

router.get("/iceberg/config", async (_req: Request, res: Response) => {
  try {
    const cfg = await getConfig();
    res.json({
      success: true,
      data: {
        ...cfg,
        warehouse: process.env.ICEBERG_WAREHOUSE || "s3://iceberg-warehouse",
        engine: "Project Nessie",
      },
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: { code: "NESSIE_UNAVAILABLE", message: (err as Error).message },
    });
  }
});

router.get("/iceberg/branches", async (_req: Request, res: Response) => {
  try {
    const refs = await listBranches();
    res.json({ success: true, data: refs });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: { code: "NESSIE_UNAVAILABLE", message: (err as Error).message },
    });
  }
});

router.get("/iceberg/entries", async (_req: Request, res: Response) => {
  try {
    const entries = await listEntries();
    res.json({ success: true, data: entries });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: { code: "NESSIE_UNAVAILABLE", message: (err as Error).message },
    });
  }
});

router.post("/iceberg/namespace", async (req: Request, res: Response) => {
  const ns = req.body?.namespace;
  if (!Array.isArray(ns) || ns.length === 0) {
    return res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "namespace must be a non-empty string array (e.g. ['ontology'])",
      },
    });
  }
  try {
    const result = await createNamespace(ns);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: { code: "NESSIE_ERROR", message: (err as Error).message },
    });
  }
});

router.post("/iceberg/table", async (req: Request, res: Response) => {
  const { namespace, name, metadataLocation } = req.body ?? {};
  if (!Array.isArray(namespace) || !name) {
    return res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "namespace[] and name are required",
      },
    });
  }
  try {
    const result = await createIcebergTableRef(
      namespace,
      name,
      metadataLocation || `s3://iceberg-warehouse/${[...namespace, name].join("/")}/metadata.json`,
    );
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: { code: "NESSIE_ERROR", message: (err as Error).message },
    });
  }
});

export default router;
