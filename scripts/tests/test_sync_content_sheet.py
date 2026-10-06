"""Tests for the Google Sheets client and the sheet sync script.

Run from the repo root:

    python3 -m unittest discover -s scripts/tests

No network: HTTP is faked through the `fetch`/`opener` parameters, and the
RSA key is built from two Mersenne primes at test time so no private key is
committed.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import google_sheets as gs  # noqa: E402

_spec = importlib.util.spec_from_file_location("sync_content_sheet", SCRIPTS / "sync-content-sheet.py")
scs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scs)


# --------------------------------------------------------------------------
# A throwaway RSA key, encoded as PKCS#8 PEM the way Google issues them
# --------------------------------------------------------------------------

P, Q, E = 2**521 - 1, 2**607 - 1, 65537
N = P * Q
D = pow(E, -1, (P - 1) * (Q - 1))


def _der(tag: int, body: bytes) -> bytes:
    if len(body) < 0x80:
        length = bytes([len(body)])
    else:
        size = (len(body).bit_length() + 7) // 8
        length = bytes([0x80 | size]) + len(body).to_bytes(size, "big")
    return bytes([tag]) + length + body


def _der_int(value: int) -> bytes:
    return _der(0x02, value.to_bytes(value.bit_length() // 8 + 1, "big"))


def test_pem() -> str:
    rsa = _der(0x30, b"".join(_der_int(v) for v in (
        0, N, E, D, P, Q, D % (P - 1), D % (Q - 1), pow(Q, -1, P),
    )))
    algorithm = _der(0x30, bytes.fromhex("06092a864886f70d0101010500"))
    pkcs8 = _der(0x30, _der_int(0) + algorithm + _der(0x04, rsa))
    body = base64.encodebytes(pkcs8).decode()
    return f"-----BEGIN PRIVATE KEY-----\n{body}-----END PRIVATE KEY-----\n"


class TestRs256(unittest.TestCase):
    def test_parses_modulus_and_private_exponent(self):
        self.assertEqual(gs.rsa_private_key(test_pem()), (N, D))

    def test_rejects_pkcs1_pem(self):
        with self.assertRaises(gs.SheetsError):
            gs.rsa_private_key("-----BEGIN RSA PRIVATE KEY-----\nAA==\n-----END RSA PRIVATE KEY-----")

    def test_signature_verifies_as_pkcs1_v15_sha256(self):
        message = b"header.claims"
        signature = gs.rs256_sign(message, N, D)
        size = (N.bit_length() + 7) // 8
        self.assertEqual(len(signature), size)
        recovered = pow(int.from_bytes(signature, "big"), E, N).to_bytes(size, "big")
        digest_info = gs.SHA256_DIGEST_INFO + hashlib.sha256(message).digest()
        self.assertTrue(recovered.startswith(b"\x00\x01\xff"))
        self.assertTrue(recovered.endswith(b"\x00" + digest_info))
        self.assertEqual(set(recovered[2:-len(digest_info) - 1]), {0xFF})

    def test_assertion_claims(self):
        info = {"client_email": "sa@example.iam.gserviceaccount.com", "private_key": test_pem()}
        header, claims, signature = gs.build_assertion(info, gs.SCOPE_READONLY, now=1000).split(".")

        def decode(part):
            return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))

        self.assertEqual(decode(header), {"alg": "RS256", "typ": "JWT"})
        self.assertEqual(decode(claims), {
            "iss": info["client_email"], "scope": gs.SCOPE_READONLY,
            "aud": gs.TOKEN_URI, "iat": 1000, "exp": 4600,
        })
        self.assertNotIn("=", signature)


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestSheetsClient(unittest.TestCase):
    def test_batch_update_writes_raw_values(self):
        sent = []

        def opener(request):
            sent.append(request)
            return FakeResponse(b'{"totalUpdatedCells": 1}')

        client = gs.SheetsClient("sheet123", "token", opener)
        result = client.batch_update_values([("'Live Content'!J2", [["Why?"]])])

        self.assertEqual(result, {"totalUpdatedCells": 1})
        request = sent[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertTrue(request.full_url.endswith("/sheet123/values:batchUpdate"))
        self.assertEqual(request.headers["Authorization"], "Bearer token")
        self.assertEqual(json.loads(request.data), {
            "valueInputOption": "RAW",
            "data": [{"range": "'Live Content'!J2", "values": [["Why?"]]}],
        })

    def test_quote_tab_escapes_apostrophes(self):
        self.assertEqual(gs.quote_tab("Live Content"), "'Live Content'")
        self.assertEqual(gs.quote_tab("Alex's tab"), "'Alex''s tab'")


# --------------------------------------------------------------------------
# Sheet sync
# --------------------------------------------------------------------------

HEADER = [
    "Title", "Content Type", "Path", "Video URL", "Launchpad URL", "Description",
    "Why It Matters", "Planning Connection", "Takeaway", "Reflection",
    "Organization", "Published At",
]
COLUMNS, _ = scs.map_columns(HEADER)
REFLECTION = (
    "Inspectors visit a kitchen one day and a pool the next. Which of these "
    "places would you most want to spend your workday in, and what would you look for?"
)


def sheet_row(**overrides) -> list[str]:
    values = {
        "Title": "Where Does a Public Health Inspector Work?",
        "Content Type": "Video",
        "Path": "On the Job",
        "Video URL": "https://youtube.com/shorts/O2l0m32u_bU?si=tracking",
        "Description": "A quick look at the places inspectors check.",
        "Takeaway": "Inspectors work in many settings.",
        "Reflection": REFLECTION,
    }
    values.update(overrides)
    return [values.get(name, "") for name in HEADER]


def fake_fetch(responses):
    def fetch(url, follow_redirects):
        return responses.get((url, follow_redirects), (404, ""))
    return fetch


def youtube_responses(video_id, *, short=True, seconds=23, maxres=True):
    return {
        (f"https://www.youtube.com/shorts/{video_id}", False): (200, "") if short else (303, ""),
        (f"https://www.youtube.com/watch?v={video_id}", True): (200, f'..."lengthSeconds":"{seconds}"...'),
        (f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg", True): (200 if maxres else 404, ""),
    }


class TestHelpers(unittest.TestCase):
    def test_youtube_id_matches_the_app_parser(self):
        cases = {
            "https://www.youtube.com/watch?v=MLKrDUzYdEs": "MLKrDUzYdEs",
            "https://youtube.com/shorts/O2l0m32u_bU?si=BIBXr7y5aANoxMtE": "O2l0m32u_bU",
            "https://youtu.be/abc123": "abc123",
            "https://www.youtube.com/embed/xyz": "xyz",
            "https://m.youtube.com/watch?v=mobile1": "mobile1",
            "https://vimeo.com/12345": None,
            "not a url": None,
        }
        for url, expected in cases.items():
            self.assertEqual(scs.youtube_id(url), expected, url)

    def test_slugify(self):
        self.assertEqual(scs.slugify("Could You Be a Public Health Inspector?"),
                         "could-you-be-a-public-health-inspector")
        self.assertEqual(scs.slugify("This Experiment Saved Kids' Lives"),
                         "this-experiment-saved-kids-lives")
        self.assertEqual(scs.slugify("Rock & Roll"), "rock-and-roll")

    def test_parse_row_spec(self):
        self.assertEqual(scs.parse_row_spec("278-280"), [278, 279, 280])
        self.assertEqual(scs.parse_row_spec("280, 278"), [278, 280])
        with self.assertRaises(ValueError):
            scs.parse_row_spec("1-3")

    def test_column_letter(self):
        self.assertEqual([scs.column_letter(i) for i in (0, 9, 25, 26, 27)],
                         ["A", "J", "Z", "AA", "AB"])

    def test_map_columns_reports_missing_required_only(self):
        _, missing = scs.map_columns([h for h in HEADER if h not in ("Reflection", "Organization")])
        self.assertEqual(missing, ["Reflection"])

    def test_sheet_timestamp_matches_existing_format(self):
        self.assertEqual(scs.sheet_timestamp("2026-06-18T10:56:10.556328+00:00"),
                         "2026-06-18 10:56:10.556328+00")


class TestProbes(unittest.TestCase):
    def test_orientation_from_shorts_redirect(self):
        self.assertEqual(scs.probe_orientation("a", fake_fetch(youtube_responses("a"))), "vertical")
        self.assertEqual(scs.probe_orientation("b", fake_fetch(youtube_responses("b", short=False))), "horizontal")
        with self.assertRaises(RuntimeError):
            scs.probe_orientation("c", fake_fetch({}))

    def test_duration(self):
        self.assertEqual(scs.probe_duration("a", fake_fetch(youtube_responses("a", seconds=113))), 113)
        with self.assertRaises(RuntimeError):
            scs.probe_duration("a", fake_fetch({}))

    def test_thumbnail_falls_back_to_hqdefault(self):
        self.assertTrue(scs.probe_thumbnail("a", fake_fetch(youtube_responses("a"))).endswith("/maxresdefault.jpg"))
        self.assertTrue(scs.probe_thumbnail("a", fake_fetch(youtube_responses("a", maxres=False))).endswith("/hqdefault.jpg"))


class TestBuildRow(unittest.TestCase):
    def build(self, **overrides):
        fetch = fake_fetch(youtube_responses("O2l0m32u_bU"))
        return scs.build_row(280, sheet_row(**overrides), COLUMNS, fetch)

    def test_builds_a_generator_row(self):
        row, errors = self.build()
        self.assertEqual(errors, [])
        self.assertEqual(row["slug"], "where-does-a-public-health-inspector-work")
        self.assertEqual(row["url"], "https://www.youtube.com/watch?v=O2l0m32u_bU")
        self.assertEqual(row["categories"], ["on-the-job"])
        self.assertEqual((row["orientation"], row["duration_seconds"]), ("vertical", 23))
        self.assertNotIn("why_it_matters", row)

    def test_orientation_column_overrides_detection(self):
        header = HEADER + ["Orientation"]
        columns, _ = scs.map_columns(header)
        values = sheet_row() + ["Horizontal"]
        row, _ = scs.build_row(280, values, columns, fake_fetch(youtube_responses("O2l0m32u_bU")))
        self.assertEqual(row["orientation"], "horizontal")

    def test_maps_multiple_paths_including_problems(self):
        row, _ = self.build(Path="Emerging Careers, Problems")
        self.assertEqual(row["categories"], ["emerging-careers", "problems-to-solve"])

    def test_rejects_unknown_path_and_corrupted_text(self):
        _, errors = self.build(Path="Job Board", Takeaway="slow work � big impact")
        self.assertTrue(any("unknown Path" in e for e in errors))
        self.assertTrue(any("corrupted character" in e for e in errors))

    def test_articles_are_refused(self):
        row, errors = self.build(**{"Content Type": "Article"})
        self.assertEqual(row, {})
        self.assertIn("only videos", errors[0])


class TestMergeRows(unittest.TestCase):
    def test_appends_with_next_id_and_updates_in_place(self):
        existing = [{"sequence": 1, "content_id": "ciphi-001", "slug": "kept-slug",
                     "youtube_id": "aaa", "title": "Old"}]
        incoming = [
            {"slug": "renamed-slug", "youtube_id": "aaa", "title": "New"},
            {"slug": "second", "youtube_id": "bbb", "title": "Second"},
        ]
        rows, updated, added = scs.merge_rows(existing, incoming, "ciphi")
        self.assertEqual(updated, ["ciphi-001"])
        self.assertEqual(added, ["ciphi-002"])
        self.assertEqual(rows[0], {"sequence": 1, "content_id": "ciphi-001", "slug": "kept-slug",
                                   "youtube_id": "aaa", "title": "New"})
        self.assertEqual(rows[1]["sequence"], 2)

    def test_live_conflicts_ignore_the_rows_own_id(self):
        live = [
            {"id": "ciphi-001", "slug": "mine", "video_url": "https://www.youtube.com/watch?v=aaa"},
            {"id": "other-007", "slug": "taken", "video_url": "https://www.youtube.com/watch?v=zzz"},
        ]
        rows = [
            {"content_id": "ciphi-001", "slug": "mine", "youtube_id": "aaa"},
            {"content_id": "ciphi-002", "slug": "taken", "youtube_id": "zzz"},
        ]
        errors = scs.live_conflicts(rows, live)
        self.assertEqual(len(errors), 2)
        self.assertTrue(all(e.startswith("ciphi-002") for e in errors))


class TestPlanFill(unittest.TestCase):
    LIVE = [
        {"id": "x-1", "slug": "linked", "video_url": "https://www.youtube.com/watch?v=aaa",
         "reflection": "Live reflection?", "published_at": "2026-06-18T10:56:10.5+00:00"},
        {"id": "x-2", "slug": "unlinked", "video_url": "https://www.youtube.com/watch?v=bbb",
         "reflection": "Second?", "published_at": "2026-10-06T12:00:00+00:00"},
    ]

    def plan(self, rows):
        return scs.plan_fill([HEADER] + rows, COLUMNS, self.LIVE, "https://launchpad.example.ca/")

    def test_fills_only_empty_cells(self):
        writes, notes, not_live = self.plan([
            sheet_row(**{"Launchpad URL": "https://launchpad.example.ca/?content=linked",
                         "Reflection": "", "Published At": "2026-06-18 10:56:10.5+00"}),
        ])
        self.assertEqual(writes, [(2, "reflection", "Live reflection?")])
        self.assertEqual((notes, not_live), ([], []))

    def test_newly_live_row_matched_by_video_gets_url_and_date(self):
        writes, _, _ = self.plan([
            sheet_row(**{"Video URL": "https://youtu.be/bbb", "Reflection": "Second?"}),
        ])
        self.assertEqual(writes, [
            (2, "launchpad_url", "https://launchpad.example.ca/?content=unlinked"),
            (2, "published_at", "2026-10-06 12:00:00+00"),
        ])

    def test_reports_differences_and_unknown_rows_without_writing(self):
        writes, notes, not_live = self.plan([
            sheet_row(**{"Launchpad URL": "https://launchpad.example.ca/?content=linked",
                         "Reflection": "Edited in the sheet?", "Published At": "x"}),
            sheet_row(**{"Video URL": "https://youtu.be/new"}),
            sheet_row(**{"Launchpad URL": "https://launchpad.example.ca/?content=gone"}),
        ])
        self.assertEqual(writes, [])
        self.assertEqual(not_live, [3])
        self.assertEqual(len(notes), 2)
        self.assertIn("differs from live", notes[0])
        self.assertIn("'gone' is not live", notes[1])


if __name__ == "__main__":
    unittest.main()
