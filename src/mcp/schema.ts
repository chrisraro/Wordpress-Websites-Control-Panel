/**
 * The single place the MCP layer gets its schema builder and server identity.
 *
 * Why `z` is re-exported here rather than imported from "zod" in each tool
 * file: the SDK converts these schemas to JSON Schema for tools/list, and
 * that conversion is version-sensitive. Pinning the import to one module
 * means switching entry points is a one-line change here rather than an
 * edit to every one of the ~31 tool files that will import from it.
 *
 * Verified on zod 4.4.3 + @modelcontextprotocol/sdk 1.30.0: plain
 * `export { z } from "zod"` converts to JSON Schema correctly --
 * `properties` lists every field (e.g. ["site_id", "n"]) and `required`
 * lists only the non-default ones -- and validation round-trips end to
 * end, rejecting a bad value like "not-a-uuid". tests/mcp-schema.test.ts
 * pins this because the failure mode for a zod/SDK version mismatch is
 * silent: an empty or missing `properties` object, not a thrown error.
 *
 * Note for tool authors: zod 4's `.uuid()` enforces real RFC 4122
 * version/variant nibbles, so it correctly accepts everything this system
 * actually generates (`crypto.randomUUID()`, Postgres `gen_random_uuid()`)
 * but rejects placeholder fixtures like all-`1`s UUIDs. Use a real v4 UUID
 * in test fixtures, not a hand-typed placeholder.
 */
export { z } from "zod";

export const MCP_SERVER_NAME = "wp-control-panel";

/**
 * Read from package.json so the version an MCP client sees is the deployed
 * app's version, per the spec's "version from package.json".
 */
import pkg from "../../package.json" with { type: "json" };
export const MCP_SERVER_VERSION: string = pkg.version;
