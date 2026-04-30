/**
 * migrateAuth.ts
 * --------------
 * Idempotent schema bootstrap for the tellus auth tables owned by the
 * ontology/tellus-auth.md Phase 1+2+3 implementation.
 *
 *     npm run migrate:auth
 *
 * Creates:
 *   • personal_access_tokens (Task 9)
 *   • auth_revoked_tokens    (Task 3 jti blacklist)
 *   • user_totp_secrets      (Phase 3 in-app TOTP enrollment)
 *   • user_webauthn_credentials (Phase 3 in-app FIDO2 passkeys)
 *   • user_webauthn_challenges  (Phase 3 challenge store for WebAuthn ceremonies)
 *
 * The tables are keyed on the Keycloak `sub` (stable UUID) rather than
 * the local users.id so the credentials survive if the local users
 * shadow row is rebuilt. All enrollment is performed IN the tellus
 * app — no browser redirect to the Keycloak server at any point.
 */
import "dotenv/config";
import { pool } from "./db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // -----------------------------------------------------------------
    // Phase 1 / 9 — PATs
    // -----------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS personal_access_tokens (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        keycloak_sub   VARCHAR(255),
        name           VARCHAR(255) NOT NULL,
        token_hash     VARCHAR(64)  NOT NULL UNIQUE,
        token_prefix   VARCHAR(32)  NOT NULL,
        scopes         TEXT[]       NOT NULL DEFAULT '{}',
        expires_at     TIMESTAMPTZ  NOT NULL,
        last_used_at   TIMESTAMPTZ,
        revoked_at     TIMESTAMPTZ,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        CHECK (expires_at > created_at)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pat_user ON personal_access_tokens(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pat_hash ON personal_access_tokens(token_hash)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pat_sub ON personal_access_tokens(keycloak_sub)`);
    console.log("[auth] personal_access_tokens ready");

    // -----------------------------------------------------------------
    // Phase 1 / 3 — jti blacklist
    // -----------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_revoked_tokens (
        jti            VARCHAR(128) PRIMARY KEY,
        user_id        UUID,
        keycloak_sub   VARCHAR(255),
        revoked_at     TIMESTAMPTZ DEFAULT NOW(),
        expires_at     TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_revoked_expires ON auth_revoked_tokens(expires_at)`);
    console.log("[auth] auth_revoked_tokens ready");

    // -----------------------------------------------------------------
    // Phase 3 — TOTP secrets (enrolled in-app via otplib + QR)
    // -----------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_totp_secrets (
        keycloak_sub        VARCHAR(255) PRIMARY KEY,
        label               VARCHAR(255) NOT NULL,
        secret              VARCHAR(64)  NOT NULL,
        verified            BOOLEAN NOT NULL DEFAULT FALSE,
        -- Highest RFC 6238 step value we've accepted so far. Replays
        -- within the same 30-second window are rejected by requiring
        -- the next accepted step to be strictly greater.
        last_accepted_step  BIGINT NOT NULL DEFAULT 0,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        verified_at         TIMESTAMPTZ
      )
    `);
    // Idempotent add for already-migrated environments — the column
    // is only absent when the table predates this hardening pass.
    await client.query(`
      ALTER TABLE user_totp_secrets
        ADD COLUMN IF NOT EXISTS last_accepted_step BIGINT NOT NULL DEFAULT 0
    `);
    console.log("[auth] user_totp_secrets ready");

    // -----------------------------------------------------------------
    // Phase 3 — WebAuthn credentials (FIDO2 passkeys enrolled in-app)
    // -----------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_webauthn_credentials (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        keycloak_sub           VARCHAR(255) NOT NULL,
        credential_id          TEXT NOT NULL UNIQUE,
        public_key             BYTEA NOT NULL,
        counter                BIGINT NOT NULL DEFAULT 0,
        transports             TEXT[] NOT NULL DEFAULT '{}',
        device_type            VARCHAR(32) NOT NULL,
        backed_up              BOOLEAN NOT NULL DEFAULT FALSE,
        user_label             VARCHAR(255) NOT NULL,
        aaguid                 VARCHAR(64),
        created_at             TIMESTAMPTZ DEFAULT NOW(),
        last_used_at           TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_webauthn_sub ON user_webauthn_credentials(keycloak_sub)`);
    console.log("[auth] user_webauthn_credentials ready");

    // -----------------------------------------------------------------
    // Phase 3 — WebAuthn ceremony challenges
    //
    // Challenges are single-use (deleted on verify) and TTL'd to 5
    // minutes by a purge job. We store them in Postgres rather than
    // Redis to keep the infra footprint small.
    // -----------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_webauthn_challenges (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        keycloak_sub   VARCHAR(255) NOT NULL,
        kind           VARCHAR(16) NOT NULL CHECK (kind IN ('register', 'auth', 'mfa-login')),
        challenge      TEXT NOT NULL,
        user_label     VARCHAR(255),
        expires_at     TIMESTAMPTZ NOT NULL,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_webauthn_chal_sub ON user_webauthn_challenges(keycloak_sub)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_webauthn_chal_expires ON user_webauthn_challenges(expires_at)`);
    console.log("[auth] user_webauthn_challenges ready");

    // -----------------------------------------------------------------
    // Phase 3 — MFA login challenge store for the two-step /auth/login
    // flow. When the first step (password) succeeds but the user has
    // enrolled TOTP or WebAuthn, we park the Keycloak access token
    // here keyed by a short-lived challenge id so the second step can
    // retrieve it and set session cookies.
    // -----------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_mfa_challenges (
        id             VARCHAR(64) PRIMARY KEY,
        keycloak_sub   VARCHAR(255) NOT NULL,
        access_token   TEXT NOT NULL,
        refresh_token  TEXT,
        methods        TEXT[] NOT NULL,
        -- Per-challenge attempt counter — the /login/mfa handler
        -- increments this on every attempt and bails (deleting the
        -- challenge) once it exceeds MFA_MAX_ATTEMPTS. Stops a password
        -- holder from brute-forcing the 6-digit TOTP.
        attempts       INT NOT NULL DEFAULT 0,
        expires_at     TIMESTAMPTZ NOT NULL,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      ALTER TABLE auth_mfa_challenges
        ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mfa_chal_expires ON auth_mfa_challenges(expires_at)`);
    console.log("[auth] auth_mfa_challenges ready");

    // -----------------------------------------------------------------
    // Hardening round — tellus-side audit events, per-account MFA
    // sliding-window budget, short-lived reauth tokens for sensitive
    // credential changes, and an email outbox for async notifications.
    // All tables are idempotent / IF NOT EXISTS so re-running against
    // an already-hardened environment is a no-op.
    // -----------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS tellus_audit_events (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        keycloak_sub    VARCHAR(255) NOT NULL,
        category        VARCHAR(64)  NOT NULL,
        action          VARCHAR(64)  NOT NULL,
        result          VARCHAR(16)  NOT NULL CHECK (result IN ('SUCCESS','FAILURE')),
        ip              VARCHAR(64),
        user_agent      TEXT,
        details         JSONB        NOT NULL DEFAULT '{}'::jsonb,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tellus_audit_sub ON tellus_audit_events(keycloak_sub, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tellus_audit_category ON tellus_audit_events(category, created_at DESC)`);
    console.log("[auth] tellus_audit_events ready");

    await client.query(`
      CREATE TABLE IF NOT EXISTS mfa_attempt_budget (
        keycloak_sub    VARCHAR(255) PRIMARY KEY,
        window_start    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        failed_count    INT          NOT NULL DEFAULT 0
      )
    `);
    console.log("[auth] mfa_attempt_budget ready");

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_outbox (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        to_address      VARCHAR(320) NOT NULL,
        subject         VARCHAR(255) NOT NULL,
        body            TEXT         NOT NULL,
        template        VARCHAR(64),
        status          VARCHAR(16)  NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','sent','failed')),
        sent_at         TIMESTAMPTZ,
        error           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox(status, created_at)`);
    console.log("[auth] email_outbox ready");

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_reauth_tokens (
        token_hash      VARCHAR(64) PRIMARY KEY,
        keycloak_sub    VARCHAR(255) NOT NULL,
        expires_at      TIMESTAMPTZ  NOT NULL,
        created_at      TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reauth_expires ON user_reauth_tokens(expires_at)`);
    console.log("[auth] user_reauth_tokens ready");

    // -----------------------------------------------------------------
    // Mandatory-passkey enrollment tokens.
    //
    // When a user completes password-based login but has no WebAuthn
    // credential on file, we DO NOT hand them a session. Instead we
    // mint a short-lived, single-use enrollment token that can only
    // be used to drive the WebAuthn registration ceremony. The KC
    // access/refresh tokens that would normally be set as cookies
    // are stashed in this row and handed back as session cookies
    // once enrollment succeeds. The row is deleted on consumption
    // or when the 10-minute TTL elapses (whichever comes first).
    //
    // Threat model: this row transiently stores a live KC refresh
    // token, so it's treated the same as a session cookie — it's
    // only reachable by possession of the enrollment token (which
    // is itself sha-256 hashed at rest) and is purged aggressively.
    // -----------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS passkey_enrollment_tokens (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        keycloak_sub     VARCHAR(255) NOT NULL,
        email            VARCHAR(320),
        token_hash       VARCHAR(64)  NOT NULL UNIQUE,
        stashed_access   TEXT         NOT NULL,
        stashed_refresh  TEXT,
        expires_at       TIMESTAMPTZ  NOT NULL,
        consumed_at      TIMESTAMPTZ,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CHECK (expires_at > created_at)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pke_sub ON passkey_enrollment_tokens(keycloak_sub)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pke_expires ON passkey_enrollment_tokens(expires_at)`);
    console.log("[auth] passkey_enrollment_tokens ready");

    // -----------------------------------------------------------------
    // system_settings — global, operator-controlled toggles.
    //
    // This is the store behind the superadmin /users page's "Require
    // passkey enrollment on login" switch. Settings are read on every
    // /login request so the value MUST be cheap to query; we stash
    // it in a JSONB value column so future boolean/numeric/string
    // settings share the same schema.
    //
    // Every mutation captures who flipped the switch and when, which
    // is mirrored into tellus_audit_events on the API side so the
    // audit log shows the same event from the application's POV.
    // -----------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key          VARCHAR(128) PRIMARY KEY,
        value        JSONB        NOT NULL,
        description  TEXT,
        updated_by   VARCHAR(255),
        updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    // Default: passkey enrollment REQUIRED. Insert-on-conflict-do-nothing
    // so re-running the migration doesn't overwrite an operator's
    // subsequent change.
    await client.query(`
      INSERT INTO system_settings (key, value, description, updated_by)
      VALUES (
        'require_passkey_enrollment',
        'true'::jsonb,
        'When true, any user without a WebAuthn credential is gated into mandatory passkey enrollment after password login.',
        'system:bootstrap'
      )
      ON CONFLICT (key) DO NOTHING
    `);
    console.log("[auth] system_settings ready");

    // Per-user sliding-window budget for /me/reauth. An attacker with
    // cookie access but no password shouldn't be able to probe the
    // direct-grant path 500 times in 5 minutes — we cap at 10 failures
    // per rolling 15-minute window, after which further reauth attempts
    // 429 with REAUTH_BUDGET_EXHAUSTED.
    await client.query(`
      CREATE TABLE IF NOT EXISTS reauth_attempt_budget (
        keycloak_sub    VARCHAR(255) PRIMARY KEY,
        window_start    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        failed_count    INT          NOT NULL DEFAULT 0
      )
    `);
    console.log("[auth] reauth_attempt_budget ready");

    await client.query("COMMIT");
    console.log("[auth] schema up to date");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[auth] migration failed:", err);
  process.exit(1);
});
