# Market Discovery: checkpoint 1

Local derivation only. These modules do not discover jobs, open browsers, call AI,
change queries, learn preferences or notify users. There is no UI or run manager.

## In-memory inspection

`deriveProfile({ profile, matchingProfile, careerContext, config })` is pure.
`deriveCurrentProfile()` uses the existing profile/config readers for the configured
DATA_DIR. Neither function writes data. Pass the resulting object to
`generateSeeds(profile)`. Both results are deeply frozen and JSON serializable.
Readers require the existing three profile files; absent files are not fabricated
or borrowed from another installation.

The projection includes evidenced capability statements, explicit targets and
responsibilities, desires, exclusions, geography, modality, seniority, structured
domains, unknowns and source pointers. Each projected array owns its own facts:
no two projected values share an object reference. Free-text source documents
should still be treated as private. Raw source input hashes are retained locally
for provenance, not exported.

Identity/contact keys are not copied. URLs, email addresses and phone-like
sequences are redacted first, then known names. A known name is redacted as a
whole name and as each of its meaningful components, so a configured full name
does not leave its given name or surnames in the text. Matching uses
Unicode-aware word boundaries, so vocabulary that merely starts with a name is
untouched: a person called `Al` does not turn `Alignment` into `[person]ignment`.
Components shorter than three characters, and connective particles such as `van`
or `del`, are only redacted as part of the whole name, never on their own.

Missing evidence never becomes an exclusion. Learned preferences and the legacy
matching capability bucket names are not used. Domain information is only
projected from explicit structured fields: a domain is not guessed from titles.
Source languages are retained when explicit; otherwise `und` means undetermined.
The model does not convert a stored workplace preference into a mandatory filter.

## Seeds and limitations

Explicit target roles/responsibilities are preferred. If absent, evidenced
capability statements can supply hypotheses. Current query strings are not copied.

An expression is reduced to a canonical concept: case/accent/punctuation
normalization, token-order normalization, and removal of level-only modifiers
(`senior`, `sr`, `snr`, `junior`, `jr`, `jnr`, `principal`). Role-defining words
are deliberately **not** stripped, because they change the concept rather than
the level: `Project Manager` and `Manager` are separate families, as are
`Technical Lead` and `Lead`. If stripping would leave no tokens, the un-stripped
tokens are used instead, and failing that the expression itself; an explicit
target can therefore never disappear through normalization.

Two expressions share a family only when their canonical concepts are *equal*.
Equality is an equivalence relation, so a third expression cannot bridge two
distinct concepts into one family: given `Architect`, `Retail Architect Manager`
and `Manager`, the three stay three families and the two endpoints keep the same
family IDs they would have without the middle expression. This handles reordered
and level variants without a profession dictionary, and is deliberately not
general multilingual synonym understanding.

IDs are deterministic hashes of canonical concept tokens, not list positions.
Reordering variants or adding a level modifier does not change IDs; materially
changing a concept does. Distinct concepts retain distinct family IDs for future
fair budget allocation. No allocation or exploration is implemented.

At most six concepts are selected; an empty or sparse input yields fewer. The
family ID never decides which families survive the cap. Families are ranked by,
in order: evidence category (explicit targets before desires before demonstrated
evidence), number of distinct evidence items, number of supporting expressions,
position in the profile, and only as a final tie-break the family ID. Each seed
carries its `rank` and its `support` count, and `reason` states why it ranked
where it did. `generateSeedPlan(profile)` returns the same seeds plus
`familiesConsidered`, `familiesSelected`, `truncated`, the documented `priority`
order, and `omittedFamilies` — the ranked families the cap excluded, with their
IDs and expressions, so truncation is never silent. `generateSeeds(profile)` is
that plan's `seeds`. Only the seeds are persisted at this checkpoint.

## Optional isolated persistence

`createRepository({ dataDir }).save(id, profile, seeds)` creates one versioned
snapshot at `dataDir/market-discovery/<id>.json`. Omitting dataDir uses runtime
DATA_DIR. `get(id)` validates and freezes a snapshot without creating directories.
IDs cannot contain paths. Linked persistence directories are rejected.
Publication uses a temporary file plus an atomic, create-only hard link. Existing
IDs cannot be overwritten. Filesystems without hard-link support fail explicitly;
there is no unsafe fallback. There is no deletion, migration or overwrite API.
This provides atomic visibility, not a promise of durability across power loss.

Only profile and seed snapshots are stored at this checkpoint. Packaging keeps
excluding runtime-data and tests, including Market Discovery snapshots/fixtures.

Run `npm run test:market-discovery` for deterministic fixture tests. It is also
included in the complete test suite. No real user data is needed by those tests.
