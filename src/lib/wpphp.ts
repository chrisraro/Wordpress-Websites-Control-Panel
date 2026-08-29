import type { SiteMcpClient } from "@/lib/mcp/client";
import { truncateForLog, unwrapAbility } from "@/lib/mcp/envelope";
import { McpToolError } from "@/lib/mcp/errors";

/**
 * Embed an untrusted string into generated PHP without any injection surface:
 * the value travels as base64 and is decoded at runtime.
 */
export function phpString(value: string): string {
  return `base64_decode('${Buffer.from(value, "utf8").toString("base64")}')`;
}

interface ExecutePhpResult {
  success?: boolean;
  return_value?: unknown;
  output?: string;
  errors?: unknown[];
}

/**
 * Run a PHP snippet inside WordPress via novamira/execute-php. The snippet
 * must `return json_encode(...)`; the decoded value is returned.
 */
export async function runPhp<T = unknown>(
  client: SiteMcpClient, code: string, timeoutMs = 60_000,
): Promise<T> {
  const raw = await client.executeAbility("novamira/execute-php", { code }, { timeoutMs });
  const env = unwrapAbility(raw) as ExecutePhpResult | null;
  if (!env || typeof env !== "object") {
    // The raw envelope can carry admin_users and other site-sensitive data
    // (see collectInventory). Keep a bounded prefix in the server log for
    // diagnosis -- truncateForLog, not the complete envelope; see its own
    // comment for why -- but never let any of it reach a thrown message:
    // manage-actions.ts returns e.message verbatim to the caller, and a
    // client holding a `manage` grant can reach this path via
    // refreshInventoryAction.
    console.error("execute-php returned an unexpected result", truncateForLog(raw));
    throw new McpToolError("execute-php returned an unexpected result");
  }
  if (env.success === false) {
    const detail = env.errors?.length ? JSON.stringify(env.errors) : env.output || "unknown error";
    // Same rule as the envelope check above: detail can carry server-side
    // output, including filesystem paths (checksums.ts and hardening.ts put
    // them early in their JSON), and manage-actions.ts returns thrown
    // messages verbatim to any client holding a `manage` grant. Bounded via
    // truncateForLog for the same reason as above.
    console.error("execute-php reported failure", truncateForLog(detail));
    throw new McpToolError("PHP execution failed");
  }
  if (typeof env.return_value !== "string") {
    throw new McpToolError("PHP snippet did not return a JSON string");
  }
  try {
    return JSON.parse(env.return_value) as T;
  } catch {
    // Same rule again: env.return_value is the PHP snippet's raw output and
    // may itself contain site-sensitive data (for INVENTORY_PHP, every
    // WordPress administrator's login and email). Bounded via truncateForLog.
    console.error("execute-php returned invalid JSON", truncateForLog(env.return_value));
    throw new McpToolError("PHP snippet returned invalid JSON");
  }
}
