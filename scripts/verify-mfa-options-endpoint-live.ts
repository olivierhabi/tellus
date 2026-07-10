// verify-mfa-options-endpoint-live.ts
// ---------------------------------------------------------------------------
// LIVE HTTP probe (companion to verify-mfa-options-counter.ts which tests
// the service functions directly). Proves the RUNNING /login/mfa/
// webauthn-options endpoint no longer burns the MFA attempt counter.
//
// Method: insert a challenge row directly into auth_mfa_challenges with a
// fake keycloakSub that has NO enrolled passkey, then hit the live options
// endpoint 6 times (MFA_MAX_ATTEMPTS+1). buildAuthenticationOptions()
// throws NO_CREDENTIALS for the fake sub, but that happens AFTER the
// challenge lookup — so the counter behaviour is still observable:
//
//   OLD code (loadMfaChallenge on options): 6th call returns 401
//     MFA_CHALLENGE_INVALID and the row is DELETED (counter exhausted).
//   NEW code (peekMfaChallenge on options): all 6 calls return 400
//     NO_CREDENTIALS and the row SURVIVES with attempts=0.
//
// Prerequisites: backend on :3000 running the fixed source (nodemon/tsx),
// dev Postgres on :5432. No Keycloak/login/passkey needed.
//
// Run: npx tsx scripts/verify-mfa-options-endpoint-live.ts
// ---------------------------------------------------------------------------
import 'dotenv/config';
import knex from 'knex';

const API = process.env.TELLUS_API || 'http://localhost:3000/api/v1';
const MFA_MAX_ATTEMPTS = 5;

const db = knex({
  client: 'pg',
  connection: {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'tellus_db',
    user: process.env.PGUSER || 'tellus',
    password: process.env.PGPASSWORD || 'tellus123',
  },
  pool: { min: 1, max: 2 },
});

const GREEN = '\x1b[0;32m';
const RED = '\x1b[0;31m';
const NC = '\x1b[0m';
const pass = (m: string) => console.log(`${GREEN}✓${NC} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗${NC} ${m}`); process.exitCode = 1; };

async function main() {
  // Random challenge id + a fake sub with no enrolled passkey.
  const id = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');
  const sub = `live-probe-${id.slice(0, 12)}`;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await db('auth_mfa_challenges').insert({
    id,
    keycloak_sub: sub,
    access_token: 'probe-access-token',
    refresh_token: null,
    methods: ['webauthn'],
    expires_at: expiresAt,
  });

  try {
    const responses: Array<{ status: number; errorCode?: string }> = [];
    for (let i = 0; i < MFA_MAX_ATTEMPTS + 1; i++) {
      const r = await fetch(`${API}/auth/login/mfa/webauthn-options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfaChallenge: id }),
      });
      const body = await r.json().catch(() => ({}));
      responses.push({ status: r.status, errorCode: (body as { errorCode?: string })?.errorCode });
    }

    const row = await db('auth_mfa_challenges').where({ id }).first();
    const attempts = row?.attempts ?? null;

    console.log('options responses (status / errorCode):');
    responses.forEach((r, i) => console.log(`  #${i + 1}: ${r.status} ${r.errorCode ?? ''}`));
    console.log(`row after ${MFA_MAX_ATTEMPTS + 1} options calls: ${
      row ? `SURVIVED, attempts=${attempts}` : 'DELETED'
    }`);

    // FIX assertions:
    // 1. The 6th call must NOT be MFA_CHALLENGE_INVALID (peek never returns null
    //    for a live challenge — buildAuthenticationOptions throws NO_CREDENTIALS
    //    instead, which happens after the non-incrementing peek).
    // 2. The row survives with attempts=0 (peek did not increment).
    const last = responses[responses.length - 1];
    const noChallengeInvalidOnExhaustion = last.errorCode !== 'MFA_CHALLENGE_INVALID';
    const rowSurvivedWithZeroAttempts = !!row && attempts === 0;

    if (noChallengeInvalidOnExhaustion) {
      pass(`call #${MFA_MAX_ATTEMPTS + 1} did NOT return MFA_CHALLENGE_INVALID (got ${last.status} ${last.errorCode ?? ''})`);
    } else {
      fail(`call #${MFA_MAX_ATTEMPTS + 1} returned MFA_CHALLENGE_INVALID — the options endpoint is still burning the counter (fix not live)`);
    }
    if (rowSurvivedWithZeroAttempts) {
      pass(`row survived ${MFA_MAX_ATTEMPTS + 1} options calls with attempts=0 — live endpoint uses peekMfaChallenge (read-only)`);
    } else {
      fail(`row was ${row ? `left with attempts=${attempts}` : 'DELETED'} — live endpoint is incrementing the counter (fix not live)`);
    }
  } finally {
    // Clean up the probe row + any webauthn challenge rows buildAuthenticationOptions
    // may have inserted for the fake sub.
    await db('auth_mfa_challenges').where({ id }).delete();
    await db('user_webauthn_challenges').where({ keycloak_sub: sub }).delete();
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(`${RED}fatal${NC}: ${(err as Error).message}`);
  process.exitCode = 1;
});
