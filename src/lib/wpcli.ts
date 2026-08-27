import type { SiteMcpClient } from "@/lib/mcp/client";
import { McpToolError } from "@/lib/mcp/errors";

export function parseWpCliResult(result: unknown): string {
  if (typeof result === "string") return result.trim();
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const exit = typeof r.exit_code === "number" ? r.exit_code
      : typeof r.code === "number" ? r.code : 0;
    const stdout = typeof r.stdout === "string" ? r.stdout
      : typeof r.output === "string" ? r.output : "";
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    if (exit !== 0) {
      throw new McpToolError(`WP-CLI exited with code ${exit}: ${stderr || stdout || "no output"}`);
    }
    return stdout.trim();
  }
  return String(result ?? "").trim();
}

export function parseJsonArray<T>(text: string): T[] {
  const trimmed = text.trim();
  if (/^success:/i.test(trimmed)) return [];
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Expected a JSON array in WP-CLI output, got: ${trimmed.slice(0, 120)}`);
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as T[];
}

export async function runWpCli(
  client: SiteMcpClient, command: string, timeoutMs = 60_000,
): Promise<string> {
  const result = await client.executeAbility("novamira/run-wp-cli", { command }, { timeoutMs });
  return parseWpCliResult(result);
}
