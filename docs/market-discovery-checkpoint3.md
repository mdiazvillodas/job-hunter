# Market Discovery: checkpoint 3 (MD3b) — LinkedIn market source

A read-only LinkedIn source adapter for Market Discovery. It executes **one**
bounded search and returns structured evidence for that search. It does not
decide, classify, expand seeds, build a query portfolio, collect descriptions,
call AI, add UI, or write anything.

No file under `src/linkedin/` was modified. The adapter composes the existing
primitives; Hunter discovery is untouched.

## Contract

`createLinkedinMarketSource({ initializeSearch, collectSearch }).search(request)`

The request carries `owner`, `page`, `search` (`searchId`, `familyId`,
`seedExpression`, `query`, `queryLanguage`), `filters`, `limits` and `signal`.
The outcome is deeply frozen and JSON serializable:

- `status` — `COMPLETED` | `INTERRUPTED` | `CANCELLED` | `FAILED`. An
  interrupted search is **never** reported as completed.
- `search` — the identity above, echoed back.
- `requestedScope` / `observedScope` — see below.
- `results` — per-search, attributed, in card order.
- `metrics` — `rawCards`, `uniqueResults`, `duplicatesWithinSearch`,
  `pagesVisited`, `limitReached`.
- `stopReason`, `challenge`, `partial`, `startedAt`, `finishedAt`.

## Budget

Market Discovery defaults to `maxPages = 1`, `maxResults = 10`, and **hard-caps
both at those values for MD3b**. A larger value is rejected; it never widens the
search silently. A smaller value is accepted. These are Market Discovery limits
only: Hunter keeps its own 25 results / 2 pages from `src/config.js`.

## Scope: requested vs observed

Only the filters the existing collector already applies and verifies are
supported — `location`, `employmentType`, `datePosted`. Nothing new is invented
for seniority, modality or language. Each filter is reported as `VERIFIED`,
`UNVERIFIED` or `NOT_REQUESTED`. The existing verifier returns `null` when it
cannot map or confirm a requested filter; that becomes `UNVERIFIED`, never
"applied". The verifier's LinkedIn URL is deliberately **not** propagated — only
the boolean `verifiedAgainstUrl` survives.

## Per-search attribution

Every result carries `searchId`, `familyId` and the exact `query` that produced
it. Deduplication happens **within** a single search only, using the product's
canonical job identity (`jobId`, falling back to `url`). The adapter never
deduplicates across searches: if two searches both return job `123`, both
outcomes keep it, because that overlap is itself evidence for the future
exploration engine. Query language is recorded on the search, never on a
posting — a query expressed in English says nothing about the language of the
postings it returns.

## Ownership

Browsing uses the MD3a contract. The adapter **requires** an existing
`MARKET_DISCOVERY` owner and refuses every other operation type, including
`UNSPECIFIED`. It never acquires, never releases, and never opens or closes a
browser: the run owns the browser across many searches, so one stable
`operationId` spans the whole run and is not regenerated per query. The adapter
contains no lock primitive at all, which a structural test enforces.

## Interruption

`LOGIN_REQUIRED` and `CHECKPOINT_REQUIRED` map to `INTERRUPTED`, cancellation to
`CANCELLED`, anything else to `FAILED`. Cancellation is cooperative through the
existing `AbortSignal` convention and is converted to a structured outcome at
the adapter boundary so a multi-search engine can record which searches ran.
Challenge diagnostics are reduced to `{ code, source, signal, stage, at }`:
URLs, excerpts, selectors, HTML and error messages never cross the contract.

## Note on `firstChanged || true` (investigated, deliberately not changed)

`src/linkedin/searchScope.js` `changeSearchQuery()` gates on
`kwMatch && (firstChanged || true)`. `firstChanged` is computed and then
discarded, so the effective gate is `kwMatch` alone — the URL's `keywords`
parameter must become exactly the new query.

This is dead code, but the effective behavior is the safe reading. The comment
describes accepting the first-card change *as well*, i.e. `kwMatch ||
firstChanged`, which would be **weaker** than what runs today. The other
plausible intent, `kwMatch && firstChanged`, would be **wrong**: two overlapping
queries legitimately share a first card, so it would report a real query change
as failed. The consumer fails closed either way —
`src/linkedin/multiSearch.js` retries once and then skips collection with
`stopReason: 'query_change_failed'` rather than inheriting the previous
keyword's results.

No failure was reproduced, and reproducing one would require a real LinkedIn
session, which this checkpoint forbids. It is therefore recorded, not changed.

**Market Discovery does not depend on it.** Each MD search starts from a fresh
navigation (`initializeSearchWithFilters` → `openJobsSearch` → `page.goto`), not
from `changeSearchQuery`, so per-search attribution cannot inherit a previous
query's cards. With `maxPages = 1` the adapter also never reaches
`goToNextPage()`, whose separate `activeChanged || firstChanged` gate is sound.

## Tests

`npm run test:market-source` — deterministic, fixture-driven. No LinkedIn, no
Chromium, no network, no OpenAI.
