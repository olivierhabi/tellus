// ---------------------------------------------------------------------------
// TellusAuthService.toTokenInfo — name-claim surfacing contract test.
//
// Locks the fix for "Welcome back, <email>": toTokenInfo MUST surface the
// Keycloak profile claims (name / given_name -> givenName / family_name ->
// familyName) so /auth/me, /auth/refresh, /auth/token-info, /auth/login and
// the MFA responses all carry a real name the FE can prefer over the
// email-shaped preferred_username. Pure-passthrough: it must NOT fabricate a
// name when the claim is absent (the FE composes the fallback).
//
// toTokenInfo touches no DB and no Keycloak (it only reads `claims` +
// `config.kcRealm` for the org fallback), so a dummy knex + minimal config
// suffice; the JWKS client is constructed but never used here.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import type { Knex } from 'knex';
import { TellusAuthService, type TellusClaims } from '../../../src/services/tellusAuthService';

const svc = new TellusAuthService({} as Knex, {
  kcUrl: 'http://localhost:8086',
  kcRealm: 'tellus',
  kcFrontendClientId: 'tellus-frontend',
});

const baseClaims: TellusClaims = {
  sub: 'sub-123',
  jti: 'jti-1',
  org: 'tellus',
  email: 'habimanaolivier6@gmail.com',
  preferred_username: 'habimanaolivier6@gmail.com',
  iss: 'http://localhost:8086/realms/tellus',
  exp: 1,
  iat: 0,
};

describe('TellusAuthService.toTokenInfo — name-claim surfacing', () => {
  it('surfaces name/givenName/familyName when the JWT carries them', () => {
    const ti = svc.toTokenInfo({
      ...baseClaims,
      name: 'Olivier Habimana',
      given_name: 'Olivier',
      family_name: 'Habimana',
    });
    expect(ti.name).toBe('Olivier Habimana');
    expect(ti.givenName).toBe('Olivier');
    expect(ti.familyName).toBe('Habimana');
    // Identity passthroughs unchanged by the name addition.
    expect(ti.sub).toBe('sub-123');
    expect(ti.email).toBe('habimanaolivier6@gmail.com');
    expect(ti.preferredUsername).toBe('habimanaolivier6@gmail.com');
  });

  it('returns undefined name fields when the JWT omits them (PAT / no profile scope)', () => {
    const ti = svc.toTokenInfo(baseClaims);
    expect(ti.name).toBeUndefined();
    expect(ti.givenName).toBeUndefined();
    expect(ti.familyName).toBeUndefined();
    // Still produces the email-shaped fallback identity.
    expect(ti.preferredUsername).toBe('habimanaolivier6@gmail.com');
    expect(ti.email).toBe('habimanaolivier6@gmail.com');
  });

  it('is pure passthrough — never fabricates a name from preferred_username/email', () => {
    // toTokenInfo must NOT synthesize a name; the FE composes the fallback.
    // If this regresses (e.g. someone "helpfully" sets name = preferred_username),
    // the email would leak back into the greeting.
    const ti = svc.toTokenInfo(baseClaims);
    expect(ti.name).toBeUndefined();
    expect(ti.givenName).toBeUndefined();
    expect(ti.familyName).toBeUndefined();
  });

  it('still emits the full pre-existing field set (regression: no fields dropped)', () => {
    const ti = svc.toTokenInfo({ ...baseClaims, name: 'Olivier Habimana' });
    // The fields that existed before the name-claim change must all still be present.
    expect(ti).toMatchObject({
      sub: 'sub-123',
      jti: 'jti-1',
      org: 'tellus',
      email: 'habimanaolivier6@gmail.com',
      preferredUsername: 'habimanaolivier6@gmail.com',
      realmRoles: [],
      markings: [],
      orgs: ['tellus'],
      cbacClearance: null,
      sessionScope: [],
      exp: 1,
      iat: 0,
      iss: 'http://localhost:8086/realms/tellus',
    });
  });
});
