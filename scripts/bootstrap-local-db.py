#!/usr/bin/env python3
"""Build a local Postgres database that matches the deployed schema.

For local testing of `generate-content-migration.py --apply` without a cloud
Supabase project. Creates the database and the roles the migrations grant to,
then applies the historical ContentHub migrations followed by every migration
in supabase/migrations, in filename order.

    # 1. put a connection string in .env.local, e.g.
    #    DATABASE_URL=postgresql://postgres:<password>@localhost:5432/launchpad_local
    # 2. then:
    python3 scripts/bootstrap-local-db.py

Only two things in these migrations are Supabase-specific: gen_random_uuid()
(core since Postgres 13) and grants TO anon. The roles are created below, so a
stock Postgres is enough.
"""

from __future__ import annotations

import argparse
import glob
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from launchpad_apply import find_psql, redact, run_psql
from launchpad_content import load_env

HISTORICAL = "supabase/historical/contenthub-migrations/*.sql"
MIGRATIONS = "supabase/migrations/*.sql"

# Roles the migrations grant to. Supabase provides these; stock Postgres does not.
ROLES = ("anon", "authenticated", "service_role")

# 003_seed_content.sql inserts content.related_playbook_id -> content.id before
# the row it points at exists, so the self-referencing FK fails on a clean
# rebuild. Deferring FK checks to commit time lets each migration's own
# transaction settle before anything is validated; both rows exist by then.
# Restored to immediate at the end, which re-validates every row.
# Migrations that cannot apply to any database but the deployed one.
#
# The historical seeds create content rows and categories with
# gen_random_uuid(), so those ids are different in every database. Later
# migrations then hardcode the ids the deployed database happened to get.
# Nothing can reproduce them, so a local rebuild skips them. This is a
# pre-existing property of the migration history, not of the content
# generator -- and it is exactly why batch files use deterministic
# content_ids like `print-nerd-001` instead.
UNREPRODUCIBLE = {
    "20260521202342_reflection_articles.sql":
        "targets 7 article ids created by gen_random_uuid() in 006_seed_indeed_articles",
    "20260521203635_reflection_non_skills_videos.sql":
        "targets 68 video ids created by gen_random_uuid() in 004/005",
    "20260805210000_rename_skills_canada_to_skilled_trades.sql":
        "asserts a hardcoded category id created by gen_random_uuid() in 001",
}

# Applied immediately before the named migration, to stand in for what the
# skipped migrations would have done.
LOCAL_REPAIRS = {
    # The two skipped reflection backfills leave 75 rows null, so the NOT NULL
    # constraint cannot be added without a stand-in value.
    "20260521210000_enforce_content_reflection.sql": (
        "update public.content set reflection = "
        "'LOCAL PLACEHOLDER: the real reflection for this row exists only in the "
        "deployed database.' where reflection is null or trim(reflection) = ''"
    ),
}

SET_FK_TIMING = """
do $$
declare r record;
begin
  for r in
    select conrelid::regclass::text as tbl, conname
    from pg_constraint
    where contype = 'f' and connamespace = 'public'::regnamespace
  loop
    execute format('alter table %s alter constraint %I {timing}', r.tbl, r.conname);
  end loop;
end $$;
"""


def maintenance_url(database_url: str) -> tuple[str, str]:
    """Return (url pointing at the 'postgres' database, target database name)."""
    parts = urlsplit(database_url)
    target = parts.path.lstrip("/")
    if not target:
        raise ValueError("DATABASE_URL has no database name")
    return urlunsplit(parts._replace(path="/postgres")), target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--database-url", default=None,
                        help="Defaults to DATABASE_URL from .env.local or the environment")
    parser.add_argument("--drop", action="store_true",
                        help="Drop and recreate the database first")
    args = parser.parse_args(argv)

    env = load_env()
    database_url = args.database_url or env.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is not set. Add it to .env.local or pass --database-url.",
              file=sys.stderr)
        return 1
    if not find_psql():
        print(r"psql not found. Add C:\Program Files\PostgreSQL\<version>\bin to PATH.",
              file=sys.stderr)
        return 1

    admin_url, database = maintenance_url(database_url)
    print(f"Target: {redact(database_url)}")

    if args.drop:
        result = run_psql(admin_url, command=f'drop database if exists "{database}"')
        if result.returncode != 0:
            print(f"Could not drop {database}:\n{result.stderr.strip()}", file=sys.stderr)
            return 1
        print(f"Dropped {database}")

    exists = run_psql(
        admin_url,
        command=f"select 1 from pg_database where datname = '{database}'",
    )
    if exists.returncode != 0:
        print(f"Could not reach Postgres:\n{exists.stderr.strip()}", file=sys.stderr)
        return 1
    if not exists.stdout.strip():
        created = run_psql(admin_url, command=f'create database "{database}"')
        if created.returncode != 0:
            print(f"Could not create {database}:\n{created.stderr.strip()}", file=sys.stderr)
            return 1
        print(f"Created database {database}")
    else:
        print(f"Database {database} already exists")

    role_sql = "; ".join(
        f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{role}') "
        f"then create role {role} nologin; end if; end $$"
        for role in ROLES
    )
    roles = run_psql(database_url, command=role_sql)
    if roles.returncode != 0:
        print(f"Could not create roles:\n{roles.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"Roles ready: {', '.join(ROLES)}")

    files = sorted(glob.glob(HISTORICAL)) + sorted(glob.glob(MIGRATIONS))
    if not files:
        print("No migration files found. Run from the repo root.", file=sys.stderr)
        return 1

    print(f"\nApplying {len(files)} migrations...")
    skipped: list[str] = []
    for path in files:
        name = Path(path).name

        if name in UNREPRODUCIBLE:
            skipped.append(name)
            print(f"  -- {name}\n     skipped: {UNREPRODUCIBLE[name]}")
            continue

        repair = LOCAL_REPAIRS.get(name)
        if repair:
            fixed = run_psql(database_url, command=repair)
            if fixed.returncode != 0:
                print(f"  FAILED local repair before {name}\n{fixed.stderr.strip()}",
                      file=sys.stderr)
                return 1
            print(f"  ~~ local repair applied before {name}")

        # New tables appear as we go, so re-apply the timing before each file.
        run_psql(database_url, command=SET_FK_TIMING.format(
            timing="deferrable initially deferred"))
        result = run_psql(database_url, file=path, single_transaction=True)
        if result.returncode != 0:
            print(f"  FAILED {name}\n{result.stderr.strip()}", file=sys.stderr)
            return 1
        print(f"  ok {name}")

    restored = run_psql(database_url, command=SET_FK_TIMING.format(timing="not deferrable"))
    if restored.returncode != 0:
        print(f"\nMigrations applied, but a foreign key does not hold:\n"
              f"{restored.stderr.strip()}", file=sys.stderr)
        return 1
    print("\nForeign keys restored to immediate checking and validated.")

    counts = run_psql(
        database_url,
        command=(
            "select (select count(*) from public.content) || ' content, ' ||"
            " (select count(*) from public.categories) || ' categories, ' ||"
            " (select count(*) from public.content_categories) || ' links'"
        ),
    )
    print(f"\nDone: {counts.stdout.strip()}")
    if skipped:
        print(f"\n{len(skipped)} migration(s) skipped as unreproducible. This database "
              "matches the deployed schema,\nbut not the deployed data for those rows. "
              "See UNREPRODUCIBLE in this script.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
