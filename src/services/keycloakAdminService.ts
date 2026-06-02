/**
 * keycloakAdminService.ts
 * -----------------------
 * Thin wrapper around the Keycloak admin API that drives every
 * self-service operation the tellus `/settings` UI needs:
 *
 *   • list / delete credentials (password, TOTP, WebAuthn passkeys)
 *   • list / delete active sessions + logout-all
 *   • schedule required actions (webauthn-register, CONFIGURE_TOTP,
 *     UPDATE_PASSWORD) so Keycloak runs the browser ceremony
 *   • query the events API for the /api/v1/audit/auth-events feed
 *   • create / update / delete realm clients for the Developer Console
 *
 * The admin token is acquired via client_credentials against
 * `tellus-confidential`. That client's service account has been granted
 * the `realm-management` client roles `view-users`, `manage-users`,
 * `view-events`, `view-realm`, and `manage-events` by
 * `scripts/bootstrap-keycloak.sh`.
 *
 * Tokens are cached in-memory for 90% of their lifetime so most calls
 * hit the cache; a failure-path re-fetch covers clock skew and rotation.
 */

import { AppError } from '../utils/foundryAppError';
import { getKeycloakRealm } from "../auth/keycloakConfig"; // F-P4-26
import { withBreaker } from "../resilience/circuitBreaker";

// F-P4-11: classify failures so 401/403/404 from a *working* Keycloak
// (caller supplied wrong token, realm-mgmt role missing, user not
// found) do NOT trip the breaker — only 5xx/network/abort counts.
function isKcFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  // AppError carries a statusCode we set ourselves.
  const code = (err as { statusCode?: number }).statusCode;
  if (typeof code === "number") return code >= 500;
  // AbortError from AbortSignal.timeout → upstream too slow.
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  // Network / DNS errors.
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed/.test(err.message)) {
    return true;
  }
  return false;
}

export interface KeycloakAdminConfig {
  kcUrl: string;
  kcRealm: string;
  clientId: string;
  clientSecret: string;
}

export interface KeycloakCredential {
  id: string;
  type: string;
  userLabel?: string;
  createdDate?: number;
  credentialData?: string;
}

export interface KeycloakSession {
  id: string;
  userId: string;
  username?: string;
  ipAddress?: string;
  start?: number;
  lastAccess?: number;
  clients?: Record<string, string>;
}

export interface KeycloakEvent {
  time: number;
  type: string;
  realmId: string;
  clientId?: string;
  userId?: string;
  sessionId?: string;
  ipAddress?: string;
  error?: string;
  details?: Record<string, string>;
}

export type RequiredAction = 'webauthn-register' | 'webauthn-register-passwordless' | 'CONFIGURE_TOTP' | 'UPDATE_PASSWORD' | 'VERIFY_EMAIL';

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class KeycloakAdminService {
  private token: CachedToken | null = null;

  constructor(private config: KeycloakAdminConfig) {}

  private get issuer(): string {
    return `${this.config.kcUrl}/realms/${this.config.kcRealm}`;
  }

  private get adminBase(): string {
    return `${this.config.kcUrl}/admin/realms/${this.config.kcRealm}`;
  }

  /** Fetch-or-reuse an admin token via client_credentials. */
  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 5000) {
      return this.token.value;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    // F-P4-08: bound the token exchange. Without an AbortSignal a
    // wedged Keycloak stalls every route that ever calls getToken() for
    // the full HTTP client window (no default timeout on undici fetch).
    // F-P4-11: route through the "kc" breaker so a dead Keycloak trips
    // once, not once per in-flight request.
    const res = await withBreaker(
      'kc',
      () =>
        fetch(`${this.issuer}/protocol/openid-connect/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(5_000),
        }),
      {},
      isKcFailure,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AppError(
        `Keycloak admin token exchange failed: ${text || res.statusText}`,
        502,
        'KEYCLOAK_UNREACHABLE',
      );
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: data.access_token,
      expiresAt: Date.now() + data.expires_in * 900, // 90% of lifetime
    };
    return data.access_token;
  }

  private async call<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | undefined>; parseJson?: boolean } = {},
  ): Promise<T> {
    const token = await this.getToken();
    const qs = opts.query
      ? '?' +
        Object.entries(opts.query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    const url = `${this.adminBase}${path}${qs}`;
    // F-P4-08: bound every Keycloak admin REST call. 8s upper bound
    // covers the p99 realm-scan latency on slow clusters; anything
    // longer surfaces as a typed 502 instead of hanging the event loop.
    // F-P4-11: shared breaker with getToken() — one wedge trips both.
    const res = await withBreaker(
      'kc',
      () =>
        fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(8_000),
        }),
      {},
      isKcFailure,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 404) {
        throw new AppError(`Keycloak resource not found`, 404, 'NOT_FOUND');
      }
      if (res.status === 403) {
        throw new AppError(
          `Keycloak admin API denied the request — check tellus-confidential service-account role grants`,
          403,
          'KEYCLOAK_FORBIDDEN',
        );
      }
      throw new AppError(
        `Keycloak admin ${method} ${path} failed: ${text || res.statusText}`,
        502,
        'KEYCLOAK_ADMIN_ERROR',
      );
    }
    if (opts.parseJson === false) return undefined as unknown as T;
    if (res.status === 204) return undefined as unknown as T;
    const text = await res.text();
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }

  // --- Credentials ---------------------------------------------------------

  listCredentials(userId: string): Promise<KeycloakCredential[]> {
    return this.call<KeycloakCredential[]>('GET', `/users/${userId}/credentials`);
  }

  deleteCredential(userId: string, credentialId: string): Promise<void> {
    return this.call('DELETE', `/users/${userId}/credentials/${credentialId}`, {
      parseJson: false,
    });
  }

  /**
   * Enqueue a required action (e.g. webauthn-register) on the user. When
   * the user next hits Keycloak's login page they'll be prompted to
   * complete it. This is how Palantir's self-service passkey directory
   * works per the spec — Keycloak runs the actual WebAuthn ceremony.
   */
  async setRequiredActions(userId: string, actions: RequiredAction[]): Promise<void> {
    await this.call('PUT', `/users/${userId}`, {
      body: { requiredActions: actions },
      parseJson: false,
    });
  }

  /**
   * Build a Keycloak "execute actions" self-service URL that triggers
   * `actions` on the user after a short redirect-back step. Useful for
   * "Add passkey" buttons that should run the ceremony immediately
   * rather than waiting for the next login.
   */
  getExecuteActionsUrl(userId: string, actions: RequiredAction[], redirectUri: string): string {
    const u = new URL(`${this.config.kcUrl}/realms/${this.config.kcRealm}/login-actions/required-action`);
    u.searchParams.set('execution', actions[0]);
    u.searchParams.set('client_id', 'tellus-frontend');
    u.searchParams.set('redirect_uri', redirectUri);
    // Also schedule the full list so KC presents any remaining actions in sequence.
    actions.slice(1).forEach((a) => u.searchParams.append('execution', a));
    u.searchParams.set('user_id', userId);
    return u.toString();
  }

  // --- Sessions ------------------------------------------------------------

  listSessions(userId: string): Promise<KeycloakSession[]> {
    return this.call<KeycloakSession[]>('GET', `/users/${userId}/sessions`);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.call('DELETE', `/sessions/${sessionId}`, { parseJson: false });
  }

  logoutAll(userId: string): Promise<void> {
    return this.call('POST', `/users/${userId}/logout`, { parseJson: false });
  }

  // --- Events --------------------------------------------------------------

  listEvents(opts: {
    user?: string;
    type?: string[];
    dateFrom?: string;
    dateTo?: string;
    max?: number;
    first?: number;
  }): Promise<KeycloakEvent[]> {
    return this.call<KeycloakEvent[]>('GET', `/events`, {
      query: {
        user: opts.user,
        type: opts.type ? opts.type.join(',') : undefined,
        dateFrom: opts.dateFrom,
        dateTo: opts.dateTo,
        max: opts.max?.toString(),
        first: opts.first?.toString(),
      },
    });
  }

  // --- Applications (Developer Console — Task 8) ---------------------------

  listClients(): Promise<Array<{ id: string; clientId: string; name?: string; publicClient: boolean; redirectUris: string[] }>> {
    return this.call('GET', `/clients`);
  }

  async createClient(body: {
    clientId: string;
    name?: string;
    publicClient: boolean;
    standardFlowEnabled?: boolean;
    directAccessGrantsEnabled?: boolean;
    serviceAccountsEnabled?: boolean;
    redirectUris?: string[];
  }): Promise<{ id: string; clientId: string }> {
    await this.call('POST', `/clients`, {
      body: {
        ...body,
        attributes: { 'pkce.code.challenge.method': 'S256' },
      },
      parseJson: false,
    });
    const created = await this.call<
      Array<{ id: string; clientId: string }>
    >('GET', `/clients`, { query: { clientId: body.clientId } });
    return created[0];
  }

  async deleteClient(clientUuid: string): Promise<void> {
    await this.call('DELETE', `/clients/${clientUuid}`, { parseJson: false });
  }

  async getClientSecret(clientUuid: string): Promise<string> {
    const res = await this.call<{ value: string }>('GET', `/clients/${clientUuid}/client-secret`);
    return res.value;
  }

  // --- Users ---------------------------------------------------------------

  async findUserByEmail(email: string): Promise<{ id: string; email?: string; username: string } | null> {
    const rows = await this.call<Array<{ id: string; email?: string; username: string }>>(
      'GET',
      '/users',
      { query: { email, max: '1', exact: 'true' } },
    );
    return rows[0] ?? null;
  }

  /**
   * Resolve a single user by Keycloak `sub` — the stable id persisted in
   * audit columns such as connectivity `created_by` / `updated_by`. Returns
   * a typed name subset, or `null` on 404 so callers can degrade gracefully:
   * a since-deleted principal must not error the surface that lists it.
   */
  async getUserById(id: string): Promise<{
    id: string;
    username: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null> {
    try {
      const u = await this.call<{
        id: string;
        username: string;
        email?: string;
        firstName?: string;
        lastName?: string;
      }>('GET', `/users/${encodeURIComponent(id)}`, {
        query: { briefRepresentation: 'true' },
      });
      if (!u?.id) return null;
      return {
        id: u.id,
        username: u.username,
        email: u.email ?? null,
        firstName: u.firstName ?? null,
        lastName: u.lastName ?? null,
      };
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) return null;
      throw err;
    }
  }

  /**
   * List users for the admin /users page. Returns a stable, typed
   * subset of the Keycloak representation — the full KC user record
   * is enormous and contains fields the FE has no use for. Supports
   * search (email/username substring), pagination, and total count.
   */
  async listUsers(opts: {
    search?: string;
    first?: number;
    max?: number;
  }): Promise<
    Array<{
      id: string;
      username: string;
      email: string | null;
      firstName: string | null;
      lastName: string | null;
      enabled: boolean;
      emailVerified: boolean;
      createdTimestamp: number | null;
      roles: string[];
    }>
  > {
    const rows = await this.call<
      Array<{
        id: string;
        username: string;
        email?: string;
        firstName?: string;
        lastName?: string;
        enabled?: boolean;
        emailVerified?: boolean;
        createdTimestamp?: number;
      }>
    >('GET', '/users', {
      query: {
        search: opts.search,
        first: opts.first?.toString(),
        max: (opts.max ?? 100).toString(),
        briefRepresentation: 'true',
      },
    });

    // Hydrate realm roles for each user in parallel. This is N+1 and
    // would be bad at >500 users; the /users admin page caps max at 100
    // which keeps the burst under Keycloak's default rate limits. If we
    // ever need to scale past that, we can switch to the group-based
    // scheme where role membership is stored in a tellus-side projection.
    const withRoles = await Promise.all(
      rows.map(async (r) => {
        const roles = await this.listUserRealmRoles(r.id).catch(() => [] as string[]);
        return {
          id: r.id,
          username: r.username,
          email: r.email ?? null,
          firstName: r.firstName ?? null,
          lastName: r.lastName ?? null,
          enabled: r.enabled ?? true,
          emailVerified: r.emailVerified ?? false,
          createdTimestamp: r.createdTimestamp ?? null,
          roles,
        };
      }),
    );
    return withRoles;
  }

  async countUsers(search?: string): Promise<number> {
    const out = await this.call<number>('GET', '/users/count', {
      query: { search },
    });
    return typeof out === 'number' ? out : 0;
  }

  /**
   * Create a Keycloak user with an initial password. The password is
   * marked temporary=false so the user can sign in with it immediately
   * (mandatory-passkey enrollment then gates them into registering a
   * passkey before they get a session). Returns the new user's id.
   */
  async createUser(body: {
    username: string;
    email: string;
    firstName?: string;
    lastName?: string;
    password: string;
    enabled?: boolean;
    emailVerified?: boolean;
  }): Promise<string> {
    // The tellus realm has KC's `Verify Profile` authenticator
    // enabled, which inspects `firstName` + `lastName` at token
    // time and short-circuits direct-grant with "Account is not
    // fully set up" when either is blank. The operator creating a
    // user through /admin/users may not know to supply both, so we
    // default them from the email local-part. These are just
    // placeholders the user can edit from /settings/profile after
    // enrolling a passkey on first login.
    const localPart = body.email.split('@')[0] || body.username;
    const defaultedFirst =
      body.firstName && body.firstName.trim().length > 0
        ? body.firstName
        : localPart;
    const defaultedLast =
      body.lastName && body.lastName.trim().length > 0 ? body.lastName : 'User';

    // Step 1 — create the user without a credential. We deliberately
    // do NOT pass `credentials` inline here: Keycloak's REST endpoint
    // silently drops the field when the realm has a strong password
    // policy (the credential makes it past validation but never lands
    // on the user record), leaving the account in an unauthenticatable
    // state. The reliable path is create-then-reset-password as two
    // distinct calls so any policy violation surfaces as a real 4xx.
    await this.call('POST', '/users', {
      body: {
        username: body.username,
        email: body.email,
        firstName: defaultedFirst,
        lastName: defaultedLast,
        enabled: body.enabled ?? true,
        emailVerified: body.emailVerified ?? true,
        // Explicitly clear default required-actions. Without this,
        // Keycloak attaches `CONFIGURE_TOTP` / `VERIFY_PROFILE` /
        // etc. to fresh users per the realm's defaultAction config,
        // which makes direct-grant login fail with "Account is not
        // fully set up". Tellus owns its own MFA via mandatory-passkey
        // enrollment — KC-level required actions would double-prompt.
        requiredActions: [],
      },
      parseJson: false,
    });
    const created = await this.call<Array<{ id: string }>>('GET', '/users', {
      query: { username: body.username, exact: 'true', max: '1' },
    });
    if (!created[0]) {
      throw new AppError('User created but could not be located', 500, 'KEYCLOAK_ADMIN_ERROR');
    }
    const userId = created[0].id;
    // Step 2 — set the password. temporary=false so the user can sign
    // in immediately and proceed straight into mandatory-passkey
    // enrollment instead of being routed through Keycloak's own
    // password-reset prompt (which would happen if temporary=true).
    try {
      await this.call('PUT', `/users/${userId}/reset-password`, {
        body: { type: 'password', value: body.password, temporary: false },
        parseJson: false,
      });
      // Step 3 — explicitly clear any required-actions Keycloak's
      // realm defaults attached to this fresh user (CONFIGURE_TOTP,
      // VERIFY_PROFILE, VERIFY_EMAIL, etc). The realm-default
      // required-actions get applied AFTER the create call, so
      // passing `requiredActions: []` in step 1 is not enough — we
      // have to overwrite them with a follow-up PUT. Without this,
      // the user's first /login direct-grant would 401 with
      // `Account is not fully set up` because KC blocks direct-grant
      // for users with pending required actions, and tellus would
      // never reach the mandatory-passkey enrollment branch.
      await this.call('PUT', `/users/${userId}`, {
        body: { requiredActions: [] },
        parseJson: false,
      });
    } catch (err) {
      // Roll back the half-created user so a re-run can succeed.
      await this.deleteUser(userId).catch(() => {});
      throw err;
    }
    return userId;
  }

  async deleteUser(userId: string): Promise<void> {
    await this.call('DELETE', `/users/${userId}`, { parseJson: false });
  }

  async setUserEnabled(userId: string, enabled: boolean): Promise<void> {
    await this.call('PUT', `/users/${userId}`, {
      body: { enabled },
      parseJson: false,
    });
  }

  // --- Realm roles ---------------------------------------------------------

  /**
   * Idempotently create a realm role. Returns the role representation
   * whether it already existed or was just created — callers that
   * want to assign the role don't care which branch ran.
   */
  async ensureRealmRole(name: string, description?: string): Promise<{ id: string; name: string }> {
    try {
      const existing = await this.call<{ id: string; name: string }>(
        'GET',
        `/roles/${encodeURIComponent(name)}`,
      );
      return existing;
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'NOT_FOUND') throw err;
    }
    await this.call('POST', '/roles', {
      body: { name, description: description ?? `Tellus ${name} realm role` },
      parseJson: false,
    });
    return this.call<{ id: string; name: string }>(
      'GET',
      `/roles/${encodeURIComponent(name)}`,
    );
  }

  async listUserRealmRoles(userId: string): Promise<string[]> {
    const rows = await this.call<Array<{ name: string }>>(
      'GET',
      `/users/${userId}/role-mappings/realm`,
    );
    return rows.map((r) => r.name);
  }

  async assignRealmRoleToUser(userId: string, roleName: string): Promise<void> {
    const role = await this.ensureRealmRole(roleName);
    const current = await this.listUserRealmRoles(userId);
    if (current.includes(roleName)) return; // idempotent
    await this.call('POST', `/users/${userId}/role-mappings/realm`, {
      body: [{ id: role.id, name: role.name }],
      parseJson: false,
    });
  }

  async removeRealmRoleFromUser(userId: string, roleName: string): Promise<void> {
    const role = await this.ensureRealmRole(roleName);
    await this.call('DELETE', `/users/${userId}/role-mappings/realm`, {
      body: [{ id: role.id, name: role.name }],
      parseJson: false,
    });
  }

  /**
   * Set a user's password to a known value (permanent, non-temporary).
   * Mirrors step 2 of `createUser` and is used by the superadmin bootstrap
   * to reconcile an EXISTING account's password with
   * `TELLUS_SUPERADMIN_PASSWORD` — Keycloak's create call sets the password
   * once, but a later env rotation never reaches an already-created user, so
   * the credential drifts and direct-grant login starts returning
   * `invalid_grant`. A 4xx (e.g. password-policy violation) surfaces here.
   */
  async resetPassword(userId: string, password: string): Promise<void> {
    await this.call('PUT', `/users/${userId}/reset-password`, {
      body: { type: 'password', value: password, temporary: false },
      parseJson: false,
    });
  }
}

let singleton: KeycloakAdminService | null = null;
export function getKeycloakAdminService(): KeycloakAdminService {
  if (!singleton) {
    singleton = new KeycloakAdminService({
      kcUrl: process.env.KEYCLOAK_URL || 'http://localhost:8086',
      kcRealm: getKeycloakRealm(),
      clientId:
        process.env.KEYCLOAK_CONFIDENTIAL_CLIENT_ID || 'tellus-confidential',
      clientSecret:
        process.env.KEYCLOAK_CONFIDENTIAL_CLIENT_SECRET ||
        'tellus-confidential-secret-change-me',
    });
  }
  return singleton;
}
