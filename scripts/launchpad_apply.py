"""Apply a validated content batch to Postgres via psql.

Split out of generate-content-migration.py so the offline modes stay free of
any database concern, and so the HTTP/subprocess layer is thin enough to fake
in tests without a mocking library.

Why psql rather than PostgREST: Supabase exposes a direct Postgres connection
string, so one code path serves both a local Postgres and the deployed
project. That means local testing exercises exactly the code that runs in
production, and the whole apply runs in a single transaction -- content rows
and category links commit together or not at all.
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit
from typing import Any, Callable

from launchpad_content import load_env, sql

ROLLBACK_DIR = Path("scripts/data/rollbacks")
REVALIDATE_PATH = "/api/revalidate-launchpad-content"

LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1", "0.0.0.0")


# --------------------------------------------------------------------------
# psql discovery and invocation
# --------------------------------------------------------------------------

def find_psql() -> str | None:
    """Locate psql on PATH, falling back to standard Windows install dirs."""
    found = shutil.which("psql")
    if found:
        return found
    candidates = sorted(
        glob.glob(r"C:\Program Files\PostgreSQL\*\bin\psql.exe")
        + glob.glob(r"C:\Program Files (x86)\PostgreSQL\*\bin\psql.exe"),
        reverse=True,
    )
    return candidates[0] if candidates else None


def connection_args(database_url: str) -> tuple[list[str], dict[str, str]]:
    """Split a connection URL into psql flags plus a PGPASSWORD environment.

    Keeps the password off the command line, which is visible to any other
    user on the machine via the process list. Anything that is not a parseable
    URL is handed to psql unchanged.
    """
    parts = urlsplit(database_url)
    if parts.scheme not in ("postgres", "postgresql") or not parts.hostname:
        return [database_url], {}

    argv: list[str] = []
    argv += ["-h", parts.hostname]
    if parts.port:
        argv += ["-p", str(parts.port)]
    if parts.username:
        argv += ["-U", unquote(parts.username)]
    database = parts.path.lstrip("/")
    if database:
        argv += ["-d", database]

    env = {"PGPASSWORD": unquote(parts.password)} if parts.password else {}
    return argv, env


def run_psql(
    database_url: str,
    *,
    command: str | None = None,
    file: str | None = None,
    single_transaction: bool = False,
    psql_path: str | None = None,
) -> subprocess.CompletedProcess:
    """Run one psql invocation. Exactly one of `command` or `file`."""
    binary = psql_path or find_psql()
    if not binary:
        raise FileNotFoundError("psql not found")

    connection, extra_env = connection_args(database_url)
    argv = [binary, *connection, "--no-psqlrc", "-v", "ON_ERROR_STOP=1"]
    if single_transaction:
        argv.append("--single-transaction")
    if command is not None:
        argv += ["-t", "-A", "-c", command]
    else:
        argv += ["-f", str(file)]

    return subprocess.run(
        argv,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, **extra_env} if extra_env else None,
    )


def is_local(database_url: str) -> bool:
    """True only if the resolved host is a loopback address.

    Parsed rather than substring-matched: a host like `localhost.example.com`
    contains "localhost" but is emphatically not local, and this gates the
    confirmation prompt.
    """
    host = urlsplit(database_url).hostname
    return host is not None and host.lower() in LOCAL_HOSTS


def redact(database_url: str) -> str:
    """Hide the password when echoing a connection string."""
    if "://" not in database_url:
        return database_url
    scheme, _, rest = database_url.partition("://")
    if "@" not in rest:
        return database_url
    creds, _, host = rest.rpartition("@")
    user = creds.split(":", 1)[0]
    return f"{scheme}://{user}:***@{host}"


# --------------------------------------------------------------------------
# Snapshot
# --------------------------------------------------------------------------

def snapshot_query(content_ids: list[str]) -> str:
    ids = ", ".join(sql(cid) for cid in content_ids)
    return (
        "select coalesce(json_agg(t), '[]'::json)::text from ("
        "  select c.id, c.slug, c.title, c.description, c.content_type,"
        "         c.thumbnail_url, c.video_url, c.video_orientation, c.video_duration,"
        "         c.is_published, c.why_it_matters, c.planning_connection,"
        "         c.takeaway, c.reflection,"
        "         (select coalesce(json_agg(cat.slug order by cat.slug), '[]'::json)"
        "            from public.content_categories cc"
        "            join public.categories cat on cat.id = cc.category_id"
        "           where cc.content_id = c.id) as categories"
        f"    from public.content c where c.id in ({ids})"
        ") t"
    )


def write_snapshot(
    label: str,
    content_ids: list[str],
    existing: list[dict[str, Any]],
    directory: Path = ROLLBACK_DIR,
) -> Path:
    """Record prior state, including which ids did not exist."""
    present = {row["id"] for row in existing}
    absent = [cid for cid in content_ids if cid not in present]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{label}-{stamp}.json"
    payload = {
        "meta": {
            "label": label,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "content_ids": content_ids,
            "absent_before_apply": absent,
            "note": (
                "Prior state captured before --apply. Rows listed in "
                "absent_before_apply did not exist and should be deleted to roll back."
            ),
        },
        "rows": existing,
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


# --------------------------------------------------------------------------
# Revalidation
# --------------------------------------------------------------------------

def revalidate_site(
    env: dict[str, str],
    opener: Callable[[urllib.request.Request], Any] = urllib.request.urlopen,
) -> list[str]:
    secret = env.get("LAUNCHPAD_REVALIDATE_SECRET")
    base = (env.get("LAUNCHPAD_SITE_URL") or env.get("NEXT_PUBLIC_SITE_URL") or "").rstrip("/")
    if not secret:
        return ["--revalidate needs LAUNCHPAD_REVALIDATE_SECRET"]
    if not base:
        return ["--revalidate needs LAUNCHPAD_SITE_URL (or NEXT_PUBLIC_SITE_URL)"]

    request = urllib.request.Request(
        base + REVALIDATE_PATH,
        data=b"",
        method="POST",
        headers={"Authorization": f"Bearer {secret}", "Content-Length": "0"},
    )
    try:
        opener(request)
    except urllib.error.HTTPError as exc:
        return [f"revalidate failed: HTTP {exc.code} {exc.reason}"]
    except OSError as exc:
        return [f"revalidate failed: {exc}"]
    return []


# --------------------------------------------------------------------------
# Apply
# --------------------------------------------------------------------------

def apply_batch(
    meta: dict[str, Any],
    rows: list[dict[str, Any]],
    statement: str,
    revalidate: bool = False,
    assume_yes: bool = False,
    env: dict[str, str] | None = None,
) -> int:
    env = env if env is not None else load_env()
    label = meta["label"]

    database_url = env.get("DATABASE_URL")
    if not database_url:
        print(
            "\nDATABASE_URL is not set. Add it to .env.local or the environment.\n"
            "  local : postgresql://postgres:<password>@localhost:5432/launchpad_scratch\n"
            "  hosted: the Supabase project's direct connection string",
            file=sys.stderr,
        )
        return 1

    if not find_psql():
        print(
            "\npsql not found on PATH.\n"
            r"  Windows: add C:\Program Files\PostgreSQL\<version>\bin to PATH",
            file=sys.stderr,
        )
        return 1

    content_ids = [row["content_id"] for row in rows]
    expected_links = sum(len(row.get("categories") or []) for row in rows)
    target_is_local = is_local(database_url)

    print(f"\nTarget: {redact(database_url)}{'  (local)' if target_is_local else '  (REMOTE)'}")

    if not target_is_local and not assume_yes:
        if not sys.stdin.isatty():
            print(
                "Refusing to write to a non-local database without --yes.",
                file=sys.stderr,
            )
            return 1
        answer = input(f"Apply {len(rows)} '{label}' rows to this REMOTE database? [y/N] ")
        if answer.strip().lower() not in ("y", "yes"):
            print("Aborted.")
            return 1

    # 1. Snapshot prior state before any write.
    probe = run_psql(database_url, command=snapshot_query(content_ids))
    if probe.returncode != 0:
        print(f"\nCould not read current state:\n{probe.stderr.strip()}", file=sys.stderr)
        return 1
    try:
        existing = json.loads(probe.stdout.strip() or "[]")
    except json.JSONDecodeError:
        print(f"\nUnexpected snapshot output:\n{probe.stdout[:400]}", file=sys.stderr)
        return 1

    snapshot_path = write_snapshot(label, content_ids, existing)
    print(f"Rollback snapshot: {snapshot_path} "
          f"({len(existing)} existing, {len(content_ids) - len(existing)} new)")

    # 2. Apply, in one transaction. The do-block carries its own assertions.
    handle, temp_path = tempfile.mkstemp(suffix=".sql", prefix=f"{label}-")
    os.close(handle)
    try:
        Path(temp_path).write_text(statement, encoding="utf-8")
        result = run_psql(database_url, file=temp_path, single_transaction=True)
    finally:
        os.unlink(temp_path)

    if result.returncode != 0:
        print(f"\nApply failed, transaction rolled back:\n{result.stderr.strip()}", file=sys.stderr)
        return 1

    # 3. Verify independently of the do-block's own assertions.
    ids = ", ".join(sql(cid) for cid in content_ids)
    verify = run_psql(
        database_url,
        command=(
            f"select (select count(*) from public.content where id in ({ids}))"
            f" || ',' ||"
            f" (select count(*) from public.content_categories where content_id in ({ids}))"
            f" || ',' ||"
            f" (select count(*) from public.content where id in ({ids}) and reflection is null)"
        ),
    )
    if verify.returncode != 0:
        print(f"\nApplied, but verification query failed:\n{verify.stderr.strip()}", file=sys.stderr)
        return 1

    parts = verify.stdout.strip().split(",")
    row_count, link_count, missing_reflection = (int(p) for p in parts)

    print(f"\nApplied '{label}':")
    print(f"  content rows      : {row_count} (expected {len(rows)})")
    print(f"  category links    : {link_count} (expected {expected_links})")
    print(f"  missing_reflection: {missing_reflection}")

    problems = []
    if row_count != len(rows):
        problems.append(f"expected {len(rows)} content rows, found {row_count}")
    if link_count != expected_links:
        problems.append(f"expected {expected_links} category links, found {link_count}")
    if problems:
        print("\nVerification failed:", file=sys.stderr)
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1

    if revalidate:
        errors = revalidate_site(env)
        if errors:
            print("\nApplied, but revalidation failed:", file=sys.stderr)
            for error in errors:
                print(f"- {error}", file=sys.stderr)
            return 1
        print("  revalidated       : yes")

    return 0
