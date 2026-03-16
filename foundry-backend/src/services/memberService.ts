import { Knex } from 'knex';
import { AppError } from '@/utils/AppError';

export class MemberService {
  constructor(private knex: Knex) {}

  async addMember(projectId: string, userId: string, role: string) {
    if (role === 'owner') {
      throw new AppError('Cannot directly assign owner role', 400, 'VALIDATION_ERROR');
    }

    const user = await this.knex('users').where({ id: userId }).first();
    if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');

    const existing = await this.knex('project_members')
      .where({ project_id: projectId, user_id: userId })
      .first();
    if (existing) throw new AppError('User is already a member of this project', 409, 'CONFLICT');

    await this.knex('project_members').insert({
      project_id: projectId,
      user_id: userId,
      role,
    });

    return { projectId, userId, role };
  }

  async removeMember(projectId: string, userId: string) {
    const membership = await this.knex('project_members')
      .where({ project_id: projectId, user_id: userId })
      .first();
    if (!membership) throw new AppError('Member not found', 404, 'NOT_FOUND');

    if (membership.role === 'owner') {
      const ownerCount = await this.knex('project_members')
        .where({ project_id: projectId, role: 'owner' })
        .count('* as count')
        .first();
      if (parseInt(ownerCount?.count as string, 10) <= 1) {
        throw new AppError('Cannot remove the last owner of a project', 400, 'VALIDATION_ERROR');
      }
    }

    await this.knex('project_members')
      .where({ project_id: projectId, user_id: userId })
      .delete();
    return true;
  }

  async listMembers(projectId: string) {
    return this.knex('project_members')
      .join('users', 'project_members.user_id', 'users.id')
      .where({ project_id: projectId })
      .select(
        'users.id',
        'users.email',
        'users.display_name',
        'project_members.role',
        'project_members.created_at'
      );
  }

  async updateMemberRole(projectId: string, userId: string, newRole: string) {
    const membership = await this.knex('project_members')
      .where({ project_id: projectId, user_id: userId })
      .first();
    if (!membership) throw new AppError('Member not found', 404, 'NOT_FOUND');

    if (membership.role === 'owner' && newRole !== 'owner') {
      const ownerCount = await this.knex('project_members')
        .where({ project_id: projectId, role: 'owner' })
        .count('* as count')
        .first();
      if (parseInt(ownerCount?.count as string, 10) <= 1) {
        throw new AppError('Cannot change role of the last owner', 400, 'VALIDATION_ERROR');
      }
    }

    await this.knex('project_members')
      .where({ project_id: projectId, user_id: userId })
      .update({ role: newRole });
    return { projectId, userId, role: newRole };
  }
}
