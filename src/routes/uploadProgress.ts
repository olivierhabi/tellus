// ---------------------------------------------------------------------------
// src/routes/uploadProgress.ts
//
// GET /api/v1/uploads/:uploadId/progress
//
// Advisory progress for an in-flight multipart upload. The frontend
// (UploadFilesDialog) polls this every 500ms while the POST .../upload is in
// flight, so its progress bar reflects the server→S3 streaming phase that
// axios `onUploadProgress` can't see. State lives in Redis (uploadProgress.ts)
// so any API replica can answer a poll, not just the one handling the POST.
//
// Auth: enforced by the global `globalAuth()` gate mounted in server.ts (no
// per-route middleware — mirrors reindexStatus.ts, which is also GET-only and
// relies on the global gate). Response envelope via sendSuccess/sendError.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from 'express';
import { readProgress } from '../services/uploadProgress';
import { sendSuccess, sendError } from '../utils/responseFormatter';

const router = Router();

router.get(
  '/:uploadId/progress',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uploadId = req.params.uploadId;
      // Basic guard against abuse of the Redis key namespace.
      if (!uploadId || !/^[A-Za-z0-9_-]{1,128}$/.test(uploadId)) {
        return sendError(res, 'VALIDATION_ERROR', 'Invalid upload id.');
      }
      const progress = await readProgress(uploadId);
      return sendSuccess(res, { data: progress });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
