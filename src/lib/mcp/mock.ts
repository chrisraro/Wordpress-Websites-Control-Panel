import type { DiscoveredAbilities, DiscoveredAbility, SiteMcpClient } from "./client";

export class MockMcpClient implements SiteMcpClient {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  closed = false;

  constructor(
    private config: {
      abilities?: DiscoveredAbility[];
      failWith?: Error;
      results?: Record<string, unknown>;
      handler?: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>;
    } = {},
  ) {}

  private failIfConfigured() {
    if (this.config.failWith) throw this.config.failWith;
  }

  async listToolNames(): Promise<string[]> {
    this.failIfConfigured();
    return ["mcp-adapter-discover-abilities", "mcp-adapter-execute-ability"];
  }

  async discoverAbilities(): Promise<DiscoveredAbilities> {
    this.failIfConfigured();
    return { abilities: this.config.abilities ?? [], instructions: undefined };
  }

  async executeAbility(name: string, args: Record<string, unknown> = {}, callOpts?: { timeoutMs?: number }): Promise<unknown> {
    this.failIfConfigured();
    this.calls.push({ name, args });
    if (this.config.handler) return this.config.handler(name, args);
    return this.config.results?.[name] ?? null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
