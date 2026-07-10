// ---------------------------------------------------------------------------
// Code Assistant proxy route — the secure intermediary between tellus-fe
// and the telos-AIE-agent AI engine for the TypeScript Functions v2 coding
// assistant.
//
// Flow:  Frontend  --POST /api/v1/code-assistant/typescript-v2-->  this route
//        this route  --POST {TELOS_AIE_AGENT_URL}/api/code-repositories-typescript-v2-->  AI engine
//        this route  <--{response, _metadata}--  AI engine
//        Frontend  <--{success, data}--  this route
//
// SECURITY: the frontend never learns the AI engine URL. This route is the
// only caller of AiEngineClient. Auth is two-layer (same pattern as
// /api/v1/code-repositories): globalAuth allowlists the prefix so the
// CODE_ASSISTANT_TEST_AUTH test-principal bypass works in CI; in production
// requireCodeAssistantAuth() enforces a real Tellus JWT/PAT.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { AppError } from "../utils/foundryAppError";
import {
  aiEngineClient,
  type AiEnginePayload,
  type AiEnginePort,
} from "../services/aiEngine/client";

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

export interface CodeAssistantPrincipal {
  readonly userId: string;
  readonly source: "bearer-jwt" | "pat" | "test";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      codeAssistantPrincipal?: CodeAssistantPrincipal;
    }
  }
}

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void;

// Cached upstream Tellus auth middleware (prod path). Lazily required so
// unit tests that inject their own `auth` never load tellusAuth/foundryDb.
let _upstream: AuthMiddleware | null | undefined;

/**
 * Required-auth middleware for the Code Assistant route.
 *
 * - Test mode (CODE_ASSISTANT_TEST_AUTH=1 && NODE_ENV !== "production"):
 *   honours X-Tellus-Test-Principal: <userId>[/roles] and short-circuits,
 *   so Cypress can exercise the route without a Keycloak JWT.
 * - Production: delegates to requireTellusAuth({ allowPat: true }) and
 *   projects the resolved principal onto req.codeAssistantPrincipal.
 */
export function requireCodeAssistantAuth(): AuthMiddleware {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (
      process.env.CODE_ASSISTANT_TEST_AUTH === "1" &&
      process.env.NODE_ENV &&
      process.env.NODE_ENV !== "production"
    ) {
      const header = req.header("X-Tellus-Test-Principal");
      const userId =
        header && header.length > 0
          ? header.split("/")[0]
          : "anonymous";
      req.codeAssistantPrincipal = { userId, source: "test" };
      next();
      return;
    }

    if (_upstream === undefined) {
      try {
        // Lazy require — avoids pulling foundryDb into the unit-test lane.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require("../middleware/tellusAuth");
        _upstream = mod.requireTellusAuth({ allowPat: true }) as AuthMiddleware;
      } catch {
        _upstream = null;
      }
    }
    if (!_upstream) {
      res.status(401).json({
        errorCode: "UNAUTHENTICATED",
        errorName: "AuthenticationError",
        message: "Authentication required",
        statusCode: 401,
      });
      return;
    }
    _upstream(req, res, (err?: unknown) => {
      if (err) return;
      const tp = (req as Request & {
        tellusPrincipal?: { userId?: string };
      }).tellusPrincipal;
      const sub = (req as Request & { auth?: { sub?: string } }).auth?.sub;
      const userId = tp?.userId ?? sub ?? "";
      if (!userId) {
        res.status(401).json({
          errorCode: "UNAUTHENTICATED",
          errorName: "AuthenticationError",
          message: "Authenticated principal has no userId",
          statusCode: 401,
        });
        return;
      }
      req.codeAssistantPrincipal = {
        userId,
        source: tp?.source === "pat" ? "pat" : "bearer-jwt",
      };
      next();
    });
  };
}

// ---------------------------------------------------------------------------
// Request schema (zod)
// ---------------------------------------------------------------------------

const BodySchema = z.object({
  message: z.string().min(1).max(8000),
  model: z.string().max(50).optional(),
  mode: z.enum(["generate", "review", "modify"]).default("generate"),
  context: z
    .object({
      repositoryRid: z.string().max(200).optional(),
      branch: z.string().max(200).optional(),
      filePath: z.string().max(500).optional(),
      functionApiName: z.string().max(200).optional(),
      fileContent: z.string().max(20000).optional(),
    })
    .optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        // TRUNCATE (not reject) to match the engine's sanitize_history cap —
        // a code-heavy prior assistant answer routinely exceeds a tight cap,
        // and rejecting it would turn the next turn into a 400.
        content: z.string().transform((s) => s.slice(0, 8000)),
      }),
    )
    .max(50)
    .optional(),
  stream: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface CreateCodeAssistantRouterOptions {
  /** Outbound AI engine client. Defaults to the production singleton. */
  client?: AiEnginePort;
  /** Auth middleware. Defaults to requireCodeAssistantAuth(). */
  auth?: AuthMiddleware;
}

export function createCodeAssistantRouter(
  opts: CreateCodeAssistantRouterOptions = {},
): Router {
  const client: AiEnginePort = opts.client ?? aiEngineClient;
  const auth: AuthMiddleware = opts.auth ?? requireCodeAssistantAuth();
  const router = Router();
  router.use(auth);

  router.post("/typescript-v2", async (req, res, next) => {
    // Forward client cancellation to the engine so an aborted FE request also
    // aborts the (expensive) LLM call. NOTE: listen on `res` (response closed =
    // client disconnect OR response done), NOT `req` — Node emits `close` on the
    // request as soon as the body is read, which would abort the fetch immediately.
    const cancelCtl = new AbortController();
    const onClose = () => cancelCtl.abort();
    res.on("close", onClose);
    try {
      const parsed = BodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          `Invalid code-assistant request: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
          400,
          "AI_ENGINE_BAD_REQUEST",
        );
      }
      const principal = req.codeAssistantPrincipal;
      if (parsed.data.stream) {
        // Streaming: proxy the engine's SSE token stream straight to the FE.
        const upstream = await client.typescriptV2Stream(
          parsed.data as AiEnginePayload,
          principal?.userId,
          cancelCtl.signal,
        );
        if (!upstream.body)
          throw new AppError(
            "AI engine returned no stream",
            502,
            "AI_ENGINE_ERROR",
          );
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no");
        try {
          const reader = upstream.body.getReader();
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              res.write(value);
              // Flush any in-process buffering layer so each frame reaches the
              // socket immediately. No-op when compression is excluded for SSE
              // (server.ts createCompressionMiddleware skips text/event-stream —
              // res.flush is only attached when compression intercepts). This is
              // belt-and-suspenders: if compression were ever re-applied to SSE,
              // this flushes the gzip pipe instead of buffering to the end.
              const r = res as Response & { flush?: () => void };
              if (typeof r.flush === "function") r.flush();
            }
          }
        } catch {
          // FE cancelled or stream interrupted — end the response quietly.
        } finally {
          res.end();
        }
        return;
      }
      const result = await client.typescriptV2(
        parsed.data as AiEnginePayload,
        principal?.userId,
        cancelCtl.signal,
      );
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    } finally {
      res.off("close", onClose);
    }
  });

  // GET /models — proxy the engine's supported-models catalog (+ its default)
  // so the frontend picker is driven by the engine's registry, not a hardcoded
  // list. Same auth (router.use(auth) above) + AppError mapping as the
  // typescript-v2 route; this is a fast catalog read, so no SSE pipe and no
  // res.on("close") abort (the client's 5s timeout bounds it).
  router.get("/models", async (_req, res, next) => {
    try {
      const result = await client.getModels();
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createCodeAssistantRouter();
