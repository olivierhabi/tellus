/**
 * B10 — ObjectType + Binding composite contract.
 * Consumed by OSDK generator, Object Explorer, and Quiver to materialise
 * fully-resolved Object Types whose properties are backed by Funnel-indexed
 * Postgres-derived datasets.
 */
import { z } from "zod";

export const RidSchema = z.string().regex(/^ri\.[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/);

export const PropertyTypeSchema = z.enum([
  "string",
  "int32",
  "int64",
  "float",
  "double",
  "boolean",
  "date",
  "timestamp",
  "decimal",
  "json",
]);

export const ObjectPropertySchema = z.object({
  name: z.string().min(1).max(120),
  type: PropertyTypeSchema,
  required: z.boolean().default(false),
  indexed: z.boolean().default(false),
  description: z.string().optional(),
});

export const ObjectTypeBindingSchema = z.object({
  rid: RidSchema,
  object_type_rid: RidSchema,
  dataset_rid: RidSchema,
  funnel_binding_rid: RidSchema,
  property_map: z.record(z.string(), z.string()),
  pk_property: z.string(),
  title_property: z.string().nullable(),
  status: z.enum(["pending", "indexing", "ready", "failed"]),
  version: z.number().int().positive(),
});

export const ObjectTypeWithBindingSchema = z.object({
  object_type_rid: RidSchema,
  display_name: z.string(),
  api_name: z.string(),
  properties: z.array(ObjectPropertySchema),
  binding: ObjectTypeBindingSchema.nullable(),
});

export type ObjectTypeBinding = z.infer<typeof ObjectTypeBindingSchema>;
export type ObjectTypeWithBinding = z.infer<typeof ObjectTypeWithBindingSchema>;
export type ObjectProperty = z.infer<typeof ObjectPropertySchema>;
