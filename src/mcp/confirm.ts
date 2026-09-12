import { z } from "./schema";
import { can } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";
import { PERMISSION_KIND, type TokenAuth } from "@/lib/authz/token";

/**
 * Appended to every tool description. An LLM that cannot tell a client's
 * staging site from their production one is the most expensive mistake this
 * server can make, so the warning is not left to per-tool prose.
 */
export const ENVIRONMENT_NOTE =
  "Every site carries an environment, either production or staging. " +
  "Results always include it. Never assume, and never act on production " +
  "when the user meant staging.";

const REASON_MIN = 10;
const REASON_MAX = 500;

/** Spread into a destructive tool's inputSchema. */
export const CONFIRM_SHAPE = {
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Must be true to actually perform this action. When false or omitted, " +
      "returns a preview of what would happen and changes nothing.",
    ),
  reason: z
    .string()
    .min(REASON_MIN)
    .max(REASON_MAX)
    .optional()
    .describe(
      `Why this action is being taken, ${REASON_MIN}-${REASON_MAX} characters. ` +
      "Required when confirm is true. Recorded in the audit log.",
    ),
};

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function preview(summary: string, details: unknown): ToolResult {
  return {
    content: [{
      type: "text",
      text:
        `DRY RUN — nothing has been changed.\n\n${summary}\n\n` +
        `${JSON.stringify(details, null, 2)}\n\n` +
        "To perform this, call again with confirm: true and a reason.",
    }],
  };
}

const SECRETISH = /password|secret|token|key/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === "[object Object]";
}

function redactValue(v: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(v)) {
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    const out = v.map((item) => redactValue(item, seen));
    seen.delete(v);
    return out;
  }
  if (isPlainObject(v)) {
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    const out = redactObject(v, seen);
    seen.delete(v);
    return out;
  }
  return v;
}

function redactObject(
  obj: Record<string, unknown>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRETISH.test(k) ? "[redacted]" : redactValue(v, seen);
  }
  return out;
}

/**
 * Redacts anything that looks like a credential before it reaches a
 * permanent record (the activity log). Recurses into plain objects and
 * arrays: a key matching the pattern is redacted wholesale -- including when
 * its value is itself an object -- without descending further into it.
 * Scalars pass through unchanged. isPlainObject excludes built-ins that
 * carry their own internal tag -- Date, Map, Set, RegExp, Function, Error --
 * so those are left alone rather than walked. A plain `class Foo {}`
 * instance is indistinguishable from an object literal by that check and
 * *will* be walked via Object.entries; this is harmless because MCP tool
 * arguments arrive as JSON and so can never actually contain a class
 * instance. A WeakSet holding the chain of containers currently being
 * walked (added before recursing, removed after) guards against a cyclic
 * object hanging this function, while letting the same object appear more
 * than once outside of a cycle -- e.g. as two sibling values -- without
 * being mistaken for one.
 */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return redactObject(args, new WeakSet());
}

/**
 * A missing permission NAMES the permission: the fix is to be granted it, and
 * the user cannot work that out from a generic refusal.
 *
 * Read-only aware. `applyReadOnly` strips every write permission from a
 * read-only token's viewer, so on such a token `can()` is false for every
 * write permission the user actually holds. Naming the permission there
 * would send the user to ask for something they already have; the real fix
 * is to mint a writable token, and that is the refusal returned instead.
 * The permission refusal is kept for a read permission (which read-only
 * never strips) and for a writable token that genuinely lacks the grant.
 */
export function requirePermission(auth: TokenAuth, p: AppPermission): ToolResult | null {
  if (can(auth.viewer, p)) return null;
  if (auth.readOnly && PERMISSION_KIND[p] === "write") return requireWritableToken(auth);
  return fail(`You do not hold the ${p} permission, which this action requires.`);
}

export function requireWritableToken(auth: TokenAuth): ToolResult | null {
  if (!auth.readOnly) return null;
  return fail(
    "This API token is read-only, so it cannot perform write actions. " +
    "Mint a token without the read-only flag to do this.",
  );
}

export type ConfirmGate =
  | { proceed: true; reason: string }
  | { proceed: false; result: ToolResult };

/**
 * The single decision point for every destructive tool.
 *
 * Order matters: a caller who did not ask to change anything gets a preview
 * before the token is checked, because previewing changes nothing. Note that
 * a read-only token never reaches this function on a destructive tool --
 * every one of them runs `requirePermission` on a write permission first,
 * and `applyReadOnly` has stripped that permission, so the token is refused
 * there (with the read-only-token message) and cannot preview. The ordering
 * here still matters for a tool gated on a writable token alone, with no
 * write permission in front of it. The read-only refusal names the token
 * rather than a permission -- the two have different fixes, and conflating
 * them sends the user to the wrong place.
 */
export function gateConfirm(
  auth: TokenAuth,
  args: { confirm?: boolean; reason?: string },
  previewSummary: string,
  previewDetails: unknown,
): ConfirmGate {
  if (!args.confirm) {
    return { proceed: false, result: preview(previewSummary, previewDetails) };
  }
  const tokenDenied = requireWritableToken(auth);
  if (tokenDenied) return { proceed: false, result: tokenDenied };

  const reason = (args.reason ?? "").trim();
  if (reason.length < REASON_MIN) {
    return {
      proceed: false,
      result: fail(
        "A reason is required when confirm is true, and must be at least " +
        `${REASON_MIN} characters. It is recorded in the audit log.`,
      ),
    };
  }
  if (reason.length > REASON_MAX) {
    return { proceed: false, result: fail(`The reason must be at most ${REASON_MAX} characters.`) };
  }
  return { proceed: true, reason };
}
