// ---------------------------------------------------------------------------
// Attachments v2 routes — Foundry-parity action parameter attachment API.
//
//   POST /api/v2/ontologies/attachments/upload?filename=...
//       Content-Type: application/octet-stream (raw file bytes)
//       → 200 { rid, filename, sizeBytes, mediaType }
//
//   GET  /api/v2/ontologies/attachments/:attachmentRid/content
//       → 200 raw bytes (Content-Type/Length/Disposition from metadata)
//
// Mounted at /api/v2/ontologies (no :ontology segment) to match the public
// Foundry path exactly; the ontology is recorded as NULL on upload and can
// be stamped when the attachment is linked via an action.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import {
  stageToDisk,
  uploadAttachment,
  getAttachmentContent,
} from "../../services/attachmentService";
import { requireSecurityContext } from "../../middleware/securityContext";
import { toV2Error } from "../../services/oss/v2Errors";

const router = Router();

router.post("/attachments/upload", async (req: Request, res: Response) => {
  try {
    const security = requireSecurityContext(req);
    const filename = String(req.query.filename ?? "").trim();
    if (!filename) {
      throw Object.assign(new Error("filename query parameter is required."), {
        errorName: "InvalidUploadAttachmentRequest",
        statusCode: 400,
      });
    }
    const contentType = req.headers["content-type"] ?? "";
    if (String(contentType).toLowerCase().startsWith("multipart/")) {
      throw Object.assign(
        new Error(
          "Uploads must send raw file bytes with Content-Type: application/octet-stream.",
        ),
        { errorName: "InvalidUploadAttachmentRequest", statusCode: 400 },
      );
    }
    const { stagedPath, size } = await stageToDisk(req);
    const attachment = await uploadAttachment({
      filename,
      stagedPath,
      size,
      createdBy: security.userId,
      ontologyId: null,
      // Honor a specific declared type (e.g. image/png); generic
      // application/octet-stream falls back to extension sniffing.
      contentType:
        contentType && !String(contentType).startsWith("application/octet-stream")
          ? String(contentType).split(";")[0].trim()
          : undefined,
    });
    res.status(200).json(attachment);
  } catch (err) {
    if (res.headersSent || res.writableEnded) return;
    const { status, body } = toV2Error(err);
    res.status(status).json(body);
  }
});

router.get(
  "/attachments/:attachmentRid/content",
  async (req: Request, res: Response) => {
    try {
      requireSecurityContext(req);
      const result = await getAttachmentContent(req.params.attachmentRid);
      if (!result) {
        throw Object.assign(new Error("Attachment not found."), {
          errorName: "AttachmentNotFound",
          statusCode: 404,
        });
      }
      res.setHeader("Content-Type", result.row.media_type);
      res.setHeader("Content-Length", result.row.size_bytes);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(result.row.filename)}"`,
      );
      result.stream.on("error", (err) => {
        if (!res.headersSent && !res.writableEnded) {
          const { status, body } = toV2Error(err);
          res.status(status).json(body);
        } else {
          res.destroy();
        }
      });
      result.stream.pipe(res);
    } catch (err) {
      if (res.headersSent || res.writableEnded) return;
      const { status, body } = toV2Error(err);
      res.status(status).json(body);
    }
  },
);

export default router;
