"""Tests for the shared content module and the config-driven generator.

Run from the repo root:

    python3 -m unittest discover -s scripts/tests
"""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import launchpad_apply  # noqa: E402
import launchpad_content as lc  # noqa: E402


def load_hyphenated(name: str):
    """Import a hyphenated script by path; the filenames are not module names."""
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), SCRIPTS / f"{name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gcm = load_hyphenated("generate-content-migration")

PRINT_NERD_BATCH = REPO_ROOT / "scripts/data/print-nerd-videos.json"
PRINT_NERD_GOLDEN = REPO_ROOT / "supabase/migrations/20260617120000_print_nerd_videos.sql"


def reflection(words: int, *, second_person=True, question=True, em_dash=False) -> str:
    """Build a reflection with an exact word count."""
    lead = "you" if second_person else "someone"
    filler = ["word"] * (words - 1)
    text = " ".join([lead] + filler)
    if em_dash:
        text = text.replace("word", "—", 1)
    return text + ("?" if question else ".")


class TestSql(unittest.TestCase):
    def test_quotes_and_escapes(self):
        self.assertEqual(lc.sql("hi"), "'hi'")
        self.assertEqual(lc.sql("it's"), "'it''s'")
        self.assertEqual(lc.sql("a'b'c"), "'a''b''c'")

    def test_none_becomes_null(self):
        self.assertEqual(lc.sql(None), "null")

    def test_coerces_non_strings(self):
        self.assertEqual(lc.sql(42), "'42'")
        self.assertEqual(lc.sql(True), "'True'")

    def test_subsumes_retired_quote_helper(self):
        # The old quote() was: "'" + value.replace("'", "''") + "'"
        for value in ("plain", "it's", "", "a'b"):
            self.assertEqual(lc.sql(value), "'" + value.replace("'", "''") + "'")


class TestSourceCommentPath(unittest.TestCase):
    def test_forward_slashes_regardless_of_platform(self):
        self.assertEqual(
            lc.source_comment_path(Path("scripts/data/x.json")),
            "scripts/data/x.json",
        )

    def test_normalises_backslashes(self):
        self.assertEqual(
            lc.source_comment_path("scripts" + chr(92) + "data" + chr(92) + "x.json"),
            "scripts/data/x.json",
        )


class TestEditorialRule(unittest.TestCase):
    def check(self, text):
        return lc.validate_editorial_rule(1, {"id": "r1", "reflection": text})

    def test_word_count_boundaries(self):
        self.assertEqual(self.check(reflection(20)), [])
        self.assertEqual(self.check(reflection(50)), [])
        self.assertIn("19 words", " ".join(self.check(reflection(19))))
        self.assertIn("51 words", " ".join(self.check(reflection(51))))

    def test_requires_second_person(self):
        errors = self.check(reflection(25, second_person=False))
        self.assertTrue(any("second-person" in e for e in errors))

    def test_second_person_variants(self):
        for word in ("you", "your", "yours", "yourself"):
            text = " ".join([word] + ["word"] * 24) + "?"
            self.assertEqual(self.check(text), [], f"{word} should satisfy the rule")

    def test_requires_question_mark(self):
        errors = self.check(reflection(25, question=False))
        self.assertTrue(any("must end with" in e for e in errors))

    def test_rejects_em_dash(self):
        errors = self.check(reflection(25, em_dash=True))
        self.assertTrue(any("em-dash" in e for e in errors))

    def test_rejects_empty(self):
        for value in ("", "   ", None, 42):
            self.assertTrue(self.check(value), f"{value!r} should fail")

    def test_error_messages_carry_the_row_id(self):
        errors = self.check(reflection(5))
        self.assertTrue(all("(r1)" in e for e in errors))

    def test_every_committed_reflection_passes(self):
        """The rule applies universally with no grandfathering."""
        checked = 0
        for path in sorted((REPO_ROOT / "scripts/data/reflections").glob("*.json")):
            if path.name.endswith("-rollback.json"):
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            for index, row in enumerate(data["rows"], start=1):
                self.assertEqual(
                    lc.validate_editorial_rule(index, row), [], f"{path.name} row {index}"
                )
                checked += 1
        self.assertGreater(checked, 200)


class TestRowValidators(unittest.TestCase):
    def test_title_length(self):
        self.assertEqual(lc.validate_title(1, "x" * 100), [])
        self.assertTrue(lc.validate_title(1, "x" * 101))

    def test_slug_rules(self):
        for good in ("abc", "a-b-c", "a1-b2"):
            self.assertEqual(lc.validate_slug(1, good), [], good)
        for bad in ("Abc", "a_b", "-ab", "ab-", "a--b", "", "a b"):
            self.assertTrue(lc.validate_slug(1, bad), bad)

    def test_duration(self):
        self.assertEqual(lc.validate_duration(1, 60), [])
        for bad in (0, -1, "60", 1.5, None, True):
            self.assertTrue(lc.validate_duration(1, bad), repr(bad))

    def test_required_fields_reject_empty_strings(self):
        """Strict semantics: an empty string is a failure, not a value."""
        self.assertTrue(lc.validate_required_fields(1, {"title": ""}, ("title",)))
        self.assertTrue(lc.validate_required_fields(1, {}, ("title",)))
        self.assertEqual(lc.validate_required_fields(1, {"title": "x"}, ("title",)), [])

    def test_batch_identity(self):
        rows = [
            {"sequence": 1, "content_id": "b-001", "slug": "a", "url": "u1"},
            {"sequence": 2, "content_id": "b-002", "slug": "b", "url": "u2"},
        ]
        self.assertEqual(lc.validate_batch_identity(rows, 2, "b"), [])
        self.assertTrue(lc.validate_batch_identity(rows, 3, "b"))
        self.assertTrue(lc.validate_batch_identity(rows, 2, "other"))

    def test_batch_identity_detects_duplicates(self):
        rows = [
            {"sequence": 1, "content_id": "b-001", "slug": "same", "url": "u1"},
            {"sequence": 2, "content_id": "b-002", "slug": "same", "url": "u2"},
        ]
        errors = lc.validate_batch_identity(rows, 2, "b")
        self.assertTrue(any("duplicate slug" in e for e in errors))


class TestBatchLoading(unittest.TestCase):
    def test_rejects_bare_array(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "b.json"
            path.write_text("[]", encoding="utf-8")
            _, _, errors = gcm.load_batch(path)
            self.assertTrue(any("bare arrays" in e for e in errors))

    def test_scalar_category_normalises_to_list(self):
        row = {"category": "on-the-job"}
        gcm.normalise_row(row)
        self.assertEqual(row["categories"], ["on-the-job"])
        self.assertNotIn("category", row)

    def test_meta_validation(self):
        base = {
            "label": "b", "id_prefix": "b", "expected_count": 1,
            "provider": "youtube", "sql_comment": "c",
        }
        self.assertEqual(gcm.validate_meta(base), [])
        self.assertTrue(gcm.validate_meta({**base, "provider": "vimeo"}))
        self.assertTrue(gcm.validate_meta({**base, "expected_count": 0}))
        for field in base:
            missing = {k: v for k, v in base.items() if k != field}
            self.assertTrue(gcm.validate_meta(missing), f"missing {field}")


class TestDerivedColumns(unittest.TestCase):
    def test_all_or_nothing(self):
        rows = [{"takeaway": "a"}, {"takeaway": "b"}]
        columns, errors = gcm.derive_columns(rows)
        self.assertIn("takeaway", columns)
        self.assertEqual(errors, [])

    def test_partial_presence_is_an_error(self):
        rows = [{"takeaway": "a"}, {}]
        columns, errors = gcm.derive_columns(rows)
        self.assertNotIn("takeaway", columns)
        self.assertTrue(any("some rows but not others" in e for e in errors))

    def test_absent_everywhere_is_fine(self):
        columns, errors = gcm.derive_columns([{}, {}])
        self.assertEqual(columns, [])
        self.assertEqual(errors, [])

    def test_duration_maps_from_duration_seconds(self):
        columns, _ = gcm.derive_columns([{"duration_seconds": 10}])
        self.assertEqual(columns, ["video_duration"])

    def test_canonical_column_order(self):
        """Both the 12-column and 15-column shapes come out in the right order."""
        full = gcm.insert_columns(list(gcm.OPTIONAL_COLUMNS))
        self.assertEqual(full, [
            "id", "slug", "title", "description", "content_type", "thumbnail_url",
            "video_url", "video_orientation", "video_duration", "published_at",
            "is_published", "why_it_matters", "planning_connection", "takeaway",
            "reflection",
        ])
        ltc_shape = gcm.insert_columns(["video_duration", "takeaway"])
        self.assertEqual(ltc_shape, [
            "id", "slug", "title", "description", "content_type", "thumbnail_url",
            "video_url", "video_orientation", "video_duration", "published_at",
            "is_published", "takeaway",
        ])
        self.assertEqual(len(ltc_shape), 12)


class TestProviderValidation(unittest.TestCase):
    def youtube_row(self, **overrides):
        row = {
            "youtube_id": "abc123XYZ_-",
            "url": "https://www.youtube.com/watch?v=abc123XYZ_-",
            "thumbnail_url": "https://img.youtube.com/vi/abc123XYZ_-/maxresdefault.jpg",
        }
        row.update(overrides)
        return row

    def gumlet_row(self, **overrides):
        gid = "0123456789abcdef01234567"
        row = {
            "gumlet_id": gid,
            "url": f"https://play.gumlet.io/embed/{gid}",
            "thumbnail_url": f"https://video.gumlet.io/{gid}/thumbnail.jpg",
        }
        row.update(overrides)
        return row

    def test_youtube_happy_path(self):
        errors = gcm.validate_provider(1, self.youtube_row(), "youtube", "youtube_id")
        self.assertEqual(errors, [])

    def test_youtube_hqdefault_thumbnail_allowed(self):
        row = self.youtube_row(
            thumbnail_url="https://img.youtube.com/vi/abc123XYZ_-/hqdefault.jpg"
        )
        self.assertEqual(gcm.validate_provider(1, row, "youtube", "youtube_id"), [])

    def test_youtube_url_must_contain_id(self):
        row = self.youtube_row(url="https://www.youtube.com/watch?v=different")
        self.assertTrue(gcm.validate_provider(1, row, "youtube", "youtube_id"))

    def test_youtube_rejects_foreign_thumbnail(self):
        row = self.youtube_row(thumbnail_url="https://example.com/x.jpg")
        self.assertTrue(gcm.validate_provider(1, row, "youtube", "youtube_id"))

    def test_gumlet_happy_path(self):
        self.assertEqual(gcm.validate_provider(1, self.gumlet_row(), "gumlet", "gumlet_id"), [])

    def test_gumlet_id_must_be_24_hex(self):
        for bad in ("short", "g" * 24, "0123456789abcdef0123456"):
            row = self.gumlet_row(gumlet_id=bad)
            self.assertTrue(gcm.validate_provider(1, row, "gumlet", "gumlet_id"), bad)

    def test_gumlet_url_prefix(self):
        row = self.gumlet_row(url="https://example.com/embed/x")
        self.assertTrue(gcm.validate_provider(1, row, "gumlet", "gumlet_id"))


class TestCategories(unittest.TestCase):
    def test_rejects_empty(self):
        self.assertTrue(gcm.validate_categories(1, []))
        self.assertTrue(gcm.validate_categories(1, None))
        self.assertTrue(gcm.validate_categories(1, "on-the-job"))

    def test_rejects_unknown_slug(self):
        self.assertTrue(gcm.validate_categories(1, ["not-a-real-category"]))

    def test_rejects_duplicates(self):
        self.assertTrue(gcm.validate_categories(1, ["on-the-job", "on-the-job"]))

    def test_accepts_known(self):
        self.assertEqual(gcm.validate_categories(1, ["on-the-job", "mindsets"]), [])


class TestGoldenFile(unittest.TestCase):
    """The acceptance test for the whole design."""

    def test_print_nerd_reproduces_committed_migration(self):
        meta, rows, errors = gcm.load_batch(PRINT_NERD_BATCH)
        self.assertEqual(errors, [])
        row_errors, optional_columns = gcm.validate(meta, rows)
        self.assertEqual(row_errors, [])

        generated = gcm.render_sql(
            meta, rows, optional_columns, Path("scripts/data/print-nerd-videos.json")
        )
        committed = PRINT_NERD_GOLDEN.read_text(encoding="utf-8")

        # The provenance comment names whichever script wrote the file, and a
        # new generator cannot honestly claim to be the retired one. Every
        # other byte must match.
        normalised = generated.replace(
            "scripts/generate-content-migration.py",
            "scripts/generate-print-nerd-migration.py",
        )
        self.assertEqual(normalised.splitlines(), committed.splitlines())

    def test_only_the_provenance_line_differs(self):
        meta, rows, _ = gcm.load_batch(PRINT_NERD_BATCH)
        _, optional_columns = gcm.validate(meta, rows)
        generated = gcm.render_sql(
            meta, rows, optional_columns, Path("scripts/data/print-nerd-videos.json")
        )
        committed = PRINT_NERD_GOLDEN.read_text(encoding="utf-8")
        differing = [
            i for i, (a, b) in enumerate(
                zip(generated.splitlines(), committed.splitlines())
            ) if a != b
        ]
        self.assertEqual(differing, [2])

    def test_print_nerd_batch_shape(self):
        meta, rows, errors = gcm.load_batch(PRINT_NERD_BATCH)
        self.assertEqual(errors, [])
        self.assertEqual(len(rows), 6)
        self.assertEqual(gcm.expected_link_count(rows), 12)


class TestRenderDetails(unittest.TestCase):
    def base_batch(self):
        meta = {
            "label": "demo", "id_prefix": "demo", "expected_count": 1,
            "provider": "youtube", "sql_comment": "Seed demo.",
        }
        rows = [{
            "sequence": 1, "content_id": "demo-001", "slug": "a-slug",
            "title": "T", "description": "D",
            "url": "https://www.youtube.com/watch?v=vid11111111",
            "youtube_id": "vid11111111",
            "thumbnail_url": "https://img.youtube.com/vi/vid11111111/maxresdefault.jpg",
            "orientation": "horizontal", "categories": ["on-the-job"],
        }]
        return meta, rows

    def test_apostrophes_survive_rendering(self):
        meta, rows = self.base_batch()
        rows[0]["title"] = "It's a Trade"
        _, optional_columns = gcm.validate(meta, rows)
        out = gcm.render_sql(meta, rows, optional_columns, Path("b.json"))
        self.assertIn("'It''s a Trade'", out)

    def test_label_appears_in_assertions(self):
        meta, rows = self.base_batch()
        _, optional_columns = gcm.validate(meta, rows)
        out = gcm.render_sql(meta, rows, optional_columns, Path("b.json"))
        self.assertIn("Expected % demo rows upserted", out)
        self.assertIn("Expected % demo category links", out)

    def test_source_url_omitted_when_absent(self):
        meta, rows = self.base_batch()
        _, optional_columns = gcm.validate(meta, rows)
        out = gcm.render_sql(meta, rows, optional_columns, Path("b.json"))
        self.assertNotIn("-- Source:", out)

    def test_minimal_batch_has_no_optional_columns(self):
        meta, rows = self.base_batch()
        errors, optional_columns = gcm.validate(meta, rows)
        self.assertEqual(errors, [])
        self.assertEqual(optional_columns, [])
        out = gcm.render_sql(meta, rows, optional_columns, Path("b.json"))
        self.assertNotIn("video_duration", out)
        self.assertNotIn("reflection", out)


class TestApplyHelpers(unittest.TestCase):
    def test_is_local(self):
        self.assertTrue(launchpad_apply.is_local(
            "postgresql://postgres:pw@localhost:5432/db"))
        self.assertTrue(launchpad_apply.is_local(
            "postgresql://postgres:pw@127.0.0.1:5432/db"))
        self.assertFalse(launchpad_apply.is_local(
            "postgresql://postgres:pw@db.example.supabase.co:5432/postgres"))

    def test_is_local_is_not_fooled_by_a_lookalike_host(self):
        """This gates the confirmation prompt, so substring matching is unsafe."""
        self.assertFalse(launchpad_apply.is_local(
            "postgresql://u:p@localhost.example.com:5432/db"))
        self.assertFalse(launchpad_apply.is_local(
            "postgresql://u:p@not-127.0.0.1.example.com/db"))

    def test_connection_args_keeps_password_off_the_command_line(self):
        argv, env = launchpad_apply.connection_args(
            "postgresql://postgres:hunter2@localhost:5432/launchpad_local")
        self.assertNotIn("hunter2", " ".join(argv))
        self.assertEqual(env, {"PGPASSWORD": "hunter2"})
        self.assertEqual(argv, ["-h", "localhost", "-p", "5432",
                                "-U", "postgres", "-d", "launchpad_local"])

    def test_connection_args_unquotes_percent_encoding(self):
        _, env = launchpad_apply.connection_args(
            "postgresql://postgres:p%40ss%3Aword@localhost/db")
        self.assertEqual(env["PGPASSWORD"], "p@ss:word")

    def test_connection_args_passes_through_non_urls(self):
        argv, env = launchpad_apply.connection_args("service=mydb")
        self.assertEqual(argv, ["service=mydb"])
        self.assertEqual(env, {})

    def test_redact_hides_password(self):
        out = launchpad_apply.redact("postgresql://postgres:hunter2@localhost:5432/db")
        self.assertNotIn("hunter2", out)
        self.assertIn("postgres:***@localhost:5432/db", out)

    def test_snapshot_records_absent_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = launchpad_apply.write_snapshot(
                "demo",
                ["demo-001", "demo-002"],
                [{"id": "demo-001", "title": "existing"}],
                directory=Path(tmp),
            )
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["meta"]["absent_before_apply"], ["demo-002"])
            self.assertEqual(len(payload["rows"]), 1)

    def test_snapshot_filename_is_timestamped(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = launchpad_apply.write_snapshot("demo", [], [], directory=Path(tmp))
            self.assertTrue(first.name.startswith("demo-"))
            self.assertTrue(first.name.endswith(".json"))

    def test_snapshot_query_escapes_ids(self):
        query = launchpad_apply.snapshot_query(["it's-001"])
        self.assertIn("'it''s-001'", query)

    def test_revalidate_requires_config(self):
        self.assertTrue(launchpad_apply.revalidate_site({}))
        self.assertTrue(launchpad_apply.revalidate_site({"LAUNCHPAD_REVALIDATE_SECRET": "s"}))

    def test_revalidate_posts_bearer_token(self):
        """The HTTP layer is thin enough to fake without a mocking library."""
        captured = {}

        def fake_opener(request):
            captured["url"] = request.full_url
            captured["method"] = request.method
            captured["auth"] = request.get_header("Authorization")
            return None

        errors = launchpad_apply.revalidate_site(
            {"LAUNCHPAD_REVALIDATE_SECRET": "s3cret",
             "LAUNCHPAD_SITE_URL": "https://example.test/"},
            opener=fake_opener,
        )
        self.assertEqual(errors, [])
        self.assertEqual(captured["url"],
                         "https://example.test/api/revalidate-launchpad-content")
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["auth"], "Bearer s3cret")

    def test_revalidate_reports_transport_errors(self):
        def boom(request):
            raise OSError("connection refused")

        errors = launchpad_apply.revalidate_site(
            {"LAUNCHPAD_REVALIDATE_SECRET": "s", "LAUNCHPAD_SITE_URL": "https://x.test"},
            opener=boom,
        )
        self.assertTrue(any("connection refused" in e for e in errors))

    def test_apply_refuses_without_database_url(self):
        code = launchpad_apply.apply_batch(
            meta={"label": "demo"}, rows=[], statement="", env={}
        )
        self.assertEqual(code, 1)


class TestEnv(unittest.TestCase):
    def test_process_env_wins_over_file(self):
        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            try:
                Path(".env.local").write_text(
                    "FOO=from_file\nBAR=only_file\n# comment\n\n", encoding="utf-8"
                )
                os.environ["FOO"] = "from_process"
                env = lc.load_env()
                self.assertEqual(env["FOO"], "from_process")
                self.assertEqual(env["BAR"], "only_file")
            finally:
                os.environ.pop("FOO", None)
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
