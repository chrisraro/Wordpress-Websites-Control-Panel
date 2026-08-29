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
      if (typeof r.error === "string") {
        // Ability-authored message (e.g. "plugin not found"): bounded, useful,
        // and not derived from response payload data. Safe to surface as-is.
        throw new McpToolError(r.error);
      }
      // Unbounded fallback: r.error/result here is the raw envelope, which for
      // callers like runPhp (src/lib/wpphp.ts) can carry admin_users and other
      // site-sensitive data (see collectInventory). manage-actions.ts returns
      // thrown messages verbatim to any client holding a `manage` grant, so
      // never let this fallback embed response content in the thrown message
      // -- log it server-side instead.
      console.error("ability reported failure with a non-string error", r.error ?? result);
      throw new McpToolError("Ability failed");
    }
  }
  return result;
}
