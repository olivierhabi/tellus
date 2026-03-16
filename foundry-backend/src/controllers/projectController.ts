import { Request, Response, NextFunction } from 'express';
import { ProjectService } from '@/services/projectService';
import { CreateProjectSchema, UpdateProjectSchema, UuidParamSchema } from '@/types/project';
import { AppError } from '@/utils/AppError';

export class ProjectController {
  constructor(private projectService: ProjectService) {}

  private getOwnerId(req: Request): string {
    const user = (req as unknown as { user?: { id: string } }).user;
    return user?.id ?? '550e8400-e29b-41d4-a716-446655440000';
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
      const projects = await this.projectService.listProjects(ownerId);
      res.json({ success: true, data: projects });
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
        throw new AppError('Project not found', 404, 'NOT_FOUND');
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  };
}
