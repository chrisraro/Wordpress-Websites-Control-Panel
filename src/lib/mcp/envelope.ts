import { McpToolError } from "./errors";

const LOG_PREVIEW_CHARS = 500;

/**
 * Bounds what an untrusted MCP envelope contributes to a server log line.
 * These envelopes can carry site-sensitive data -- admin_users logins and
 * emails (see collectInventory), filesystem paths (checksums.ts,
 * hardening.ts) -- the same category of data 0011/0013 moved into an
 * RLS-gated table specifically to narrow who can read it. Logs here are
 * staff-only and this never crosses that trust boundary, but there is no
 * reason for a diagnostic log line to hold a complete, unbounded copy of
 * exactly the data those migrations exist to gate. A bounded prefix is
 * enough to diagnose a failure; it is deliberately not the full payload.
 */
export function truncateForLog(value: unknown): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return str.length > LOG_PREVIEW_CHARS ? `${str.slice(0, LOG_PREVIEW_CHARS)}…(truncated)` : str;
}

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
      console.error("ability reported failure with a non-string error", truncateForLog(r.error ?? result));
      throw new McpToolError("Ability failed");
    }
  }
  return result;
}
