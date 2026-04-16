import { z } from 'zod';

export const DatasetListQuerySchema = z.object({
  status: z
    .enum(['pending', 'processing', 'ready', 'error'])
    .optional(),
  sort: z
    .enum(['name', 'created_at', 'updated_at', 'file_size_bytes'])
    .default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const DatasetPreviewQuerySchema = z.object({
  rows: z.coerce.number().int().min(1).max(1000).default(50),
});

export type DatasetListQuery = z.infer<typeof DatasetListQuerySchema>;
export type DatasetPreviewQuery = z.infer<typeof DatasetPreviewQuerySchema>;
