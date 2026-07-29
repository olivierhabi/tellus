// ---------------------------------------------------------------------------
// routeIntrospection.ts — derive the live HTTP route table from the Express
// app so the OpenAPI document can be generated FROM the real routes instead of
// hand-maintained, which previously drifted from the live route surface.
//
// The existing `extractRoutes` in middleware/notFoundHandler.ts is best-effort
// and mangles nested parameterised mounts (e.g. it drops the `:apiName`
// segment of `/ontology/:ontologyId/objectTypes/:apiName`, producing `//`).
// This module decodes each mount layer's compiled regexp using its `keys`
// array, which reconstructs every `{param}` segment correctly.
// ---------------------------------------------------------------------------

import type { Express } from 'express';

export interface LiveRoute {
  method: string;
  /** Absolute path with OpenAPI-style `{param}` placeholders, e.g.
   *  `/api/v1/ontology/{ontologyId}/objectTypes/{apiName}`. */
  path: string;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** Convert an Express path token (`:name`) to OpenAPI form (`{name}`). */
function toOpenApiSegment(seg: string): string {
  if (seg.startsWith(':')) {
    // Express allows `:name?`, `:name(regex)`, and escaped suffixes like
    // `:version\:revert`; keep just the leading identifier so the OpenAPI
    // `{param}` name is valid.
    const name = seg.slice(1).replace(/[^A-Za-z0-9_].*$/, '');
    return `{${name}}`;
  }
  return seg;
}

function normalizePath(p: string): string {
  let out = p.replace(/\/{2,}/g, '/');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out || '/';
}

/**
 * Decode a sub-router mount layer's regexp into a path fragment using its
 * `keys` (the ordered param names path-to-regexp captured). Returns '' for a
 * root mount (`app.use(router)`).
 */
function decodeMount(layer: unknown): string {
  const l = layer as { regexp?: RegExp & { fast_slash?: boolean }; keys?: Array<{ name: string | number }> };
  const re = l?.regexp;
  if (!re) return '';
  if (re.fast_slash) return ''; // mounted at '/'
  const keys = l.keys || [];

  let src = re.source;
  // Normalise: unescape slashes so the format is uniform `/` regardless of
  // whether this path-to-regexp build escaped them (`\/`) or not (`/`).
  src = src.replace(/\\\//g, '/');
  // Strip anchors + the trailing optional-slash lookahead wrapper.
  src = src.replace(/^\^/, '');
  src = src.replace(/\/\?\(\?=\/\|\$\)$/, '');
  src = src.replace(/\(\?=\/\|\$\)$/, '');
  src = src.replace(/\/\?$/, '');
  src = src.replace(/\$$/, '');

  // Replace each param capture group with a `§N§` sentinel (the char never
  // occurs in a route path or a regexp source), in path order. path-to-regexp
  // emits params as `(?:/([^/]+?))` (with a leading separator) or `([^/]+?)`.
  // Preserve the leading separator slash for the slashed form.
  let ki = 0;
  src = src.replace(/\(\?:\/\(\[\^\/\]\+\?\)\)\??/g, () => `/§${ki++}§`);
  src = src.replace(/\(\?:\(\[\^\/\]\+\?\)\)\??/g, () => `§${ki++}§`);
  src = src.replace(/\(\[\^\/\]\+\?\)/g, () => `§${ki++}§`);

  const restore = (seg: string): string =>
    seg.replace(/§(\d+)§/g, (_m, i) => {
      const k = keys[Number(i)];
      return `{${k ? k.name : 'param'}}`;
    });
  const parts = src
    .split('/')
    .map(restore)
    .filter((s) => s.length > 0);
  return '/' + parts.join('/');
}

/** Walk the Express router stack and collect every concrete route. */
export function extractLiveRoutes(app: Express): LiveRoute[] {
  const routes: LiveRoute[] = [];
  const seen = new Set<string>();

  function walk(stack: unknown[], prefix: string): void {
    if (!Array.isArray(stack)) return;
    for (const layer of stack as Array<Record<string, any>>) {
      if (layer.route) {
        const routePath = layer.route.path;
        const candidatePaths = Array.isArray(routePath) ? routePath : [routePath];
        for (const rp of candidatePaths) {
          const segs = String(rp)
            .split('/')
            .filter((s) => s.length > 0)
            .map(toOpenApiSegment);
          const full = normalizePath(prefix + '/' + segs.join('/'));
          for (const method of Object.keys(layer.route.methods || {})) {
            if (!HTTP_METHODS.has(method)) continue;
            const key = `${method.toUpperCase()} ${full}`;
            if (seen.has(key)) continue;
            seen.add(key);
            routes.push({ method: method.toUpperCase(), path: full });
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + decodeMount(layer));
      }
    }
  }

  const stack = (app as unknown as { _router?: { stack: unknown[] } })?._router?.stack;
  if (stack) walk(stack, '');

  routes.sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  );
  return routes;
}
