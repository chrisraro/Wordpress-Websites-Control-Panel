import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseTokensRepo } from "@/services/tokens/repo";
import { authenticateToken, type TokenAuth } from "@/lib/authz/token";
import { buildToolCtx } from "@/mcp/context";
import { buildServer } from "@/mcp/server";
import { MCP_SERVER_NAME } from "@/mcp/schema";

export const dynamic = "force-dynamic";
// Manage tools registered on this route carry their own timeouts --
// ACTION_TIMEOUT_MS (180_000) and HEAVY_TIMEOUT_MS (270_000) in
// src/services/manage/service.ts, and INSTALL_TIMEOUT_MS (300_000) in
// src/services/marketplace/install.ts -- so the function's own ceiling must
// exceed the largest of them or the platform kills the request with a 504
// before a tool's own abort ever fires. 300 matches src/app/api/cron/process
// /route.ts, which needs the same headroom, and is honoured on Vercel Pro.
export const maxDuration = 300;

const CHALLENGE = { "WWW-Authenticate": `Bearer realm="${MCP_SERVER_NAME}"` };

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: a valid API token is required." },
      id: null,
    }),
    { status: 401, headers: { "content-type": "application/json", ...CHALLENGE } },
  );
}

/**
 * A thrown error here means the token repo/database failed, not that the
 * token was bad -- supabaseTokensRepo.findByHash throws on a Postgres error,
 * and authenticateToken does not catch it. That distinction matters: a 401
 * would send an operator chasing a bad-token theory when the real problem is
 * an outage, and a 200 is obviously worse. The real error is logged
 * server-side only; the response body carries no message, stack, or other
 * internal detail that could leak to a caller.
 */
function internalError(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error." },
      id: null,
    }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}

function bearer(req: Request): string | null {
  const raw = req.headers.get("authorization");
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

export async function POST(req: Request): Promise<Response> {
  const secret = bearer(req);
  if (!secret) return unauthorized();

  const repo = supabaseTokensRepo(createServiceSupabase());
  let auth: TokenAuth | null;
  try {
    auth = await authenticateToken(secret, repo);
  } catch (e) {
    console.error("[mcp] authenticateToken failed:", e);
    return internalError();
  }
  // Every failure mode -- unknown, revoked, expired, no role -- is one 401.
  // Distinguishing them would tell a caller whether a secret was ever real.
  if (!auth) return unauthorized();

  const server = buildServer(buildToolCtx(auth));
  // Stateless is required, not preferred: consecutive requests may land on
  // different Vercel instances and there is no shared session store, so every
  // request must carry its own auth and be complete in itself. Passing
  // sessionIdGenerator: undefined is what selects that mode.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Without this, a POST takes the SDK's SSE-streaming branch: handleRequest
    // dispatches the message to the server without awaiting it and returns a
    // Response whose body is a ReadableStream that the SDK fills in later via
    // send(). The `finally` below runs the instant handleRequest resolves --
    // before any tool has produced a result -- and close() shuts every stream
    // controller, so every response body comes back empty. enableJsonResponse
    // makes handleRequest's promise resolve only once the JSON-RPC response is
    // fully ready, so closing the transport in `finally` is safe. Do not
    // remove this to "enable streaming" -- see Fix 1 in
    // .superpowers/sdd/task-7-report.md for the runtime probe that proved it.
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await transport.close();
    await server.close();
  }
}

const NOT_ALLOWED = { status: 405, headers: { allow: "POST" } };

/** Stateless mode has no server-initiated stream to open. */
export async function GET(): Promise<Response> {
  return new Response("Method Not Allowed", NOT_ALLOWED);
}

/** Stateless mode has no session to end. */
export async function DELETE(): Promise<Response> {
  return new Response("Method Not Allowed", NOT_ALLOWED);
}
