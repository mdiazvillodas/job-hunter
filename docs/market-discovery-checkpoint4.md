# Market Discovery: checkpoint 4 (MD4) — compatibility gate and grounded terminology

The semantic interpretation layer. It assesses **one** posting against **one**
immutable MD1 profile map and returns, in a single structured response:
compatibility, grounded evidence, and observed market terminology.

It does not explore, does not expand seeds, does not aggregate, does not promote
vocabulary, does not persist, and does not add UI. No existing file was modified.

## Not the Job Analyzer

Hunter's `src/ai/jobAnalyzer.js` answers "should this candidate apply?" — a
product decision with `YES/MAYBE/NO`, four 0-100 scores and a CAN SELL
dimension. MD4 answers "is this posting close enough to learn market vocabulary
from?". The two must not converge, so MD4 **does not import the Analyzer** and
reproduces none of its output contract. A test asserts the Analyzer module is
never even loaded.

What is reused is the *house convention*, not the contract: OpenAI Chat
Completions with Structured Outputs (`json_schema`, `strict: true`), an
injectable `transport` so tests never touch the network, `AbortSignal` plus a
timeout, a trusted SYSTEM prompt with untrusted USER data, and never logging the
API key. The ~40-line default transport is deliberately duplicated rather than
imported, because importing it would couple Market Discovery to the Analyzer
module it must stay independent of. Same stack, separate contract.

## Compatibility contract

`classification` ∈ `COMPATIBLE` | `UNCERTAIN` | `OUT_OF_SCOPE`.

`dimensions` covers `capabilities`, `responsibilities`, `domain`, `direction`,
`seniority`, `exclusions`, `geography`, `modality`; each is `SUPPORTS`,
`NEUTRAL`, `CONFLICTS` or `UNKNOWN`. The result also carries `rationale`,
`uncertaintyReasons`, grounded `evidence`, `terminology`, `dropped` counts,
`provenance`, `identity` and `modelUsed`. There is no score and no YES/MAYBE/NO.

**Absence is not conflict.** Missing seniority, missing modality and an
unmentioned domain are `UNKNOWN`, never `CONFLICTS`. Profile `unknowns` travel
as open questions, never as negatives. A posting with neither a usable title nor
a description is `UNCERTAIN` **without calling the model at all**.

## Drift protection

Three independent mechanisms, two of them deterministic:

1. **The query never reaches the model.** The seed/family/query that found the
   posting is provenance, not truth, so `postingPayload` omits it entirely and
   the result attaches it afterwards. Query-driven compatibility is structurally
   impossible, not merely discouraged.
2. **Deterministic post-checks that fail closed.** `COMPATIBLE` requires
   `capabilities === SUPPORTS` or `responsibilities === SUPPORTS`; a `CONFLICTS`
   on any dimension forbids `COMPATIBLE`; `exclusions === CONFLICTS` forces
   `OUT_OF_SCOPE`; and `COMPATIBLE` requires at least one grounded evidence
   snippet. Sharing a generic word ("manager", "development") with the seed
   cannot survive these rules.
3. **Prompt rules** naming the drift pattern explicitly.

So `Store Development → Business Development → Sales Manager` cannot walk
through this gate on lexical overlap alone.

## Terminology

`ROLE_TITLE` — an expression actually used in the posting as a role or title.
`DISCRIMINATOR` — an expression identifying the professional context: domain,
industry, work type, project type or responsibility context.

**Grounding.** Every evidence snippet and every terminology expression is
verified by the code to occur literally in the field the model named, matched
case-insensitively against the exact sanitized text that was sent. Each
observation stores `expression` (the posting's own text, not the model's
casing), `normalized`, `sourceField`, `offset`, `length`, `postingId`,
`searchId` and `familyId` — enough to re-verify independently. Anything not
found is **dropped and counted**, never repaired into something similar.

**Known limit, stated plainly:** grounding proves *presence*, not *legitimacy*.
A posting whose description contains a planted phrase can have that phrase
extracted, because it genuinely is in the posting. What injected text cannot do
is change the classification — the deterministic rules above own that — and
terminology from a non-`COMPATIBLE` posting is never promotable. Frequency and
cross-company corroboration in a later checkpoint are what turn an observation
into vocabulary.

## Eligibility gate

| classification | terminology |
|---|---|
| `COMPATIBLE` | retained, `eligibility: ELIGIBLE`, `promotable: true` |
| `UNCERTAIN` | retained as review evidence, `REVIEW_ONLY`, `promotable: false` |
| `OUT_OF_SCOPE` | discarded entirely |

No global promotion state exists in MD4: no counts, no `WATCH`/`PROMOTED`, no
expansion queries, no portfolio scoring. Those belong after individual
observations are trustworthy.

## Untrusted input

Posting content is data. The SYSTEM prompt states it, the USER message wraps it
in `<posting_data>`, and the model's reply is validated against a closed schema:
unknown fields, unknown enum values, a mismatched `postingId`, a `sourceField`
outside `{title, description}`, malformed JSON or a model refusal all fail
closed. Descriptions are stripped of control characters, whitespace-collapsed
and truncated deterministically at 12000 characters; titles at 300.

## Request boundaries and cache identity

One posting, one request, `temperature: 0`, `top_p: 1`, a 60 s default timeout
and cooperative `AbortSignal` cancellation. No AI call is made when the posting
is deterministically unusable.

`identity` carries `postingHash`, `profileHash`, `model`, `promptVersion`,
`classifierVersion`, `schemaVersion` and a combined `cacheKey`, so the same
posting, profile, model and prompt reproduce the same key. MD4 does not
implement a cache — it makes one buildable.

## Persistence

None. MD4 returns immutable results and leaves run-level persistence to MD5, so
nothing was added under `DATA_DIR/market-discovery`.

## Tests

`npm run test:market-semantic` — deterministic, fake transports, synthetic
profiles and postings. No OpenAI, no LinkedIn, no Chromium, no network.
