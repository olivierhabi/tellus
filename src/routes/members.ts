import { Router } from 'express';
import { MemberController } from '../controllers/memberController';
import { MemberService } from '../services/memberService';
import { authenticate } from '../middleware/auth';
import { authorizeRoles } from '../middleware/authorize';
import foundryDb from '../config/foundryDb';

const router = Router({ mergeParams: true });
const memberService = new MemberService(foundryDb);
const memberController = new MemberController(memberService);

// Membership management is owner-only: adding/removing members and changing
// a member's role are privileged operations. `authorizeRoles` resolves the
// caller's row in `project_members` for the `:projectId` mount param and
// rejects non-owners — without this any authenticated user could self-promote
// to owner via PATCH /:userId. Reads (listMembers) stay open to any member.
router.post('/', authenticate, authorizeRoles('owner'), memberController.addMember);
router.get('/', authenticate, memberController.listMembers);
router.delete('/:userId', authenticate, authorizeRoles('owner'), memberController.removeMember);
router.patch('/:userId', authenticate, authorizeRoles('owner'), memberController.updateRole);

export default router;
