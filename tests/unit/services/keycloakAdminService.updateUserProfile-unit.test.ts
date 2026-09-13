import { describe, expect, it, vi } from 'vitest';
import { KeycloakAdminService } from '../../../src/services/keycloakAdminService';

type AdminCall = (
  method: string,
  path: string,
  options?: { body?: unknown; parseJson?: boolean },
) => Promise<unknown>;

describe('KeycloakAdminService.updateUserProfile', () => {
  it('updates only editable profile fields through the Keycloak admin API', async () => {
    const service = new KeycloakAdminService({
      kcUrl: 'http://keycloak.invalid',
      kcRealm: 'tellus',
      clientId: 'tellus-confidential',
      clientSecret: 'test-secret',
    });
    const call = vi
      .spyOn(service as unknown as { call: AdminCall }, 'call')
      .mockResolvedValue(undefined);

    await service.updateUserProfile('user-123', {
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Example',
    });

    expect(call).toHaveBeenCalledWith('PUT', '/users/user-123', {
      body: {
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'Example',
      },
      parseJson: false,
    });
  });
});
