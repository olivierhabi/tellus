// B3 — templates_index store.
//
// Cache layer for fast listing + admin deprecation flips. Template content
// itself is shipped as TS literals (manifest.ts).

import type { Pool } from "pg";

export interface TemplatesIndexRow {
  readonly templateId: string;
  readonly version: string;
  readonly displayName: string;
  readonly language: "typescript" | "python" | "java" | "sql";
  readonly category: "functions" | "transforms";
  readonly description: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly isDeprecated: boolean;
  readonly createdAt: Date;
  readonly deprecatedAt: Date | null;
}

interface DbTemplateRow {
  template_id: string;
  version: string;
  display_name: string;
  language: "typescript" | "python" | "java" | "sql";
  category: "functions" | "transforms";
  description: string;
  file_count: number;
  total_bytes: string | number;
  is_deprecated: boolean;
  created_at: Date;
  deprecated_at: Date | null;
}

function fromDb(r: DbTemplateRow): TemplatesIndexRow {
  return {
    templateId: r.template_id,
    version: r.version,
    displayName: r.display_name,
    language: r.language,
    category: r.category,
    description: r.description,
    fileCount: r.file_count,
    totalBytes: typeof r.total_bytes === "string" ? parseInt(r.total_bytes, 10) : r.total_bytes,
    isDeprecated: r.is_deprecated,
    createdAt: r.created_at,
    deprecatedAt: r.deprecated_at,
  };
}

export interface UpsertTemplatesIndexArgs {
  readonly templateId: string;
  readonly version: string;
  readonly displayName: string;
  readonly language: "typescript" | "python" | "java" | "sql";
  readonly category: "functions" | "transforms";
  readonly description: string;
  readonly parametersJson: unknown;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export async function upsertTemplatesIndex(
  pool: Pool,
  args: UpsertTemplatesIndexArgs,
): Promise<TemplatesIndexRow> {
  const sql = `INSERT INTO templates_index
    (template_id, version, display_name, language, category, description, parameters_json, file_count, total_bytes)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
    ON CONFLICT (template_id, version) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      language = EXCLUDED.language,
      category = EXCLUDED.category,
      description = EXCLUDED.description,
      parameters_json = EXCLUDED.parameters_json,
      file_count = EXCLUDED.file_count,
      total_bytes = EXCLUDED.total_bytes
    RETURNING *`;
  const r = await pool.query<DbTemplateRow>(sql, [
    args.templateId,
    args.version,
    args.displayName,
    args.language,
    args.category,
    args.description,
    JSON.stringify(args.parametersJson),
    args.fileCount,
    args.totalBytes,
  ]);
  return fromDb(r.rows[0]);
}

export async function listTemplates(pool: Pool, opts?: {
  readonly category?: "functions" | "transforms";
  readonly includeDeprecated?: boolean;
}): Promise<ReadonlyArray<TemplatesIndexRow>> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.category !== undefined) {
    params.push(opts.category);
    where.push(`category = $${params.length}`);
  }
  if (!opts?.includeDeprecated) where.push(`is_deprecated = FALSE`);
  const w = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const r = await pool.query<DbTemplateRow>(`SELECT * FROM templates_index ${w} ORDER BY template_id, version`, params);
  return r.rows.map(fromDb);
}

export async function getTemplate(
  pool: Pool,
  templateId: string,
  version: string,
): Promise<TemplatesIndexRow | null> {
  const r = await pool.query<DbTemplateRow>(
    `SELECT * FROM templates_index WHERE template_id = $1 AND version = $2 LIMIT 1`,
    [templateId, version],
  );
  return r.rowCount === 0 ? null : fromDb(r.rows[0]);
}

export async function markDeprecated(
  pool: Pool,
  templateId: string,
  version: string,
): Promise<TemplatesIndexRow | null> {
  const r = await pool.query<DbTemplateRow>(
    `UPDATE templates_index SET is_deprecated = TRUE, deprecated_at = NOW()
     WHERE template_id = $1 AND version = $2 AND is_deprecated = FALSE RETURNING *`,
    [templateId, version],
  );
  return r.rowCount === 0 ? null : fromDb(r.rows[0]);
}
