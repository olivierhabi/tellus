// Quiver B9 — AIP routes (Generate / Configure / Assist + trace fetch).
// Mount path: /quiver/api/v1/aip
//
// Phase feature flag: TELLUS_QUIVER_PHASE >= 5.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { readBranch } from "../../services/quiver/branchHeader";
import { isQuiverTestAuthBound } from "./testAuth";
import {
  invalidAnalysisRequest,
  isQuiverError,
  unauthenticated,
  llmTimeout,
} from "../../services/quiver/errors";
import { inProcessAipPort } from "../../services/quiver/aip/inProcessAip";
import {
  defaultAuthorizedTools,
  orchestrate,
} from "../../services/quiver/aip/orchestrator";
import { startSse, writeSse, endSse } from "../../services/quiver/aip/sse";
import { getTrace } from "../../services/quiver/aip/traces";
import type {
  AipPort,
  AipSurface,
  UserSubject,
} from "../../services/quiver/aip/types";

interface ActorAndBranch {
  readonly user: UserSubject;
  readonly branch: string;
}

function actorAndBranch(req: Request): ActorAndBranch {
  const allowTest = isQuiverTestAuthBound(req);
  const fromCtx = (req as Request & {
    securityContext?: { userSubject?: string; orgRid?: string };
  }).securityContext;
  let userSubject = fromCtx?.userSubject;
  let orgRid = fromCtx?.orgRid;
  if (allowTest) {
    userSubject ??= req.header("x-test-user") ?? undefined;
    orgRid ??= req.header("x-test-org") ?? "ri.multipass.main.org.test";
  }
  if (!userSubject) {
    throw unauthenticated({ reason: "missing or invalid Multipass token" });
  }
  const groupsHeader = req.header("x-test-groups") ?? "";
  return {
    user: {
      userRid: userSubject,
      orgRid: orgRid ?? "ri.multipass.main.org.unknown",
      groups: groupsHeader ? groupsHeader.split(",") : [],
    },
    branch: readBranch(req),
  };
}

const GenerateBody = z.object({
  analysisRid: z.string().min(1),
  contextCardIds: z.array(z.string()).optional(),
  prompt: z.string().min(1),
});

const ConfigureBody = z.object({
  analysisRid: z.string().min(1),
  cardId: z.string().min(1),
  prompt: z.string().min(1),
});

const AssistBody = z.object({
  analysisRid: z.string().min(1),
  conversationId: z.string().min(1),
  message: z.string().min(1),
});

let portFactory: () => AipPort = () => inProcessAipPort;

export function setAipPortForTests(p: AipPort): void {
  portFactory = () => p;
}

export function resetAipPortForTests(): void {
  portFactory = () => inProcessAipPort;
}

async function streamSurface(
  req: Request,
  res: Response,
  surface: AipSurface,
  body: { analysisRid: string; cardId?: string; prompt: string },
): Promise<void> {
  let actor: ActorAndBranch;
  try {
    actor = actorAndBranch(req);
  } catch (e) {
    if (isQuiverError(e)) {
      res.status(e.status).json(e.envelope);
      return;
    }
    throw e;
  }

  const remainingMs = Math.max(
    0,
    Number(req.header("x-deadline-ms") ?? 30_000),
  );

  startSse(res);
  let producedAnyEvent = false;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  // 504 LLM timeout if the stream takes longer than remainingMs.
  timer = setTimeout(() => {
    timedOut = true;
    writeSse(res, {
      event: "error",
      data: {
        errorCode: "DEADLINE_EXCEEDED",
        errorName: "Tellus:Quiver:LlmTimeout",
        message: `exceeded ${remainingMs}ms deadline`,
      },
    });
    endSse(res);
  }, remainingMs);

  try {
    const port = portFactory();
    // vuln-0033: the authorized tool manifest is server-derived only. The
    // privileged `apply_action` tool must never be added from a client-
    // supplied boolean — its authorization must flow through
    // buildAuthorizedManifest + AuthPort.canApplyAction (services/quiver/
    // aip/tools.ts), which the production AIP logic service will wire. The
    // previous `authorizeApplyAction` request field let any authenticated
    // user self-authorize apply_action by sending `"authorizeApplyAction":
    // true`.
    const stream = orchestrate({
      port,
      surface,
      authorizedTools: defaultAuthorizedTools(),
      req: {
        analysisRid: body.analysisRid,
        cardId: body.cardId,
        prompt: body.prompt,
        userSubject: actor.user,
        branch: actor.branch,
        remainingMs,
      },
    });

    for await (const ev of stream) {
      if (timedOut) return;
      producedAnyEvent = true;
      writeSse(res, ev);
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (!timedOut) endSse(res);
    void producedAnyEvent;
  }
}

export const aipRouter: Router = Router();

aipRouter.post("/aip/generate", async (req, res) => {
  const parsed = GenerateBody.safeParse(req.body);
  if (!parsed.success) {
    const e = invalidAnalysisRequest({ issues: parsed.error.format() });
    res.status(e.status).json(e.envelope);
    return;
  }
  await streamSurface(req, res, "GENERATE", parsed.data);
});

aipRouter.post("/aip/configure", async (req, res) => {
  const parsed = ConfigureBody.safeParse(req.body);
  if (!parsed.success) {
    const e = invalidAnalysisRequest({ issues: parsed.error.format() });
    res.status(e.status).json(e.envelope);
    return;
  }
  await streamSurface(req, res, "CONFIGURE", parsed.data);
});

aipRouter.post("/aip/assist", async (req, res) => {
  const parsed = AssistBody.safeParse(req.body);
  if (!parsed.success) {
    const e = invalidAnalysisRequest({ issues: parsed.error.format() });
    res.status(e.status).json(e.envelope);
    return;
  }
  await streamSurface(req, res, "ASSIST", {
    ...parsed.data,
    prompt: parsed.data.message,
  });
});

aipRouter.get("/aip/traces/:rid", async (req, res) => {
  let actor: ActorAndBranch;
  try {
    actor = actorAndBranch(req);
  } catch (e) {
    if (isQuiverError(e)) {
      res.status(e.status).json(e.envelope);
      return;
    }
    throw e;
  }
  const trace = await getTrace(req.params.rid);
  if (!trace) {
    const e = llmTimeout({ reason: "trace not found" });
    res.status(404).json({
      errorCode: "NOT_FOUND",
      errorName: "Tellus:Quiver:TraceNotFound",
      errorInstanceId: e.envelope.errorInstanceId,
      parameters: { rid: req.params.rid },
    });
    return;
  }
  // CBAC v1: trace visible to its author. Same-org reads allowed via D-59.
  // vuln-0028: the mismatch branch was previously an empty no-op, so any
  // authenticated user could read every other user's AIP trace (plaintext
  // LLM prompts + tool inputs). Enforce fail-closed as 404 (so trace
  // existence is not oracle-able by co-tenants), matching the IDOR-as-404
  // pattern used elsewhere in the quiver/jemma routes.
  if (trace.userRid !== actor.user.userRid && trace.userRid !== "*") {
    const e = llmTimeout({ reason: "trace not found" });
    res.status(404).json({
      errorCode: "NOT_FOUND",
      errorName: "Tellus:Quiver:TraceNotFound",
      errorInstanceId: e.envelope.errorInstanceId,
      parameters: { rid: req.params.rid },
    });
    return;
  }
  res.status(200).json(trace);
});
