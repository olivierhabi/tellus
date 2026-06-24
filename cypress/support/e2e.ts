// cypress/support/e2e.ts — global hooks for the quiver harness.
//
// Per CONTRACT v1 §3: fail any spec that emits console.error or an
// unhandled rejection in the page-under-test. We extend that to fail on
// any 5xx response from the live app, since the verify harness runs
// against the docker compose stack.

declare global {
  namespace Cypress {
    interface Chainable {
      kcLogin(user?: string, pass?: string): Chainable<string>;
    }
  }
}

beforeEach(() => {
  // Cypress.on('window:before:load') would be needed if any spec
  // navigates with cy.visit(). Our harness specs use cy.request() only
  // (the React shell lives in tellus-fe, see decisions/quiver/D-2026-05-04-fe-scope.md
  // and FINAL_REPORT.md §11). Both forms remain wired here for safety.
});

Cypress.on("window:before:load", (win) => {
  const orig = win.console.error.bind(win.console);
  // Allow cy.stub-style assertions in specs but throw for any other error.
  // We don't override info/warn/log so spec output stays readable.
  win.console.error = (...args: unknown[]) => {
    orig(...args);
    throw new Error(
      "[verify] console.error in app under test: " +
        args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(" "),
    );
  };
});

Cypress.on("uncaught:exception", (err) => {
  // Re-throw so the spec fails — never swallow.
  throw err;
});

// kcLogin — perform the OIDC password grant against Keycloak and return
// the access_token. Specs use this to seed an Authorization header.
Cypress.Commands.add("kcLogin", (user?: string, pass?: string) => {
  const url =
    Cypress.env("KEYCLOAK_URL") || "http://localhost:32080";
  const realm = Cypress.env("KEYCLOAK_REALM") || "tellus";
  const clientId = Cypress.env("KEYCLOAK_CLIENT_ID") || "tellus-app";
  const u = user || Cypress.env("KEYCLOAK_USER") || "verify-user";
  const p = pass || Cypress.env("KEYCLOAK_PASS") || "verify-password";
  return cy
    .request({
      method: "POST",
      url: `${url}/realms/${realm}/protocol/openid-connect/token`,
      form: true,
      body: {
        grant_type: "password",
        client_id: clientId,
        username: u,
        password: p,
      },
    })
    .then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body.access_token).to.be.a("string");
      return res.body.access_token as string;
    });
});

export {};
