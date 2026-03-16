import { Router } from 'express';
import { MemberController } from '@/controllers/memberController';
import { MemberService } from '@/services/memberService';
import { authenticate } from '@/middleware/auth';
import db from '@/config/database';

const router = Router({ mergeParams: true });
const memberService = new MemberService(db);
const memberController = new MemberController(memberService);

router.post('/', authenticate, memberController.addMember);
router.get('/', authenticate, memberController.listMembers);
router.delete('/:userId', authenticate, memberController.removeMember);
router.patch('/:userId', authenticate, memberController.updateRole);

export default router;
