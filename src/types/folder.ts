import { z } from 'zod';

export const CreateFolderSchema = z.object({
  name: z
    .string()
    .min(1, 'Folder name is required')
    .max(255, 'Folder name must be 255 characters or fewer')
    .trim()
    .refine((name) => !name.includes('/') && !name.includes('\\'), {
      message: 'Folder name cannot contain path separators',
    }),
  parentFolderId: z.string().uuid('Invalid parent folder ID format').nullable().optional(),
});

export const UpdateFolderSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Folder name is required')
      .max(255, 'Folder name must be 255 characters or fewer')
      .trim()
      .refine((name) => !name.includes('/') && !name.includes('\\'), {
        message: 'Folder name cannot contain path separators',
      })
      .optional(),
    parentFolderId: z.string().uuid('Invalid parent folder ID format').nullable().optional(),
  })
  .refine((data) => data.name !== undefined || data.parentFolderId !== undefined, {
    message: 'At least one of name or parentFolderId must be provided',
  });

export type CreateFolderInput = z.infer<typeof CreateFolderSchema>;
export type UpdateFolderInput = z.infer<typeof UpdateFolderSchema>;
