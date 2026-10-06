#!/usr/bin/env python3
"""Sync LaunchPad content with the "LaunchPad Live Content" Google Sheet.

Two commands, one per direction:

    # Sheet -> batch file. Reads the given sheet rows and writes, or extends,
    # a content batch that scripts/generate-content-migration.py then ships.
    python3 scripts/sync-content-sheet.py import --rows 278-280 \\
        --batch scripts/data/<label>-videos.json --label <label> --id-prefix <prefix>

    # Live content -> sheet. Fills empty Reflection, LaunchPad URL and
    # Published At cells on rows whose content is live. Dry run unless --write.
    python3 scripts/sync-content-sheet.py fill [--write]

`import` never touches the database and `fill` never overwrites a non-empty
cell. The sheet is read by header name, so added or reordered columns are
fine; an optional "Orientation" column overrides the detected value.

Env (from .env.local or the process environment):
  LAUNCHPAD_SHEETS_CREDENTIALS  path to the service account key JSON
  LAUNCHPAD_CONTENT_SHEET_ID    spreadsheet id (from the sheet URL)
  SUPABASE_URL, SUPABASE_ANON_KEY  live content, read the same way the app does

See docs/content-authoring.md.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

import google_sheets
from launchpad_content import load_env

DEFAULT_GID = 1201697823
DEFAULT_SITE_URL = "https://launchpad.myblueprint.ca"

# Sheet "Path" values are the category display names.
CATEGORY_SLUGS = {
    "Emerging Careers": "emerging-careers",
    "How I Got Here": "how-i-got-here",
    "Life Skills": "life-skills",
    "Mindsets": "mindsets",
    "On the Job": "on-the-job",
    "Post-Secondary": "post-secondary",
    "Problems": "problems-to-solve",
    "Skilled Trades": "skilled-trades",
}

HEADERS = {
    "title": "Title",
    "content_type": "Content Type",
    "path": "Path",
    "video_url": "Video URL",
    "launchpad_url": "Launchpad URL",
    "description": "Description",
    "why_it_matters": "Why It Matters",
    "planning_connection": "Planning Connection",
    "takeaway": "Takeaway",
    "reflection": "Reflection",
    "organization": "Organization",
    "published_at": "Published At",
    "orientation": "Orientation",
}
OPTIONAL_HEADERS = {"why_it_matters", "planning_connection", "organization", "orientation"}

# Copied onto batch rows verbatim when non-empty. The generator requires each
# optional one to be present on every row of a batch or on none.
TEXT_FIELDS = ("title", "description", "why_it_matters", "planning_connection", "takeaway", "reflection")

REPLACEMENT_CHAR = "�"
LENGTH_SECONDS_RE = re.compile(r'"lengthSeconds":"(\d+)"')

Fetch = Callable[[str, bool], tuple[int, str]]


# --------------------------------------------------------------------------
# Sheet layout
# --------------------------------------------------------------------------

def column_letter(index: int) -> str:
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(ord("A") + remainder) + letters
    return letters


def map_columns(header: list[str]) -> tuple[dict[str, int], list[str]]:
    positions = {name.strip(): i for i, name in enumerate(header)}
    columns: dict[str, int] = {}
    missing: list[str] = []
    for key, name in HEADERS.items():
        if name in positions:
            columns[key] = positions[name]
        elif key not in OPTIONAL_HEADERS:
            missing.append(name)
    return columns, missing


def cell(row: list[str], columns: dict[str, int], key: str) -> str:
    index = columns.get(key)
    if index is None or index >= len(row):
        return ""
    return row[index].strip()


def parse_row_spec(spec: str) -> list[int]:
    """'278-280' or '278,280' or a mix, as 1-based sheet row numbers."""
    numbers: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            start, _, end = part.partition("-")
            numbers.extend(range(int(start), int(end) + 1))
        elif part:
            numbers.append(int(part))
    if not numbers or min(numbers) < 2:
        raise ValueError(f"--rows {spec!r}: row 1 is the header; give rows 2 and up")
    return sorted(set(numbers))


def read_sheet(client: google_sheets.SheetsClient, gid: int) -> tuple[str, list[list[str]]]:
    title = client.tab_title(gid)
    return title, client.get_values(google_sheets.quote_tab(title))


# --------------------------------------------------------------------------
# YouTube
# --------------------------------------------------------------------------

def youtube_id(url: str) -> str | None:
    """Mirror of getYouTubeId in src/lib/content.ts."""
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    host = (parsed.hostname or "").removeprefix("www.")
    if host not in ("youtube.com", "m.youtube.com", "youtu.be"):
        return None
    if host == "youtu.be":
        return parsed.path.lstrip("/").split("/")[0] or None
    query = urllib.parse.parse_qs(parsed.query)
    if query.get("v"):
        return query["v"][0]
    match = re.search(r"/(?:shorts|embed)/([^/?]+)", parsed.path)
    return match.group(1) if match else None


def canonical_youtube_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - urllib hook
        return None


def http_get(url: str, follow_redirects: bool = True, attempts: int = 3) -> tuple[int, str]:
    """(status, body). A redirect is returned as its 3xx status when not followed.

    YouTube intermittently answers 5xx for pages that load fine a moment
    later, so server errors are retried with a short backoff.
    """
    opener = (
        urllib.request.build_opener()
        if follow_redirects
        else urllib.request.build_opener(_NoRedirect)
    )
    request = urllib.request.Request(url, headers={"Accept-Language": "en"})
    status = 0
    for attempt in range(attempts):
        if attempt:
            time.sleep(2 ** attempt)
        try:
            with opener.open(request, timeout=30) as response:
                return response.status, response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            status = exc.code
            if status < 500:
                return status, ""
    return status, ""


def probe_orientation(video_id: str, fetch: Fetch = http_get) -> str:
    """YouTube serves /shorts/<id> for Shorts and redirects anything else to /watch."""
    status, _ = fetch(f"https://www.youtube.com/shorts/{video_id}", False)
    if status == 200:
        return "vertical"
    if 300 <= status < 400:
        return "horizontal"
    raise RuntimeError(f"could not detect orientation for {video_id}: HTTP {status}")


def probe_duration(video_id: str, fetch: Fetch = http_get) -> int:
    status, body = fetch(canonical_youtube_url(video_id), True)
    match = LENGTH_SECONDS_RE.search(body)
    if status != 200 or not match:
        raise RuntimeError(f"could not read duration for {video_id}: HTTP {status}")
    return int(match.group(1))


def probe_thumbnail(video_id: str, fetch: Fetch = http_get) -> str:
    maxres = f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"
    status, _ = fetch(maxres, True)
    return maxres if status == 200 else f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg"


# --------------------------------------------------------------------------
# Live content
# --------------------------------------------------------------------------

def fetch_live_content(
    env: dict[str, str],
    opener: Callable[[urllib.request.Request], Any] = urllib.request.urlopen,
) -> list[dict[str, Any]]:
    url = env.get("SUPABASE_URL")
    key = env.get("SUPABASE_ANON_KEY") or env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("missing SUPABASE_URL or SUPABASE_ANON_KEY")
    query = urllib.parse.urlencode({
        "select": "id,slug,video_url,reflection,published_at",
        "is_published": "eq.true",
        "order": "published_at.desc",
    })
    request = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/content?{query}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    with opener(request) as response:
        return json.load(response)


def index_live(live: list[dict[str, Any]]) -> tuple[dict[str, dict], dict[str, dict]]:
    by_slug = {item["slug"]: item for item in live}
    by_video = {}
    for item in live:
        video = youtube_id(item.get("video_url") or "")
        if video:
            by_video[video] = item
    return by_slug, by_video


def slug_from_launchpad_url(url: str) -> str | None:
    values = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get("content")
    return values[0] if values else None


def sheet_timestamp(value: str) -> str:
    """PostgREST ISO timestamps, rendered the way the sheet already stores them."""
    text = value.replace("T", " ", 1)
    return re.sub(r"([+-]\d\d):00$", r"\1", text)


# --------------------------------------------------------------------------
# import: sheet rows -> batch file
# --------------------------------------------------------------------------

def slugify(title: str) -> str:
    text = title.lower().replace("&", " and ")
    text = re.sub(r"['’]", "", text)
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def build_row(
    sheet_row_number: int,
    row: list[str],
    columns: dict[str, int],
    fetch: Fetch = http_get,
) -> tuple[dict[str, Any], list[str]]:
    """One batch row (without sequence/content_id) from one sheet row."""
    ref = f"sheet row {sheet_row_number}"
    errors: list[str] = []

    content_type = cell(row, columns, "content_type")
    if content_type.lower() != "video":
        return {}, [f"{ref}: Content Type is {content_type!r}; only videos can be imported"]

    video_id = youtube_id(cell(row, columns, "video_url"))
    if not video_id:
        return {}, [f"{ref}: Video URL is not a YouTube link: {cell(row, columns, 'video_url')!r}"]

    out: dict[str, Any] = {}
    for field in TEXT_FIELDS:
        value = cell(row, columns, field)
        if REPLACEMENT_CHAR in value:
            errors.append(f"{ref}: {HEADERS[field]} contains a corrupted character (�)")
        if value:
            out[field] = value
    for field in ("title", "description", "takeaway", "reflection"):
        if field not in out:
            errors.append(f"{ref}: {HEADERS[field]} is empty")

    paths = [name.strip() for name in cell(row, columns, "path").split(",") if name.strip()]
    unknown = [name for name in paths if name not in CATEGORY_SLUGS]
    if not paths:
        errors.append(f"{ref}: Path is empty")
    if unknown:
        errors.append(f"{ref}: unknown Path value(s) {unknown}; expected {sorted(CATEGORY_SLUGS)}")

    orientation = cell(row, columns, "orientation").lower()
    try:
        if not orientation:
            orientation = probe_orientation(video_id, fetch)
        duration = probe_duration(video_id, fetch)
        thumbnail = probe_thumbnail(video_id, fetch)
    except RuntimeError as exc:
        return {}, errors + [f"{ref}: {exc}"]

    slug = slugify(out.get("title", ""))
    ordered = {
        "slug": slug,
        "title": out.get("title"),
        "description": out.get("description"),
        **{field: out[field] for field in ("why_it_matters", "planning_connection") if field in out},
        "takeaway": out.get("takeaway"),
        "reflection": out.get("reflection"),
        "categories": [CATEGORY_SLUGS[name] for name in paths if name in CATEGORY_SLUGS],
        "youtube_id": video_id,
        "url": canonical_youtube_url(video_id),
        "orientation": orientation,
        "duration_seconds": duration,
        "thumbnail_url": thumbnail,
    }
    return ordered, errors


def merge_rows(
    existing: list[dict[str, Any]],
    incoming: list[dict[str, Any]],
    id_prefix: str,
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """Update rows already in the batch (matched on youtube_id) and append the rest.

    A matched row keeps its sequence, content_id and slug: content_id is the
    upsert key and the slug is the public URL, so neither may drift.
    """
    rows = [dict(row) for row in existing]
    by_video = {row.get("youtube_id"): row for row in rows}
    updated: list[str] = []
    added: list[str] = []
    for new in incoming:
        match = by_video.get(new["youtube_id"])
        if match is not None:
            keep = {key: match[key] for key in ("sequence", "content_id", "slug")}
            match.clear()
            match.update({**keep, **{k: v for k, v in new.items() if k != "slug"}})
            updated.append(match["content_id"])
            continue
        sequence = len(rows) + 1
        row = {"sequence": sequence, "content_id": f"{id_prefix}-{sequence:03d}", **new}
        rows.append(row)
        by_video[new["youtube_id"]] = row
        added.append(row["content_id"])
    return rows, updated, added


def live_conflicts(
    rows: list[dict[str, Any]],
    live: list[dict[str, Any]],
) -> list[str]:
    """Rows whose video or slug is already live under a different id."""
    by_slug, by_video = index_live(live)
    errors: list[str] = []
    for row in rows:
        same_video = by_video.get(row["youtube_id"])
        if same_video and same_video["id"] != row["content_id"]:
            errors.append(
                f"{row['content_id']}: video {row['youtube_id']} is already live as "
                f"{same_video['slug']!r} (id {same_video['id']})"
            )
        same_slug = by_slug.get(row["slug"])
        if same_slug and same_slug["id"] != row["content_id"]:
            errors.append(
                f"{row['content_id']}: slug {row['slug']!r} is already used by {same_slug['id']}"
            )
    return errors


def load_generator():
    spec = importlib.util.spec_from_file_location(
        "generate_content_migration",
        Path(__file__).with_name("generate-content-migration.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def command_import(args: argparse.Namespace, env: dict[str, str]) -> int:
    batch_path = Path(args.batch)
    if batch_path.exists():
        data = json.loads(batch_path.read_text(encoding="utf-8"))
        meta, existing = data["meta"], data["rows"]
        for flag, key in (("--label", "label"), ("--id-prefix", "id_prefix")):
            given = getattr(args, key)
            if given and given != meta[key]:
                print(f"error: {flag} {given!r} does not match the batch's {key} {meta[key]!r}")
                return 1
    else:
        if not args.label or not args.id_prefix:
            print("error: a new batch needs --label and --id-prefix (id_prefix is permanent)")
            return 1
        meta = {
            "label": args.label,
            "id_prefix": args.id_prefix,
            "expected_count": 0,
            "provider": "youtube",
            "source_url": sheet_url(args.sheet_id, args.gid),
            "sql_comment": f"Seed {args.label} videos from the LaunchPad Live Content sheet.",
        }
        existing = []

    client = google_sheets.SheetsClient.from_key_file(args.sheet_id, args.credentials)
    title, values = read_sheet(client, args.gid)
    columns, missing = map_columns(values[0] if values else [])
    if missing:
        print(f"error: tab {title!r} is missing column(s): {missing}")
        return 1

    errors: list[str] = []
    incoming: list[dict[str, Any]] = []
    for number in args.rows:
        if number > len(values):
            errors.append(f"sheet row {number} is past the last row ({len(values)})")
            continue
        row, row_errors = build_row(number, values[number - 1], columns)
        errors.extend(row_errors)
        if row:
            incoming.append(row)

    if len(incoming) < len(args.rows):
        # Writing a partial import would shift later rows into the missing
        # row's sequence number, and content_id is permanent once applied.
        print("error: nothing written; these rows could not be read:")
        for error in errors:
            print(f"  - {error}")
        return 1

    rows, updated, added = merge_rows(existing, incoming, meta["id_prefix"])
    meta["expected_count"] = len(rows)
    errors.extend(live_conflicts(rows, fetch_live_content(env)))

    batch_path.parent.mkdir(parents=True, exist_ok=True)
    batch_path.write_text(
        json.dumps({"meta": meta, "rows": rows}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Read tab {title!r}, rows {args.rows[0]}-{args.rows[-1]}")
    print(f"Wrote {batch_path.as_posix()}: {len(added)} added {added}, {len(updated)} updated {updated}")
    for row in rows:
        if row["content_id"] in added + updated:
            print(
                f"  {row['content_id']}  {row['orientation']:<10} {row['duration_seconds']:>4}s  "
                f"{','.join(row['categories']):<28} {row['slug']}"
            )

    generator = load_generator()
    batch_meta, batch_rows, batch_errors = generator.load_batch(batch_path)
    if not batch_errors:
        batch_errors, _ = generator.validate(batch_meta, batch_rows)
    errors.extend(batch_errors)

    if errors:
        print(f"\n{len(errors)} problem(s); fix them in the sheet and re-run:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print(f"\nBatch is valid. Next: python3 scripts/generate-content-migration.py --batch {batch_path.as_posix()} --apply")
    return 0


# --------------------------------------------------------------------------
# fill: live content -> empty sheet cells
# --------------------------------------------------------------------------

def plan_fill(
    values: list[list[str]],
    columns: dict[str, int],
    live: list[dict[str, Any]],
    site_url: str,
) -> tuple[list[tuple[int, str, str]], list[str], list[int]]:
    """Return (writes as (sheet row, header key, value), notes, rows not live)."""
    by_slug, by_video = index_live(live)
    writes: list[tuple[int, str, str]] = []
    notes: list[str] = []
    not_live: list[int] = []

    for number, row in enumerate(values[1:], start=2):
        if not cell(row, columns, "title"):
            continue
        launchpad_url = cell(row, columns, "launchpad_url")
        item = None
        if launchpad_url:
            slug = slug_from_launchpad_url(launchpad_url)
            item = by_slug.get(slug or "")
            if item is None:
                notes.append(f"row {number}: LaunchPad URL slug {slug!r} is not live")
                continue
        else:
            video = youtube_id(cell(row, columns, "video_url"))
            item = by_video.get(video or "")
        if item is None:
            not_live.append(number)
            continue

        if not launchpad_url:
            writes.append((number, "launchpad_url", f"{site_url.rstrip('/')}/?content={item['slug']}"))
        if not cell(row, columns, "published_at") and item.get("published_at"):
            writes.append((number, "published_at", sheet_timestamp(item["published_at"])))

        reflection = cell(row, columns, "reflection")
        live_reflection = (item.get("reflection") or "").strip()
        if not reflection and live_reflection:
            writes.append((number, "reflection", live_reflection))
        elif reflection and live_reflection and reflection != live_reflection:
            notes.append(f"row {number}: Reflection differs from live ({item['slug']}); left as is")

    return writes, notes, not_live


def command_fill(args: argparse.Namespace, env: dict[str, str]) -> int:
    scope = google_sheets.SCOPE_READWRITE if args.write else google_sheets.SCOPE_READONLY
    client = google_sheets.SheetsClient.from_key_file(args.sheet_id, args.credentials, scope)
    title, values = read_sheet(client, args.gid)
    columns, missing = map_columns(values[0] if values else [])
    if missing:
        print(f"error: tab {title!r} is missing column(s): {missing}")
        return 1

    live = fetch_live_content(env)
    site_url = env.get("LAUNCHPAD_SITE_URL") or DEFAULT_SITE_URL
    writes, notes, not_live = plan_fill(values, columns, live, site_url)

    counts: dict[str, int] = {}
    for _, key, _ in writes:
        counts[HEADERS[key]] = counts.get(HEADERS[key], 0) + 1
    print(f"Tab {title!r}: {len(values) - 1} rows; {len(live)} live items")
    print(f"Empty cells to fill: {counts or 'none'}")
    if not_live:
        print(f"Not live yet (import these): rows {not_live}")
    for note in notes:
        print(f"  note: {note}")
    if args.verbose:
        for number, key, value in writes:
            print(f"  {column_letter(columns[key])}{number}: {value[:90]}")

    if not writes:
        return 0
    if not args.write:
        print("\nDry run. Re-run with --write to fill these cells.")
        return 0

    updates = [
        (f"{google_sheets.quote_tab(title)}!{column_letter(columns[key])}{number}", [[value]])
        for number, key, value in writes
    ]
    result = client.batch_update_values(updates)
    print(f"Wrote {result.get('totalUpdatedCells', 0)} cell(s).")
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def sheet_url(sheet_id: str, gid: int) -> str:
    return f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit#gid={gid}"


def main(argv: list[str] | None = None) -> int:
    env = load_env()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sheet-id", default=env.get("LAUNCHPAD_CONTENT_SHEET_ID"))
    parser.add_argument("--gid", type=int, default=DEFAULT_GID, help="tab id from the sheet URL")
    parser.add_argument("--credentials", default=env.get("LAUNCHPAD_SHEETS_CREDENTIALS"))
    commands = parser.add_subparsers(dest="command", required=True)

    importer = commands.add_parser("import", help="sheet rows -> content batch file")
    importer.add_argument("--rows", required=True, type=parse_row_spec, help="e.g. 278-280")
    importer.add_argument("--batch", required=True, help="batch JSON to create or extend")
    importer.add_argument("--label", help="new batches only")
    importer.add_argument("--id-prefix", help="new batches only; permanent")

    filler = commands.add_parser("fill", help="live content -> empty sheet cells")
    filler.add_argument("--write", action="store_true", help="write; default is a dry run")
    filler.add_argument("-v", "--verbose", action="store_true", help="list every cell")

    args = parser.parse_args(argv)
    if not args.sheet_id or not args.credentials:
        parser.error("set LAUNCHPAD_CONTENT_SHEET_ID and LAUNCHPAD_SHEETS_CREDENTIALS in .env.local")

    try:
        if args.command == "import":
            return command_import(args, env)
        return command_fill(args, env)
    except (google_sheets.SheetsError, RuntimeError) as exc:
        print(f"error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
