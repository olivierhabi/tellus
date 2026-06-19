// B10.04+ — OSS service: thin layer above the IR compiler that takes a
// parsed request, runs the OS query via an injected `executeFn`, and
// returns the structured result for the route layer.
import type { SearchRequest, AggregateRequest } from "./irSchema";
import { compileSearch, compileAggregate, compileFilter } from "./irCompiler";

export type ExecuteFn = (index: string, body: Record<string, unknown>) => Promise<{ hits?: Array<{ _id: string; _source: unknown; sort?: unknown }>; aggregations?: unknown; total?: number }>;

export function indexNameFor(req: { ontologyRid: string; objectType: string; branchRid?: string | null }): string {
  // We index per (ontology, branch, object_type) → simple, deterministic.
  const branch = req.branchRid ?? "main";
  return `oms-${req.ontologyRid.replace(/[^a-z0-9]/gi, "_")}-${branch.replace(/[^a-z0-9]/gi, "_")}-${req.objectType}`;
}

export class OssService {
  async load(req: SearchRequest, executeFn: ExecuteFn): Promise<{ hits: unknown[]; nextCursor?: string; total?: number }> {
    const compiled = compileSearch(req);
    const r = await executeFn(indexNameFor(req), compiled as unknown as Record<string, unknown>);
    const hits = (r.hits ?? []).map((h) => ({ id: h._id, ...(h._source as Record<string, unknown>) }));
    let nextCursor: string | undefined;
    if (r.hits && r.hits.length === req.pageSize && r.hits[r.hits.length - 1]?.sort) {
      nextCursor = Buffer.from(JSON.stringify(r.hits[r.hits.length - 1]!.sort)).toString("base64");
    }
    return { hits, nextCursor, total: r.total };
  }

  async aggregate(req: AggregateRequest, executeFn: ExecuteFn): Promise<{ aggregations: unknown }> {
    const compiled = compileAggregate(req);
    const r = await executeFn(indexNameFor(req), compiled as unknown as Record<string, unknown>);
    return { aggregations: r.aggregations ?? {} };
  }

  /** B10.06 — searchAround: given a primary objectType + linkType,
   * find related objects through the link.  We compile the IR for the
   * primary objectType, then issue a second targeted query for the
   * counterparty side; the link traversal itself is delegated to the
   * caller via `linkLookupFn` (so this stays infrastructure-agnostic). */
  async searchAround(opts: {
    primary: SearchRequest;
    linkType: string;
    direction: 'A_TO_B' | 'B_TO_A';
    counterpartyObjectType: string;
    executeFn: ExecuteFn;
    linkLookupFn: (linkType: string, sourceIds: string[], direction: 'A_TO_B' | 'B_TO_A') => Promise<string[]>;
    counterpartyOntologyRid?: string;
    counterpartyBranchRid?: string | null;
  }): Promise<{ primaryHits: unknown[]; counterpartyHits: unknown[] }> {
    const primary = await this.load(opts.primary, opts.executeFn);
    const ids = primary.hits.map((h) => (h as any).id as string).filter((id): id is string => !!id);
    if (ids.length === 0) return { primaryHits: primary.hits, counterpartyHits: [] };
    const counterpartyIds = await opts.linkLookupFn(opts.linkType, ids, opts.direction);
    if (counterpartyIds.length === 0) return { primaryHits: primary.hits, counterpartyHits: [] };
    const counterRequest: SearchRequest = {
      ontologyRid: opts.counterpartyOntologyRid ?? opts.primary.ontologyRid,
      objectType: opts.counterpartyObjectType,
      branchRid: opts.counterpartyBranchRid ?? null,
      filter: { kind: 'term', field: '_id', operator: 'in', value: counterpartyIds } as any,
      pageSize: counterpartyIds.length,
    };
    const counter = await this.load(counterRequest, opts.executeFn);
    return { primaryHits: primary.hits, counterpartyHits: counter.hits };
  }
  /** B10.08 — load-by-PK convenience: fetch a single object by its
   * primary key.  Compiles to a 1-document `terms` query against the
   * primary-key field.  Returns the document or null. */
  async loadByPk(opts: {
    ontologyRid: string;
    objectType: string;
    branchRid?: string | null;
    primaryKey: string;
    primaryKeyValue: string | number;
    executeFn: ExecuteFn;
  }): Promise<unknown | null> {
    const compiled = compileSearch({
      ontologyRid: opts.ontologyRid,
      objectType: opts.objectType,
      branchRid: opts.branchRid ?? null,
      filter: { kind: 'term', field: opts.primaryKey, operator: 'eq', value: opts.primaryKeyValue },
      pageSize: 1,
    } as any);
    const r = await opts.executeFn(indexNameFor(opts), compiled as unknown as Record<string, unknown>);
    if (!r.hits || r.hits.length === 0) return null;
    const h = r.hits[0]!;
    return { id: h._id, ...(h._source as Record<string, unknown>) };
  }

}
export const ossService = new OssService();
