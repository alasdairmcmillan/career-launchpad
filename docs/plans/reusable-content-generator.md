# Reusable Content Migration Generator — Implementation Plan

## Context

Adding new content to LaunchPad currently means writing a new Python
generator per batch. There are eight of them in `scripts/`, 2,768 lines
total, and the seed generators are ~90% the same code: identical `sql()`
quoting, near-identical row validation, and the same `do $$ … end $$`
upsert-plus-assertions SQL skeleton.

The immediate trigger is a request for two YouTube videos (Job Talks OYAP,
`hDxgwhLXS6A` and `BeD8CFlb0MA`). Under today's process that means a ninth
~300-line script for two rows. The point of this work is that the next
request costs a JSON file instead.

`docs/content-authoring.md:83` already anticipates this — it refers to
"`scripts/generate-long-term-care-migration.py` and any future
equivalents" — but nothing was ever extracted.

There is a second, larger problem this plan now also addresses: **28 of the
33 files in `supabase/migrations/` are pure data; only 5 touch schema.**
Content delivery has been riding on the schema migration mechanism. See
"Content stops being a migration" below.

## What the investigation found

Empirical, not assumed. Each existing generator was re-run against its
committed source data and the output diffed against the committed
migration.

1. **Thirteen committed migrations regenerate byte-identically**: all 11
   `*_reflection_*.sql` migrations, plus `20260617120000_print_nerd_videos.sql`
   and `20260522164318_mindsets_gumlet_videos.sql`. The generators are
   deterministic — no timestamps or environment leak into their output.
   This gives us a real golden-file harness for free.
2. **`generate-skills-canada-migration.py` differs by exactly one row.**
   `skills-canada-107`'s title was corrected after the fact (`9e5a061`,
   `b6a2ab0`); the JSON moved forward and the migration didn't. Explained,
   not a defect — but it disqualifies that batch as a golden file.
3. **`generate-long-term-care-migration.py` cannot run at all.** It exits 1:
   all 17 rows in `scripts/data/long-term-care-videos.json` lack
   `reflection`, which the generator requires. Those 17 reflections exist
   in `scripts/data/reflections/long-term-care.json` and shipped as a
   separate UPDATE migration (`20260521200441`). The database is correct —
   `20260521210000_enforce_content_reflection.sql` set the column `NOT NULL`
   and could not have succeeded otherwise. This is a source-file bookkeeping
   gap, not unfinished work: the batch file no longer describes the rows it
   produced, and the batch is not re-runnable.
4. **The reflection editorial rule exists in three places** —
   `preflight-reflections.py:44-47,145-170`,
   `generate-reflections-migration.py:26-29,104-128`, and
   `generate-print-nerd-migration.py:64-67,166-182`. The constants are
   byte-identical; the print-nerd copy has drifted in signature and error
   messages. Worse, the docstring at `preflight-reflections.py:146` claims
   "12-28 words" while the code enforces 20-50. All 279 authored reflections
   in the repo measure 30-48 words, so the stale docstring describes a rule
   that would fail the entire corpus.
5. **Column sets genuinely differ per batch.** The committed long-term-care
   migration inserts 12 columns — it has `video_duration` and `takeaway` but
   no `why_it_matters`, `planning_connection` or `reflection`; print-nerd
   inserts 15. The current LTC script would now emit 13, which is the same
   drift as finding 3. A shared renderer must treat the column list as
   derived from the rows, not fixed.
6. **The two seed migrations differ structurally**, which changes the design
   (see below): print-nerd asserts a *plural* set of required categories and
   writes multi-category links; mindsets asserts a *single* category, deletes
   a temporary `gumlet-bend-the-world-test` row first, and uses Gumlet URL
   and thumbnail templates with a hardcoded collection id.
7. **There are two quoting helpers doing one job.** `sql()` is byte-identical
   across all four seeders; `quote()` is byte-identical across all three
   updaters. They differ only in that `quote()` lacks the `None → null`
   branch and the `str()` coercion, so `sql()` subsumes it.
8. **Missing-field validation semantics fork.** Seeders use
   `not row.get(field)`, which rejects empty strings; updaters use
   `field not in row`, which accepts them. This is a real behavioural
   difference and unifying means picking one on purpose.
9. **The editorial rule can be enforced universally with no grandfathering.**
   Checked all 279 reflections that currently live in seed batch files or the
   reflections files against the full rule: **zero fail**. Mindsets' 21 pass
   even though its own generator only checks for non-blank. So strictness
   does not need to be a config knob.
10. **`load_env()` is triplicated too** — identical in all three preflight
    scripts, reading `.env.local` (not `.env`) relative to CWD, with
    `env.setdefault` so process env wins. The apply path needs it, so it
    moves into the shared module with everything else.

### The design consequence of finding 6

My first instinct was "reproduce both seed migrations byte-identically."
That is the wrong target. Making one renderer emit both, comment headers
and one-off temp-row deletion included, would require a config language
about as complicated as the code it replaces.

Migrations are immutable history. We never regenerate an applied migration —
the golden-file diff is a *correctness proof for the new generator*, not
something we re-commit. So:

- **`print_nerd_videos.sql` is the byte-identity target.** It is the newest
  and most complete seed shape, and it has already been reviewed and applied
  in production. If the new generator reproduces it exactly, it provably
  emits SQL of a shape we trust.
- **Mindsets/Gumlet is supported as a provider but not retrofitted.** Its
  temp-row deletion was a one-off and the new generator should not learn to
  emit it.

So of the 13 migrations that regenerate identically today, **12 become the
golden-file harness** (11 reflections + print-nerd). Mindsets stays a
semantic reference for the Gumlet templates only.

## Content stops being a migration

28 of 33 migrations are content. That has a visible cost: two entire
migrations (`9e5a061`, `b6a2ab0`) exist only to fix capitalisation and a
trailing `..` in one video title. A typo costs a migration, a review and a
manual apply; the 5 real schema changes are buried among 28 content loads;
and content editors cannot ship anything without an engineer.

So the generator gets an **apply mode**, and content stops being written into
`supabase/migrations/` at all:

| | Before | After |
|---|---|---|
| Schema change | migration | migration (unchanged) |
| New content batch | migration + manual apply | `--apply`, idempotent |
| Fix a typo | *another* migration | edit JSON, re-run `--apply` |
| Source of truth | migration file, then it drifts | batch JSON, re-runnable |

The important second-order effect: **re-running becomes the normal case
rather than something to avoid.** Both drift bugs we found (finding 2, the
skills-canada title; finding 3, the LTC reflections) are permanent today
precisely because nobody ever re-runs a batch. When re-applying is routine
and idempotent, that class of bug becomes self-correcting.

Consequences accepted deliberately:

- A database rebuilt from `supabase/migrations/` alone will have an empty
  `content` table. Rebuild becomes: apply schema migrations, then re-apply
  each batch. That is only viable because batches are self-describing and
  idempotent — which is exactly what Step 7 fixes for LTC.
- The existing 28 content migrations stay where they are. They are applied
  history; we do not rewrite them.
- `--apply` is not atomic (see the risk register). `--sql` remains available
  for anything you would rather run inside a transaction by hand.

## Scope

**In:**

- `scripts/launchpad_content.py` — shared module: `sql()` quoting, the single
  editorial-rule validator, common row validators, `load_env()`, the seed SQL
  renderer, audit printer.
- `scripts/generate-content-migration.py` — one config-driven seed generator
  with three modes: `--check`, `--sql`, `--apply`.
- Batch config moves into the batch JSON as a `meta` block.
- Retire the triplicated editorial rule; `generate-reflections-migration.py`
  imports the shared one (verifiable against 11 golden files).
- Backfill the 17 LTC reflections into `long-term-care-videos.json` so the
  batch is self-describing and re-runnable.
- Add `SUPABASE_SERVICE_ROLE_KEY` to `.env.example` — all three preflight
  scripts prefer it, the apply path requires it, and it is undocumented.
- Unit tests (stdlib `unittest`, no new dependency).
- Rewrite `docs/content-authoring.md` for the new flow.

**Out:**

- Regenerating, rewriting or deleting any already-applied migration.
- The preflight/UPDATE family (`preflight-*.py`,
  `generate-non-skills-copy-migration.py`, `generate-skills-canada-copy.py`).
  Those hit live Supabase and write rollback snapshots — a different pipeline
  with its own config axes. Phase 2 at the earliest.
- `generate-skilled-trades-migration.py` and the job-board retirement. These
  are one-off structural surgery with bespoke terminal-state assertions.
  They should stay bespoke; abstracting them would be actively harmful. Two
  things there are worth a separate ticket rather than this PR: its
  `sql_id_values`/`sql_pair_values` helpers do not escape apostrophes (latent
  only, because they quote ids and slugs), and `COMMON_CHECK_HELPERS` is dead
  code.
- `generate-skills-canada-migration.py`. 160 rows, drifted source, its own
  `title_original`/`title_clean`/`sheet_row` provenance fields. Leave it.
- An admin UI. That is the right eventual destination for content editing and
  it is a project, not a step in this one.

## Design

### Batch file shape

Config lives in the same file as the rows, so one file is the complete
source of truth for a batch and one file is what a reviewer reads:

```json
{
  "meta": {
    "label": "job-talks-oyap",
    "id_prefix": "oyap",
    "expected_count": 2,
    "provider": "youtube",
    "source_url": "https://www.youtube.com/@…",
    "sql_comment": "Seed Job Talks OYAP videos."
  },
  "rows": [ { "sequence": 1, "content_id": "oyap-001", … } ]
}
```

There is precedent: every `scripts/data/reflections/*.json` and most
`copy-updates/*.json` already use `{meta, rows}`. The four video batch files
are bare arrays with their counts hardcoded in the generator — exactly the
coupling this absorbs.

Note `meta.output` is gone from the shape above. Content no longer has a
migration path to pin; `--sql` takes an explicit `--output` when you want a
file, which is what the golden-file test uses.

### Derived, not configured

- **Column set** is derived from which optional fields are present in the
  rows (`video_duration`, `why_it_matters`, `planning_connection`,
  `takeaway`, `reflection`), emitted in a canonical fixed order, and
  validated as all-or-nothing across the batch. Less config, fewer ways to
  be wrong, and it reproduces both the 12-column and 15-column shapes.
- **Categories** normalise to a list internally. Accept `categories: []`;
  a single-element list is the scalar case. Assertion style follows
  cardinality.
- **Provider** (`youtube` | `gumlet`) drives id field, URL template and
  thumbnail validation, all keyed off `meta.provider`.

### Two behavioural choices to make on purpose

Both come out of finding 7/8 and neither should be decided by accident:

- **One quoting helper.** Keep `sql()` (with the `None → null` branch) and
  retire `quote()`. Every current `quote()` call site passes a non-None
  string, so the emitted SQL is unchanged — which the 11 reflection golden
  files will prove.
- **Strict missing-field checks.** Adopt the seeders' `not row.get(field)`
  everywhere, so an empty string is a validation failure rather than a row
  that writes `''` into a column that should hold real copy. This is stricter
  than the updaters are today; it cannot change output for data that already
  validates, only reject data that should never have passed.

### The three modes

| Mode | Network | Writes | Use |
|---|---|---|---|
| `--check` | none | nothing | CI, pre-commit, "is this batch valid" |
| `--sql [--output P]` | none | a `.sql` file (or stdout) | review, golden-file test, hand-apply in a transaction |
| `--apply` | Supabase | the database | the normal path for shipping content |

`--check` and `--sql` stay offline and dependency-free, which is what keeps
the golden-file harness meaningful.

### How `--apply` works

Same order of operations as the `do $$` block it replaces, over PostgREST
with `urllib.request` — no new dependency:

1. `load_env()` for `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Fail fast
   with a clear message if absent; never fall back to the anon key for a
   write.
2. Validate the batch fully (identical to `--check`). Nothing touches the
   network until validation passes.
3. `GET /categories?slug=in.(…)` to resolve every referenced slug to an id.
   Any missing slug aborts before a single write.
4. `GET /content?id=in.(…)` for the batch's ids and write a rollback snapshot
   to `scripts/data/rollbacks/<label>-<utc>.json` — prior state for rows that
   exist, recorded as absent for rows that don't. This mirrors what the
   preflight scripts already do, and it matters more here because there is no
   reviewed SQL file in the loop.
5. `POST /content` with `Prefer: resolution=merge-duplicates` — the upsert.
6. `POST /content_categories` with `Prefer: resolution=ignore-duplicates`.
7. Verify: re-read row count and link count, assert they match the batch's
   expectations, and print the same audit summary `print_audit` gives today.
8. `--revalidate` (opt-in) POSTs `/api/revalidate-launchpad-content` with
   `LAUNCHPAD_REVALIDATE_SECRET` so the change is visible immediately rather
   than up to 300s later. Opt-in, not automatic, so a scratch-DB run never
   pokes a deployed environment.

### Module import gotcha

Existing scripts are hyphenated (`generate-print-nerd-migration.py`), which
is not an importable module name. The shared module must be underscored —
`scripts/launchpad_content.py`. Running `python3 scripts/generate-*.py` from
the repo root puts `scripts/` on `sys.path[0]`, so a plain
`import launchpad_content` resolves with no packaging and no `sys.path`
manipulation. Keep every script stdlib-only and runnable from the repo root
with zero install; that property is worth protecting.

## Workflow

### Step 1 — Shared module, extracted verbatim

Move `sql()`, the editorial-rule validator, the common row validators and
`load_env()` into `scripts/launchpad_content.py`. Take the
`preflight-reflections.py:145-170` version of the editorial rule as canonical
(it carries the `({rid})` context in error messages) and drop the stale
docstring. Retire `quote()` in favour of `sql()`. Do not change behaviour in
this step.

Shared units confirmed byte-identical and safe to lift verbatim: `sql()`
(4 call sites), `quote()` (3), `load_env()` (3), the seeder `main()` (3),
`render_content_value()` for the full Learn More shape (2),
`render_category_value()` (2), the batch-level count/sequence/id/dedupe block
(3), the per-row duration, title length and slug regex checks (3), and the
`get diagnostics` rowcount assertion prose (3).

### Step 2 — Prove the extraction is safe

Point `generate-reflections-migration.py` at the shared module and
regenerate all 11 reflection migrations. Every one must stay byte-identical.
This is the cheapest possible proof that the extraction changed nothing.

### Step 3 — The generator, offline modes first

Write `scripts/generate-content-migration.py` with `--batch <path>`,
`--check` and `--sql [--output <path>]`. Both are offline and deterministic.
Get these right before touching the network.

### Step 4 — Prove it against print-nerd

Convert `scripts/data/print-nerd-videos.json` to `{meta, rows}` and run
`--sql --output` against it. Output must be byte-identical to
`supabase/migrations/20260617120000_print_nerd_videos.sql`. This is the
acceptance test for the whole design, and it is unaffected by the apply
work — the renderer is the same code either way.

### Step 5 — The apply path

Add `--apply` and `--revalidate` as specified above. Two things to get right
rather than fast:

- **Validate-then-network.** No request fires until the batch validates and
  every category slug resolves.
- **Rollback snapshot before the first write**, including recording rows that
  did not previously exist, so the snapshot describes how to get back for
  both new and updated rows.

Test it against a scratch Supabase project, never prod. Confirm that running
it twice in a row is a no-op the second time.

### Step 6 — Tests

`scripts/tests/test_launchpad_content.py`, run via
`python3 -m unittest discover -s scripts/tests`. Cover the editorial rule at
its boundaries (19/20/50/51 words, missing second person, missing `?`,
em-dash present), `sql()` quote escaping, slug and title-length rules,
provider URL/thumbnail validation, derived column-set consistency, and the
golden-file diff from Step 4. A shared module that every future batch depends
on needs tests; there are currently no Python tests in this repo.

The apply path's HTTP layer should be thin enough to test by faking the
request function — do not add a mocking library to do it.

### Step 7 — Backfill LTC, then documentation

Merge the 17 reflections from `scripts/data/reflections/long-term-care.json`
into the batch file, so the batch describes the rows that are actually live
and `--apply` on it is a verifiable no-op. That doubles as the most realistic
end-to-end test available: a batch whose expected result is "change nothing".

Then rewrite `docs/content-authoring.md`. It currently documents authoring
reflections and a migration-based pipeline; it needs to document one
generator, the three modes, the batch file shape, and the fact that content
no longer ships as a migration.

## Verification

Success criteria, all mechanical:

1. New generator reproduces `20260617120000_print_nerd_videos.sql`
   byte-for-byte via `--sql`.
2. All 11 `*_reflection_*.sql` migrations still reproduce byte-for-byte after
   the shared-module refactor.
3. `python3 -m unittest discover -s scripts/tests` passes.
4. The LTC batch validates and generates cleanly instead of exiting 1.
5. `--apply` against a scratch DB: correct row and link counts, the audit
   query from `docs/content-authoring.md` returns `missing_reflection = 0`,
   and the app renders the new content locally.
6. **`--apply` run twice changes nothing the second time.** Idempotency is
   the property the whole model rests on, so it is a test, not a hope.
7. `--apply` on the backfilled LTC batch reports zero changes against a DB
   that already has that content.
8. `npm run lint` and `npm test` unaffected — no TypeScript changes in this
   work.

## Risk register

| Risk | Mitigation |
|---|---|
| Refactor silently changes generated SQL | 12 byte-identical golden files; any drift fails immediately |
| **`--apply` is not atomic.** PostgREST has no multi-statement transaction, so content and links are two requests | Both steps are idempotent and the verify step runs after; a failure between them is fixed by re-running. For anything you want in one transaction, use `--sql` and apply it by hand. Rejected `psycopg` because it breaks the stdlib-only, zero-install property |
| A write to prod with no reviewed SQL in the loop | Rollback snapshot written before the first write; validation and category resolution happen before any request; `--apply` requires an explicit flag and a service-role key it will not infer |
| Service-role key handling | Never falls back to the anon key for writes; read from `.env.local` or process env only; `.gitignore` already covers `.env*.local`; document in `.env.example` without a value |
| Config schema grows to match the code it replaced | Column set and category cardinality are *derived*; only 6 meta keys are configurable; bespoke batches keep the escape hatch of a bespoke script |
| Content no longer reconstructible from migrations alone | Accepted and documented: rebuild is schema migrations plus a re-apply per batch, which the self-describing batch files make possible |
| A stale rollback snapshot is mistaken for a real one | Snapshots are timestamped per run rather than overwritten, unlike the preflight convention. Noted for phase 2: `copy-updates/skills-canada-life-skills-copy-rollback.json` has `previous_takeaway` equal to the applied `new_takeaway`, meaning that preflight was re-run after apply |
| Gumlet support is speculative | Provider is 2 templates keyed off one meta field, and mindsets proves the shape. If it looks like more than that during Step 3, cut it to YouTube-only |

## Decisions

Settled on review — no longer open:

1. **Config location** — same file as the rows.
2. **Phase 1 scope** — seed-only; the preflight/UPDATE family is untouched.
3. **Gumlet** — support both providers from the start.
4. **LTC backfill** — included in this work.
5. **Test runner** — stdlib `unittest`.
6. **Content stops shipping as a migration** — `--apply` is the normal path;
   `supabase/migrations/` goes back to being schema-only.

Decided inside Step 5, flagged here because they are trade-offs rather than
details: `--apply` accepts non-atomicity in exchange for staying
dependency-free; it writes a timestamped rollback snapshot before its first
write; and revalidation is opt-in rather than automatic.

## Files referenced

- `scripts/generate-print-nerd-migration.py` — template for the new generator
- `scripts/generate-mindsets-gumlet-migration.py:1` — Gumlet provider shape
- `scripts/preflight-reflections.py:145-170` — canonical editorial rule
- `scripts/preflight-reflections.py:173-182` — `load_env()` to share
- `scripts/generate-reflections-migration.py:104-128` — clone to retire
- `scripts/data/long-term-care-videos.json` — needs reflection backfill
- `supabase/migrations/20260617120000_print_nerd_videos.sql` — golden file
- `docs/content-authoring.md` — to be rewritten for the new flow
- `src/lib/content.ts:116` — `getVideoSource`, the consumer of `video_url`
- `src/lib/launchpad-content.ts:33` — the 300s `launchpad-content` cache tag
- `src/app/api/revalidate-launchpad-content/route.ts` — what `--revalidate` calls
- `.env.example` — add `SUPABASE_SERVICE_ROLE_KEY`

## Out of scope for this pass

- Preview-environment database access. Preview deployments currently throw
  `Missing SUPABASE_URL or SUPABASE_ANON_KEY` from
  `src/lib/supabase/server.ts:11-16` and render only a shell. Worth fixing —
  point Preview at a scratch project, not prod — but it is a Vercel
  configuration change, not part of this work.
- Local Supabase tooling. There is no `supabase/config.toml`, so
  `supabase start` is not initialised. A scratch cloud project is enough for
  this work.
- Article content. This generator seeds videos; articles need
  `article_embed_url`/`reading_time_minutes` and no batch has needed them
  since the historical Indeed seeds.

## How a fresh session should start

Read this plan, then `scripts/generate-print-nerd-migration.py` in full, then
run the golden-file check to confirm the baseline still holds:

```bash
python3 scripts/generate-print-nerd-migration.py --output /tmp/pn.sql
diff /tmp/pn.sql supabase/migrations/20260617120000_print_nerd_videos.sql
```

That diff must be empty before starting. Begin at Step 1.
