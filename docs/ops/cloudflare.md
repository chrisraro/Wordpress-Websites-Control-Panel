# Cloudflare and the MCP endpoint

Both Azalea domains — `azaleabaguio.com` and `azaleaboracay.com`, production
and staging — sit behind Cloudflare bot protection that challenges the
panel's MCP requests. Every `snapshot_refresh` for those four sites fails
with:

```
Streamable HTTP error: Error POSTing to endpoint:
<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
```

That is Cloudflare's interstitial, not a WordPress error. The four sites
therefore never collect inventory, accumulate `consecutive_failures`, and
drift to `degraded`, which the dashboard reports as "connection is failing
intermittently".

## What was measured

| From | User-Agent | Result |
|---|---|---|
| Residential IP, `curl` | none (curl default) | `406` — a security plugin rejecting curl's own UA, unrelated to Cloudflare |
| Residential IP, `curl` | browser string | `401 rest_forbidden` — reaches WordPress |
| Residential IP, `curl` | `wp-control-panel-mcp/1.0` | `401 rest_forbidden` — reaches WordPress |
| Residential IP, Node `fetch` | none | `401 rest_forbidden` — reaches WordPress |
| Residential IP, Node `fetch` | `wp-control-panel-mcp/1.0` | `401 rest_forbidden` — reaches WordPress |
| **Vercel production** | `wp-control-panel-mcp/1.0` | **challenge page** |

`401 rest_forbidden` is the correct answer to an unauthenticated probe — it
means the request reached WordPress.

**The User-Agent is not the discriminator.** From a residential IP the
request succeeds with or without it. The same code from Vercel is challenged.
What differs is the source IP and TLS fingerprint of a datacenter egress,
which Cloudflare scores far more aggressively and which no request header
changes.

An earlier commit message and code comment claimed the User-Agent fixed
this. It does not, and both have been corrected.

## The fix

This needs a rule on the Cloudflare account. It cannot be fixed from this
codebase.

For each of `azaleabaguio.com` and `azaleaboracay.com`:

**WAF → Custom rules → Create rule**

- Expression:
  ```
  (http.request.uri.path contains "/wp-json/mcp/novamira"
   and http.user_agent eq "wp-control-panel-mcp/1.0")
  ```
- Action: **Skip** → select *All remaining custom rules*, and under
  *Additional options* also skip **Bot Fight Mode / Super Bot Fight Mode**.

Then re-run inventory for the four sites (dashboard → **Refresh all
inventory**, or per site) and confirm they return to `connected`.

## Why this rule is narrow enough

It matches only the MCP path and only this panel's User-Agent, so ordinary
traffic keeps full protection.

**It is worth being clear about what it does and does not grant.** A
User-Agent is trivially spoofable — anyone who reads this file can send that
header. The rule does not grant access: the endpoint still requires a
WordPress application password, and an unauthenticated request answers
`401 rest_forbidden` as shown above. What the rule skips is the *bot
challenge*, not authentication. The exposure it adds is that an attacker who
knows the header can reach the login check directly instead of being
challenged first — the same position they are in on the ten sites that have
no Cloudflare in front of them at all.

If that trade is unwanted, the tighter alternative is an IP allowlist for
Vercel's egress addresses instead of a User-Agent match. That is stronger but
needs maintaining: the egress range is not static on all Vercel plans, and
inventory silently starts failing again whenever it changes.

## Related

`src/lib/mcp/client.ts` sends the `wp-control-panel-mcp/1.0` header, and
`tests/mcp-user-agent.test.ts` pins it — if that string changes, the rule
above stops matching and these sites go dark again.
