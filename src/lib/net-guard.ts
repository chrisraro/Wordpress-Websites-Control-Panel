import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Refuses hosts that point back into private address space.
 *
 * The panel makes authenticated outbound requests -- carrying a WordPress
 * application password -- to whatever URL (or pinned origin IP) a site
 * record names. Without this, anyone who can add or edit a site could aim
 * those requests at loopback, the VPC, or the cloud metadata endpoint
 * (169.254.169.254) and use the panel as an SSRF proxy.
 *
 * This is a check at the moment a site record is written. It does not stop
 * DNS rebinding (a name that resolves publicly now and privately later);
 * that needs enforcement at connect time.
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

type Resolver = (host: string) => Promise<{ address: string }[]>;
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
