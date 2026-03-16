import { Request, Response, NextFunction } from 'express';
import { SearchService } from '../services/searchService';
import { AppError } from '../utils/foundryAppError';
import { SEARCH_EMPTY_HINTS } from '../utils/hints';
import { z } from 'zod';

const SearchQuerySchema = z.object({
  q: z.string().max(500).optional().default(''),
  type: z.enum(['project', 'folder', 'dataset']).optional(),
  projectId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export class SearchController {
  constructor(private searchService: SearchService) {}

  private getOwnerId(req: Request): string {
    const user = (req as unknown as { user?: { id: string } }).user;
    return user?.id ?? '550e8400-e29b-41d4-a716-446655440000';
  }

  search = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = SearchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
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

  suggest = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = (req.query.q as string) || '';
      const ownerId = this.getOwnerId(req);
      const suggestions = await this.searchService.suggest(q, ownerId);
      res.json({ success: true, data: suggestions });
    } catch (error) {
      next(error);
    }
  };
}
