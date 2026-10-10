import { constants as fsConstants, promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  requireBearerAuth
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod";

import { SERVER_VERSION } from "./constants.js";
import type { Runtime } from "./runtime.js";
import { buildServer } from "./server.js";
import { createStaticTokenVerifier, STATIC_SCOPES } from "./utils/auth.js";
import { UserFacingError } from "./utils/diagnostics.js";
import type { Logger } from "./utils/logger.js";
import { RateLimiter } from "./utils/rate-limit.js";

export interface HttpConfig {
  /** Bind address. Keep loopback unless a TLS terminator does not front this process. */
  host: string;
  /** Bind port; `0` asks the kernel for an ephemeral port (use `handle.port` afterwards). */
  port: number;
  /** Public HTTPS URL clients connect to, e.g. `https://mcp.example.com`. */
  publicUrl: string;
  /** Static bearer token. `undefined` only in explicit developer mode. */
  token?: string;
  legacy: "serve" | "reject";
  maxRequestBodyBytes: number;
  rateLimitPerMinute: number;
  /** Port-agnostic Host/Origin allowlist; the public hostname is always included. */
  allowedHostnames: string[];
}

export interface HttpHandle {
  /** The actually-bound port, which differs from the configured one when `port: 0`. */
  port: number;
  close: () => Promise<void>;
}

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

/**
 * Startup-time environment validation. Fails fast with actionable
 * `UserFacingError` diagnostics so a misconfigured container never serves
 * half-secured traffic. CLI overrides win over environment defaults.
 */
export function parseHttpEnvironment(
  env: NodeJS.ProcessEnv,
  overrides: { host?: string; port?: number; legacy: "serve" | "reject" }
): HttpConfig {
  const schema = z.object({
    MCP_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
    MCP_HTTP_PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    MCP_PUBLIC_URL: z.url("MCP_PUBLIC_URL must be an absolute URL such as https://mcp.example.com"),
    MCP_AUTH_TOKEN: z
      .string()
      .min(
        32,
        "MCP_AUTH_TOKEN must be at least 32 characters; generate one with `openssl rand -hex 32`."
      )
      .optional(),
    MCP_ALLOW_UNAUTHENTICATED: z
      .enum(["0", "1"])
      .default("0")
      .transform((value) => value === "1"),
    MCP_MAX_BODY_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .default(DEFAULT_MAX_BODY_BYTES),
    MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(DEFAULT_RATE_LIMIT_PER_MINUTE)
  });
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
    );
    throw new UserFacingError(
      {
        code: "HTTP_ENV_INVALID",
        problem: "The HTTP environment configuration is invalid.",
        detected: issues,
        fix: [
          "Correct the environment variables above and restart the server.",
          "MCP_PUBLIC_URL is required; MCP_AUTH_TOKEN is required unless MCP_ALLOW_UNAUTHENTICATED=1."
        ],
        helpAnchor: "diagnostic-reference"
      },
      2
    );
  }
  const environment = parsed.data;
  if (environment.MCP_AUTH_TOKEN === undefined && !environment.MCP_ALLOW_UNAUTHENTICATED) {
    throw new UserFacingError(
      {
        code: "HTTP_AUTH_TOKEN_MISSING",
        problem: "HTTP mode requires a static bearer token.",
        detected: "MCP_AUTH_TOKEN is not set.",
        fix: [
          "Set MCP_AUTH_TOKEN to a random secret of at least 32 characters (for example `openssl rand -hex 32`).",
          "For a local development server only, set MCP_ALLOW_UNAUTHENTICATED=1 to serve without authentication."
        ],
        helpAnchor: "diagnostic-reference"
      },
      2
    );
  }
  const publicHostname = new URL(environment.MCP_PUBLIC_URL).hostname;
  const allowedHostnames = [...new Set([publicHostname, "localhost", "127.0.0.1", "[::1]"])];
  return {
    host: overrides.host ?? environment.MCP_HTTP_HOST,
    port: overrides.port ?? environment.MCP_HTTP_PORT,
    publicUrl: environment.MCP_PUBLIC_URL,
    ...(environment.MCP_AUTH_TOKEN === undefined ? {} : { token: environment.MCP_AUTH_TOKEN }),
    legacy: overrides.legacy,
    maxRequestBodyBytes: environment.MCP_MAX_BODY_BYTES,
    rateLimitPerMinute: environment.MCP_RATE_LIMIT_PER_MINUTE,
    allowedHostnames
  };
}

/**
 * Serve the MCP protocol over Streamable HTTP.
 *
 * Security posture (applied in order inside the composed fetch):
 * 1. `/healthz` and `/readyz` answer unauthenticated for orchestrators.
 * 2. Host and Origin validation run BEFORE the MCP handler because
 *    `createMcpHandler` is deliberately validation-free (DNS-rebinding).
 * 3. Rate limiting keyed by a digest of the bearer token.
 * 4. Static bearer authentication, then the MCP handler itself.
 *
 * `Runtime` is captured from the closure and built once: the factory runs per
 * HTTP request to produce a fresh `McpServer`, and rebuilding `Runtime` there
 * would recreate `TransactionManager` and lose journal/lock state.
 */
export async function serveHttp(
  runtime: Runtime,
  logger: Logger,
  cfg: HttpConfig
): Promise<HttpHandle> {
  const mcp = createMcpHandler(() => buildServer(runtime), {
    legacy: cfg.legacy === "reject" ? "reject" : "stateless",
    responseMode: "auto",
    keepAliveMs: 15_000,
    onerror: (error) => logger.log("error", "http_error", { message: error.message })
  });
  const gate =
    cfg.token === undefined
      ? undefined
      : requireBearerAuth({
          verifier: createStaticTokenVerifier(cfg.token),
          requiredScopes: [...STATIC_SCOPES]
        });
  const limiter = cfg.rateLimitPerMinute > 0 ? new RateLimiter(cfg.rateLimitPerMinute) : undefined;

  const handler = {
    fetch: async (request: Request): Promise<Response> => {
      // Host/Origin validation runs first: createMcpHandler is deliberately
      // validation-free, and probes must not be reachable through a
      // DNS-rebound name either.
      const badHost = hostHeaderValidationResponse(request, cfg.allowedHostnames);
      if (badHost !== undefined) return badHost;
      const badOrigin = originValidationResponse(request, cfg.allowedHostnames);
      if (badOrigin !== undefined) return badOrigin;

      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/healthz") {
        return jsonResponse({ ok: true, version: SERVER_VERSION });
      }
      if (request.method === "GET" && pathname === "/readyz") {
        return await readinessResponse(runtime);
      }
      if (limiter !== undefined) {
        const verdict = limiter.check(request);
        if (!verdict.ok) {
          return jsonResponse(
            { error: "Too many requests.", retry_after_seconds: verdict.retryAfterSeconds },
            429,
            { "retry-after": String(verdict.retryAfterSeconds) }
          );
        }
      }
      if (gate === undefined) return mcp.fetch(request);
      const auth = await gate(request);
      if (auth instanceof Response) return auth;
      return mcp.fetch(request, { authInfo: auth });
    }
  };

  // exactOptionalPropertyTypes rejects IncomingMessage as the SDK's
  // duck-typed NodeIncomingMessageLike (its optional `method?: string`
  // cannot absorb Node's `string | undefined`). The adapter only reads
  // method/url/headers, so one localized cast documents the checked gap.
  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: cfg.maxRequestBodyBytes,
    onerror: (error) => logger.log("error", "http_adapter_error", { message: error.message })
  }) as unknown as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const server = createServer((req, res) => {
    void nodeHandler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : cfg.port;
  logger.log("info", "http_server_started", {
    host: cfg.host,
    port: boundPort,
    public_url: cfg.publicUrl,
    authenticated: gate !== undefined,
    vaults: runtime.registry.ids(),
    version: SERVER_VERSION
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await mcp.close();
    server.closeIdleConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  return { port: boundPort, close };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

/** Readiness truly probes each vault root for read and write access. */
async function readinessResponse(runtime: Runtime): Promise<Response> {
  const vaults: { vault: string; readable: boolean; writable: boolean }[] = [];
  for (const id of runtime.registry.ids()) {
    const root = runtime.forVault(id).vault.root;
    let readable = false;
    let writable = false;
    try {
      await fs.access(root, fsConstants.R_OK);
      readable = true;
    } catch {
      readable = false;
    }
    try {
      await fs.access(root, fsConstants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    vaults.push({ vault: id, readable, writable });
  }
  const ready = vaults.length > 0 && vaults.every((entry) => entry.readable && entry.writable);
  return jsonResponse({ ok: ready, vaults }, ready ? 200 : 503);
}
