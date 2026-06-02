// ---------------------------------------------------------------------------
// Named egress policy handlers (B1 — egress policy resource).
//
// Routes (mounted under /api/v1/connectivity):
//   POST   /egress-policies                  create (PENDING)   connectivity:write
//   GET    /egress-policies                  list               connectivity:read
//   GET    /egress-policies/:eprid           get                connectivity:read
//   PUT    /egress-policies/:eprid           update (If-Match)  connectivity:write
//   DELETE /egress-policies/:eprid           delete (If-Match)  connectivity:write
//   POST   /egress-policies/:eprid/decision  approve/reject     connectivity:write
//
// A policy is created PENDING and is only enforceable once APPROVED (see the
// pool-layer enforcement in connectors/postgresql/pool.ts). Editing the
// allowlist resets the policy to PENDING so destinations are always re-reviewed.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { withTransaction } from "../../../db";
import {
  EgressPolicyNotApproved,
  HasActiveDependencies,
  InvalidConfiguration,
} from "../../../lib/errors/connectivity.errors";
import { TellusError } from "../../../lib/errors/envelope";
import {
  requireConnectivityIfMatch,
  setConnectivityEtag,
} from "../../../middleware/connectivityEtag";
import {
  EgressPolicyCreateRequest,
  EgressPolicyDecisionRequest,
  EgressPolicyUpdateRequest,
} from "../contracts";
import * as repo from "../store/egress-policies.repo";
import { extractUser, requireScope } from "./connections.handler";

function mintEgressPolicyRid(): string {
  return `ri.magritte.main.egress-policy.${randomUUID()}`;
}

export async function postEgressPolicy(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = extractUser(req);
    requireScope(user, "connectivity:write");

    const parsed = EgressPolicyCreateRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new TellusError(InvalidConfiguration, { issues: parsed.error.issues });
    }
    const request = parsed.data;
    const rid = mintEgressPolicyRid();
    const created = await withTransaction((client) =>
      repo.insert(client, {
        rid,
        tenant: user.tenant,
        name: request.name,
        description: request.description ?? "",
        allowlist: request.allowlist,
        actor: user.id,
      }),
    );
    setConnectivityEtag(res, created.version);
    res.setHeader("Location", `/api/v1/connectivity/egress-policies/${rid}`);
    res.status(201).json(created);
  } catch (e) {
    if (e instanceof TellusError) return void e.send(res);
    next(e);
  }
}

export async function listEgressPolicies(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = extractUser(req);
    requireScope(user, "connectivity:read");
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : undefined;
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) {
      throw new TellusError(InvalidConfiguration, {
        field: "pageSize",
        message: "must be a positive integer",
      });
    }
    const result = await repo.list({
      tenant: user.tenant,
      status: req.query.status as string | undefined,
      pageSize,
      pageToken: (req.query.pageToken as string | undefined) ?? null,
    });
    res.status(200).json(result);
  } catch (e) {
    if (e instanceof TellusError) return void e.send(res);
    next(e);
  }
}

export async function getEgressPolicy(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = extractUser(req);
    requireScope(user, "connectivity:read");
    const policy = await repo.findByRid(req.params.eprid, user.tenant);
    setConnectivityEtag(res, policy.version);
    res.status(200).json(policy);
  } catch (e) {
    if (e instanceof TellusError) return void e.send(res);
    next(e);
  }
}

export async function putEgressPolicy(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = extractUser(req);
    requireScope(user, "connectivity:write");
    const current = await repo.findByRid(req.params.eprid, user.tenant);
    const expected = requireConnectivityIfMatch(req, current.version);

    const parsed = EgressPolicyUpdateRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new TellusError(InvalidConfiguration, { issues: parsed.error.issues });
    }
    const patch = parsed.data;
    const updated = await withTransaction((client) =>
      repo.update(
        client,
        req.params.eprid,
        user.tenant,
        expected,
        {
          name: patch.name,
          description: patch.description,
          allowlist: patch.allowlist,
        },
        user.id,
      ),
    );
    setConnectivityEtag(res, updated.version);
    res.status(200).json(updated);
  } catch (e) {
    if (e instanceof TellusError) return void e.send(res);
    next(e);
  }
}

export async function deleteEgressPolicy(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = extractUser(req);
    requireScope(user, "connectivity:write");
    const current = await repo.findByRid(req.params.eprid, user.tenant);
    const expected = requireConnectivityIfMatch(req, current.version);

    if (await repo.isReferenced(req.params.eprid)) {
      throw new TellusError(HasActiveDependencies, {
        rid: req.params.eprid,
        reason: "egress policy is referenced by one or more live connections",
      });
    }
    await withTransaction((client) =>
      repo.softDelete(client, req.params.eprid, user.tenant, expected, user.id),
    );
    res.status(204).send();
  } catch (e) {
    if (e instanceof TellusError) return void e.send(res);
    next(e);
  }
}

export async function decideEgressPolicy(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = extractUser(req);
    requireScope(user, "connectivity:write");
    const current = await repo.findByRid(req.params.eprid, user.tenant);
    const expected = requireConnectivityIfMatch(req, current.version);

    const parsed = EgressPolicyDecisionRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new TellusError(InvalidConfiguration, { issues: parsed.error.issues });
    }
    // Only a PENDING policy can be decided; deciding an already-terminal policy
    // is a precondition failure surfaced as not-approved (reviewer must reset
    // by editing the allowlist, which returns it to PENDING).
    if (current.status !== "PENDING") {
      throw new TellusError(EgressPolicyNotApproved, {
        rid: current.rid,
        currentStatus: current.status,
        reason: "only a PENDING policy may be approved or rejected",
      });
    }
    const updated = await withTransaction((client) =>
      repo.decide(
        client,
        req.params.eprid,
        user.tenant,
        expected,
        parsed.data.decision,
        user.id,
      ),
    );
    setConnectivityEtag(res, updated.version);
    res.status(200).json(updated);
  } catch (e) {
    if (e instanceof TellusError) return void e.send(res);
    next(e);
  }
}
