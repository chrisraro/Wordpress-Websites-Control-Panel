export class McpError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

export class McpConnectionError extends McpError {}
export class McpAuthError extends McpError {}

export class McpAbilityMissingError extends McpError {
  constructor(public ability: string) {
    super(`Site does not support ability: ${ability}`);
  }
}

export class McpToolError extends McpError {}

export function mapConnectError(e: unknown): McpError {
  if (e instanceof McpError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/\b(401|403)\b|unauthorized|forbidden/i.test(msg)) return new McpAuthError(msg, e);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|certificate|aborted|timeout/i.test(msg)) {
    return new McpConnectionError(msg, e);
  }
  return new McpError(msg, e);
}
