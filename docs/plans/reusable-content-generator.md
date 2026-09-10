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
   separate UPDATE migration (`20260521200441`). Net effect: that batch file
   no longer describes the rows it produced, and the batch is not
   re-runnable.
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
   Checked all 38 reflections that currently live in seed batch files or the
   LTC reflections file against the full rule: **zero fail**. Mindsets' 21
   pass even though its own generator only checks for non-blank. So strictness
   does not need to be a config knob.

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

## Scope

**In:**

- `scripts/launchpad_content.py` — shared module: `sql()` quoting, the single
  editorial-rule validator, common row validators, the seed SQL renderer,
  audit printer.
- `scripts/generate-content-migration.py` — one config-driven seed generator.
- Batch config moves into the batch JSON as a `meta` block.
- Retire the triplicated editorial rule; `generate-reflections-migration.py`
  imports the shared one (verifiable against 11 golden files).
- Backfill the 17 LTC reflections into `long-term-care-videos.json` so the
  batch is self-describing and re-runnable.
- Add `SUPABASE_SERVICE_ROLE_KEY` to `.env.example` — all three preflight
  scripts prefer it and it is undocumented.
- Unit tests (stdlib `unittest`, no new dependency).
- Update `docs/content-authoring.md` to document the one generator.

**Out:**

- Regenerating or rewriting any already-applied migration.
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
    "sql_comment": "Seed Job Talks OYAP videos.",
    "output": "supabase/migrations/<ts>_job_talks_oyap_videos.sql"
  },
  "rows": [ { "sequence": 1, "content_id": "oyap-001", … } ]
}
```

There is precedent: every `scripts/data/reflections/*.json` and most
`copy-updates/*.json` already use `{meta, rows}`. The four video batch files
are bare arrays with their counts hardcoded in the generator — exactly the
coupling this absorbs.

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
  that writes `''` into a `NOT NULL`-ish column. This is stricter than the
  updaters are today; it cannot change output for data that already
  validates, only reject data that should never have passed.

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

Move `sql()`, the editorial-rule validator, and the common row validators
into `scripts/launchpad_content.py`. Take the
`preflight-reflections.py:145-170` version as canonical (it carries the
`({rid})` context in error messages) and drop the stale docstring. Retire
`quote()` in favour of `sql()`. Do not change behaviour in this step.

Shared units confirmed byte-identical and safe to lift verbatim: `sql()`
(4 call sites), `quote()` (3), the seeder `main()` (3), `render_content_value()`
for the full Learn More shape (2), `render_category_value()` (2), the
batch-level count/sequence/id/dedupe block (3), the per-row duration, title
length and slug regex checks (3), and the `get diagnostics` rowcount
assertion prose (3).

### Step 2 — Prove the extraction is safe

Point `generate-reflections-migration.py` at the shared module and
regenerate all 11 reflection migrations. Every one must stay byte-identical.
This is the cheapest possible proof that the extraction changed nothing.

### Step 3 — The generator

Write `scripts/generate-content-migration.py`:
`--batch <path> [--output <path>] [--check]`. `--check` writes nothing and
exits non-zero on any validation failure, for CI or a pre-commit hook later.

Default the output filename to the updaters' convention —
`supabase/migrations/{utc_stamp}_{label}_videos.sql` — rather than the
seeders' hardcoded path, so a new batch cannot collide with an existing
migration. `meta.output` stays available to pin an exact path, which is what
Step 4 needs in order to reproduce the print-nerd golden file.

### Step 4 — Prove it against print-nerd

Convert `scripts/data/print-nerd-videos.json` to `{meta, rows}` and run the
new generator against it. Output must be byte-identical to
`supabase/migrations/20260617120000_print_nerd_videos.sql`. This is the
acceptance test for the whole design.

### Step 5 — Tests

`scripts/tests/test_launchpad_content.py`, run via
`python3 -m unittest discover -s scripts/tests`. Cover the editorial rule at
its boundaries (19/20/50/51 words, missing second person, missing `?`,
em-dash present), `sql()` quote escaping, slug and title-length rules,
provider URL/thumbnail validation, derived column-set consistency, and the
golden-file diff from step 4. A shared module that every future batch depends
on needs tests; there are currently no Python tests in this repo.

### Step 6 — Backfill LTC and update docs

Merge the 17 reflections from `scripts/data/reflections/long-term-care.json`
into the batch file. The batch then regenerates a migration that differs from
the committed one only by including `reflection` values already applied by
`20260521200441` — so re-applying it is a semantic no-op, which is the
correct end state. Then update `docs/content-authoring.md` to document one
generator instead of "any future equivalents".

## Verification

Success criteria, all mechanical:

1. New generator reproduces `20260617120000_print_nerd_videos.sql`
   byte-for-byte.
2. All 11 `*_reflection_*.sql` migrations still reproduce byte-for-byte after
   the shared-module refactor.
3. `python3 -m unittest discover -s scripts/tests` passes.
4. `generate-long-term-care-migration.py`'s batch (via the new generator)
   exits 0 instead of 1.
5. `npm run lint` and `npm test` unaffected — no TypeScript changes in this
   work.
6. For the actual OYAP batch: generated SQL reviewed by hand, applied to a
   Supabase **branch** first, audit query from `docs/content-authoring.md:71`
   returns `missing_reflection = 0`, then production.

## Risk register

| Risk | Mitigation |
|---|---|
| Refactor silently changes generated SQL | 12 byte-identical golden files; any drift fails immediately |
| Config schema grows to match the code it replaced | Column set and category cardinality are *derived*; only 6 meta keys are configurable; bespoke batches keep the escape hatch of a bespoke script |
| A stale rollback snapshot is mistaken for a real one | Out of scope here, but noted: `copy-updates/skills-canada-life-skills-copy-rollback.json` has `previous_takeaway` equal to the applied `new_takeaway`, meaning that preflight was re-run after apply. Phase 2 should guard this |
| Gumlet support is speculative | Provider is 2 templates keyed off one meta field, and mindsets proves the shape. If it looks like more than that during Step 3, cut it to YouTube-only |
| New generator used on prod before review | Step 6 applies to a Supabase branch first |

## Required decisions before coding

Answer these on review — I have a recommendation for each and will not
assume silently.

1. **Config location.** Same file as rows (**recommended** — one reviewable
   artefact per batch, matches existing `{meta, rows}` precedent) vs a
   separate manifest.
2. **Phase 1 scope.** Seed-only (**recommended** — it is what the OYAP
   request needs, and the UPDATE family is a genuinely different pipeline)
   vs also unifying preflight/UPDATE now.
3. **Gumlet.** Support both providers from the start (**recommended**, it is
   cheap and already proven) vs YouTube-only until a Gumlet batch appears.
4. **LTC backfill.** Include in this PR (**recommended** — the 17
   reflections are already written and it fixes a broken generator) vs a
   separate follow-up.
5. **Test runner.** Stdlib `unittest` (**recommended** — preserves
   zero-install) vs adding pytest and a `requirements-dev.txt`.

## Files referenced

- `scripts/generate-print-nerd-migration.py` — template for the new generator
- `scripts/generate-mindsets-gumlet-migration.py:1` — Gumlet provider shape
- `scripts/preflight-reflections.py:145-170` — canonical editorial rule
- `scripts/generate-reflections-migration.py:104-128` — clone to retire
- `scripts/data/long-term-care-videos.json` — needs reflection backfill
- `supabase/migrations/20260617120000_print_nerd_videos.sql` — golden file
- `docs/content-authoring.md:81-83` — doc section to update
- `src/lib/content.ts:116` — `getVideoSource`, the consumer of `video_url`
- `.env.example` — add `SUPABASE_SERVICE_ROLE_KEY`

## Out of scope for this pass

- Any change to how migrations are applied. There is still no
  `supabase/config.toml` and no CI that applies them; that is a separate
  conversation.
- Cache revalidation. `POST /api/revalidate-launchpad-content` already
  exists and needs no change.
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
