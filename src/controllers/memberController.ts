import { Request, Response, NextFunction } from 'express';
import { MemberService } from '../services/memberService';
import { AppError } from '../utils/foundryAppError';
import { z } from 'zod';

const AddMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['editor', 'viewer']),
});

const UpdateRoleSchema = z.object({
  role: z.enum(['owner', 'editor', 'viewer']),
});

export class MemberController {
  constructor(private memberService: MemberService) {}

  addMember = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      const parsed = AddMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const result = await this.memberService.addMember(projectId, parsed.data.userId, parsed.data.role);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  removeMember = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      const userId = req.params.userId as string;
      await this.memberService.removeMember(projectId, userId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  };

  listMembers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      const members = await this.memberService.listMembers(projectId);
      res.json({ success: true, data: members });
    } catch (error) {
      next(error);
    }
  };

  updateRole = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      const userId = req.params.userId as string;
      const parsed = UpdateRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const result = await this.memberService.updateMemberRole(projectId, userId, parsed.data.role);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };
}
