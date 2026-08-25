// verify-mfa-options-counter.ts
// ---------------------------------------------------------------------------
// Service-layer proof for the fix to:
//   "The multi-factor check expired, was reused, or hit the maximum number
//    of tries. Start over from the sign-in screen."
//
// ROOT CAUSE: /login/mfa/webauthn-options called loadMfaChallenge(), which
// atomically increments auth_mfa_challenges.attempts (cap MFA_MAX_ATTEMPTS=5).
// Fetching WebAuthn options is a PREREQUISITE to the ceremony, not an auth
// attempt — so every passkey click burned 2 of the 5 slots (options + verify),
// and every DISMISSED OS prompt (options fetched, ceremony cancelled, no
// assertion submitted) burned 1 slot with zero real attempt. After 2-3 such
// events on the same challenge the counter exceeded 5 and the user was told
// to "Start over from the sign-in screen" even though they had never
// submitted a real assertion. A fresh password login reset the counter, so
// the user eventually succeeded — the "3 tries, 4th works" pattern.
//
// FIX: the options endpoint now calls peekMfaChallenge() (read-only — no
// increment). Only the verify endpoint (/login/mfa) calls loadMfaChallenge().
//
// This script proves at the service layer (no WebAuthn ceremony, no
// Keycloak — just the challenge store against the dev DB):
//   1. loadMfaChallenge() increments + returns null after MFA_MAX_ATTEMPTS
//      (the verify path — unchanged, still protects against brute force).
//   2. peekMfaChallenge() does NOT increment — calling it 20× leaves
//      attempts at 0 and never returns null.
//   3. Simulating "5 dismissed prompts" (5× peek) then a verify (load):
//      under the OLD code the 6th load would return null (MFA_CHALLENGE_
//      INVALID); under the fix the verify succeeds (attempts=1).
//
// Prerequisites: dev Postgres on localhost:5432, database tellus_db (the
// same DB the backend on :3000 uses). No server/Keycloak needed.
//
// Run: npx tsx scripts/verify-mfa-options-counter.ts
// ---------------------------------------------------------------------------
import 'dotenv/config';
import knex, { Knex } from 'knex';
import assert from 'node:assert';
import {
  saveMfaChallenge,
  peekMfaChallenge,
  loadMfaChallenge,
  consumeMfaChallenge,
  newMfaChallengeId,
  MFA_MAX_ATTEMPTS,
} from '../src/services/totpService';

const db: Knex = knex({
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
const YELLOW = '\x1b[0;33m';
const NC = '\x1b[0m';
const pass = (m: string) => console.log(`${GREEN}✓${NC} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗${NC} ${m}`); process.exitCode = 1; };
const info = (m: string) => console.log(`${YELLOW}~${NC} ${m}`);

const TEST_SUB_PREFIX = 'mfa-options-counter-test';
const createdIds: string[] = [];

async function freshChallenge(sub: string): Promise<string> {
  const id = newMfaChallengeId();
  await saveMfaChallenge(db, {
    id,
    keycloakSub: sub,
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    methods: ['webauthn'],
    ttlSeconds: 5 * 60,
  });
  createdIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdIds) {
    try { await db('auth_mfa_challenges').where({ id }).delete(); } catch { /* ignore */ }
  }
  // Sweep any stragglers from a previous aborted run too.
  try {
    await db('auth_mfa_challenges')
      .where('keycloak_sub', 'like', `${TEST_SUB_PREFIX}-%`)
      .delete();
  } catch { /* ignore */ }
  await db.destroy();
}

async function main() {
  info(`MFA_MAX_ATTEMPTS = ${MFA_MAX_ATTEMPTS}`);

  // --- Test 1: loadMfaChallenge (verify path) increments + caps -----------
  {
    const sub = `${TEST_SUB_PREFIX}-load-${Date.now()}`;
    const id = await freshChallenge(sub);
    let lastAttempts = 0;
    let nullAt: number | null = null;
    for (let i = 1; i <= MFA_MAX_ATTEMPTS + 2; i++) {
      const row = await loadMfaChallenge(db, id);
      if (row === null) { nullAt = i; break; }
      lastAttempts = row.attempts;
    }
    try {
      assert.ok(nullAt !== null, 'loadMfaChallenge should eventually return null');
      assert.strictEqual(nullAt, MFA_MAX_ATTEMPTS + 1,
        `verify path should exhaust exactly after MFA_MAX_ATTEMPTS (${MFA_MAX_ATTEMPTS}); got nullAt=${nullAt}`);
      assert.strictEqual(lastAttempts, MFA_MAX_ATTEMPTS,
        `last successful load should report attempts=${MFA_MAX_ATTEMPTS}; got ${lastAttempts}`);
      pass(`loadMfaChallenge (verify) increments + returns null on attempt ${nullAt} (cap ${MFA_MAX_ATTEMPTS})`);
    } catch (e) {
      fail(`Test 1 (verify caps at MFA_MAX_ATTEMPTS): ${(e as Error).message}`);
    }
  }

  // --- Test 2: peekMfaChallenge (options path) does NOT increment ---------
  {
    const sub = `${TEST_SUB_PREFIX}-peek-${Date.now()}`;
    const id = await freshChallenge(sub);
    let allNonNull = true;
    for (let i = 0; i < 20; i++) {
      const row = await peekMfaChallenge(db, id);
      if (row === null) { allNonNull = false; break; }
    }
    const rowAfter = await peekMfaChallenge(db, id);
    try {
      assert.ok(allNonNull, 'peekMfaChallenge must never return null for a live challenge');
      assert.ok(rowAfter !== null, 'challenge still live after 20 peeks');
      assert.strictEqual(rowAfter?.attempts, 0,
        `peekMfaChallenge must NOT increment attempts; expected 0, got ${rowAfter?.attempts}`);
      pass('peekMfaChallenge (options) called 20×: attempts stays 0, never null');
    } catch (e) {
      fail(`Test 2 (peek does not increment): ${(e as Error).message}`);
    }
    await consumeMfaChallenge(db, id);
  }

  // --- Test 3: dismissed prompts no longer starve the verify budget -------
  //     OLD code: 5× load (options) → attempts=5; 6th load (verify) → null → MFA_CHALLENGE_INVALID.
  //     NEW code: 5× peek (options) → attempts=0; verify load → attempts=1, succeeds.
  {
    const sub = `${TEST_SUB_PREFIX}-dismiss-${Date.now()}`;
    const id = await freshChallenge(sub);
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      const row = await peekMfaChallenge(db, id);
      assert.ok(row !== null, `peek #${i + 1} should succeed`);
      assert.strictEqual(row!.attempts, 0, `peek must not increment (peek #${i + 1})`);
    }
    const verify = await loadMfaChallenge(db, id);
    try {
      assert.ok(verify !== null,
        'verify (loadMfaChallenge) MUST succeed after MFA_MAX_ATTEMPTS dismissed prompts — ' +
        'this is the regression: the old options-endpoint burned the budget so a dismissed ' +
        'prompt would force "Start over from the sign-in screen"');
      assert.strictEqual(verify!.attempts, 1,
        `first real verify should report attempts=1; got ${verify!.attempts}`);
      pass(`${MFA_MAX_ATTEMPTS} dismissed prompts (peek) leave the full verify budget intact → verify succeeds`);
    } catch (e) {
      fail(`Test 3 (dismissed prompts do not starve verify): ${(e as Error).message}`);
    }
    await consumeMfaChallenge(db, id);
  }

  // --- Test 4: peek on a missing / expired challenge returns null ----------
  {
    const missing = await peekMfaChallenge(db, 'definitely-not-a-real-challenge-id');
    try {
      assert.strictEqual(missing, null, 'peek must return null for an unknown challenge');
      pass('peekMfaChallenge returns null for an unknown challenge (FE still gets MFA_CHALLENGE_INVALID)');
    } catch (e) {
      fail(`Test 4 (peek missing): ${(e as Error).message}`);
    }
  }
}

main()
  .then(async () => { await cleanup(); })
  .catch(async (err) => {
    console.error(`${RED}fatal${NC}: ${(err as Error).message}`);
    await cleanup();
    process.exitCode = 1;
  });
