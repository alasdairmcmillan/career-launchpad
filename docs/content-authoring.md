# Content authoring

Learn More content — the videos and articles behind each category — is
authored as JSON and applied with one generator. **Content is no longer
shipped as a database migration.** `supabase/migrations/` is for schema
changes; a content batch is a re-runnable JSON file.

| | Schema change | Content batch |
|---|---|---|
| Lives in | `supabase/migrations/*.sql` | `scripts/data/<batch>.json` |
| Ships via | migration, applied once | `--apply`, idempotent, re-runnable |
| Fix a typo | new migration | edit the JSON, re-run `--apply` |

The 28 content migrations already in `supabase/migrations/` are applied
history and stay where they are. Nothing new joins them.

> **Rebuilding a database from scratch** means applying the schema migrations
> and then re-applying each batch. `scripts/bootstrap-local-db.py` does both.

---

## The generator

One script handles every batch: `scripts/generate-content-migration.py`.
It has three modes, and the first two are completely offline.

| Mode | Network | Writes | Use |
|---|---|---|---|
| `--check` | none | nothing | CI, pre-commit, "is this batch valid" |
| `--sql [--output P]` | none | a `.sql` file (or stdout) | review, or apply by hand |
| `--apply` | Postgres | the database | the normal path for shipping content |

```bash
# Validate. Always start here.
python3 scripts/generate-content-migration.py \
  --batch scripts/data/<batch>.json --check

# See the SQL it would run.
python3 scripts/generate-content-migration.py \
  --batch scripts/data/<batch>.json --sql

# Ship it.
python3 scripts/generate-content-migration.py \
  --batch scripts/data/<batch>.json --apply --revalidate
```

Every script here is stdlib-only and runs from the repo root with no install.
Please keep it that way.

### `--apply` in detail

1. Validates the batch in full. **Nothing touches the database until it passes.**
2. Reads the current state of the batch's rows and writes a timestamped
   rollback snapshot to `scripts/data/rollbacks/<label>-<utc>.json`, recording
   both prior values and which rows did not yet exist.
3. Applies the upsert **in a single transaction** via `psql`, so content rows
   and category links commit together or not at all. A missing category slug
   aborts the whole thing.
4. Re-reads row and link counts and checks them against the batch.
5. `--revalidate` (opt-in) posts to `/api/revalidate-launchpad-content` so the
   change is visible immediately instead of up to 300s later.

`--apply` is **idempotent**: running it twice changes nothing the second time.
That is what makes re-running a batch the normal case rather than something to
avoid, and it is covered by a test.

Applying to a non-local database prompts for confirmation; pass `--yes` in CI.

---

## Batch file shape

Config lives in the same file as the rows, so one file is the complete source
of truth for a batch and one file is what a reviewer reads.

```json
{
  "meta": {
    "label": "print-nerd",
    "id_prefix": "print-nerd",
    "expected_count": 6,
    "provider": "youtube",
    "source_url": "https://www.youtube.com/@CanadianPrintScholarships/shorts",
    "sql_comment": "Seed \"Print Nerd\" YouTube shorts (Canadian Print Scholarships)."
  },
  "rows": [
    {
      "sequence": 1,
      "content_id": "print-nerd-001",
      "slug": "swatch-books-choosing-paper",
      "title": "Swatch Books: How Printers Pick the Right Paper",
      "description": "…",
      "categories": ["emerging-careers", "on-the-job"],
      "youtube_id": "gSRTIpqDKow",
      "url": "https://www.youtube.com/watch?v=gSRTIpqDKow",
      "orientation": "vertical",
      "duration_seconds": 61,
      "thumbnail_url": "https://img.youtube.com/vi/gSRTIpqDKow/maxresdefault.jpg",
      "why_it_matters": "…",
      "planning_connection": "…",
      "takeaway": "…",
      "reflection": "…"
    }
  ]
}
```

### `meta`

| Key | Required | Notes |
|---|---|---|
| `label` | yes | Appears in assertion messages and snapshot filenames |
| `id_prefix` | yes | **Permanent.** `content_id` must be `<id_prefix>-001`, `-002`, … |
| `expected_count` | yes | Must equal `len(rows)` |
| `provider` | yes | `youtube` or `gumlet` |
| `source_url` | no | Rendered into the SQL header comment |
| `sql_comment` | yes | First line of the generated SQL |

> **`id_prefix` is the upsert key.** It becomes the permanent `content_id` for
> every row. Changing it later orphans rows rather than renaming them, so
> confirm it with the requester *before* creating the batch file.

### Rows

Always required: `sequence`, `content_id`, `slug`, `title`, `description`,
`url`, `orientation`, `thumbnail_url`, plus the provider's id field
(`youtube_id` or `gumlet_id`).

`categories` is a list of known category slugs. A single-category batch may
write `"category": "on-the-job"` instead; it normalises to a one-element list.

**Optional columns are derived, not configured.** If a batch has
`duration_seconds`, `why_it_matters`, `planning_connection`, `takeaway` or
`reflection`, those columns are written. Each is all-or-nothing across the
batch: present on every row or on none. Half a batch with `takeaway` is a
validation error, not a partial write. This is how the same renderer produces
both the 12-column long-term-care shape and the 15-column print-nerd shape.

Validation is strict: an empty string is a failure, not a value.

---

## Reflections

Every piece of Learn More content ships with a **Reflection** prompt. It
appears below the Key Takeaway in the Learn More modal and asks the student to
apply what they just saw to their own "life after high school" decisions.

`reflection` is `NOT NULL` on `public.content` with a
`CHECK (length(trim(reflection)) > 0)` constraint, so a row without one cannot
be inserted.

### Editorial rule

**Scaffolded prompt.** Two parts in one short paragraph: (1) a framing sentence
naming the tension or context the content surfaced, and (2) an open question
tied to the student's own life-after-high-school decisions. 20–50 words.
Second-person ("you"/"your" must appear). Ends with a question mark. No
em-dashes. No journaling commands ("write down…", "list three…") unless the
batch is intentionally action-oriented.

Anchor the question in *choice, exploration, skill, path, experiment,* or
*next step*.

The rule is enforced in exactly one place —
`launchpad_content.validate_editorial_rule` — and applies to every batch with
no grandfathering. All 279 reflections currently in the repo pass it.

#### Good examples (✅)

1. *Schools and workplaces are both figuring out where AI fits. As you think about your next step after high school, where do you want to be the one doing the thinking, and where would you welcome a tool to help?*
   42 words. Framing names the AI/work tension; question pivots to the student's own role.
2. *Most adults you know did not follow their original plan. When you imagine your own next five years, does it feel safer to pick one path now, or to design your first experiment?*
   33 words. Framing normalises non-linear paths; question forces a stance.
3. *Plans change, but skills travel. As you think about life after high school, which skill on this list do you feel you already have, and which one do you want to grow on purpose?*
   34 words. Framing teases the takeaway; question makes it concrete.

#### Bad examples (❌)

1. *Reflect on the video.* — 4 words. Closed. No framing, no anchor.
2. *Write down three things you learned, then list two skills you want to develop, and finally describe a goal for next year.* — A journaling command stacked into one sentence. Not a question; not scaffolded.
3. *What did you think about the video?* — 8 words. No framing, no anchor, generic. Fails even though it ends in a question mark.

### Editing reflections on existing content

For content that is already live, reflections are still authored separately in
`scripts/data/reflections/<label>.json` and applied with
`scripts/preflight-reflections.py` + `scripts/generate-reflections-migration.py`.
That pipeline is unchanged.

For **new** batches, put the reflection straight in the batch row. There is no
reason to split it out.

---

## Local setup

`--apply` needs a Postgres connection string, not a Supabase API key. Supabase
exposes a direct connection string, so the same code path serves a local
database and the deployed project.

```bash
# 1. Connection string in .env.local (NOT .env — that is what the scripts read).
#    DATABASE_URL=postgresql://postgres:<password>@localhost:5432/launchpad_local

# 2. Build a local database matching the deployed schema.
python3 scripts/bootstrap-local-db.py        # --drop to start clean
```

`bootstrap-local-db.py` creates the database, creates the `anon`,
`authenticated` and `service_role` roles the migrations grant to, then applies
the historical ContentHub migrations followed by everything in
`supabase/migrations/`. Stock Postgres is enough — the only Supabase-specific
things in those files are `gen_random_uuid()` (core since Postgres 13) and
those role grants.

`psql` must be on `PATH`. On Windows the script also looks in
`C:\Program Files\PostgreSQL\<version>\bin` automatically.

### Two things a local database cannot give you

**Three migrations are skipped as unreproducible.** The historical seeds
create rows and categories with `gen_random_uuid()`, and later migrations
hardcode the ids the deployed database happened to generate. Nothing can
reproduce those ids, so `reflection_articles`,
`reflection_non_skills_videos` and `rename_skills_canada_to_skilled_trades`
are skipped, and the 75 rows they would have touched get a clearly-marked
placeholder reflection so the `NOT NULL` constraint can still be applied. The
list and the reasoning live in `UNREPRODUCIBLE` in the bootstrap script.

This is a pre-existing property of the migration history, not of the content
generator — and it is precisely why batch files use deterministic
`content_id`s like `print-nerd-001`. A batch applied by `--apply` *is*
reproducible on any database.

**The app cannot read your local Postgres.** `src/lib/supabase/server.ts`
talks to Supabase over PostgREST using `SUPABASE_URL` and
`SUPABASE_ANON_KEY`, not a Postgres connection. So `--apply` against a local
database is verifiable at the SQL level — row counts, links, idempotency —
but rendering the result in the running app needs a Supabase project (or a
local PostgREST pointed at your database).

---

## Tests

```bash
python3 -m unittest discover -s scripts/tests
```

Covers the editorial rule at its boundaries, SQL quote escaping, slug and
title rules, provider validation, derived column-set consistency, the apply
path's helpers, and the golden-file check below.

### The golden file

`supabase/migrations/20260617120000_print_nerd_videos.sql` was generated by the
retired per-batch script, reviewed, and applied in production. The generator
reproduces it byte-for-byte from `scripts/data/print-nerd-videos.json`, with
one deliberate exception: the `-- Generated by …` line names whichever script
wrote the file, and the new generator will not claim to be the retired one.
The test asserts that this is the *only* differing line.

We never regenerate an applied migration. The diff is a correctness proof for
the generator, not something we re-commit.

---

## Audit SQL

```sql
select content_type,
       count(*) as total_published,
       count(*) filter (where reflection is null or reflection = '') as missing_reflection
from content
where is_published = true
group by content_type
order by content_type;
```

`missing_reflection` should be 0.

---

## Bespoke batches

Three generators stay bespoke on purpose and are not worth folding in:

- `scripts/generate-skilled-trades-migration.py` — one-off structural surgery
  with terminal-state assertions.
- `scripts/generate-skills-canada-migration.py` — 160 rows with its own
  `title_original`/`title_clean`/`sheet_row` provenance fields.
- `scripts/generate-mindsets-gumlet-migration.py` — its Gumlet shape is
  supported by `provider: "gumlet"`, but its one-off temp-row deletion is not
  something the shared generator should learn to emit.

If a new batch pushes you toward adding a config key for a one-off, write a
bespoke script instead. Keeping the config small is the point.
