import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { DatasetService } from '../services/datasetService';
import { DatasetListQuerySchema, DatasetPreviewQuerySchema } from '../types/dataset';
import { AppError } from '../utils/foundryAppError';
import { sendSuccess, sendCreated, sendError } from '../utils/foundryResponse';
import { z } from 'zod';
import { getObjectStream, getPresignedDownloadUrl, headObject } from '../services/storageService';

const UuidParam = z.string().uuid('Invalid UUID format');

export class DatasetController {
  constructor(private datasetService: DatasetService) {}

  /**
   * List datasets in a folder with pagination.
   */
  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const folderId = req.params.folderId as string;
      if (!UuidParam.safeParse(folderId).success) {
        throw new AppError('Invalid folder ID format', 400, 'VALIDATION_ERROR');
      }

      const queryParsed = DatasetListQuerySchema.safeParse(req.query);
      if (!queryParsed.success) {
        throw new AppError(queryParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const result = await this.datasetService.listDatasets(folderId, queryParsed.data);
      res.json({ success: true, data: result.datasets, meta: result.meta });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get a single dataset by ID with columns.
   */
  getById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const dataset = await this.datasetService.getDatasetById(datasetId);
      if (!dataset) {
        throw new AppError('Dataset not found', 404, 'NOT_FOUND');
      }

      res.json({ success: true, data: dataset });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get a preview of dataset rows.
   */
  preview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const queryParsed = DatasetPreviewQuerySchema.safeParse(req.query);
      if (!queryParsed.success) {
        throw new AppError(queryParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const preview = await this.datasetService.getDatasetPreview(
        datasetId,
        queryParsed.data.rows
      );

      // Set cache control header for preview responses
      res.set('Cache-Control', 'private, max-age=60');
      res.json({ success: true, data: preview });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get lightweight dataset status.
   */
  getStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const status = await this.datasetService.getDatasetStatus(datasetId);

      const updatedAtStr = status.updated_at instanceof Date
        ? status.updated_at.toISOString()
        : String(status.updated_at ?? '');
      const etagSource = `${status.status}:${updatedAtStr}:${status.row_count}`;
      const etag = `"${crypto.createHash('md5').update(etagSource).digest('hex')}"`;

      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }

      res.set('ETag', etag);
      res.set('Cache-Control', 'no-cache');
      res.json({ success: true, data: status });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get batch dataset statuses.
   */
  getStatusBatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const idsParam = req.query.ids as string;
      if (!idsParam) {
        throw new AppError('ids query parameter is required.', 400, 'VALIDATION_ERROR');
      }
      const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length === 0 || ids.length > 50) {
        throw new AppError('ids must contain 1-50 UUIDs.', 400, 'VALIDATION_ERROR');
      }
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const id of ids) {
        if (!uuidRegex.test(id)) {
          throw new AppError(`Invalid UUID: ${id}`, 400, 'VALIDATION_ERROR');
        }
      }
      const statuses = await this.datasetService.getDatasetStatusBatch(ids);
      res.json({ success: true, data: statuses });
    } catch (error) { next(error); }
  };

  /**
   * Get dataset summary.
   */
  getSummary = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }
      const summary = await this.datasetService.getDatasetSummary(datasetId);
      res.json({ success: true, data: summary });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Update a dataset (name and/or folderId).
   */
  update = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { datasetId } = req.params;
      const uuidParse = z.string().uuid().safeParse(datasetId);
      if (!uuidParse.success) return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid dataset ID');

      const { name, folderId } = req.body;
      if (!name && folderId === undefined) return sendError(res, 400, 'VALIDATION_ERROR', 'At least one field (name or folderId) is required');

      const updated = await this.datasetService.updateDataset(datasetId, { name, folderId });
      return sendSuccess(res, updated);
    } catch (err) { next(err); }
  };

  /**
   * Delete a dataset.
   */
  delete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { datasetId } = req.params;
      const uuidParse = z.string().uuid().safeParse(datasetId);
      if (!uuidParse.success) return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid dataset ID');

      await this.datasetService.deleteDataset(datasetId);
      return res.status(204).send();
    } catch (err) { next(err); }
  };

  /**
   * Duplicate a dataset.
   */
  duplicate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { datasetId } = req.params;
      const uuidParse = z.string().uuid().safeParse(datasetId);
      if (!uuidParse.success) return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid dataset ID');

      const dup = await this.datasetService.duplicateDataset(datasetId);
      return sendCreated(res, dup);
    } catch (err) { next(err); }
  };

  /**
   * Download a dataset file from S3/MinIO.
   * Streams the file directly to the client with correct headers.
   */
  download = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { datasetId } = req.params;
      const uuidParse = z.string().uuid().safeParse(datasetId);
      if (!uuidParse.success) return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid dataset ID');

      const dataset = await this.datasetService.getDatasetById(datasetId);
      if (!dataset) {
        throw new AppError('Dataset not found', 404, 'NOT_FOUND');
      }

      const s3Key = dataset.file_path as string;

      // Check if client wants a presigned URL redirect instead of a stream
      const mode = req.query.mode as string;
      if (mode === 'presigned') {
        const url = await getPresignedDownloadUrl(s3Key, 3600);
        return res.json({ success: true, data: { url, expiresIn: 3600 } });
      }

      // Get object metadata for Content-Length
      const meta = await headObject(s3Key);

      const fileName = (dataset.original_filename as string) || 'download.csv';

      res.set({
        'Content-Type': (dataset.mime_type as string) || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(meta.contentLength),
        'Cache-Control': 'private, max-age=300',
      });

      const stream = await getObjectStream(s3Key);
      stream.pipe(res);

      stream.on('error', (err) => {
        console.error(`[download] Stream error for dataset ${datasetId}:`, err);
        if (!res.headersSent) {
          next(new AppError('Failed to download file', 500, 'DOWNLOAD_ERROR'));
        }
      });
    } catch (err) { next(err); }
  };
}
