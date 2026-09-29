import { z } from "./schema";
import { can } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";
import { PERMISSION_KIND, type TokenAuth } from "@/lib/authz/token";
import { createHmac, timingSafeEqual } from "node:crypto";

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
  confirm_code: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Required when confirm is true. Returned by the dry run (the same call " +
      "without confirm); valid for 10 minutes, for this token and these exact " +
      "arguments only. Show the dry-run preview to the user before confirming.",
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

export function preview(summary: string, details: unknown, confirmCode?: string): ToolResult {
  const how = confirmCode
    ? "To perform this, show this preview to the user, then call again with the " +
      `same arguments plus confirm: true, a reason, and confirm_code: "${confirmCode}" ` +
      "(valid for 10 minutes, for exactly this action)."
    : "To perform this, call again with confirm: true and a reason.";
  return {
    content: [{
      type: "text",
      text:
        `DRY RUN — nothing has been changed.\n\n${summary}\n\n` +
        `${JSON.stringify(details, null, 2)}\n\n${how}`,
    }],
  };
}

// ---------------------------------------------------------------------------
// Confirm codes
// ---------------------------------------------------------------------------

/** How long a dry run's confirm code stays valid. */
export const CONFIRM_CODE_TTL_MS = 10 * 60_000;

/** Arguments that steer the gate itself rather than the action. */
const GATE_KEYS = new Set(["confirm", "reason", "confirm_code"]);

/** JSON with object keys sorted at every level, so key order cannot matter. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isPlainObject(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function actionArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([k]) => !GATE_KEYS.has(k)));
}

/**
 * Key for confirm-code MACs, derived from APP_ENCRYPTION_KEY with a fixed
 * label so it is never the encryption key itself. No new secret to manage.
 */
function confirmKey(): Buffer {
  const base = process.env.APP_ENCRYPTION_KEY;
  if (!base) throw new Error("Missing required env var: APP_ENCRYPTION_KEY");
  return createHmac("sha256", Buffer.from(base, "base64")).update("mcp-confirm-code/v1").digest();
}

function confirmMac(auth: TokenAuth, tool: string, args: Record<string, unknown>, exp: number): string {
  const siteId = typeof args.site_id === "string" ? args.site_id : "";
  const payload = ["v1", auth.tokenId, auth.viewer.id, tool, siteId, canonical(actionArgs(args)), String(exp)]
    .join("\n");
  return createHmac("sha256", confirmKey()).update(payload).digest().subarray(0, 18).toString("base64url");
}

/**
 * A code the dry run hands out and the real call must echo back:
 * `<expiry unix seconds>.<mac>`, the MAC binding (token, user, tool, site,
 * canonical arguments, expiry). Stateless on purpose -- nothing to store or
 * clean up. Within its ten minutes the same code authorizes the identical
 * action again, which for these idempotent-by-target actions (delete X,
 * update Y) is harmless; any change of target or arguments needs a new
 * dry run.
 */
export function mintConfirmCode(
  auth: TokenAuth, tool: string, args: Record<string, unknown>, now: number = Date.now(),
): string {
  const exp = Math.floor((now + CONFIRM_CODE_TTL_MS) / 1000);
  return `${exp}.${confirmMac(auth, tool, args, exp)}`;
}

function verifyConfirmCode(
  auth: TokenAuth, tool: string, args: Record<string, unknown>, code: string, now: number,
): boolean {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{1,64})$/.exec(code.trim());
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isSafeInteger(exp) || exp * 1000 < now) return false;
  // Codes are never minted further out than the TTL; a later expiry is forged.
  if (exp * 1000 > now + CONFIRM_CODE_TTL_MS + 60_000) return false;
  const expected = Buffer.from(confirmMac(auth, tool, args, exp));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && timingSafeEqual(expected, given);
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
 *
 * The preview carries a confirm code (mintConfirmCode) bound to `tool` and
 * the action's arguments; a confirmed call proceeds only with a valid,
 * unexpired code for exactly that call, after the reason checks.
 */
export function gateConfirm(
  auth: TokenAuth,
  tool: string,
  args: { confirm?: boolean; reason?: string; confirm_code?: string } & Record<string, unknown>,
  previewSummary: string,
  previewDetails: unknown,
  now: number = Date.now(),
): ConfirmGate {
  if (!args.confirm) {
    const code = mintConfirmCode(auth, tool, args, now);
    return { proceed: false, result: preview(previewSummary, previewDetails, code) };
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
  // The code is what a model steered by site-controlled text cannot supply
  // in a single step: only the dry run for this exact action produces it.
  if (!args.confirm_code) {
    return {
      proceed: false,
      result: fail(
        "A confirm_code is required when confirm is true. Call this tool without " +
        "confirm first to see the preview; it returns the code to pass back.",
      ),
    };
  }
  if (!verifyConfirmCode(auth, tool, args, args.confirm_code, now)) {
    return {
      proceed: false,
      result: fail(
        "The confirm_code does not match this action or has expired. Codes are tied " +
        "to this token and these exact arguments, for 10 minutes. Run the dry run again.",
      ),
    };
  }
  return { proceed: true, reason };
}
