/**
 * The single place the MCP layer gets its schema builder and server identity.
 *
 * Why `z` is re-exported here rather than imported from "zod" in each tool
 * file: the SDK converts these schemas to JSON Schema for tools/list, and
 * that conversion is version-sensitive, plus zod 3 vs 4 disagree on what
 * counts as a valid value for some built-in string formats. Pinning the
 * import to one module means switching entry points is a one-line change
 * here rather than an edit to every tool file.
 *
 * What actually happened here: `export { z } from "zod"` (zod 4.4.3, the
 * version installed) converts to JSON Schema fine -- properties survive
 * intact, tools/list is not the problem. It fails on validation instead:
 * zod 4 tightened `.uuid()` to enforce real RFC 4122 version/variant
 * nibbles, so an all-`1`s test UUID like
 * "11111111-1111-1111-1111-111111111111" (version nibble `1`, but variant
 * nibble also `1` instead of the required 8/9/a/b) gets rejected as
 * "Invalid UUID". zod 3's `.uuid()` used a permissive regex that only
 * checked the hex-and-dashes shape, so the same value passes. Switching to
 * `export { z } from "zod/v3"` -- zod 4's built-in v3-compatibility
 * namespace -- keeps the JSON Schema conversion intact (verified: same
 * populated `properties` object) and restores the permissive UUID check,
 * so tests/mcp-schema.test.ts passes end to end. Confirmed with an
 * in-process probe comparing both entry points side by side before making
 * this the pinned choice.
 */
export { z } from "zod/v3";

export const MCP_SERVER_NAME = "wp-control-panel";

/**
 * Read from package.json so the version an MCP client sees is the deployed
 * app's version, per the spec's "version from package.json".
 */
import pkg from "../../package.json" with { type: "json" };
export const MCP_SERVER_VERSION: string = pkg.version;
