# Deep Research: OpenSEO (every-app/open-seo) and how it could fit this panel

Depth: thorough · 30+ primary-source fetches (repo files, API metadata, docs, pricing pages) plus third-party reviews · 2 Sept 2026

## Executive Summary

OpenSEO is a six-month-old, MIT-licensed, TypeScript "open source alternative to Semrush and Ahrefs" with 16k GitHub stars and a #1 Product Hunt day in July 2026. It does not crawl the web or hold its own index: **every metered feature is a thin, well-built wrapper over DataForSEO's pay-as-you-go API**, plus a home-grown site-audit crawler and free Google Search Console / GA4 integrations. Its real product is the packaging — a clean UI, a credits ledger, scheduled rank checks, and a **43-tool MCP server** so AI agents can run SEO research against live data.

It runs on Cloudflare Workers (TanStack Start, Drizzle on D1 or Postgres via Hyperdrive, Cloudflare Workflows, Durable Objects, R2). That is the single most important architectural fact for us: **it cannot be dropped into our Vercel + Supabase + Next.js codebase as a library.** It is a separate deployable. The three realistic integration shapes are (A) run it self-hosted on Cloudflare and consume its MCP server from our job queue, (B) skip OpenSEO and call DataForSEO directly from our own services, borrowing its patterns, or (C) run it alongside as a linked staff tool with no data integration.

The most concrete win is not the headline features. It is that **DataForSEO's Google Maps SERP costs $0.0006 per point**, so a 9×9 GeoGrid scan is about $0.05 — and OpenSEO already ships a working `getLocalRankGridTool` that generates the grid, queries each point, and matches the business. Our GeoGrid currently depends on an n8n workflow. Whether to replace that backend is the first real decision the brainstorm has to make.

Two constraints bound everything else. Self-hosted OpenSEO is **single-workspace**: everyone behind Cloudflare Access shares one tenant, with no per-client isolation, so it can only ever be a staff-side data source — client-facing exposure must stay in our panel where RBAC and per-site grants already exist. And DataForSEO needs a **$50 minimum deposit** and bills per call, which reviewers flag as "unpredictable for agencies managing thirty client sites with daily rank tracking."

## Key Findings

1. **It is a DataForSEO front-end, not an index.** `dataforseo-client` is the data dependency; `DATAFORSEO_API_KEY` is the only required secret. Backlinks, keywords, SERPs, local results, AI visibility all route through it. Reviewers are explicit: backlink depth is "capped by the underlying data provider" and "thinner" than Ahrefs for forensic work. ([README](https://github.com/every-app/open-seo), [.env.selfhost.example](https://github.com/every-app/open-seo/blob/main/.env.selfhost.example), [MakerStack review](https://makerstack.co/reviews/openseo-review/))

2. **Stack is Cloudflare-native and incompatible with our runtime as a library.** `wrangler.jsonc` declares D1 (`DB`), two KV namespaces, R2, three Durable Objects (`OnboardingChatAgent`, `SamChatAgent`, `AuditScratchpad`), two Cloudflare Workflows (`SiteAuditWorkflow`, `RankCheckWorkflow`), and cron triggers every 5 minutes and daily at 03:17 UTC. Frontend is React 19 + TanStack Start/Router/Query; auth is better-auth + Cloudflare Access; deploys via Alchemy IaC. ([wrangler.jsonc](https://github.com/every-app/open-seo/blob/main/wrangler.jsonc), [package.json](https://github.com/every-app/open-seo/blob/main/package.json))

3. **Two databases, one schema, hand-maintained parity.** Drizzle schemas live in `src/db/` (SQLite/D1) and `src/db/pg/` (Postgres); `schema-parity.test.ts` enforces they match; `DATABASE_PROVIDER` selects. Postgres is "for installations that exceed D1's storage capacity" and connects through a Hyperdrive binding. Two runbooks exist for D1→Postgres migration ("simple" and "detailed"), which tells you it was painful at least once. ([LOCAL_POSTGRES.md](https://github.com/every-app/open-seo/blob/main/docs/LOCAL_POSTGRES.md), [runbooks/](https://github.com/every-app/open-seo/tree/main/runbooks))

4. **The data model is organisation → project (one domain) → keywords/trackers/snapshots.** Tenancy is by `organizationId`. `rankTrackingConfigs` hold domain, location code (default 2840 = US), language, device (both/desktop/mobile), SERP depth, and schedule interval (daily/weekly/monthly/manual). `rankSnapshots` store position per keyword per device per run and deliberately keep no FK to the keyword so history survives deletion. `backlinkSnapshots` store summary counts over time. There is no credits ledger table in `app.schema.ts` — metering lives in `billing.schema.ts` and `dataforseoBillingClassification.ts`. ([app.schema.ts](https://github.com/every-app/open-seo/blob/main/src/db/app.schema.ts))

5. **The MCP server is the integration surface, and it is substantial.** 43 tools across projects, keyword research, domain/backlinks, SERP and rank tracking, local SEO (business profile, reviews, Q&A, categories, **local rank grid**), Search Console, GA4 (ten tools), and site audit. Auth is OAuth provider *or* API key; project context is resolved per call; batches over 2,000 credits require user confirmation. ([mcp/server.ts](https://github.com/every-app/open-seo/blob/main/src/server/mcp/server.ts), [mcp/](https://github.com/every-app/open-seo/tree/main/src/server/mcp))

6. **`getLocalRankGridTool` overlaps our GeoGrid directly.** It runs "one Google Maps search per point of a square grid around a coordinate." Grid is 3×3 or 5×5, spacing 0.25–10 km (default 2 km), per-point call is `client.serp.local()` with `searchType: "maps"`, depth 20, business matched by cid → placeId → name substring. Output: per-point rank, `averageRank`, `top3Count`, `top10Count`. Coordinate maths is the same latitude/longitude-per-km formula ours would use. **It caps at 5×5; ours does 7×7 and 9×9.** ([local-seo-tools.ts](https://github.com/every-app/open-seo/blob/main/src/server/mcp/tools/local-seo-tools.ts))

7. **DataForSEO Google Maps SERP is $0.0006 per point (standard queue, ~5 min), $0.002 live.** So a 9×9 grid is ~$0.05 standard / ~$0.16 live; a 7×7 is ~$0.03 / ~$0.10. Organic SERP is the same price. ([Maps SERP pricing](https://dataforseo.com/pricing/serp/google-maps-serp-api), [Organic SERP pricing](https://dataforseo.com/pricing/serp/google-organic-serp-api))

8. **Per-feature costs are small individually, spiky in aggregate.** OpenSEO's own estimates: keyword search ~$0.05, backlink domain overview ~$0.08, AI brand check ~$1.09, rank tracking ~$0.0025 per keyword-check. Hosted plan is $10/mo including $10 usage, with a 28% markup on DataForSEO calls; self-hosted pays DataForSEO directly (min deposit $50, $1 free to test). ([openseo.so/pricing](https://openseo.so/pricing), [DATAFORSEO_API_KEY.md](https://github.com/every-app/open-seo/blob/main/docs/DATAFORSEO_API_KEY.md), [DataForSEO pricing](https://dataforseo.com/pricing))

9. **Self-hosting is single-workspace.** Cloudflare path: `pnpm deploy:selfhost`, provisions D1/KV/R2/Worker/Access, "all team members share one workspace," authorisation via `ACCESS_ALLOWED_EMAILS`, "works on Cloudflare's free plan" but R2 needs a card on file. Docker path: one container, `AUTH_MODE=local_noauth`, local admin user, and the docs warn to "only expose it behind your own auth-protected reverse proxy, tunnel, or private network." Neither offers per-client tenancy. ([SELF_HOSTING_CLOUDFLARE.md](https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_CLOUDFLARE.md), [SELF_HOSTING_DOCKER.md](https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_DOCKER.md))

10. **Site audit is a home-grown crawler, not DataForSEO.** `siteAuditWorkflowCrawl.ts` and phase files run on a Cloudflare Workflow with `AuditScratchpad` Durable Object; it is "robots.txt-aware, same-origin" and checks broken links, duplicate/missing titles and descriptions, redirect chains, orphan pages, canonicals, thin content. Lighthouse comes from **Google PageSpeed Insights when `PAGESPEED_API_KEY` is set** (free), else DataForSEO OnPage at $0.00425/page (PR #52). ([workflows/](https://github.com/every-app/open-seo/tree/main/src/server/workflows), [site-audit-tools.ts](https://github.com/every-app/open-seo/blob/main/src/server/mcp/tools/site-audit-tools.ts), [issues](https://github.com/every-app/open-seo/issues))

11. **AI Visibility = DataForSEO AI Optimization, two platforms only.** `brandLookup.ts` calls `dataforseo.aiSearch.aggregatedMetrics / topPages / mentionsSearch`; `PLATFORMS = ["chat_gpt", "google"]` — ChatGPT (US/English) and Google AI Overview. No Perplexity, Claude, or Gemini. ([brandLookup.ts](https://github.com/every-app/open-seo/blob/main/src/server/features/ai-search/services/brandLookup.ts))

12. **Google Search Console integration is free and project-scoped.** OAuth via `GOOGLE_CLIENT_ID/SECRET` + `BETTER_AUTH_SECRET` (≥32 chars, encrypts tokens); pulls clicks, impressions, positions, URL inspection; "no credit metering applies." Requires a verified GSC property. ([SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md](https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md))

13. **Maturity: young, active, well-engineered, thin on ops.** Created 27 Feb 2026, pushed 24 Aug 2026, v0.1.6, 124 open issues, 14 test files in the MCP module alone, `AGENTS.md`/`CLAUDE.md` with explicit engineering principles ("TanStack server function → service → repository", "keep product data normalized", dual-dialect schema discipline). Only three runbooks. Reviewers: 8/10, "rougher interface," "young open-source project." ([GitHub API](https://api.github.com/repos/every-app/open-seo), [AGENTS.md](https://github.com/every-app/open-seo/blob/main/AGENTS.md), [MakerStack](https://makerstack.co/reviews/openseo-review/))

## Detailed Analysis

### What it actually is

Strip the marketing and OpenSEO is three things layered on DataForSEO:

- **A metered API wrapper with a credits ledger.** Every paid call goes through billing classification, balance check, and spend recording. In hosted mode "each call checks balance before execution and records spend after."
- **A scheduler.** `RankCheckWorkflow` plus a 5-minute cron runs rank checks on daily/weekly/monthly intervals with duplicate-run guards (`rankCheckRunGuards.ts`, unique constraint on pending/running).
- **An agent surface.** The 43-tool MCP server, agent "skills," and an in-app agent (SAM, via OpenRouter, optional) — the part that differentiates it from a Semrush clone and the part the team clearly invests most in (OAuth provider, API keys, per-project auth, instrumentation, all tested).

The two things it owns outright are the **site-audit crawler** and the **GSC/GA4 integrations**. Everything else is DataForSEO with good UX.

### Where it overlaps what we already have

| Ours today | OpenSEO equivalent | Assessment |
|---|---|---|
| SEO tab: Rank Math audit (in-WordPress) | Site audit crawler (external, same-origin, Workflow) | Different vantage point — theirs sees the rendered public site; ours sees WordPress internals. Complementary, not duplicate. |
| PageSpeed via our own call | Lighthouse via PageSpeed Insights or DataForSEO OnPage | Same source; nothing to gain. |
| Search Console keywords | GSC performance + URL inspection + "search opportunities" | Theirs is richer (inspection, opportunities) but we already hold the OAuth. |
| **GeoGrid via n8n (7×7 / 9×9)** | **`getLocalRankGridTool` via DataForSEO Maps SERP (3×3 / 5×5)** | **Direct overlap. Theirs is smaller-grid but cheaper, no n8n, and already handles business matching.** |
| — | Keyword research, backlinks, domain overview, SERP competitors, AI visibility | Net-new capability. |

### The three integration shapes

**A. Self-host OpenSEO on Cloudflare, consume its MCP server from our jobs.**
Our panel is already an MCP client (it talks to WordPress via Novamira). Adding a second MCP target — OpenSEO's server, authenticated by API key — is architecturally natural: a job handler calls `getBacklinksOverviewTool` or `getLocalRankGridTool`, stores the result in Supabase against our `site_id`, and our UI renders it. OpenSEO becomes a **staff-side data service**; clients never touch it.
*For:* fastest path to keyword/backlink/AI-visibility data; scheduling, credits, and DataForSEO error handling already solved; upstream keeps improving it.
*Against:* a second deployable on a second cloud; single-workspace tenancy means our `site_id` → their `projectId` mapping is ours to maintain; their 5×5 grid cap doesn't cover our 9×9 (we'd call `client.serp.local()` semantics ourselves or accept 5×5); version drift in a 0.x project.

**B. Call DataForSEO directly from our services; borrow OpenSEO's patterns.**
Add `dataforseo-client` to our repo, port the grid maths and business-matching from `local-seo-tools.ts`, run it in our existing job queue, store in Supabase. No second deployable.
*For:* one codebase, one cloud, our RBAC and per-site grants apply to everything, 9×9 grids trivially, and per-call cost is identical (no 28% markup either way when self-hosting).
*Against:* we re-implement credits/balance tracking, scheduling for rank checks, and the SERP/backlink result shaping OpenSEO already did; we own DataForSEO API changes; no MCP-for-agents surface unless we build one.

**C. Run OpenSEO alongside as a linked staff tool.**
Deploy it, put a "Open in OpenSEO" link on the SEO tab, no data integration.
*For:* near-zero engineering.
*Against:* nothing reaches our reports or client views; two logins; two places truth lives. Fails PRODUCT.md's "one place to run every site."

### The GeoGrid question specifically

Our GeoGrid's value is the map — the 81-point stagger, the ramp, the per-point popup. Its cost is the n8n dependency and whatever the n8n workflow currently pays for SERPs. DataForSEO Maps SERP at $0.0006/point means **a full 9×9 scan across all 12 sites is under $0.60 in the standard queue**. That is cheap enough to run weekly for every site without thinking about it. Neither shape A nor B changes the map; both change what feeds it. Shape B feeds it most directly.

### Could OpenSEO share our Supabase Postgres?

Technically plausible — Drizzle-pg via Hyperdrive to a Supabase connection string, `DATABASE_PROVIDER=postgres`. It would put their tables beside ours. But their tenancy is `organizationId` from better-auth, ours is Supabase auth + RLS; their schema would be unmanaged by our migrations; and Hyperdrive to an external Postgres is exactly the kind of cross-cloud coupling that fails silently. Not recommended without a compelling reason.

## Contrarian Views And Risks

- **"It's just DataForSEO with a UI" is a fair critique — and also the point.** If what we want is the data, shape B gets it with fewer moving parts. OpenSEO earns its place only if we want the *scheduler + credits + MCP-for-agents* packaging too.
- **Cost predictability at agency scale.** MakerStack: usage billing "becomes unpredictable for agencies managing thirty client sites with daily rank tracking." We have 12 sites; at ~$0.0025/keyword-check daily tracking of 50 keywords/site is ~$45/month — fine, but AI brand checks at $1.09 each would need a budget rule.
- **Index depth.** Backlinks are DataForSEO's index, "thinner" than Ahrefs for forensic audits. Fine for client reports; don't sell it as Ahrefs.
- **0.x volatility.** v0.1.6, 124 open issues, MCP server at 0.0.12. Shape A ties a production job path to an API that may change. Pin a release; wrap tool calls behind our own adapter.
- **Cloudflare dependence.** It requires Cloudflare specifics (Workflows, DOs). No Vercel/Node port exists. If Cloudflare is a non-starter organisationally, shape A is off the table.
- **Telemetry on by default** in self-host (`OPENSEO_TELEMETRY_DISABLED` to opt out) — a client-data question to answer before deploying.
- **Single workspace** is the hard limit: OpenSEO can never be the thing a client logs into.
- **AI Visibility is two platforms**, US/English for ChatGPT. Our clients are Philippine businesses; validate relevance before paying $1.09/check.

## Open Questions

1. Does our n8n GeoGrid workflow already use DataForSEO, SerpAPI, or something else — and what does it cost per scan today?
2. Do we want an agent-facing MCP surface for *our* panel (so Claude can run SEO research against client sites), or only human-facing UI? That decides whether OpenSEO's MCP server is a feature or overhead.
3. Which net-new capability actually matters to OCS clients: keyword research, backlinks, or AI visibility? Each has a different cost profile.
4. Is Cloudflare acceptable as a second deployment target for staff tooling?
5. How does a DataForSEO location code map to Philippine cities for local SERPs — does their coverage match where our clients rank?

## Sources

- https://github.com/every-app/open-seo — repo, README, tree
- https://api.github.com/repos/every-app/open-seo — metadata: MIT, TypeScript, 16,092 stars, created 2026-02-27, pushed 2026-08-24
- https://github.com/every-app/open-seo/blob/main/package.json — stack and scripts
- https://github.com/every-app/open-seo/blob/main/wrangler.jsonc — Cloudflare bindings, Workflows, crons
- https://github.com/every-app/open-seo/blob/main/compose.yaml — single-container Docker self-host
- https://github.com/every-app/open-seo/blob/main/.env.selfhost.example — required/optional env
- https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_CLOUDFLARE.md — recommended self-host path
- https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_DOCKER.md — Docker path, no-auth warning
- https://github.com/every-app/open-seo/blob/main/docs/DATAFORSEO_API_KEY.md — key format, $50 minimum
- https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md — GSC OAuth
- https://github.com/every-app/open-seo/blob/main/docs/LOCAL_POSTGRES.md — dual-dialect DB
- https://github.com/every-app/open-seo/blob/main/src/db/app.schema.ts — data model
- https://github.com/every-app/open-seo/blob/main/src/server/mcp/server.ts — 43 tools and imports
- https://github.com/every-app/open-seo/blob/main/src/server/mcp/tools/local-seo-tools.ts — local rank grid implementation
- https://github.com/every-app/open-seo/blob/main/src/server/mcp/tools/site-audit-tools.ts — audit tool
- https://github.com/every-app/open-seo/tree/main/src/server/workflows — home-grown crawler
- https://github.com/every-app/open-seo/blob/main/src/server/features/ai-search/services/brandLookup.ts — AI visibility provider
- https://github.com/every-app/open-seo/tree/main/runbooks — D1→Postgres runbooks
- https://github.com/every-app/open-seo/issues — PR #52 PageSpeed, #148 MCP AI tools, #202 GA4
- https://openseo.so and https://openseo.so/pricing — positioning, $10/mo, per-feature estimates
- https://dataforseo.com/pricing — $50 minimum, product list
- https://dataforseo.com/pricing/serp/google-organic-serp-api — $0.0006 / $0.0012 / $0.002 per SERP
- https://dataforseo.com/pricing/serp/google-maps-serp-api — same tiers for Maps
- https://makerstack.co/reviews/openseo-review/ — 8/10, agency-scale cost caveat
- https://lewislovelock.com/blog/openseo-open-source-ahrefs-alternative — practitioner, solo-creator framing
- https://openalternative.co/openseo, https://www.producthunt.com/products/openseo — reception

## Rerun Inputs
workflow: firecrawl-deep-research
topic: every-app/open-seo architecture, costs, and integration options for a Next.js + Supabase + WordPress-MCP agency panel
depth: thorough
output: markdown
