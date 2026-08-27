import { McpToolError } from "./errors";

/**
 * The Novamira mcp-adapter wraps every ability result as {success, data} on
 * success or {success:false, error} on failure. Unwrap to the ability's own
 * payload; pass through results that are not wrapped.
 */
export function unwrapAbility(result: unknown): unknown {
  if (result && typeof result === "object" && "success" in result) {
    const r = result as { success: unknown; data?: unknown; error?: unknown };
    if (r.success === true && "data" in r) return r.data;
    if (r.success === false) {
      throw new McpToolError(
        typeof r.error === "string" ? r.error : `Ability failed: ${JSON.stringify(r.error ?? result)}`,
      );
    }
  }
  return result;
}
