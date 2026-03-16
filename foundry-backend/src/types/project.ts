import { z } from 'zod';

export const CreateProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Project name is required')
    .max(255, 'Project name must be 255 characters or fewer'),
});

export const UpdateProjectSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Project name is required')
      .max(255, 'Project name must be 255 characters or fewer')
      .optional(),
    description: z.string().max(2000).optional(),
  })
  .refine((data) => data.name !== undefined || data.description !== undefined, {
    message: 'At least one of name or description must be provided',
  });

export const UuidParamSchema = z.object({
  id: z.string().uuid('Invalid UUID format'),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
