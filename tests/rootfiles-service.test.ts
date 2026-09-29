import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  creds: null as unknown,
  connectError: null as Error | null,
  phpResult: { ok: true } as unknown,
  phpError: null as Error | null,
  phpCalls: [] as string[],
  closed: 0,
  connected: 0,
}));

vi.mock("@/lib/mcp/connect", () => ({
  connectToSite: async () => {
    if (state.connectError) throw state.connectError;
    state.connected += 1;
    return { close: async () => { state.closed += 1; } };
  },
}));
vi.mock("@/lib/wpphp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/wpphp")>()),
  runPhp: async (_c: unknown, code: string) => {
    state.phpCalls.push(code);
    if (state.phpError) throw state.phpError;
    return state.phpResult;
  },
}));

import {
  listRootFiles, putRootFile, deleteRootFile, readRootFile, type RootFilesDeps,
} from "@/services/rootfiles/service";
import { MAX_ROOT_FILE_BYTES } from "@/services/rootfiles/types";

const deps: RootFilesDeps = {
  repo: { getSiteCredentials: async () => state.creds } as unknown as RootFilesDeps["repo"],
  mcp: (async () => { throw new Error("unused"); }) as unknown as RootFilesDeps["mcp"],
};
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

beforeEach(() => {
  Object.assign(state, {
    creds: { mcp_endpoint: "x" }, connectError: null, phpResult: { ok: true },
    phpError: null, phpCalls: [], closed: 0, connected: 0,
  });
});

describe("putRootFile — guards before any network call", () => {
  it.each([
    "../wp-config.php", "shell.php", "shell.php.html", ".htaccess", "a/b.html", "readme.html", "",
  ])("rejects the name %j without connecting", async (name) => {
    await expect(putRootFile(deps, "s1", name, Buffer.from("x"))).rejects.toThrow();
    expect(state.connected).toBe(0);
    expect(state.phpCalls).toEqual([]);
  });

  it("rejects an empty file", async () => {
    await expect(putRootFile(deps, "s1", "google1.html", Buffer.alloc(0))).rejects.toThrow("empty");
    expect(state.connected).toBe(0);
  });

  it("rejects a file over the size limit and names the limit in KB", async () => {
    const big = Buffer.alloc(MAX_ROOT_FILE_BYTES + 1, "a");
    await expect(putRootFile(deps, "s1", "google1.html", big)).rejects.toThrow(/limit is 64 KB/);
    expect(state.connected).toBe(0);
  });

  it("accepts a file of exactly the limit", async () => {
    state.phpResult = { ok: true, url: "u", bytes: MAX_ROOT_FILE_BYTES, sha256: "h", replaced: false };
    const res = await putRootFile(deps, "s1", "google1.html", Buffer.alloc(MAX_ROOT_FILE_BYTES, "a"));
    expect(res.bytes).toBe(MAX_ROOT_FILE_BYTES);
  });

  it("throws 'Site not found' when the site has no credentials, without opening a connection", async () => {
    state.creds = null;
    await expect(putRootFile(deps, "s1", "google1.html", Buffer.from("x"))).rejects.toThrow("Site not found");
    expect(state.connected).toBe(0);
  });
});

describe("putRootFile — PHP payload and result", () => {
  it("returns url, bytes, sha256 and replaced from the read-back", async () => {
    state.phpResult = { ok: true, url: "https://a.test/google1.html", bytes: 3, sha256: "abc", replaced: true };
    const res = await putRootFile(deps, "s1", "google1.html", Buffer.from("hey"));
    expect(res).toEqual({ url: "https://a.test/google1.html", bytes: 3, sha256: "abc", replaced: true });
  });

  it("embeds the name and content only as base64, never as raw source", async () => {
    await putRootFile(deps, "s1", "google1.html", Buffer.from("'; system('id'); //"));
    const code = state.phpCalls[0];
    expect(code).toContain(b64("google1.html"));
    // Content is base64-encoded, then embedded through phpString (base64 again).
    expect(code).toContain(b64(b64("'; system('id'); //")));
    expect(code).not.toContain("system('id')");
  });

  it("ships the PHP-side guard (basename, extension allowlist, core-file blocklist, realpath)", async () => {
    await putRootFile(deps, "s1", "google1.html", Buffer.from("x"));
    const code = state.phpCalls[0];
    expect(code).toContain("basename($name)");
    expect(code).toContain("preg_match");
    expect(code).toContain("in_array($name");
    expect(code).toContain("realpath(dirname($path))");
    expect(code).toContain("hash_file('sha256'");
  });

  it("surfaces the PHP error message when the write is refused", async () => {
    state.phpResult = { ok: false, error: "The document root is not writable" };
    await expect(putRootFile(deps, "s1", "google1.html", Buffer.from("x")))
      .rejects.toThrow("The document root is not writable");
  });

  it("uses a generic message when PHP fails without one", async () => {
    state.phpResult = { ok: false };
    await expect(putRootFile(deps, "s1", "google1.html", Buffer.from("x"))).rejects.toThrow("The upload failed");
  });

  it("closes the connection on success and on failure", async () => {
    await putRootFile(deps, "s1", "google1.html", Buffer.from("x"));
    expect(state.closed).toBe(1);
    state.phpError = new Error("transport died");
    await expect(putRootFile(deps, "s1", "google1.html", Buffer.from("x"))).rejects.toThrow("transport died");
    expect(state.closed).toBe(2);
  });
});

describe("deleteRootFile", () => {
  it.each(["../index.php", "license.txt", "x.php", "dir/a.txt"])("rejects %j without connecting", async (name) => {
    await expect(deleteRootFile(deps, "s1", name)).rejects.toThrow();
    expect(state.connected).toBe(0);
  });

  it("resolves when PHP reports ok, sending the name base64-encoded with the guard", async () => {
    await expect(deleteRootFile(deps, "s1", "ads.txt")).resolves.toBeUndefined();
    expect(state.phpCalls[0]).toContain(b64("ads.txt"));
    expect(state.phpCalls[0]).toContain("basename($name)");
    expect(state.closed).toBe(1);
  });

  it("surfaces 'already gone' from PHP and still closes the connection", async () => {
    state.phpResult = { ok: false, error: "That file is already gone" };
    await expect(deleteRootFile(deps, "s1", "ads.txt")).rejects.toThrow("already gone");
    expect(state.closed).toBe(1);
  });

  it("falls back to a generic message", async () => {
    state.phpResult = { ok: false };
    await expect(deleteRootFile(deps, "s1", "ads.txt")).rejects.toThrow("The delete failed");
  });
});

describe("readRootFile", () => {
  it("rejects an invalid name without connecting", async () => {
    await expect(readRootFile(deps, "s1", "../wp-config.php")).rejects.toThrow();
    expect(state.connected).toBe(0);
  });

  it("decodes UTF-8 content and reports isText:true", async () => {
    state.phpResult = { ok: true, b64: b64("héllo \"quoted\"\nline2"), bytes: 20 };
    const res = await readRootFile(deps, "s1", "page.html");
    expect(res).toEqual({ content: "héllo \"quoted\"\nline2", bytes: 20, isText: true });
  });

  it("reports isText:false for bytes that are not valid UTF-8", async () => {
    state.phpResult = { ok: true, b64: Buffer.from([0xff, 0xfe, 0x41]).toString("base64"), bytes: 3 };
    const res = await readRootFile(deps, "s1", "page.html");
    expect(res.isText).toBe(false);
  });

  it("returns empty content for a missing payload", async () => {
    state.phpResult = { ok: true };
    expect(await readRootFile(deps, "s1", "page.html")).toEqual({ content: "", bytes: 0, isText: true });
  });

  it("embeds the size cap in the PHP so oversized files are refused remotely", async () => {
    state.phpResult = { ok: true, b64: "", bytes: 0 };
    await readRootFile(deps, "s1", "page.html");
    expect(state.phpCalls[0]).toContain(String(MAX_ROOT_FILE_BYTES));
  });

  it("surfaces PHP errors and closes the connection", async () => {
    state.phpResult = { ok: false, error: "That file is too large to edit here" };
    await expect(readRootFile(deps, "s1", "page.html")).rejects.toThrow("too large");
    expect(state.closed).toBe(1);
  });
});

describe("listRootFiles", () => {
  it("returns the files PHP reports", async () => {
    const files = [{ name: "a.txt", bytes: 1, modified: 2, url: "https://a.test/a.txt" }];
    state.phpResult = { ok: true, files };
    expect(await listRootFiles(deps, "s1")).toEqual(files);
  });

  it("returns [] when PHP reports ok with no files key", async () => {
    state.phpResult = { ok: true };
    expect(await listRootFiles(deps, "s1")).toEqual([]);
  });

  it("filters by the extension allowlist and core-file list on the PHP side", async () => {
    await listRootFiles(deps, "s1");
    const code = state.phpCalls[0];
    expect(code).toContain(b64("html|htm|txt|xml|json"));
    expect(code).toContain("in_array($f, $core, true)");
  });

  it("throws the PHP error when the root cannot be read, and closes the connection", async () => {
    state.phpResult = { ok: false, error: "Could not read the document root" };
    await expect(listRootFiles(deps, "s1")).rejects.toThrow("Could not read the document root");
    expect(state.closed).toBe(1);
  });

  it("throws 'Site not found' with no credentials", async () => {
    state.creds = null;
    await expect(listRootFiles(deps, "s1")).rejects.toThrow("Site not found");
  });

  it("propagates a connection failure", async () => {
    state.connectError = new Error("cannot connect");
    await expect(listRootFiles(deps, "s1")).rejects.toThrow("cannot connect");
  });
});
