// ---------------------------------------------------------------------------
// Folders handler — GET /api/v1/connectivity/folders
//
// Returns folder-like resources from the `resources` table for the
// folder-picker dialog used when creating a new connection.
//
// Query parameters:
//   parentRid  (optional) — RID of the parent to list children of.
//              When omitted, returns root-level items (parent_folder_rid IS NULL).
//   q          (optional) — case-insensitive search on display_name.
//
// Requires: connectivity:read scope.
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { TellusError } from "../../../lib/errors/envelope";
import {
  CompassFolderNotFound,
  InvalidConfiguration,
} from "../../../lib/errors/connectivity.errors";
import * as repo from "../store/folders.repo";
import { extractUser, requireScope } from "./connections.handler";

/**
 * GET /api/v1/connectivity/folders
 *
 * Response shape: { items: [{ rid, displayName, type, hasChildren }] }
 */
export async function listFolders(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parentRid = (req.query.parentRid as string | undefined) ?? undefined;
    const q = (req.query.q as string | undefined) ?? undefined;

    // Validate parentRid shape if provided — must look like a RID.
    if (parentRid !== undefined && !/^ri\.[a-z]/.test(parentRid)) {
      throw new TellusError(InvalidConfiguration, {
        field: "parentRid",
        message: "must be a valid resource identifier (ri.…)",
      });
    }

    const result = await repo.listFolders({
      tenant: "default",
      parentRid,
      q,
    });

    res.status(200).json(result);
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}

/**
 * GET /api/v1/connectivity/folders/:rid
 *
 * Resolves a single folder-like resource by RID into display metadata
 * ({ rid, displayName, type, path, parentPath }). Powers connection-settings
 * prefill — turning a stored `compassFolderRid` into the location name + path
 * shown in the "Name and location" and "Output folder" sections.
 *
 * Returns 404 (CompassFolderNotFound) when the RID does not resolve to a
 * non-trashed resource.
 */
export async function getFolder(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rid = req.params.rid;

    // Validate shape — must look like a RID — to keep the lookup well-formed.
    if (!rid || !/^ri\.[a-z]/.test(rid)) {
      throw new TellusError(InvalidConfiguration, {
        field: "rid",
        message: "must be a valid resource identifier (ri.…)",
      });
    }

    const folder = await repo.resolveFolder(rid);
    if (!folder) {
      throw new TellusError(CompassFolderNotFound, { rid });
    }

    res.status(200).json(folder);
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}

const CreateOutputFolderBody = z.object({
  // The wizard's selected location (project/space/folder). Optional — when
  // absent the backend seeds/uses the default data project.
  parentRid: z
    .string()
    .regex(/^ri\.[a-z]/, "must be a valid resource identifier (ri.…)")
    .optional(),
  // Folder display name. Defaults to "raw" server-side when omitted.
  name: z.string().trim().min(1).max(256).optional(),
});

/**
 * POST /api/v1/connectivity/folders
 *
 * Creates (or reuses) a default output folder for syncs. Returns
 * { rid, name, path } where `path` is the folder's parent ancestor path,
 * e.g. "/Ontologize Public-33fd9b/My Data Project".
 *
 * Requires: connectivity:write scope.
 */
export async function createOutputFolder(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = extractUser(req);
    requireScope(user, "connectivity:write");

    const parsed = CreateOutputFolderBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new TellusError(InvalidConfiguration, {
        issues: parsed.error.issues,
      });
    }

    const ownerEmail = (req as unknown as { user?: { email?: string } }).user
      ?.email;

    const folder = await repo.createOutputFolder({
      parentRid: parsed.data.parentRid,
      name: parsed.data.name,
      ownerEmail,
    });

    res.status(201).json(folder);
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}
