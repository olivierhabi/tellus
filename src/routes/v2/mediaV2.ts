// ---------------------------------------------------------------------------
// Media v2 routes — upload-only media picker backing store.
//
//   POST /api/v2/ontologies/:ontology/media/upload?filename=...
//       Content-Type: application/octet-stream (raw file bytes)
//       → 200 { mediaItemRid, filename, sizeBytes, mediaType }
//
// mediaItemRid = `ri.mio.main.media-item.<uuid>` — the value submitted as a
// media_reference action parameter. Reads flow through the existing
// signed-media-reference path (signMediaReadToken), which is keyed on the
// media item rid.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import {
  stageToDisk,
  uploadMediaItem,
} from "../../services/attachmentService";
import { requireSecurityContext } from "../../middleware/securityContext";
import { requireOntology } from "./ontologyParam";
import { getOntologyId } from "../../services/ontology/canonicalOntology";
import { resolveRequestTenant } from "../../utils/requestTenant";
import { toV2Error } from "../../services/oss/v2Errors";

const router = Router({ mergeParams: true });

router.post("/upload", async (req: Request, res: Response) => {
  try {
    const security = requireSecurityContext(req);
    // The v1 surface collapses any ontology alias (e.g. "default") to the
    // canonical UUID server-side; v2 resolves by UUID/display name only.
    // Workshop callers can hold either shape, so accept the canonical
    // single-ontology fallback the "One Enterprise, One Ontology" edge
    // collapse applies everywhere else.
    let ontologyId: string;
    try {
      ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
    } catch {
      const canonical = await getOntologyId();
      if (!canonical) throw new Error("Ontology not found.");
      ontologyId = canonical;
    }
    const filename = String(req.query.filename ?? "").trim();
    if (!filename) {
      throw Object.assign(new Error("filename query parameter is required."), {
        errorName: "InvalidUploadMediaRequest",
        statusCode: 400,
      });
    }
    const { stagedPath, size } = await stageToDisk(req);
    const item = await uploadMediaItem({
      filename,
      stagedPath,
      size,
      createdBy: security.userId,
      ontologyId,
    });
    res.status(200).json(item);
  } catch (err) {
    if (res.headersSent || res.writableEnded) return;
    const { status, body } = toV2Error(err);
    res.status(status).json(body);
  }
});

export default router;
