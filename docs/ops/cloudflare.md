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

## The fix, if you have Cloudflare access

(If you do not, skip to **Direct-to-origin connection** below — that is the
route that needs only the panel.)

### WAF skip rule

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


---

## Direct-to-origin connection (no Cloudflare access needed)

The WAF rule above needs the Cloudflare account holding the zone. Both
domains' nameservers point at Cloudflare (`rick`/`walk.ns.cloudflare.com`),
so **cPanel cannot change any of it** — while the nameservers point there,
Cloudflare is authoritative for DNS and owns the WAF.

The panel can instead connect straight to the origin server, past the CDN.
Configure it per site: **site page → Connection → Direct connection → Set up**.

Two values:

| Field | What it is | Example |
|---|---|---|
| Origin IP address | the hosting server's own address | `192.249.125.21` |
| Certificate name | the name on the certificate that server presents | `ngx357.inmotionhosting.com` |

Find them by running this on the site (WP Admin → any PHP runner, or the
panel's own tooling from a network that is not challenged):

```php
echo $_SERVER['SERVER_ADDR'], ' ', php_uname('n');
```

### Why two fields and not one

Three things have to differ, and each is load-bearing:

- the **IP** the connection goes to — DNS currently answers with Cloudflare;
- the **certificate name** verified — the origin's own certificate for the
  site domain has expired (see below), so verification has to check a name
  that is still valid, which is the host's shared hostname;
- the **Host header**, which stays the site's real hostname and is what
  selects the right vhost on shared hosting. It comes from the endpoint URL
  and needs no configuration.

**Certificate verification stays on.** It is verified against the name in
the second field. What changes is that the connection authenticates *the
server* rather than *the domain* — a narrower claim, and one the operator
makes explicitly by entering these values. Turning verification off instead
would trade a bot challenge for a credential-interception risk on a
connection carrying a WordPress application password;
`tests/origin-override.test.ts` pins that this was not done.

### Measured

| From | Path | Result |
|---|---|---|
| Vercel | `https://azaleabaguio.com/wp-json/mcp/novamira` | challenge page |
| Anywhere | origin IP, SNI `ngx357.inmotionhosting.com`, Host `azaleabaguio.com` | **`401 rest_forbidden`** — reached WordPress, TLS verified |

`401 rest_forbidden` is the correct answer to an unauthenticated probe.

### Failure mode, and it is silent

Shared hosts migrate accounts between servers. When that happens the origin
IP goes stale and the site stops connecting with a timeout that names
nothing. **Test connection** on the site page is the check; re-run the
snippet above to get the new address.

---

## Unrelated but urgent: the origin certificates have expired

Found while measuring the above.

| Domain | Origin certificate expired |
|---|---|
| `azaleabaguio.com` | 14 Aug 2026 |
| `azaleaboracay.com` | 10 Jul 2026 |

Visitors do not see it because Cloudflare terminates TLS at its edge with a
valid certificate. The Let's Encrypt certificates on the InMotion origin
stopped renewing underneath — most likely because Let's Encrypt's HTTP
validation cannot reach the origin through Cloudflare.

This means Cloudflare's SSL mode is currently **Flexible** or **Full**, not
**Full (strict)** — strict validates the origin certificate and both sites
would already be down. So there is a hidden dependency: switching to Full
(strict), moving off Cloudflare, or changing the DNS breaks both sites
immediately.

**Fix in cPanel** (this part does not need Cloudflare): *SSL/TLS Status* →
select both domains → *Run AutoSSL*. If it fails, that confirms Cloudflare
is blocking validation, and the answer is DNS-01 validation or temporarily
setting the record to DNS-only while it renews.

Once the origin certificates are valid, the **Certificate name** field can
simply be the site's own domain, and the shared hostname is no longer needed.

---

## The request document sent to the client's IT team

`docs/ops/client-requests/azalea-cloudflare-request.html` (+ `.pdf`) is the
written request for the two WAF rules, addressed to whoever holds the
Cloudflare account. Regenerate the PDF with:

```bash
node scripts/build-client-doc.mjs azalea-cloudflare-request
```

It asks for two things: a skip rule for `/.well-known/acme-challenge/` and
`/.well-known/pki-validation/` so certificates can renew, and a skip rule for
the MCP endpoint so this panel can reach the sites.

### Why the MCP rule is offered in two forms

The User-Agent version is the simpler ask, but `wp-control-panel-mcp/1.0` is
published in this repository, so anyone can send it. The stronger version
matches an unguessable shared secret instead:

- Set `MCP_EDGE_SECRET` in the deployment environment (`openssl rand -hex 32`).
- Every MCP request then carries it in `X-OCS-Panel-Key`
  (`MCP_EDGE_SECRET_HEADER` in `src/lib/mcp/client.ts`).
- The Cloudflare rule matches that header instead of the User-Agent.

Neither version is authentication and neither grants anything: WordPress still
requires the application password, and an unauthenticated request answers
`401 rest_forbidden` either way. What the rule skips is the bot challenge.

### Why an IP allowlist is not offered

It would be the cleanest answer and it is the first thing a security-minded
administrator suggests. It needs a stable egress address, and this deployment
does not have one: the Vercel account is on the **Hobby** plan, where
functions egress from rotating shared addresses. Fixed egress (Secure Compute)
is an Enterprise feature. The only allowlist we could offer would be a broad
cloud provider range covering thousands of unrelated tenants — weaker than
either header rule, and a competent reviewer would refuse it.

If an IP match ever becomes a hard requirement, that is a hosting decision
(dedicated egress or a small always-on box), not a code change.
