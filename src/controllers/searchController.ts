import { Request, Response, NextFunction } from 'express';
import { SearchService } from '../services/searchService';
import { AppError } from '../utils/foundryAppError';
import { SEARCH_EMPTY_HINTS } from '../utils/hints';
import { z } from 'zod';
import { MAX_SEARCH_QUERY_LENGTH } from '../utils/propertyLimits';

/**
 * Ontology Platform spec §2.4:
 *   - Max search query length: 1000 chars (bumped from 500).
 *   - Leading + trailing wildcard pattern `*x*` must be rejected (it forces
 *     a full-scan over the Lucene index).
 */
const SearchQuerySchema = z.object({
  q: z.string().max(MAX_SEARCH_QUERY_LENGTH).optional().default(''),
  type: z.enum(['project', 'folder', 'dataset']).optional(),
  projectId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const PICKER_RESOURCE_TYPES = [
  'project',
  'folder',
  'dataset',
  'pipeline',
  'module',
  'aip_logic',
] as const;
type PickerResourceType = (typeof PICKER_RESOURCE_TYPES)[number];

const PickerQuerySchema = z.object({
  q: z.string().max(MAX_SEARCH_QUERY_LENGTH).optional().default(''),
  // `types` is a comma-separated list, e.g. "folder,dataset". Empty/missing
  // means "all types".
  types: z
    .string()
    .optional()
    .transform((raw): PickerResourceType[] => {
      if (!raw) return [];
      return raw
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t): t is PickerResourceType =>
          (PICKER_RESOURCE_TYPES as readonly string[]).includes(t),
        );
    }),
  scope: z
    .enum(['all', 'yours', 'shared', 'recent', 'favorites'])
    .optional()
    .default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const LEADING_TRAILING_WILDCARD = /^\s*\*.+\*\s*$/;

function sanitizeQuery(q: string): void {
  if (q.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new AppError(
      `Search query exceeds maximum length of ${MAX_SEARCH_QUERY_LENGTH} characters.`,
      400,
      'QUERY_VALIDATION_ERROR'
    );
  }
  if (LEADING_TRAILING_WILDCARD.test(q)) {
    throw new AppError(
      'Search queries may not begin and end with a wildcard (*term*).',
      400,
      'QUERY_VALIDATION_ERROR'
    );
  }
}

export class SearchController {
  constructor(private searchService: SearchService) {}

  private getOwnerId(req: Request): string {
    const user = (req as unknown as { user?: { id: string } }).user;
    if (!user?.id) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    return user.id;
  }

  search = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = SearchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      sanitizeQuery(parsed.data.q);
      const ownerId = this.getOwnerId(req);
      const result = await this.searchService.search({ ...parsed.data, ownerId });
      const response: any = { success: true, ...result };
      if (result.results.length === 0) {
        response.hints = SEARCH_EMPTY_HINTS;
      }
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/v1/search/picker
   *
   * Returns pickable resources (projects, folders, datasets, pipelines)
   * for the ontology "Select dataset" dialog. Supports search, scope
   * filtering (yours/shared/recent/favorites/all), and per-type counts.
   */
  picker = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = PickerQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      sanitizeQuery(parsed.data.q);
      const ownerId = this.getOwnerId(req);
      const result = await this.searchService.searchPicker({
        q: parsed.data.q,
        types: parsed.data.types,
        scope: parsed.data.scope,
        page: parsed.data.page,
        limit: parsed.data.limit,
        ownerId,
      });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  suggest = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = (req.query.q as string) || '';
      sanitizeQuery(q);
      const ownerId = this.getOwnerId(req);
      const suggestions = await this.searchService.suggest(q, ownerId);
      res.json({ success: true, data: suggestions });
    } catch (error) {
      next(error);
    }
  };

  // Spec §Task 20: "Use Elasticsearch completion suggester (not
  // query_string) for type-ahead. P95 < 150ms." This endpoint targets
  // the ontology-suggestions index which is populated with a
  // `completion` field by the indexing pipeline.
  typeahead = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = (req.query.q as string) || '';
      sanitizeQuery(q);
      if (!q.trim()) {
        return res.json({ success: true, data: { suggestions: [] } });
      }
      const { client: osClient } = await import('../services/opensearch/client');
      try {
        const result = await osClient.search({
          index: 'ontology-suggestions',
          body: {
            suggest: {
              autocomplete: {
                prefix: q,
                completion: {
                  field: 'suggest',
                  size: 10,
                  skip_duplicates: true,
                  fuzzy: { fuzziness: 'AUTO' },
                },
              },
            },
          },
        });
        const options =
          (result.body as any)?.suggest?.autocomplete?.[0]?.options ?? [];
        return res.json({
          success: true,
          data: {
            suggestions: options.map((o: any) => ({
              text: o.text,
              score: o._score,
              source: o._source,
            })),
            engine: 'completion-suggester',
          },
        });
      } catch {
        // Fall back to the in-process suggester if the suggestion index
        // hasn't been seeded yet (dev mode / fresh install).
        const ownerId = this.getOwnerId(req);
        const suggestions = await this.searchService.suggest(q, ownerId);
        return res.json({
          success: true,
          data: { suggestions, engine: 'fallback' },
        });
      }
    } catch (error) {
      next(error);
    }
  };
}
