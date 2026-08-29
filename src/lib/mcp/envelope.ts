import { McpToolError } from "./errors";

const LOG_PREVIEW_CHARS = 500;

/**
 * Recursively strips any `admin_users` key from a plain object/array tree
 * before it is ever stringified. `INVENTORY_PHP` (src/services/inventory/
 * service.ts) emits `admin_users` *last* in its JSON object, and on a
 * stripped install (zero plugins, one theme) the first administrator's
 * `user_login` and `user_email` land within LOG_PREVIEW_CHARS of the start
 * -- inside the truncation window, not past it. The path that reaches
 * truncateForLog with that raw payload is wpphp.ts's invalid-JSON branch,
 * which fires exactly when someone is debugging a malformed response and
 * most needs the log line not to leak the thing it's supposed to protect.
 * Redacting the key is the primary protection; the length bound below is a
 * second, independent one, not a substitute for this.
 */
function redactAdminUsers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAdminUsers);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) =>
        k === "admin_users" ? [k, "[redacted]"] : [k, redactAdminUsers(v)],
      ),
    );
  }
  return value;
}

/**
 * Bounds what an untrusted MCP envelope contributes to a server log line.
 * These envelopes can carry site-sensitive data -- admin_users logins and
 * emails (see collectInventory), filesystem paths (checksums.ts,
 * hardening.ts) -- the same category of data 0011/0013 moved into an
 * RLS-gated table specifically to narrow who can read it. Logs here are
 * staff-only and this never crosses that trust boundary, but there is no
 * reason for a diagnostic log line to hold a complete, unbounded copy of
 * exactly the data those migrations exist to gate. `admin_users` is
 * redacted outright (see redactAdminUsers above) rather than relied on to
 * fall past the length bound below -- the bound alone is not reliably
 * below where admin_users lands, and is kept only as a second, independent
 * cap on total line length.
 */
export function truncateForLog(value: unknown): string {
  const redacted = typeof value === "string" ? value : redactAdminUsers(value);
  // JSON.stringify(undefined) returns `undefined` (not a string), which
  // would otherwise make `.length` below throw -- turning a clean
  // McpToolError into an unrelated TypeError that manage-actions.ts would
  // then return verbatim to the caller.
  const str = typeof redacted === "string" ? redacted : (JSON.stringify(redacted) ?? String(redacted));
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
