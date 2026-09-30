/**
 * The latest uptime check's framing verdict, or null when it cannot be read.
 * Never throws: an unreadable verdict must not block a hardening run.
 */
export async function readFrameable(
  security: { uptimeSummary?: (siteId: string) => Promise<{ frameable?: boolean | null }> },
  siteId: string,
): Promise<boolean | null> {
  try {
    return (await security.uptimeSummary?.(siteId))?.frameable ?? null;
  } catch {
    return null;
  }
}
