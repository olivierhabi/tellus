// B10 — Dashboards / Visual Functions / Templates type contracts.

import { z } from "zod";

// ---------- Dashboard ------------------------------------------------------

export const ParameterSchemaProperty = z.object({
  type: z.enum(["string", "number", "boolean", "array"]),
  description: z.string().optional(),
  default: z.any().optional(),
  enum: z.array(z.any()).optional(),
});
export type ParameterSchemaProperty = z.infer<typeof ParameterSchemaProperty>;

export const ParameterSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), ParameterSchemaProperty),
  required: z.array(z.string()).default([]),
});
export type ParameterSchema = z.infer<typeof ParameterSchema>;

export const PublishDashboardRequest = z.object({
  analysisRid: z.string().regex(/^ri\.tellus-quiver\.main\.analysis\./),
  displayName: z.string().min(1).max(256),
  exposedCanvases: z.array(z.string()).min(1),
  parameterSchema: ParameterSchema,
});
export type PublishDashboardRequest = z.infer<typeof PublishDashboardRequest>;

export const Dashboard = z.object({
  rid: z.string().regex(/^ri\.tellus-quiver\.main\.dashboard\./),
  parentFolderRid: z.string(),
  analysisRid: z.string(),
  displayName: z.string(),
  branch: z.string(),
  exposedCanvases: z.array(z.string()),
  parameterSchema: ParameterSchema,
  currentVersion: z.number().int().nonnegative(),
  etag: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
});
export type Dashboard = z.infer<typeof Dashboard>;

// ---------- Embed ----------------------------------------------------------

export const EmbedSurface = z.enum(["OBJECT_VIEW", "WORKSHOP"]);
export type EmbedSurface = z.infer<typeof EmbedSurface>;

export const EmbedRequest = z.object({
  targetRid: z.string(),
  paramBindings: z.record(z.string(), z.any()).default({}),
});
export type EmbedRequest = z.infer<typeof EmbedRequest>;

export const Embed = z.object({
  embedId: z.string(),
  dashboardRid: z.string(),
  surface: EmbedSurface,
  targetRid: z.string(),
  paramBindings: z.record(z.string(), z.any()),
  createdAt: z.string(),
  createdBy: z.string(),
});
export type Embed = z.infer<typeof Embed>;

// ---------- Visual Function -----------------------------------------------

export const PublishVisualFunctionRequest = z.object({
  analysisRid: z.string().regex(/^ri\.tellus-quiver\.main\.analysis\./),
  displayName: z.string().min(1).max(256),
  exposedParameterCardIds: z.array(z.string()),
  rootCardId: z.string().min(1),
});
export type PublishVisualFunctionRequest = z.infer<typeof PublishVisualFunctionRequest>;

export const VisualFunction = z.object({
  rid: z.string().regex(/^ri\.tellus-quiver\.main\.visual-function\./),
  parentFolderRid: z.string(),
  analysisRid: z.string(),
  displayName: z.string(),
  branch: z.string(),
  exposedParameterCardIds: z.array(z.string()),
  rootCardId: z.string(),
  inputSchema: ParameterSchema,
  outputType: z.string(),
  currentVersion: z.number().int().nonnegative(),
  etag: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
});
export type VisualFunction = z.infer<typeof VisualFunction>;

// ---------- Template (legacy) ---------------------------------------------

export const CreateTemplateRequest = z.object({
  parentFolderRid: z.string(),
  displayName: z.string().min(1).max(256),
  snapshot: z.record(z.string(), z.any()),
});
export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequest>;

export const Template = z.object({
  rid: z.string().regex(/^ri\.tellus-quiver\.main\.template\./),
  parentFolderRid: z.string(),
  displayName: z.string(),
  snapshot: z.record(z.string(), z.any()),
  createdAt: z.string(),
  createdBy: z.string(),
});
export type Template = z.infer<typeof Template>;
