// ---------------------------------------------------------------------------
// Served-spec auto-stub machinery (extracted from docs/openapi.ts during
// the god-file breakup — behavior-preserving move).
//
// buildServedSpec() derives the spec served at /api/docs from the live
// Express route table. Routes without a hand-written curated operation get
// an auto-generated stub from these pure helpers: path-shape normalisation
// (so curated `{ontologyId}` / `:id` match live `{x}`), area tagging,
// path-parameter synthesis, public-path detection, and the stub builder.
// Pure and dependency-free — unit-testable without booting the app.
// ---------------------------------------------------------------------------

/** Collapse param segments so curated `{ontologyId}` / `:id` match live `{x}`. */
export function normShape(path: string): string {
  return path.replace(/\{[^}]+\}/g, '{}').replace(/:[^/]+/g, '{}');
}

export function areaTag(path: string): string {
  if (path.startsWith('/health')) return 'Health';
  if (path.startsWith('/api/docs') || path.startsWith('/api/metrics')) return 'Meta';
  if (path.startsWith('/quiver')) return 'Quiver';
  const segs = path.split('/').filter(Boolean); // [api, v1, ontology, ...]
  const a = (segs[2] || segs[1] || 'root').toLowerCase();
  const map: Record<string, string> = {
    connectivity: 'Connectivity', ontology: 'Ontology', funnel: 'Funnel',
    workshop: 'Workshop', auth: 'Auth', 'code-repositories': 'Code Repositories',
    projects: 'Projects', datasets: 'Datasets', objects: 'Objects',
    functions: 'Functions', templates: 'Templates', actions: 'Actions',
    search: 'Search', dev: 'Dev', resources: 'Foundry', system: 'System',
    compass: 'Foundry', users: 'Users', scaffold: 'Templates', charts: 'Objects',
    status: 'System', breadcrumb: 'Foundry',
  };
  return map[a] || a.charAt(0).toUpperCase() + a.slice(1);
}

export function pathParameters(path: string): Array<Record<string, unknown>> {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1], in: 'path', required: true,
    schema: { type: 'string' }, description: `${m[1]} path parameter`,
  }));
}

export function isPublicPath(path: string): boolean {
  return (
    path.startsWith('/health') ||
    path.startsWith('/api/docs') ||
    path === '/api/metrics' ||
    path === '/api/v1/auth/health' ||
    /^\/api\/v1\/auth\/(login|oidc|refresh|logout|register|pat-scopes|password)/.test(path)
  );
}

export function autoStub(method: string, path: string): Record<string, unknown> {
  const op: Record<string, unknown> = {
    tags: [areaTag(path)],
    summary: `${method} ${path}`,
    description:
      'Auto-generated from the live route table. Not yet hand-documented with ' +
      'full request/response schemas — see docs/openapi.ts to enrich.',
    'x-auto-generated': true,
    parameters: pathParameters(path),
    responses: {
      '200': { description: 'Successful response' },
      '400': { description: 'Bad request' },
      '401': { description: 'Unauthorized' },
      '403': { description: 'Forbidden' },
      '404': { description: 'Not found' },
      '500': { description: 'Server error' },
    },
    security: isPublicPath(path) ? [] : [{ bearerAuth: [] }],
  };
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    op.requestBody = {
      required: false,
      content: { 'application/json': { schema: { type: 'object' } } },
    };
  }
  return op;
}
