import { Request, Response, NextFunction } from 'express';
import { ProjectService } from '../services/projectService';
import { CreateProjectSchema, UpdateProjectSchema, UuidParamSchema } from '../types/project';
import { AppError } from '../utils/foundryAppError';
import { PROJECT_EMPTY_HINTS } from '../utils/hints';

export class ProjectController {
  constructor(private projectService: ProjectService) {}

  private getOwnerId(req: Request): string {
    const user = (req as unknown as { user?: { id: string } }).user;
    if (!user?.id) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    return user.id;
  }

  create = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CreateProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const ownerId = this.getOwnerId(req);
      const project = await this.projectService.createProject(parsed.data.name, ownerId);
      res.status(201).json({ success: true, data: project });
    } catch (error) {
      next(error);
    }
  };

  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ownerId = this.getOwnerId(req);
      const selectedFields = (req as any).selectedFields;
      const projects = await this.projectService.listProjects(ownerId, selectedFields);
      const response: any = { success: true, data: projects };
      if (projects.length === 0) {
        response.hints = PROJECT_EMPTY_HINTS;
      }
      res.setHeader('X-Total-Count', String(projects.length));
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paramParsed = UuidParamSchema.safeParse(req.params);
      if (!paramParsed.success) {
        throw new AppError('Invalid UUID format', 400, 'VALIDATION_ERROR');
      }
      const ownerId = this.getOwnerId(req);
      const project = await this.projectService.getProjectById(paramParsed.data.id, ownerId);
      if (!project) {
        throw new AppError('Project not found', 404, 'NOT_FOUND');
      }
      res.json({ success: true, data: project });
    } catch (error) {
      next(error);
    }
  };

  update = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paramParsed = UuidParamSchema.safeParse(req.params);
      if (!paramParsed.success) {
        throw new AppError('Invalid UUID format', 400, 'VALIDATION_ERROR');
      }
      const bodyParsed = UpdateProjectSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const ownerId = this.getOwnerId(req);
      const project = await this.projectService.updateProject(
        paramParsed.data.id,
        ownerId,
        bodyParsed.data
      );
      if (!project) {
        // The list endpoint surfaces org-shared (read-scoped) projects,
        // so distinguish "does not exist" from "exists but not yours".
        if (await this.projectService.exists(paramParsed.data.id)) {
          throw new AppError('Only the project owner can update this project', 403, 'FORBIDDEN');
        }
        throw new AppError('Project not found', 404, 'NOT_FOUND');
      }
      res.json({ success: true, data: project });
    } catch (error) {
      next(error);
    }
  };

  delete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paramParsed = UuidParamSchema.safeParse(req.params);
      if (!paramParsed.success) {
        throw new AppError('Invalid UUID format', 400, 'VALIDATION_ERROR');
      }
      const ownerId = this.getOwnerId(req);
      const deleted = await this.projectService.deleteProject(paramParsed.data.id, ownerId);
      if (!deleted) {
        // The list endpoint surfaces org-shared (read-scoped) projects,
        // so distinguish "does not exist" from "exists but not yours" —
        // deleting someone else's project is a permission failure.
        if (await this.projectService.exists(paramParsed.data.id)) {
          throw new AppError('Only the project owner can delete this project', 403, 'FORBIDDEN');
        }
        throw new AppError('Project not found', 404, 'NOT_FOUND');
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  };

  getStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paramParsed = UuidParamSchema.safeParse(req.params);
      if (!paramParsed.success) {
        throw new AppError('Invalid UUID format', 400, 'VALIDATION_ERROR');
      }
      const stats = await this.projectService.getProjectStats(paramParsed.data.id);
      if (!stats) {
        throw new AppError('Project not found.', 404, 'NOT_FOUND');
      }
      res.json({ success: true, data: stats });
    } catch (error) {
      next(error);
    }
  };
}
