# DataForSEO SEO Expansion — Design & Roadmap

Date: 2026-09-04 · Status: approved design, not started
Research: `docs/research/2026-09-02-open-seo-integration.md`

**Read this first if you are picking the work up cold.** It is written to be
self-contained: the decision, why the alternatives lost, what already exists,
and a phased roadmap where each phase ships something usable on its own.

---

## 1. Decision

Add net-new SEO data — backlinks, keyword research, competitor keywords, and
(conditionally) AI visibility — to the panel by **calling DataForSEO directly
from our own services**, behind a provider port, using our existing job queue
and `seo_snapshots` table.

We evaluated integrating **every-app/open-seo** (MIT, 16k stars, "open source
alternative to Semrush and Ahrefs"). It was rejected as a dependency, and the
reasoning matters because someone will ask again:

- OpenSEO is a **Cloudflare Workers app** (D1/KV/R2, Durable Objects,
  Cloudflare Workflows, Alchemy IaC). It cannot be imported as a library into
  a Next.js/Vercel/Supabase codebase. Integrating it means running a second
  deployable on a second cloud.
- Every metered thing it does is **a wrapper over DataForSEO** — the same API
  we would call ourselves, with the same per-call price. It owns no index.
- Its self-hosted mode is **single-workspace**: everyone behind Cloudflare
  Access shares one tenant. It can never be client-facing, so it could only
  ever be a staff-side data source feeding our UI.
- We want the *data*, not its UI or its 43-tool MCP server. Taking the
  dependency would still leave us building every panel screen and report
  section ourselves — the API wrapper is the smallest part of the work.

What we **do** take from OpenSEO is its homework: which DataForSEO endpoints
to call per feature, how to shape the results, and the idea of a spend ledger.
Those are recorded below so nobody has to re-derive them.

---

## 2. What we already have (read before scoping anything)

The SEO tab is **not** empty, and two of the four requested capabilities
partly exist already — for free. All five current sources come from Rank Math
abilities over the site's own MCP connection (`src/services/seo/collect.ts`):

| Existing `SeoSource` | Rank Math ability | What it actually is |
|---|---|---|
| `rankmath_audit` | `rank-math/audit-site-seo` | On-site SEO audit + findings |
| `rankmath_scores` | `rank-math/get-seo-scores` | Per-post SEO scores |
| `links` | `rank-math/get-link-report` | **Internal/external links on our own pages** — not inbound backlinks |
| `keywords` | `rank-math/get-top-keywords` | **Our own** Search Console keywords (clicks, impressions, CTR, position) |
| `ai_visibility` | `rank-math/get-ai-visibility-overview` | Brand score, mentions, citations, sentiment |

Consequences for scope, stated plainly:

- **Backlinks is a genuine gap.** `links` counts links *we* place on *our*
  pages. It says nothing about who links to us. Net-new. ✅
- **Keyword research is a genuine gap.** We only see keywords we already rank
  for. Volume, difficulty and CPC for keywords we *don't* rank for are absent. ✅
- **Competitor keywords are a genuine gap.** Nothing in the panel looks at
  anyone else's site. ✅
- **Ranked keywords partly duplicate `keywords`.** DataForSEO adds a
  third-party view (not limited to what GSC reports) and makes
  like-for-like competitor comparison possible — but it is an *enrichment*,
  not a missing capability. Lower priority than it looked.
- **AI visibility already exists and costs nothing.** DataForSEO's version is
  ~$1.09 per check, covers ChatGPT (US/English only) and Google AI Overview,
  and returns different data (mentions with cited source URLs) from Rank
  Math's brand score. **It is not obviously better, and it is 20× the price of
  every other call here.** Phase 4 therefore starts with a comparison, not an
  implementation. See §8.

This is the single most important section of the document. A reasonable
person reading the four-item request would build all four; two of them need
qualification first.

---

## 3. Architecture

Follows the pattern GeoGrid already uses (`src/services/geogrid/providers/`),
so there is nothing novel to learn.

```
src/services/seo/
  types.ts          extend SeoSource union; add ExternalSeoProvider port
  collect.ts        unchanged (Rank Math over MCP)
  collectExternal.ts NEW — loops DataForSEO sources
  repo.ts           unchanged (seo_snapshots is source-keyed, free-text)
  providers/
    dataforseo.ts   NEW — the only file that talks to DataForSEO
    stub.ts         NEW — deterministic fixtures; default in dev and tests
  spend/
    ledger.ts       NEW — record + query spend
    budget.ts       NEW — caps, pre-flight estimate, refusal
```

**Provider port.** One interface, two implementations, selected by env
(`SEO_EXTERNAL_PROVIDER=stub|dataforseo`). Every method returns a
`SourceResult` exactly like the Rank Math path, so the UI does not care where
data came from:

```ts
export interface ExternalSeoProvider {
  backlinks(domain: string): Promise<SourceResult<BacklinksPayload>>;
  rankedKeywords(domain: string, loc: LocationRef): Promise<SourceResult<RankedKeywordsPayload>>;
  serpCompetitors(domain: string, loc: LocationRef): Promise<SourceResult<CompetitorsPayload>>;
  keywordResearch(seeds: string[], loc: LocationRef): Promise<SourceResult<KeywordResearchPayload>>;
  estimate(call: PlannedCall): CostEstimate;   // no network; pure
}
```

`estimate()` being pure and separate is deliberate: the budget check must be
answerable without spending money.

**Why a separate collector rather than extending `collect.ts`.** The Rank Math
path is per-site MCP and free; the DataForSEO path is a global metered API
with a budget that can refuse. Mixing them means a DataForSEO outage or an
exhausted budget breaks the free on-site scan, and a WordPress connection
failure blocks paid data we could still fetch. They fail independently, so
they run independently.

**Job type.** New `seo_external_scan`, registered in
`src/services/jobs/handlers.ts` beside `seo_scan`. Same reason as above.
Payload: `{ site_id, sources: SeoSource[] }`.

**Storage.** `seo_snapshots` already stores `(site_id, taken_at, source text,
payload jsonb)` with `source` unconstrained free text. **New sources need no
migration.** New rows simply carry new `source` values, and
`latestBySource()` / `history()` work unchanged.

**Naming.** New sources are `backlinks`, `ranked_keywords`, `serp_competitors`,
`keyword_research`, and — if Phase 4 proceeds — `ai_search`. That last name
deliberately differs from the existing `ai_visibility` so the two can coexist
and be compared rather than one silently overwriting the other.

---

## 4. Data model

Only two new tables. Snapshots reuse `seo_snapshots`.

### `dataforseo_spend` (migration 0020)

Every metered call, recorded. This is what turns "usage billing is
unpredictable for agencies" — the one serious criticism in every OpenSEO
review — into a number on a screen.

| column | type | note |
|---|---|---|
| `id` | uuid pk | |
| `site_id` | uuid null | null for global calls not attributable to one site |
| `source` | text | the `SeoSource` that caused it |
| `endpoint` | text | DataForSEO endpoint, for auditing the bill |
| `units` | int | SERPs, rows, or pages — whatever the endpoint charges by |
| `cost_usd` | numeric(10,6) | six decimals: individual calls are ~$0.0006 |
| `actor` | uuid null | null when a scheduled job, set when a person clicked |
| `job_id` | uuid null | ties spend to the queue run |
| `created_at` | timestamptz | |

Indexed on `(created_at desc)` and `(site_id, created_at desc)`.
Not granted to `authenticated` — staff-only, read through the service-role
client, same class as `mcp_endpoint`.

### `seo_keyword_cache` (migration 0020)

Keyword metrics are stable for weeks and cost $0.05 per lookup. Caching them
is the difference between a usable research tool and a meter that spins every
time someone re-sorts a table.

| column | type | note |
|---|---|---|
| `keyword` | text | |
| `location_code` | int | DataForSEO location; 2840 = US |
| `language_code` | text | |
| `search_volume` | int null | |
| `difficulty` | int null | |
| `cpc` | numeric null | |
| `competition` | numeric null | |
| `intent` | text null | |
| `fetched_at` | timestamptz | |

Primary key `(keyword, location_code, language_code)`. TTL is a read-time
decision (default 30 days), not a delete job.

---

## 5. Budget and spend control

Non-negotiable, and built in Phase 0 before a single live call is possible.

- **Two caps**, both configurable: per-site monthly and global monthly.
- **Pre-flight.** Every job calls `estimate()` and checks the ledger. Over
  cap ⇒ the job fails with a plain reason (`"Monthly budget for this site is
  spent"`), it does not silently skip or half-run.
- **Post-call.** Actual cost recorded from the response where DataForSEO
  reports it, else from the estimate, flagged as estimated.
- **Confirmation threshold.** Any operator-initiated action estimated over a
  set amount (start: $1.00) requires a confirm dialog naming the cost and the
  site — the same pattern as every other destructive action in the panel, and
  the same idea as OpenSEO's 2,000-credit confirmation.
- **Visibility.** A Spend card on the admin side: this month by site, by
  source, and the ten most expensive calls. Without this the caps are
  invisible until they bite.

Reference costs (measured 2026-09-02, sources in the research doc):

| Call | Cost |
|---|---|
| Google organic/maps SERP, standard queue | $0.0006 |
| Same, live | $0.002 |
| Keyword lookup | ~$0.05 |
| Backlinks domain overview | ~$0.08 |
| AI brand check | ~$1.09 |
| DataForSEO minimum deposit | $50 |

At 12 sites, monthly backlinks + ranked keywords is roughly **$1.50–$2.00/month**.
The budget machinery exists for the tail, not the mean.

---

## 6. UI surfaces

All on the existing SEO tab (`/sites/[id]/seo`) — no new tab. The critique
already flagged seven tabs as over the cognitive-load line; an eighth is not
on the table.

- **Backlinks card.** Referring domains, total backlinks, new/lost since last
  check, sparkline from snapshot history. Report-ready.
- **Keyword research panel.** Staff enter seeds; results table with volume,
  difficulty, CPC, intent. Cached; each fetch shows its cost before running.
- **Competitors card.** Domains ranking for the same terms, with overlap count.
- **Ranked keywords** (Phase 3) folds into the existing keywords card as a
  second source, clearly labelled, never silently merged with GSC data.

Every card follows the existing discipline: skeleton on load, empty state that
distinguishes *never fetched* from *fetched and empty*, and errors that survive
(`showInlineError` defaults true — do not reintroduce the opt-out).

Per project memory: run `/impeccable` after each UI phase, and responsive is
mandatory, not a checkbox.

---

## 7. Reports

Backlinks and competitors are the two clients understand without explanation,
so they go in the PDF (`src/services/reports/document.tsx`) as a short
"Visibility" section: referring domains with month-over-month change, and
"who else ranks for your terms".

Keyword research is a staff tool and stays out of client reports.

Principle 4 binds hardest here: a site with no backlink snapshot must render
"not yet measured", never "0 referring domains".

---

## 8. Roadmap

Each phase is independently shippable and independently valuable. Stop after
any of them without leaving the codebase half-built.

### Phase 0 — Foundation (no live calls, no spend)
Provider port, stub provider, spend ledger, budget checks, migration 0020,
`seo_external_scan` job type wired to the stub. Tests run entirely on the
stub.
**Ships:** nothing user-visible. **Costs:** $0. **Gate to Phase 1:** a
DataForSEO account exists and `DATAFORSEO_API_KEY` is set.

### Phase 1 — Backlinks
DataForSEO provider implements `backlinks()`. Monthly scheduled refresh per
site. Backlinks card on the SEO tab. Report section.
**Why first:** cheapest ($0.08/site/month ≈ $1/month for the fleet), genuinely
net-new, and the one metric clients recognise.

### Phase 2 — Keyword research + competitors
`keywordResearch()` and `serpCompetitors()`, keyword cache, research panel,
competitors card, report line. On-demand only — no schedule.
**Why second:** highest day-to-day staff value; cost is bounded because
nothing runs unattended.

### Phase 3 — Ranked keywords
`rankedKeywords()` as a labelled second source beside the Rank Math/GSC
keywords, plus competitor comparison.
**Why third:** enrichment of data we already have, not a gap. Only worth doing
once Phase 2 proves the competitor angle is used.

### Phase 4 — AI visibility (gated, may be cancelled)
**Do not start by writing code.** Start by running
`rank-math/get-ai-visibility-overview` against two or three live client sites
and comparing what it returns to a manually-purchased DataForSEO AI check for
the same brand. Decide from evidence whether the paid version tells us
anything the free one does not.

Proceed only if all three hold:
1. The DataForSEO data is materially better for these clients.
2. ChatGPT's US/English-only coverage is meaningful for Philippine local
   businesses — this is genuinely doubtful and is the likeliest reason to cancel.
3. $1.09/check fits a defined budget with a per-site cap.

If it proceeds it is **on-demand only, behind a confirm dialog naming the cost**.
Never scheduled.

### Deferred — explicitly out of scope here
- **GeoGrid DataForSEO provider.** Once `dataforseo-client` is in the repo,
  `serp.local` with `searchType: "maps"` gives GeoGrid a second rank source for
  ~$0.0006/point (a 3×3 scan is under a cent; a 9×9 about $0.05). This is a
  cheap follow-on but it is a **separate spec** — it changes GeoGrid's
  provider, not the SEO tab.

  **It is also not urgent.** Checked against the live database on 2026-09-04:
  the n8n rank lookup now works. Runs on 2026-09-04 ("Cakes", "Pastries")
  returned a real rank on all 9 points; the 2026-08-30 runs ("Tourist Bus",
  "Transit", "Rides") returned none. Someone replaced the placeholder node in
  between. An earlier draft of this spec called the stub a live defect — that
  was true a week ago and is not true now. Verify current state before acting
  on any GeoGrid claim; the provider lives inside n8n where this repo cannot
  see it.
- **MCP surface for agents.** Not wanted; revisit only if the goal changes.
- **Site audit crawler.** OpenSEO's is home-grown and good, but our Rank Math
  audit already covers on-site SEO from inside WordPress. No gap.

---

## 9. Risks

- **Cost drift at scale.** Twelve sites is cheap; the caps exist for the day
  someone schedules AI checks or daily rank tracking. Mitigated by Phase 0
  landing before any live call.
- **Backlink index depth.** DataForSEO is thinner than Ahrefs for forensic
  link auditing. Fine for client reporting; do not position it as Ahrefs.
- **Location codes.** DataForSEO location targeting for Philippine cities is
  unverified. Validate in Phase 1 with one real client domain before
  scheduling anything.
- **Provider lock-in.** Mitigated by the port: a future provider implements
  the same interface. Nothing above `providers/` imports `dataforseo-client`.
- **$50 minimum deposit** is a real up-front commitment for what may be ~$2/month
  of usage. Worth knowing before Phase 1, not during.

## 10. Open questions

1. Which client domains should Phase 1 validate location targeting against?
2. What monthly cap, per site and globally? (Suggested start: $5/site, $25 global.)
3. Does the $50 DataForSEO deposit need sign-off before Phase 1?

None block Phase 0.
