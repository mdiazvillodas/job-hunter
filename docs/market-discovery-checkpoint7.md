# Market Discovery: checkpoint 7 (MD7) — run manager, API and persisted result

Makes Market Discovery executable end to end inside the existing application by
orchestrating MD1–MD6. It reimplements none of them.

Not the UI checkpoint, not apply-to-config, not scheduling, not Telegram, not
ntfy.

## Composition

```
start()  →  validate setup + profile (MD1 map, MD2 seed plan)
         →  acquire MARKET_DISCOVERY ownership (MD3a)
         →  open ONE persistent LinkedIn session
         →  MD5 exploration, driven by the MD3b source and the MD4 evaluator
         →  MD6 portfolio when compatible evidence exists
         →  persist artifacts
         →  close only its own browser  →  release its exact owner
```

It does **not** route through `huntRunManager`, does not call `runPipeline`,
does not import the Hunter Analyzer, and starts no second process or server.

## Run manager

`createMarketDiscoveryRunManager({...})` owns the lifecycle of one run and
exposes `start()`, `getStatus()`, `cancel()`, plus `stopAccepting()`,
`waitForIdle()`, `getRun(runId)` and `getProposal(runId)`.

Statuses: `IDLE`, `STARTING`, `RUNNING`, `CANCELLING`, `COMPLETED`, `CANCELLED`,
`INTERRUPTED`, `FAILED`. Reasons include `SETUP_REQUIRED`, `PROFILE_REQUIRED`,
`MARKET_DISCOVERY_ALREADY_RUNNING`, `RESOURCE_BUSY`, `LOGIN_REQUIRED`,
`CHECKPOINT_REQUIRED`, `SOURCE_FAILED`, `SEMANTIC_FAILED`, `TIME_LIMIT`,
`RUN_PERSISTENCE_FAILED` and `INTERNAL_ERROR`.

MD5's stop reason maps to the run outcome: `COMPLETED`/`SATURATED`/
`BUDGET_EXHAUSTED` → `COMPLETED`; `LOGIN_REQUIRED`/`CHECKPOINT_REQUIRED`/
`TIME_LIMIT` → `INTERRUPTED`; `SOURCE_FAILED`/`SEMANTIC_FAILED` → `FAILED`;
`CANCELLED` → `CANCELLED`. Login and checkpoint are never flattened into a
generic failure.

Only one run may be active: a second `start()` fails with
`MARKET_DISCOVERY_ALREADY_RUNNING`.

## Ownership and session

Ownership is acquired **before** the browser is touched — asserted by event
order in tests. The run uses **one** persistent context and page for every
search; the browser is never opened per query. Cleanup closes only what this run
opened, and the lock is released afterwards, always with the exact owner. That
holds on completion, cancellation, login, checkpoint, source failure, semantic
failure, time limit, and unexpected exceptions, because release lives in a
`finally`.

If another operation (`HUNT`, `MANUAL_SESSION`, `SESSION_PROBE`, `CLI_TOOL`, or
another `MARKET_DISCOVERY`) holds the resource, the run ends `FAILED` /
`RESOURCE_BUSY` without opening a browser, and the foreign lock is left
untouched. MD3a semantics are used as-is and never weakened.

## Profile and seeds

The configured profile reaches MD7 through MD1's `deriveCurrentProfile`; seeds
through MD2's `generateSeedPlan`. Both run **before** ownership and before
LinkedIn, so a missing or broken profile fails with `SETUP_REQUIRED` or
`PROFILE_REQUIRED` having opened nothing. Nothing is inferred to fill a gap.

## Exploration, portfolio and the partial policy

MD5 is called with the profile map, seed plan, owner, shared page, MD3b source,
MD4 evaluator, filters and the AbortSignal. MD6 is called **only when the
exploration produced at least one `COMPATIBLE` posting** — including partial
explorations, where the proposal inherits `sourceExploration.partial: true` and
MD6's own warning. With no compatible evidence, the run result is persisted and
**no proposal file is written**; nothing is fabricated.

`applied` is always `false`. MD7 has no config writer at all.

## Progress

Phases: `PREPARING`, `OPENING_LINKEDIN`, `INITIAL_SEARCH`, `INITIAL_EVALUATION`,
`EXPANSION`, `BUILDING_PORTFOLIO`, `PERSISTING`, `CLEANUP`, `DONE`.

Counters are real, never a synthetic percentage: searches completed and max,
initial vs expansion searches, unique postings, evaluations completed and max,
compatible / uncertain / out-of-scope, selected queries.

Progress is obtained by **wrapping the injected source and evaluator** inside the
manager, so MD5's public contract needed no change and no engine logic was
duplicated.

## Cancellation

An `AbortController` owned by the manager. `cancel()` is idempotent, sets
`CANCELLING`, aborts, and lets cleanup finish; the final state is `CANCELLED`.
No source or evaluator call happens after cancellation is observed — tested
before the first search, during a search and during an evaluation. Partial
evidence already gathered is persisted. Another operation's run or lock is never
affected.

## Persistence

Everything lives under `DATA_DIR/market-discovery/runs/<runId>/`:
`manifest.json`, `profile-map.json`, `seed-plan.json`, `exploration.json`,
`proposal.json` (only when one exists) and `result.json`.

`runStore.js` deliberately does not reuse MD1's repository — that one publishes a
single immutable profile+seeds snapshot under a strict schema, while a run needs
several artifacts written at different moments. What is reused is its safety
policy: run ids restricted to `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` with no path
separators, a closed allow-list of artifact filenames, symlink rejection along
the whole path, create-only run identity, and atomic temp-file + rename writes at
mode 0600.

Run ids are `mdrun_<16 hex>` and operation ids `md_<16 hex>` — random, unrelated
to time, and carrying no personal data. No cookies, no browser profile, no API
key, no Telegram token and no LinkedIn HTML are ever written, which a test
asserts by scanning every persisted byte.

## API

Added to the existing server with its existing conventions — no new server.

| Route | Behaviour |
|---|---|
| `POST /api/market-discovery/start` | 202 with the accepted run; **returns immediately**, does not await the run |
| `GET /api/market-discovery/status` | 200 with the immutable status snapshot |
| `POST /api/market-discovery/cancel` | 202 |
| `GET /api/market-discovery/runs/:runId` | 200, or 404 `RUN_NOT_FOUND` |
| `GET /api/market-discovery/runs/:runId/proposal` | 200, or 404 `PROPOSAL_NOT_FOUND` |

`runId` is validated against the same pattern before it can reach the filesystem;
an invalid one is 400 `INVALID_RUN_ID`. Busy returns 409
`MARKET_DISCOVERY_ALREADY_RUNNING`. Responses carry a stable code and a short
message — never a stack, a raw browser or provider error, a filesystem path or a
secret. Reads come from persisted artifacts, so a result survives the in-memory
run being gone.

## Shutdown

Graceful shutdown now also stops accepting Market Discovery runs, requests
cancellation, and waits for its cleanup with the same timeout as Hunt. It closes
only Market Discovery's own browser and releases only its own ownership; a
foreign lock is verified untouched. Hunt's existing shutdown behaviour is
unchanged.

## Tests

`npm run test:market-run` — deterministic, with injected source, evaluator,
session, clock, id generators and persistence root. No LinkedIn, no Chromium, no
OpenAI, no external network. Includes an end-to-end fake run proving the MD1→MD7
composition and that Hunter's config file is byte-for-byte unchanged.

---

# MD7.0.1 — strict configured geography

A correction found by the first controlled real run.

## The bug

`createServer` built the run manager without a `filters` option, so
`options.filters || {}` resolved to `{}`, MD3b normalized `location` to `null`,
and `initializeSearchWithFilters` skipped `applyLocationFilter` entirely. Every
search ran as a bare `?keywords=…` with no geographic scope, and LinkedIn
returned whatever market it chose.

**Run `mdrun_ce229f36dd9d09b3` is therefore INFRASTRUCTURE VALIDATION ONLY and
INVALID AS GEOGRAPHIC MARKET EVIDENCE.** Its lifecycle, ownership, fairness,
dedup and persistence findings stand; its market sample, compatibility counts,
terminology and query-overlap evidence must not be read as Barcelona evidence.
The artifacts are kept unmodified as diagnostic material; no migration is done.

## Location source

Market Discovery introduces **no second location setting**. It derives the scope
from the canonical `search.locations[0]` of the user configuration, resolved
**at run start** — not captured at server startup — so a configuration change
takes effect on the next run. No hardcoded city, no inference from the LinkedIn
account, no browser-profile fallback.

With no configured location the run fails with `LOCATION_REQUIRED` **before**
ownership is taken and before the browser opens. An unscoped search is never
performed.

## Discovery filter policy

The external scope is **query + configured location, and nothing else**.

| Filter | Market Discovery |
|---|---|
| location | **required**, from user config |
| datePosted | **not inherited** — a 7-day window would starve vocabulary evidence |
| employmentType | **not inherited** — this is market research, not fresh-job hunting |
| modality (`hybrid`) | **never a hard LinkedIn filter**; it stays semantic context in the MD1 profile map with `enforcement: 'unspecified'` |

Hunter is unchanged and keeps its own location + `Full-time` + `Past week`.

## Fail closed

When a location is requested and `observedScope.location !== VERIFIED`, MD3b
returns `INTERRUPTED` / `scope_not_verified` with **zero results**. MD5 maps that
to the stable reason `SCOPE_NOT_VERIFIED` — deliberately not collapsed into
`SOURCE_FAILED` — and MD7 reports `INTERRUPTED` / `SCOPE_NOT_VERIFIED`. No
posting from an unconfirmed market is ever evaluated, no terminology is
promoted, no expansion happens and no proposal is built.

## Auditability

Persisted search records now carry `requestedScope`, `observedScope` and
`metrics`, so "what location did this search ask for, and did LinkedIn confirm
it?" is answerable from artifacts alone. Persisted postings now carry `title`,
`location` and `url` alongside identity and attribution — the gap that made the
first geography audit inconclusive. Still no cookies, session, tracking
parameters or HTML; the verifier's internal LinkedIn URL remains inside the
LinkedIn layer.

## Tests

`npm run test:market-geography` — 11 deterministic tests, including a production
regression that drives the real wiring and asserts `filters.location` is the
configured value and never `null`/`undefined`/`""`, then proves an `UNVERIFIED`
scope lets **zero** postings reach semantic evaluation.

---

# MD7.1 — detail enrichment

The first real run produced **zero COMPATIBLE** postings because MD3b returns
card metadata only: MD4 saw `descriptionAvailable: false` everywhere and, per its
own grounding rule, correctly answered `UNCERTAIN`. MD7.1 supplies the missing
evidence **without touching MD4's gate**.

## Insertion point

Enrichment happens inside MD5's fair evaluation loop, on the single line where a
globally deduplicated candidate reaches its turn — after `picked.evaluated = true`
and immediately before the evaluator call. Never during search collection, never
for every card, never family-by-family in advance.

Consequences, all tested: a posting seen by three searches is enriched **once**;
a candidate never selected for evaluation gets **zero** detail fetches; and the
round-robin order is unchanged (`A,B,C,A,B,A`), so detail latency cannot reorder
or starve families.

## Reuse

`collectJobDetail` already existed in `src/linkedin/detailCollector.js` as the
single-posting unit but was not exported. MD7.1 exports it — a four-line additive
change with no behavioural effect — and `src/marketDiscovery/detailEnricher.js`
is a thin adapter over it. Hunter's `collectJobDetails` loop is untouched. The
adapter never imports the job repository, job service, Analyzer, pipeline or run
manager.

## Contract

`enrich(posting, context) -> { outcome, description, descriptionAvailable, ... }`
with outcomes `DETAIL_AVAILABLE`, `DETAIL_UNAVAILABLE`, `DETAIL_FAILED`,
`LOGIN_REQUIRED`, `CHECKPOINT_REQUIRED`, `CANCELLED`. The context carries the
**shared page**, the existing `MARKET_DISCOVERY` owner and the `AbortSignal`.

The enricher never launches a browser, creates a context, acquires or releases
ownership, or touches cookies — a structural test forbids those tokens outright.

## Geography stays authoritative

A search that is `SCOPE_NOT_VERIFIED` returns zero results, so no posting from it
ever enters the pool and therefore none can be enriched: **0 details, 0
evaluations, 0 expansions, 0 proposal**. The detail page's own location is kept
as posting data and explicitly never redefines the search scope. A tested
sequence proves search A → detail → search B still requests *and verifies* the
configured location on B.

## Budget and failure policy

`maxDetailFetches` defaults to 60 and automatically follows `maxEvaluations`
downward, so detail can never exceed the semantic budget; setting it higher
explicitly is rejected. One attempt per candidate, no retry loop. Counters:
attempted / available / unavailable / failed.

`DETAIL_UNAVAILABLE` and `DETAIL_FAILED` fall back to card-only evaluation —
nothing is invented — until **5** detail failures, at which point the run stops
with the stable reason `DETAIL_FAILED`. A challenge or login wall is never
degraded into a detail failure; both propagate as the existing interruptions.

## Persistence

Full descriptions are **not** persisted. Each posting records `detailAttempted`,
`detailOutcome`, `descriptionAvailable` and `descriptionLength` — enough to audit
what happened without storing job text — plus the run-level `detail` counters.
No HTML, cookies, headers, tracking or secrets, asserted by scanning every
persisted byte.

## Progress

Adds `detailFetchesAttempted`, `detailAvailable`, `detailUnavailable`,
`detailFailed` alongside all existing counters. No invented percentages.

## Tests

`npm run test:market-detail` — 17 deterministic tests, including a fixture built
on vocabulary observed in the first real run (`Project Manager Espacios
Comerciales`): the card alone stays `UNCERTAIN`, and only the grounded
description produces `COMPATIBLE`, which then yields promotable terminology, a
depth-1 expansion whose postings are *also* enriched before evaluation, and an
MD6 proposal with `applied: false`.
