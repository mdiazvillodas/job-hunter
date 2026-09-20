# Market Discovery: checkpoint 6 (MD6) — vocabulary state and query portfolio

Turns an immutable MD5 exploration ledger into an auditable market vocabulary
state, query candidates, and a proposed query portfolio.

**Pure transformation.** No LinkedIn, no OpenAI, no Chromium, no browser
ownership, no Hunter execution, no persistence, no UI — and above all **no
config mutation**. MD6 produces a *proposal*; changing Hunter's searches stays a
later, user-driven checkpoint. The result carries `applied: false`.

No existing file was modified.

## Two separate states, on purpose

A phrase can be legitimate market vocabulary and still be a poor LinkedIn query.
MD6 keeps those judgements apart:

- **Vocabulary state** — `PROMOTED` / `WATCH` / `REJECTED`: what the market says.
- **Query-use state** — `ELIGIBLE` / `INELIGIBLE`, plus a test state of
  `TESTED_POSITIVE` / `TESTED_NEGATIVE` / `UNTESTED`: whether that expression
  works as a search.

A noisy tested query is marked ineligible for query use **without** deleting the
term from the vocabulary.

## Evidence aggregation

Only grounded MD4 observations that are `promotable` **and** attached to a
`COMPATIBLE` posting are counted. Support is measured in **distinct canonical
posting identities**, so a posting found by three searches counts once, and three
mentions inside one posting count once. Each term keeps its observed variants,
types, source fields, posting/search/family identities, companies, and initial vs
expansion evidence split.

Company is never invented: `postingsWithCompany` records how many postings
actually declared one. **Language is never inferred** — MD4 never asserts a
posting's language, and the query that found it proves nothing, so every term
carries `language: null` with `languageEvidence: "not evidenced by the sample"`.

## Promotion policy (versioned, calibratable)

`vocabularyPolicy.js` holds every threshold under `POLICY_VERSION`. Changing a
threshold changes the proposal identity.

`PROMOTED` requires ≥3 distinct compatible postings and ≥2 distinct companies —
the company rule applying only when ≥2 of those postings declare a company.
Anything relevant but thinner stays `WATCH`. **`REJECTED` requires an affirmative
reason**; sparse evidence is never rejection. Today the only affirmative reason
is a match against an explicit profile exclusion.

The 3-posting / 2-company rule is a default evidence threshold, not a truth.

## Query test policy

Every **completed** search in the ledger — seed or expansion — is a controlled
query test. For each, MD6 derives sample size, unique postings, compatible /
uncertain / out-of-scope counts, compatibility ratio, incremental compatible
postings, and overlap with already-known evidence.

Positively validated requires sample ≥ 5, ≥ 60% compatible, and ≥ 2 incremental
compatible postings. Falling short is `TESTED_NEGATIVE` with the specific reason
(too small, noisy, or redundant). A term never executed is `UNTESTED` — no test
result is ever fabricated.

## Generic terms

No giant stopword list. A term is treated as too broad to stand alone when it
normalizes to a **single token** and either that token is in a small versioned
set of level/function words (in English and Spanish, no domain terms), or — the
evidence-driven half — the token appears as a component of ≥2 other observed
expressions in this sample. A generic term remains vocabulary; it is only
ineligible as a standalone query, with the reason recorded.

## Candidate generation

Candidates come from evidence, never imagination: executed seed expressions,
`PROMOTED` `ROLE_TITLE` terms, executed expansion terms, and role +
discriminator combinations **only where both were observed in the same ≥3
compatible postings**. No synonym chains, no LLM, no arbitrary pairings. Novel
combinations are marked `UNTESTED`. Exact normalized duplicates collapse into one
candidate that keeps every provenance.

## Portfolio selection

Deterministic greedy marginal coverage over compatible posting identities, never
a model or an opaque score. Targets: `targetMin` 8, `targetMax` 12, `hardMax` 15.
Returning fewer than 8 is valid and is explained in `warnings` — weak queries are
never manufactured to fill a quota.

At each step candidates with zero new coverage are dropped. A **diversity tier**
then applies: if any evidenced family is not yet represented and still offers new
coverage, it gets its opportunity before another redundant variant of an
already-covered family. Within the tier, ordering is positive test evidence →
new compatible postings → lower overlap → distinct companies → support →
normalized text. The diversity tier is an *opportunity*, not a fixed quota: once
a family is represented it competes normally, and a family adding nothing new
gets no query at all.

Redundancy is measured by evidence-set overlap (Jaccard), not by title string
similarity. Every unselected candidate records its reason and the selected query
it most overlaps with.

## Current Hunter queries

Optional comparison input, accepted as a flat list or as the `queryGroups` shape.
It is normalized and **never mutated**. Each current query gets a factual status:
`KEEP` (tested positive in this sample), `REVIEW` (tested, fell short — with the
real metrics), or `NOT_SUPPORTED_BY_THIS_SAMPLE`. Absence from a bounded sample
is never reported as failure; the note says plainly that this sample says nothing
about it.

## Proposal contract

Deeply frozen, carrying `schemaVersion`, `policy` (version + thresholds),
`sourceExploration` (operation id, status, partial flag, ledger hash),
`proposalId` (a deterministic hash of policy + ledger hash + targets + selection),
`applied: false`, `vocabulary`, `queryCandidates`, `selectedQueries`,
`unselectedCandidates`, `currentQueryComparison`, `evidenceCoverage` and
`warnings`. Each selected query explains its provenance, status, supporting
postings, companies, families, incremental coverage at selection, overlap and
`whySelected`.

Identical input yields an identical proposal and identity; a changed ledger
changes the identity.

## Persistence

None. A future run manager may persist proposals under
`DATA_DIR/market-discovery/proposals`; MD6 does not write.

## Tests

`npm run test:market-portfolio` — deterministic, fixture-driven, including a
realistic multi-family fixture with overlapping variants, a smaller genuinely
incremental family, Spanish and English terms, a generic term, one positively
tested and one noisy tested expansion, and duplicate postings across searches.
