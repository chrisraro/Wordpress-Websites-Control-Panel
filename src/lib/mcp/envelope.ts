import { McpToolError } from "./errors";

const LOG_PREVIEW_CHARS = 500;

/**
 * Recursively strips any `admin_users` key from a plain object/array tree
 * before it is ever stringified. `INVENTORY_PHP` (src/services/inventory/
 * service.ts) emits `admin_users` *last* in its JSON object, and on a
 * stripped install (zero plugins, one theme) the first administrator's
 * `user_login` and `user_email` land within LOG_PREVIEW_CHARS of the start
 * -- inside the truncation window, not past it. This handles the
 * object-shaped paths into truncateForLog: unwrapAbility's `r.error ?? result`
 * fallback below when that value is not a string, and wpphp.ts's "returned
 * an unexpected result" branch, which logs the raw (still unparsed) envelope.
 * wpphp.ts's other two branches ("reported failure", invalid-JSON) always
 * pass a string -- see redactAdminUsersInString below for why those need a
 * different tool.
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
 * Same protection as redactAdminUsers above, but for a string that has
 * already failed JSON.parse -- wpphp.ts's invalid-JSON branch passes
 * env.return_value, which line 50 there has already narrowed to a string,
 * so it can never reach the object-shaped redactor above. That branch fires
 * exactly when the payload is *not* valid JSON, so there is no parse tree to
 * redact structurally: a scan for the `"admin_users"` key is the honest tool
 * here, not a JSON.parse-then-redact round trip that would just throw again.
 *
 * This finds the key and removes it together with its value up to the
 * matching closing bracket, tracking string literals so a stray `]`/`}`
 * inside a logged-in admin's email does not end the scan early. Best-effort
 * on malformed input -- which is the only kind of input this function ever
 * sees: if a value is truncated before its closing bracket (the payload was
 * cut off mid-admin_users, since INVENTORY_PHP emits that key last), the key
 * and everything after it is dropped rather than left half-redacted.
 */
function redactAdminUsersInString(value: string): string {
  const KEY_RE = /"admin_users"\s*:\s*/g;
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = KEY_RE.exec(value))) {
    result += value.slice(cursor, match.index);
    result += '"admin_users":"[redacted]"';
    const valueStart = KEY_RE.lastIndex;
    const opener = value[valueStart];
    if (opener !== "[" && opener !== "{") {
      // Scalar (string/number/null/malformed) value: drop up to the next
      // top-level comma or closing bracket, whichever comes first.
      const scalarEnd = value.slice(valueStart).search(/[,}\]]/);
      cursor = scalarEnd === -1 ? value.length : valueStart + scalarEnd;
    } else {
      const closer = opener === "[" ? "]" : "}";
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = value.length; // unbalanced: drop through to end of string
      for (let i = valueStart; i < value.length; i++) {
        const ch = value[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === opener) depth++;
        else if (ch === closer) {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }
      cursor = end;
    }
    KEY_RE.lastIndex = cursor;
  }
  result += value.slice(cursor);
  return result;
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
  const redacted = typeof value === "string" ? redactAdminUsersInString(value) : redactAdminUsers(value);
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
