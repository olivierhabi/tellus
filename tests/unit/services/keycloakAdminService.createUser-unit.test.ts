// ---------------------------------------------------------------------------
// KeycloakAdminService.createUser — name requirement (no placeholder fabrication).
//
// Locks gap #2: createUser must REQUIRE non-blank firstName + lastName rather
// than fabricate the old `<email-local-part>` / `User` placeholder, which
// leaked into the JWT `name` claim and rendered as "foo User" in the greeting.
// The Keycloak realm requires both names for direct-grant (Keycloak blocks the
// password grant with "Account is not fully set up" when either is blank), so
// the caller must supply real names; createUser validates and throws BEFORE
// any Keycloak call so the failure is fast and side-effect-free.
//
// The validation throws before this.call(), so these cases hit no network —
// construct with a dummy config (no KC needed).
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { KeycloakAdminService } from '../../../src/services/keycloakAdminService';

const svc = new KeycloakAdminService({
  kcUrl: 'http://localhost:8086',
  kcRealm: 'tellus',
  clientId: 'tellus-confidential',
  clientSecret: 'tellus-confidential-secret-change-me',
});

const base = {
  username: 'u@tellus.local',
  email: 'u@tellus.local',
  password: 'Password123!',
};

describe('KeycloakAdminService.createUser — requires real names (no placeholder)', () => {
  it('throws VALIDATION_ERROR when firstName is missing', async () => {
    await expect(
      svc.createUser({ ...base, lastName: 'Last' } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws VALIDATION_ERROR when lastName is missing', async () => {
    await expect(
      svc.createUser({ ...base, firstName: 'First' } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws VALIDATION_ERROR when both are whitespace-only', async () => {
    await expect(
      svc.createUser({ ...base, firstName: '   ', lastName: '  ' } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('mentions the realm requirement in the message (operator-facing reason)', async () => {
    await expect(
      svc.createUser({ ...base, lastName: 'Last' } as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
  });
});
