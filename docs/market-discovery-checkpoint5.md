# Market Discovery: checkpoint 5 (MD5) — bounded fair exploration engine

Composes MD1/MD2 (profile map + seed plan), MD3a (operation ownership), MD3b
(read-only LinkedIn source) and MD4 (compatibility + terminology) into the first
bounded exploration run. None of those contracts was changed; no existing file
was modified.

MD5 discovers and measures. It does not produce the final Hunter query
portfolio, does not diff against current config, does not apply anything, does
not schedule, and adds no UI.

## Guiding principle: breadth before depth

Hunter's discovery-order analysis once let one early query family consume most
of the analysis budget. Market Discovery must not repeat that, so:

1. **Every selected family is searched once before anything is evaluated.**
2. **Semantic evaluation is round-robin across families.** Each family
   contributes at most one *evaluation* per round. A duplicate posting costs no
   evaluation — it only advances that family's cursor — so the scarce resource
   is shared by real evaluations, not by queue position.

`src/tests/marketExploration.test.js` contains the named **FAIRNESS REGRESSION**:
family A returns 10 noisy `OUT_OF_SCOPE` postings, families B and C return 2
each containing the compatible evidence, and the semantic budget is 6. A
sequential engine would spend all 6 on A and find nothing. The fair engine
evaluates 2/2/2, discovers both B's and C's compatible evidence, and the
observed evaluation order is exactly `A,B,C,A,B,C`.

## Budget contract

All limits live in `src/marketDiscovery/explorationBudget.js`. Every one is a
**hard cap**: `resolveBudget` rejects anything larger, unknown keys, and
non-integers, and checks internal coherence (phase searches ≤ total, reserves ≤
total evaluations).

| Limit | Default = cap |
|---|---|
| families | 6 (enforced upstream by MD2) |
| total searches | 10 |
| initial searches | 6 |
| expansion searches | 4 |
| unique postings observed | 100 |
| semantic evaluations | 60 |
| initial evaluation reserve | 36 |
| expansion evaluation reserve | 24 |
| expansion depth | 1 |
| max duration | 45 min (injected clock; no real timers in tests) |
| source failures tolerated | 2 |
| semantic failures tolerated | 3 |
| per-search limits | `maxPages: 1`, `maxResults: 10` (MD3b's own caps) |

The engine never asks the source for more than `POLICY.searchLimits`, and it
introduces no retry loop of its own.

## Global dedup, local attribution

Postings are keyed by canonical LinkedIn identity (`jobId`), falling back to the
canonical URL MD3b already produces. Different jobs are never merged on title or
company similarity.

A posting seen by several searches is **evaluated once** but keeps every
attribution: `firstSearchId`, the full `searchIds` list and `familyIds`.
Cross-search overlap is reported in `overlaps`. A repeated posting therefore
cannot count as two independent compatible postings, and cannot inflate a term's
support — support is counted in *distinct posting identities*.

## Expansion

Candidates are aggregated from **`COMPATIBLE` postings only**, using terminology
MD4 marked `promotable`. A term is eligible when it has ≥2 distinct compatible
postings, and ≥2 distinct companies **when at least 2 of those postings declare a
company** (otherwise the company rule is waived and recorded as such — no
company is ever invented). A term identical to an already-executed query, or
matching an explicit profile exclusion, is rejected. Every candidate records why
it was or was not eligible and selected.

Ranking is deterministic and explainable: distinct compatible postings, then
distinct companies, then distinct families, then `ROLE_TITLE` before
`DISCRIMINATOR` (a role title is directly usable as a query in the way a seed
expression is; a discriminator describes context), then normalized text. **Hash
order is never a semantic priority** — the identifier only appears as the final
lexical tie-break. No LLM ranks expansion terms.

Selected terms run at depth 1. Terminology found in depth-1 results is recorded
as an observation but **never generates another search**: there is no recursive
queue and no depth 2.

**No compatibility inheritance.** Every expansion result goes back through the
same MD4 gate against the original profile map. A term drawn from compatible
postings can perfectly well return `OUT_OF_SCOPE` jobs, and it does — that case
is tested.

## Saturation

Exploration is saturated when **two consecutive completed searches** each have
overlap > 0.8 with already-observed postings **and** contribute no new
`COMPATIBLE` posting. A completed search returning nothing counts as overlap 1.
Interrupted and failed searches never enter the streak.

Saturation is checked after the initial breadth pass and after each expansion
search. It is deliberately **not** checked mid-breadth: giving every family its
one search is the stronger guarantee, and the breadth pass is capped at 6 anyway.

Saturation is never conflated with running out of budget. `BUDGET_EXHAUSTED` is
reported when a selected family got no search at all, or when the evaluation
allowance ran out with candidates still unevaluated.

## Interruption policy

| Condition | Status |
|---|---|
| normal end | `COMPLETED` (`partial: false`) |
| saturation rule met | `SATURATED` |
| search or evaluation budget short | `BUDGET_EXHAUSTED` |
| MD3b reports login wall | `LOGIN_REQUIRED` — stops at once |
| MD3b reports checkpoint | `CHECKPOINT_REQUIRED` — stops at once |
| cancellation observed | `CANCELLED` — no further source or evaluator call |
| 2 ordinary source failures | `SOURCE_FAILED` (LinkedIn is not hammered) |
| 3 semantic failures | `SEMANTIC_FAILED` |
| clock past the budget | `TIME_LIMIT` |

Every non-`COMPLETED` status sets `partial: true` and keeps the evidence gathered
so far. An isolated semantic failure is recorded against its posting, yields no
terminology, and the run continues.

Cancellation is checked before and after each search, before each evaluation,
before expansion planning and before each expansion search. The engine does
**not** own the browser lock — acquiring and releasing remains the future run
manager's job — so no interruption path releases ownership.

## Result ledger

The returned object is deeply frozen and answers, without reading engine
internals: families selected and omitted upstream, every search in execution
order with its family/origin/depth/status/overlap/new-compatible counts and
whether it counted toward saturation, every unique posting with all its search
and family attributions, the overlap set, every evaluation, every terminology
observation, every expansion candidate with eligibility and selection reasons,
source and semantic failures, and budget limits/policy/consumed/remaining.

## Persistence

None. MD5 is an in-memory deterministic engine returning an immutable ledger;
run-level persistence belongs to the future run manager.

## Tests

`npm run test:market-exploration` — deterministic, fixture-driven fakes for both
the source and the evaluator. No LinkedIn, no Chromium, no OpenAI, no network,
no real timers.
