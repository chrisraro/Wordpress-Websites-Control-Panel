import { describe, it, expect } from "vitest";
import { parseWpCliResult, parseJsonArray, runWpCli } from "@/lib/wpcli";
import { MockMcpClient } from "@/lib/mcp/mock";
import { McpToolError } from "@/lib/mcp/errors";

describe("parseWpCliResult", () => {
  it("passes through plain strings", () => {
    expect(parseWpCliResult("6.7.1\n")).toBe("6.7.1");
  });
  it("extracts stdout from object results", () => {
    expect(parseWpCliResult({ stdout: "ok\n", stderr: "", exit_code: 0 })).toBe("ok");
    expect(parseWpCliResult({ output: "ok" })).toBe("ok");
  });
  it("throws McpToolError on nonzero exit code with stderr detail", () => {
    expect(() => parseWpCliResult({ stdout: "", stderr: "Error: boom", exit_code: 1 }))
      .toThrow(McpToolError);
  });
});

describe("parseJsonArray", () => {
  it("parses a clean JSON array", () => {
    expect(parseJsonArray<{ a: number }>('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  it("strips CLI noise around the array", () => {
    expect(parseJsonArray('Warning: foo\n[{"name":"x"}]\n')).toEqual([{ name: "x" }]);
  });
  it("returns [] for Success-style non-JSON output", () => {
    expect(parseJsonArray("Success: WordPress is at the latest version.")).toEqual([]);
  });
  it("throws on garbage", () => {
    expect(() => parseJsonArray("<html>fatal error</html>")).toThrow();
  });
});

describe("runWpCli", () => {
  it("invokes novamira/run-wp-cli with an args array and returns parsed stdout", async () => {
    const mock = new MockMcpClient({
      handler: (name, args) => {
        expect(name).toBe("novamira/run-wp-cli");
        expect((args as { args: string[] }).args).toEqual(["core", "version"]);
        return { stdout: `ran:${(args as { args: string[] }).args.join(" ")}`, exit_code: 0 };
      },
    });
    expect(await runWpCli(mock, ["core", "version"])).toBe("ran:core version");
    expect(mock.calls[0]).toMatchObject({ name: "novamira/run-wp-cli", args: { args: ["core", "version"] } });
  });
});
