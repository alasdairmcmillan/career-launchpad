#!/usr/bin/env python3
"""Config-driven content batch generator for LaunchPad.

One generator for every video content batch, replacing the per-batch scripts.
Configuration lives in the batch JSON itself as a `meta` block, so one file is
the complete source of truth for a batch.

    python3 scripts/generate-content-migration.py --batch <path> --check
    python3 scripts/generate-content-migration.py --batch <path> --sql [--output P]
    python3 scripts/generate-content-migration.py --batch <path> --apply [--revalidate]

`--check` and `--sql` are offline and deterministic. `--apply` writes to the
database named by DATABASE_URL, via psql, inside a single transaction.

Batch file shape:

    {
      "meta": {
        "label": "print-nerd",
        "id_prefix": "print-nerd",
        "expected_count": 6,
        "provider": "youtube",
        "source_url": "https://www.youtube.com/@Example/shorts",
        "sql_comment": "Seed \"Print Nerd\" YouTube shorts."
      },
      "rows": [ { "sequence": 1, "content_id": "print-nerd-001", ... } ]
    }

See docs/content-authoring.md.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from launchpad_content import (
    KNOWN_CATEGORY_SLUGS,
    sql,
    source_comment_path,
    validate_batch_identity,
    validate_duration,
    validate_editorial_rule,
    validate_orientation,
    validate_required_fields,
    validate_slug,
    validate_title,
)

SCRIPT_NAME = "scripts/generate-content-migration.py"

REQUIRED_META_FIELDS = ("label", "id_prefix", "expected_count", "provider", "sql_comment")
PROVIDERS = ("youtube", "gumlet")

# Fields every row must carry, whatever the batch.
BASE_REQUIRED_FIELDS = (
    "sequence",
    "content_id",
    "slug",
    "title",
    "description",
    "url",
    "orientation",
    "thumbnail_url",
)

# Optional columns, in the canonical order they appear in an INSERT. Derived
# from the rows rather than configured: a batch either has a field on every row
# or on none of them.
OPTIONAL_COLUMNS = (
    "video_duration",
    "why_it_matters",
    "planning_connection",
    "takeaway",
    "reflection",
)

# Column name -> row field name, where they differ.
COLUMN_SOURCE = {"video_duration": "duration_seconds"}

GUMLET_ID_RE = re.compile(r"[0-9a-f]{24}")


# --------------------------------------------------------------------------
# Loading and normalising
# --------------------------------------------------------------------------

def load_batch(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[str]]:
    """Return (meta, rows, errors). Rows are normalised in place."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {}, [], [f"{path} is not valid JSON: {exc}"]

    if not isinstance(data, dict):
        return {}, [], [
            f"{path} must be an object with 'meta' and 'rows' keys; "
            "bare arrays are the old per-batch format"
        ]

    meta = data.get("meta")
    rows = data.get("rows")
    errors: list[str] = []
    if not isinstance(meta, dict):
        errors.append("missing or invalid 'meta' block")
    if not isinstance(rows, list) or not rows:
        errors.append("missing or empty 'rows' array")
    if errors:
        return {}, [], errors

    errors.extend(validate_meta(meta))
    if errors:
        return meta, rows, errors

    for row in rows:
        normalise_row(row)
    return meta, rows, []


def validate_meta(meta: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for field in REQUIRED_META_FIELDS:
        if not meta.get(field):
            errors.append(f"meta missing field: {field!r}")
    if errors:
        return errors

    if not isinstance(meta["expected_count"], int) or meta["expected_count"] <= 0:
        errors.append(
            f"meta.expected_count must be a positive int, got {meta['expected_count']!r}"
        )
    if meta["provider"] not in PROVIDERS:
        errors.append(
            f"meta.provider is {meta['provider']!r}, expected one of {list(PROVIDERS)}"
        )
    return errors


def normalise_row(row: dict[str, Any]) -> None:
    """Accept a scalar `category` as the single-element `categories` case."""
    if "categories" not in row and "category" in row:
        row["categories"] = [row.pop("category")]


# --------------------------------------------------------------------------
# Derived column set
# --------------------------------------------------------------------------

def derive_columns(rows: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
    """Which optional columns this batch writes. All-or-nothing across rows."""
    columns: list[str] = []
    errors: list[str] = []
    for column in OPTIONAL_COLUMNS:
        field = COLUMN_SOURCE.get(column, column)
        present = [bool(row.get(field)) for row in rows]
        if all(present):
            columns.append(column)
        elif any(present):
            missing = [i for i, ok in enumerate(present, start=1) if not ok]
            errors.append(
                f"field {field!r} is present on some rows but not others "
                f"(missing on rows {missing}); a batch must be consistent"
            )
    return columns, errors


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def validate(meta: dict[str, Any], rows: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
    """Full offline validation. Returns (errors, derived_optional_columns)."""
    errors = list(
        validate_batch_identity(rows, meta["expected_count"], meta["id_prefix"])
    )

    optional_columns, column_errors = derive_columns(rows)
    errors.extend(column_errors)

    provider = meta["provider"]
    id_field = "youtube_id" if provider == "youtube" else "gumlet_id"
    required = BASE_REQUIRED_FIELDS + (id_field,) + tuple(
        COLUMN_SOURCE.get(column, column) for column in optional_columns
    )

    for index, row in enumerate(rows, start=1):
        missing = validate_required_fields(index, row, required)
        if missing:
            errors.extend(missing)
            continue

        errors.extend(validate_title(index, row["title"]))
        errors.extend(validate_slug(index, row["slug"]))
        errors.extend(validate_orientation(index, row["orientation"]))
        if "video_duration" in optional_columns:
            errors.extend(validate_duration(index, row["duration_seconds"]))
        if "reflection" in optional_columns:
            errors.extend(validate_editorial_rule(index, row))

        errors.extend(validate_provider(index, row, provider, id_field))
        errors.extend(validate_categories(index, row.get("categories")))

    return errors, optional_columns


def validate_provider(index: int, row: dict[str, Any], provider: str, id_field: str) -> list[str]:
    errors: list[str] = []
    media_id = row[id_field]
    url = row["url"]
    thumbnail = row["thumbnail_url"]

    if provider == "youtube":
        if media_id not in url:
            errors.append(f"row {index} url does not contain {id_field} {media_id!r}")
        expected_thumbs = {
            f"https://img.youtube.com/vi/{media_id}/maxresdefault.jpg",
            f"https://img.youtube.com/vi/{media_id}/hqdefault.jpg",
        }
        if thumbnail not in expected_thumbs:
            errors.append(
                f"row {index} thumbnail_url is {thumbnail!r}, "
                f"expected one of {sorted(expected_thumbs)}"
            )
    else:  # gumlet
        if not GUMLET_ID_RE.fullmatch(media_id):
            errors.append(f"row {index} has invalid gumlet_id: {media_id!r}")
        expected_prefix = f"https://play.gumlet.io/embed/{media_id}"
        if not url.startswith(expected_prefix):
            errors.append(
                f"row {index} url {url!r} does not start with {expected_prefix!r}"
            )
        if media_id not in thumbnail:
            errors.append(f"row {index} thumbnail_url does not reference gumlet_id {media_id!r}")

    return errors


def validate_categories(index: int, categories: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(categories, list) or not categories:
        errors.append(f"row {index} categories must be a non-empty list")
        return errors
    if len(set(categories)) != len(categories):
        errors.append(f"row {index} has duplicate categories: {categories}")
    unknown = [slug for slug in categories if slug not in KNOWN_CATEGORY_SLUGS]
    if unknown:
        errors.append(f"row {index} has unknown category slugs: {unknown}")
    return errors


# --------------------------------------------------------------------------
# Audit
# --------------------------------------------------------------------------

def print_audit(meta: dict[str, Any], rows: list[dict[str, Any]], optional_columns: list[str]) -> None:
    if meta.get("source_url"):
        print(f"Source: {meta['source_url']}")
    print(f"Batch: {meta['label']} (provider: {meta['provider']})")
    print(f"Row count: {len(rows)}")

    category_counts: Counter = Counter()
    for row in rows:
        for slug in row.get("categories") or []:
            category_counts[slug] += 1
    print(f"Category histogram: {dict(sorted(category_counts.items()))}")
    print(f"Total content_categories links: {expected_link_count(rows)}")
    print(f"Orientation counts: {dict(Counter(row.get('orientation') for row in rows))}")

    if "video_duration" in optional_columns:
        durations = [row["duration_seconds"] for row in rows]
        print(f"Duration (s): min={min(durations)}, max={max(durations)}, sum={sum(durations)}")
    print(f"Optional columns: {optional_columns or '(none)'}")


def expected_link_count(rows: list[dict[str, Any]]) -> int:
    return sum(len(row.get("categories") or []) for row in rows)


def used_category_slugs(rows: list[dict[str, Any]]) -> list[str]:
    slugs: list[str] = []
    for row in rows:
        for slug in row.get("categories") or []:
            if slug not in slugs:
                slugs.append(slug)
    return slugs


# --------------------------------------------------------------------------
# SQL rendering
# --------------------------------------------------------------------------

def insert_columns(optional_columns: list[str]) -> list[str]:
    columns = [
        "id",
        "slug",
        "title",
        "description",
        "content_type",
        "thumbnail_url",
        "video_url",
        "video_orientation",
    ]
    if "video_duration" in optional_columns:
        columns.append("video_duration")
    columns += ["published_at", "is_published"]
    for column in ("why_it_matters", "planning_connection", "takeaway", "reflection"):
        if column in optional_columns:
            columns.append(column)
    return columns


def render_content_value(row: dict[str, Any], optional_columns: list[str]) -> str:
    parts = [
        sql(row["content_id"]),
        sql(row["slug"]),
        sql(row["title"]),
        sql(row["description"]),
        "'video'",
        sql(row["thumbnail_url"]),
        sql(row["url"]),
        sql(row["orientation"]),
    ]
    if "video_duration" in optional_columns:
        parts.append(str(int(row["duration_seconds"])))
    parts.append(f"now() - ({int(row['sequence'])} * interval '1 second')")
    parts.append("true")
    for column in ("why_it_matters", "planning_connection", "takeaway", "reflection"):
        if column in optional_columns:
            parts.append(sql(row[column]))
    return "(" + ", ".join(parts) + ")"


def render_category_values(row: dict[str, Any]) -> str:
    content_id = sql(row["content_id"])
    return ",\n    ".join(f"({content_id}, {sql(slug)})" for slug in row["categories"])


def render_sql(
    meta: dict[str, Any],
    rows: list[dict[str, Any]],
    optional_columns: list[str],
    source: Path,
) -> str:
    label = meta["label"]
    columns = insert_columns(optional_columns)
    column_block = ",\n    ".join(columns)
    update_block = ",\n        ".join(
        f"{column} = excluded.{column}" for column in columns if column != "id"
    )
    content_values = ",\n    ".join(
        render_content_value(row, optional_columns) for row in rows
    )
    content_ids = ", ".join(sql(row["content_id"]) for row in rows)
    category_values = ",\n    ".join(render_category_values(row) for row in rows)
    expected_categories = ",\n      ".join(
        f"({sql(slug)})" for slug in used_category_slugs(rows)
    )

    header = [f"-- {meta['sql_comment']}"]
    if meta.get("source_url"):
        header.append(f"-- Source: {meta['source_url']}")
    header.append(f"-- Generated by {SCRIPT_NAME} from {source_comment_path(source)}.")
    header_block = "\n".join(header)

    return f"""{header_block}

do $$
declare
  expected_count int := {meta['expected_count']};
  expected_links int := {expected_link_count(rows)};
  actual_count int;
  linked_count int;
  missing_categories text[];
begin
  select array_agg(expected.slug order by expected.slug)
    into missing_categories
  from (
    values
      {expected_categories}
  ) as expected(slug)
  left join public.categories categories on categories.slug = expected.slug
  where categories.id is null;

  if missing_categories is not null then
    raise exception 'Missing required categories: %', array_to_string(missing_categories, ', ');
  end if;

  insert into public.content (
    {column_block}
  )
  values
    {content_values}
  on conflict (id) do update
    set {update_block},
        updated_at = now();

  get diagnostics actual_count = row_count;
  if actual_count <> expected_count then
    raise exception 'Expected % {label} rows upserted, got %', expected_count, actual_count;
  end if;

  insert into public.content_categories (content_id, category_id)
  select links.content_id, categories.id
  from (
    values
    {category_values}
  ) as links(content_id, category_slug)
  join public.categories categories on categories.slug = links.category_slug
  on conflict (content_id, category_id) do nothing;

  select count(*)
    into linked_count
  from public.content_categories cc
  where cc.content_id in ({content_ids});

  if linked_count <> expected_links then
    raise exception 'Expected % {label} category links, got %', expected_links, linked_count;
  end if;
end $$;
"""


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--batch", required=True, type=Path, help="Path to the batch JSON")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Validate only; no output, no network")
    mode.add_argument("--sql", action="store_true", help="Render SQL to --output or stdout")
    mode.add_argument("--apply", action="store_true", help="Apply to DATABASE_URL via psql")
    parser.add_argument("--output", type=Path, default=None, help="With --sql: write here")
    parser.add_argument(
        "--revalidate", action="store_true",
        help="With --apply: POST the revalidate hook so the change is visible immediately",
    )
    parser.add_argument(
        "--yes", action="store_true",
        help="With --apply: skip the confirmation prompt",
    )
    args = parser.parse_args(argv)

    if not args.batch.exists():
        print(f"Batch file not found: {args.batch}", file=sys.stderr)
        return 1
    if args.output and not args.sql:
        print("--output is only meaningful with --sql", file=sys.stderr)
        return 1

    meta, rows, errors = load_batch(args.batch)
    if errors:
        return fail(errors)

    row_errors, optional_columns = validate(meta, rows)
    print_audit(meta, rows, optional_columns)
    if row_errors:
        return fail(row_errors)

    if args.check:
        print(f"\nOK: {meta['label']} is valid ({len(rows)} rows, "
              f"{expected_link_count(rows)} category links).")
        return 0

    statement = render_sql(meta, rows, optional_columns, args.batch)

    if args.sql:
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(statement, encoding="utf-8")
            print(f"\nWrote {args.output}")
        else:
            sys.stdout.write(statement)
        return 0

    # --apply
    from launchpad_apply import apply_batch
    return apply_batch(
        meta=meta,
        rows=rows,
        statement=statement,
        revalidate=args.revalidate,
        assume_yes=args.yes,
    )


def fail(errors: list[str]) -> int:
    print("\nRefusing to continue:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
