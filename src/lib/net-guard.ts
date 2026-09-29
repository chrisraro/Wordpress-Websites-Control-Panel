import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

/**
 * Refuses hosts that point back into private address space.
 *
 * The panel makes authenticated outbound requests -- carrying a WordPress
 * application password -- to whatever URL (or pinned origin IP) a site
 * record names. Without this, anyone who can add or edit a site could aim
 * those requests at loopback, the VPC, or the cloud metadata endpoint
 * (169.254.169.254) and use the panel as an SSRF proxy.
 *
 * Enforced twice: when a site record is written (checkPublicHttpsUrl), and
 * again at connect time (createGuardedFetch / publicOnlyLookup), because a
 * name that resolved publicly when saved can resolve privately later (DNS
 * rebinding), and a public site can redirect a probe into private space.
 */

type Cidr4 = [number, number]; // [network as uint32, prefix length]

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc * 256) + Number(o), 0);
}

const PRIVATE_V4: Cidr4[] = [
  ["0.0.0.0", 8],       // "this network"
  ["10.0.0.0", 8],      // RFC1918
  ["100.64.0.0", 10],   // CGNAT (RFC6598)
  ["127.0.0.0", 8],     // loopback
  ["169.254.0.0", 16],  // link-local, incl. cloud metadata
  ["172.16.0.0", 12],   // RFC1918
  ["192.168.0.0", 16],  // RFC1918
  ["224.0.0.0", 4],     // multicast
  ["240.0.0.0", 4],     // reserved, incl. broadcast
].map(([net, bits]) => [v4ToInt(net as string), bits as number]);

function isPrivateV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return PRIVATE_V4.some(([net, bits]) => {
    const size = 2 ** (32 - bits);
    return n >= net && n < net + size;
  });
}

/** Expands an IPv6 literal to eight 16-bit groups; null if malformed. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  // Trailing dotted IPv4 (e.g. ::ffff:127.0.0.1) becomes two groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const n = v4ToInt(tail);
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.length === 8 && nums.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? nums : null;
}

function isPrivateV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true; // unparseable: refuse rather than guess
  const allZeroPrefix = g.slice(0, 5).every((x) => x === 0);
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the
  // embedded IPv4 address.
  const mapped = allZeroPrefix && g[5] === 0xffff;
  const compatible = allZeroPrefix && g[5] === 0 && (g[6] !== 0 || g[7] > 1); // not :: or ::1
  if (mapped || compatible) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return isPrivateV4(v4);
  }
  if (g.every((x) => x === 0)) return true;                         // :: unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
  if ((g[0] & 0xffc0) === 0xfe80) return true;                        // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true;                        // fc00::/7 unique-local
  if ((g[0] & 0xff00) === 0xff00) return true;                        // ff00::/8 multicast
  return false;
}

/** True if `ip` is a literal address in loopback/private/link-local/etc. space. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return false;
}

export type HostCheck = { ok: true } | { ok: false; error: string };

export type Resolver = (host: string) => Promise<{ address: string }[]>;
const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true });

/**
 * Checks a hostname or literal IP. Literal IPs are judged directly; names
 * are resolved and refused if *any* address they resolve to is private (a
 * name with one public and one private record is still a way in).
 */
export async function checkPublicHost(host: string, resolve: Resolver = defaultResolver): Promise<HostCheck> {
  const bare = host.trim().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  if (!bare) return { ok: false, error: "Enter a host name." };
  const refused: HostCheck = {
    ok: false,
    error: `“${bare}” points at a private or local network address, which is not allowed.`,
  };
  if (bare === "localhost" || bare.endsWith(".localhost")) return refused;
  if (isIP(bare)) return isPrivateAddress(bare) ? refused : { ok: true };

  let addresses: { address: string }[];
  try {
    addresses = await resolve(bare);
  } catch {
    return { ok: false, error: `Could not resolve “${bare}”. Check the address and try again.` };
  }
  if (addresses.length === 0) {
    return { ok: false, error: `Could not resolve “${bare}”. Check the address and try again.` };
  }
  return addresses.some((a) => isPrivateAddress(a.address)) ? refused : { ok: true };
}

/**
 * Checks a site URL: must be https (the request carries an application
 * password, which must never cross the network in cleartext) and its host
 * must be public per checkPublicHost.
 */
export async function checkPublicHttpsUrl(raw: string, resolve?: Resolver): Promise<HostCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Enter a full URL, e.g. https://example.com" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "The site URL must start with https://" };
  }
  return checkPublicHost(url.hostname, resolve);
}

// ---------------------------------------------------------------------------
// Connect-time enforcement
// ---------------------------------------------------------------------------

/** Redirect hops followed by createGuardedFetch before giving up. */
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Thrown when a request is refused because of where it would go. */
export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

async function assertPublicHttpUrl(url: URL, resolve: Resolver): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlockedAddressError(`Refused a redirect to a non-web address (${url.protocol}).`);
  }
  const check = await checkPublicHost(url.hostname, resolve);
  if (!check.ok) throw new BlockedAddressError(check.error);
}

export type LookupFn = (
  hostname: string,
  options: { all?: boolean } | undefined,
  callback: (err: Error | null, ...rest: unknown[]) => void,
) => void;

/**
 * A `lookup` for net/tls/undici connect options that resolves the name and
 * refuses to hand back any private address. This is the check at the moment
 * of connecting, so a record that flips between the pre-check and the socket
 * (DNS rebinding) is still refused. Literal-IP hosts never reach a lookup;
 * those are judged by the pre-check in createGuardedFetch.
 */
export function publicOnlyLookup(resolve: Resolver = defaultResolver): LookupFn {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new BlockedAddressError(`Could not resolve “${hostname}”.`));
          return;
        }
        if (addresses.some((a) => isPrivateAddress(a.address))) {
          callback(new BlockedAddressError(
            `“${hostname}” points at a private or local network address, which is not allowed.`,
          ));
          return;
        }
        const withFamily = addresses.map((a) => ({ address: a.address, family: isIP(a.address) || 4 }));
        if (options?.all) callback(null, withFamily);
        else callback(null, withFamily[0].address, withFamily[0].family);
      },
      (e: unknown) => callback(e instanceof Error ? e : new Error(String(e))),
    );
  };
}

let sharedAgent: Agent | undefined;
/** Process-wide dispatcher whose every connection goes through publicOnlyLookup. */
function publicOnlyAgent(): Agent {
  sharedAgent ??= new Agent({ connect: { lookup: publicOnlyLookup() as never } });
  return sharedAgent;
}

export interface GuardedFetchOptions {
  /** Underlying fetch; defaults to the global one, looked up per call. */
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
  /** Redirect hops to follow; 0 returns a redirect response as-is. */
  maxRedirects?: number;
}

function toUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return new URL(input.href);
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

type HopInit = RequestInit & { dispatcher?: unknown };

/** The request to make for the next hop, per the fetch spec's redirect rules. */
function nextHopInit(prev: HopInit, status: number, crossOrigin: boolean): HopInit {
  let next = prev;
  const method = (prev.method ?? "GET").toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    const { body: _dropped, ...rest } = prev;
    next = { ...rest, method: "GET" };
  }
  if (crossOrigin && next.headers) {
    const headers = new Headers(next.headers);
    headers.delete("authorization");
    next = { ...next, headers };
  }
  return next;
}

/**
 * A fetch that refuses private destinations at connect time.
 *
 * Every hop is checked with checkPublicHost before it is requested; redirects
 * are taken with `redirect: "manual"` and followed here (at most
 * `maxRedirects`), each re-validated the same way. Semantics follow the fetch
 * spec where it matters: 303 (and 301/302 after a POST) become a body-less
 * GET, 307/308 keep method and body, and Authorization is dropped when a hop
 * changes origin. With the real global fetch, connections also go through
 * publicOnlyLookup, closing the gap between the pre-check and the socket.
 */
export function createGuardedFetch(opts: GuardedFetchOptions = {}): typeof fetch {
  const resolve = opts.resolve ?? defaultResolver;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const doFetch = opts.fetchImpl ?? globalThis.fetch;
    const start = toUrl(input);
    let url = start;
    let hopInit: HopInit = { ...init };
    if (!opts.fetchImpl && !("dispatcher" in hopInit)) hopInit.dispatcher = publicOnlyAgent();
    for (let hop = 0; ; hop++) {
      await assertPublicHttpUrl(url, resolve);
      const res = await doFetch(url.href, { ...hopInit, redirect: "manual" } as RequestInit);
      const location = res.headers.get("location");
      if (!REDIRECT_STATUSES.has(res.status) || !location || maxRedirects === 0) return res;
      if (hop >= maxRedirects) {
        throw new BlockedAddressError(`Too many redirects (more than ${maxRedirects}) from ${start.host}.`);
      }
      try { await res.body?.cancel(); } catch { /* best effort */ }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new BlockedAddressError("The site answered with a redirect that is not a valid address.");
      }
      hopInit = nextHopInit(hopInit, res.status, next.origin !== url.origin);
      url = next;
    }
  }) as typeof fetch;
}

/** The default outbound fetch for probes that contact a site. */
export const guardedFetch: typeof fetch = createGuardedFetch();
