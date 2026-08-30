// Constructors below assign fields in the body rather than via TypeScript
// parameter-property shorthand (`constructor(public x: T)`): parameter
// properties require a real transform, not mere type erasure, so they are
// rejected under `--experimental-strip-types` (and TypeScript's own
// `erasableSyntaxOnly`). scripts/import-novamira-sites.ts imports this
// module transitively via src/services/sites/service.ts and runs under
// `node --experimental-strip-types`, so this file must stay erasable.
export class McpError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
    this.name = new.target.name;
  }
}

export class McpConnectionError extends McpError {}
export class McpAuthError extends McpError {}

export class McpAbilityMissingError extends McpError {
  ability: string;
  constructor(ability: string) {
    super(`Site does not support ability: ${ability}`);
    this.ability = ability;
  }
}

export class McpToolError extends McpError {}

export function mapConnectError(e: unknown): McpError {
  if (e instanceof McpError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/\b(401|403)\b|unauthorized|forbidden/i.test(msg)) return new McpAuthError(msg, e);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|certificate|aborted|timed out|timeout/i.test(msg)) {
    return new McpConnectionError(msg, e);
  }
  return new McpError(msg, e);
}

/**
 * Turns a raw transport failure into something a person can act on.
 *
 * The motivating case: when Cloudflare challenges a request, the MCP
 * transport surfaces the entire interstitial page as the error message --
 * doctype, minified challenge JavaScript and all. Rendered into a card that
 * showed the error verbatim, that filled the panel with several kilobytes of
 * red minified JS and buried the one fact that mattered, which is that the
 * request never reached WordPress.
 *
 * Bounded unconditionally, not just for the cases named here. Any message
 * that reaches a user should be a sentence; the full text stays in the server
 * log for diagnosis, which is where a stack of minified JS belongs.
 */
export function friendlySiteError(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? "");

  // Cloudflare's managed challenge / "Just a moment..." interstitial.
  if (/just a moment|cf_chl_opt|cf-browser-verification|__cf_chl/i.test(msg)) {
    return (
      "Cloudflare is challenging this request, so it never reached WordPress. " +
      "This affects requests from the deployed app rather than the site itself — " +
      "see docs/ops/cloudflare.md for the WAF rule that fixes it."
    );
  }
  if (/\b(401|403)\b|unauthorized|forbidden|rest_forbidden/i.test(msg)) {
    return "WordPress refused the credentials for this site. Reconnect it to update the application password.";
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out|timeout|fetch failed/i.test(msg)) {
    return "Could not reach this site. If a direct connection is configured, the origin address may be stale or the host may be refusing connections from this app; otherwise the site may be down.";
  }
  if (/<!doctype html|<html/i.test(msg)) {
    // Some other HTML page where JSON was expected — a host error page, a
    // maintenance splash, a login wall.
    return "The site returned a web page instead of a response, so the request did not reach WordPress.";
  }

  const oneLine = msg.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine || "Something went wrong.";
}
