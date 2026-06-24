/**
 * B10 — Ontology binding contracts.
 * A binding links a dataset (Iceberg) to an OSv2 Object Type and declares the
 * property map + FK-derived Link Types. Frontend mirrors this Zod schema 1:1.
 */
import { z } from "zod";

export const PropertyMappingSchema = z.object({
  source_column: z.string().min(1),
  target_property: z.string().min(1),
  is_primary_key: z.boolean().default(false),
  is_indexed: z.boolean().default(false),
});
export type PropertyMapping = z.infer<typeof PropertyMappingSchema>;

export const LinkTypeSpecSchema = z.object({
  rid: z.string().regex(/^ri\.ontology\.main\.linktype\.[a-z0-9-]+$/),
  source_object_type_rid: z.string(),
  target_object_type_rid: z.string(),
  source_property: z.string(),
  target_property: z.string(),
  cardinality: z.enum(["1:1", "1:N", "N:1", "N:M"]),
  derived_from_fk: z.boolean().default(true),
});
export type LinkTypeSpec = z.infer<typeof LinkTypeSpecSchema>;

export const OntologyBindingSchema = z.object({
  rid: z.string().regex(/^ri\.ontology\.main\.binding\.[a-z0-9-]+$/),
  dataset_rid: z.string(),
  object_type_rid: z.string(),
  property_mappings: z.array(PropertyMappingSchema).min(1).max(250),
  link_types: z.array(LinkTypeSpecSchema).default([]),
  status: z.enum(["pending", "ready", "failed", "regenerating"]).default("pending"),
  osdk_version: z.string().nullable().default(null),
  version: z.number().int().nonnegative().default(1),
}).superRefine((v, ctx) => {
  const pkCount = v.property_mappings.filter((p) => p.is_primary_key).length;
  if (pkCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one property mapping must be primary key",
      path: ["property_mappings"],
    });
  }
});
export type OntologyBinding = z.infer<typeof OntologyBindingSchema>;
