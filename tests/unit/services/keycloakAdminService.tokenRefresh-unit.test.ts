import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeycloakAdminService } from '../../../src/services/keycloakAdminService';

describe('KeycloakAdminService cached token recovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refreshes once and retries when Keycloak rejects the cached token', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'stale-token',
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'fresh-token',
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }));

    const service = new KeycloakAdminService({
      kcUrl: 'http://keycloak.invalid',
      kcRealm: 'tellus',
      clientId: 'tellus-confidential',
      clientSecret: 'test-secret',
    });

    await expect(service.listUsers({ first: 0, max: 50 })).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer stale-token',
    });
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer fresh-token',
    });
  });
});
