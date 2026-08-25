import { Request, Response, NextFunction } from 'express';
import { MemberService } from '../services/memberService';
import { AppError } from '../utils/foundryAppError';
import { z } from 'zod';

// `userId` is the LOCAL users.id (what GET …/members and
// project_members.user_id use). Directory search (/automations/discovery)
// surfaces Keycloak ids instead, so callers MAY pass `email` — resolved
// case-insensitively against the provisioned local user. Exactly one of
// the two identifiers is required.
const AddMemberSchema = z
  .object({
    userId: z.string().uuid().optional(),
    email: z.string().email().optional(),
    role: z.enum(['editor', 'viewer']),
  })
  .refine((d) => Boolean(d.userId ?? d.email), {
    message: 'Either userId or email must be provided',
  })
  .refine((d) => !(d.userId && d.email), {
    message: 'Pass either userId or email, not both',
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
      const result = await this.memberService.addMember(
        projectId,
        { userId: parsed.data.userId, email: parsed.data.email },
        parsed.data.role,
      );
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
