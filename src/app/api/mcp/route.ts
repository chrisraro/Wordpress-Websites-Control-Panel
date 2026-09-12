import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseTokensRepo } from "@/services/tokens/repo";
import { authenticateToken } from "@/lib/authz/token";
import { buildToolCtx } from "@/mcp/context";
import { buildServer } from "@/mcp/server";
import { MCP_SERVER_NAME } from "@/mcp/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  let auth;
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
