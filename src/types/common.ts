/**
 * API Field Naming Conventions (Accessibility)
 *
 * All API response fields follow these rules for screen reader compatibility:
 * - Use camelCase for JSON response fields (matches JavaScript convention)
 * - No abbreviations: use "description" not "desc", "configuration" not "config"
 * - Boolean fields start with "is" or "has": "isDefault", "hasNext", "isOperational"
 * - Date fields end with "At": "createdAt", "updatedAt", "parsedAt"
 * - Count fields end with "Count": "rowCount", "columnCount", "totalCount"
 * - ID fields end with "Id": "datasetId", "projectId", "folderId"
 *
 * These conventions ensure screen readers can parse field names into
 * pronounceable words when developers inspect API responses.
 */

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}
