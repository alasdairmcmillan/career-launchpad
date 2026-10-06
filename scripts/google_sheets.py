"""Minimal Google Sheets client, authenticated as a service account.

Stdlib-only, like everything else in scripts/. The one thing the standard
library lacks for service-account auth is RS256 signing; PKCS#1 v1.5 over
SHA-256 is a few lines of integer arithmetic once the PEM key is parsed, and
it is deterministic, so a test pins it against a fixed signature.

The key file path comes from LAUNCHPAD_SHEETS_CREDENTIALS (read from
`.env.local` or the process env via `launchpad_content.load_env`). The key
must never be committed; `.gitignore` covers the downloaded filename.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

SCOPE_READONLY = "https://www.googleapis.com/auth/spreadsheets.readonly"
SCOPE_READWRITE = "https://www.googleapis.com/auth/spreadsheets"
TOKEN_URI = "https://oauth2.googleapis.com/token"
SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"

# DER-encoded DigestInfo prefix for SHA-256 (RFC 8017, section 9.2, note 1).
SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")

Opener = Callable[[urllib.request.Request], Any]


class SheetsError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# RS256
# --------------------------------------------------------------------------

def _der_read(buf: bytes, offset: int) -> tuple[int, bytes, int]:
    """Read one DER TLV at `offset`; return (tag, value, next offset)."""
    tag = buf[offset]
    length = buf[offset + 1]
    offset += 2
    if length & 0x80:
        size = length & 0x7F
        length = int.from_bytes(buf[offset:offset + size], "big")
        offset += size
    return tag, buf[offset:offset + length], offset + length


def _der_children(body: bytes) -> list[tuple[int, bytes]]:
    children, offset = [], 0
    while offset < len(body):
        tag, value, offset = _der_read(body, offset)
        children.append((tag, value))
    return children


def rsa_private_key(pem: str) -> tuple[int, int]:
    """Return (modulus, private exponent) from a PKCS#8 PEM RSA key.

    Google service-account keys are always `-----BEGIN PRIVATE KEY-----`
    (PKCS#8), wrapping a PKCS#1 RSAPrivateKey in an OCTET STRING.
    """
    if "BEGIN PRIVATE KEY" not in pem:
        raise SheetsError("expected a PKCS#8 'BEGIN PRIVATE KEY' PEM")
    body = "".join(line for line in pem.strip().splitlines() if not line.startswith("-----"))
    _, private_key_info, _ = _der_read(base64.b64decode(body), 0)
    _, rsa_der = _der_children(private_key_info)[2]
    _, rsa_body, _ = _der_read(rsa_der, 0)
    integers = [int.from_bytes(value, "big") for _, value in _der_children(rsa_body)]
    # RSAPrivateKey ::= SEQUENCE { version, n, e, d, p, q, dp, dq, qinv }
    return integers[1], integers[3]


def rs256_sign(message: bytes, modulus: int, private_exponent: int) -> bytes:
    """RSASSA-PKCS1-v1_5 signature with SHA-256."""
    size = (modulus.bit_length() + 7) // 8
    digest_info = SHA256_DIGEST_INFO + hashlib.sha256(message).digest()
    padding = b"\xff" * (size - len(digest_info) - 3)
    encoded = b"\x00\x01" + padding + b"\x00" + digest_info
    signature = pow(int.from_bytes(encoded, "big"), private_exponent, modulus)
    return signature.to_bytes(size, "big")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------

def load_service_account(path: str | Path) -> dict[str, Any]:
    path = Path(path)
    if not path.exists():
        raise SheetsError(f"service account key not found: {path}")
    info = json.loads(path.read_text(encoding="utf-8"))
    for field in ("client_email", "private_key"):
        if not info.get(field):
            raise SheetsError(f"{path} is not a service account key (no {field})")
    return info


def build_assertion(info: dict[str, Any], scope: str, now: int | None = None) -> str:
    now = int(time.time()) if now is None else now
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claims = _b64url(json.dumps({
        "iss": info["client_email"],
        "scope": scope,
        "aud": info.get("token_uri") or TOKEN_URI,
        "iat": now,
        "exp": now + 3600,
    }, separators=(",", ":")).encode())
    signing_input = f"{header}.{claims}"
    modulus, exponent = rsa_private_key(info["private_key"])
    return f"{signing_input}.{_b64url(rs256_sign(signing_input.encode(), modulus, exponent))}"


def fetch_access_token(
    info: dict[str, Any],
    scope: str,
    opener: Opener = urllib.request.urlopen,
) -> str:
    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": build_assertion(info, scope),
    }).encode()
    request = urllib.request.Request(info.get("token_uri") or TOKEN_URI, data=body, method="POST")
    return _send(request, opener)["access_token"]


def _send(request: urllib.request.Request, opener: Opener) -> dict[str, Any]:
    try:
        with opener(request) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            pass
        raise SheetsError(f"HTTP {exc.code} from {request.full_url.split('?')[0]}: {detail}") from None


# --------------------------------------------------------------------------
# Client
# --------------------------------------------------------------------------

class SheetsClient:
    def __init__(
        self,
        spreadsheet_id: str,
        access_token: str,
        opener: Opener = urllib.request.urlopen,
    ) -> None:
        self.spreadsheet_id = spreadsheet_id
        self._token = access_token
        self._opener = opener

    @classmethod
    def from_key_file(
        cls,
        spreadsheet_id: str,
        key_path: str | Path,
        scope: str = SCOPE_READONLY,
        opener: Opener = urllib.request.urlopen,
    ) -> "SheetsClient":
        token = fetch_access_token(load_service_account(key_path), scope, opener)
        return cls(spreadsheet_id, token, opener)

    def _request(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        url = f"{SHEETS_API}/{self.spreadsheet_id}{path}"
        headers = {"Authorization": f"Bearer {self._token}"}
        data = None
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers,
                                         method="POST" if data is not None else "GET")
        return _send(request, self._opener)

    def tab_title(self, gid: int) -> str:
        """Resolve a tab's title from the `gid` in its URL."""
        meta = self._request("?fields=sheets.properties(sheetId,title)")
        for sheet in meta.get("sheets", []):
            if sheet["properties"]["sheetId"] == gid:
                return sheet["properties"]["title"]
        raise SheetsError(f"no tab with gid {gid} in spreadsheet {self.spreadsheet_id}")

    def get_values(self, a1_range: str) -> list[list[str]]:
        """Formatted cell values. Trailing empty cells and rows are omitted by the API."""
        quoted = urllib.parse.quote(a1_range, safe="")
        return self._request(f"/values/{quoted}?valueRenderOption=FORMATTED_VALUE").get("values", [])

    def batch_update_values(self, updates: list[tuple[str, list[list[Any]]]]) -> dict[str, Any]:
        """Write each (range, rows) pair as RAW values, so text is never parsed as a formula."""
        return self._request("/values:batchUpdate", {
            "valueInputOption": "RAW",
            "data": [{"range": a1, "values": values} for a1, values in updates],
        })


def quote_tab(title: str) -> str:
    """A1 notation for a tab title, quoted so spaces and punctuation survive."""
    return "'" + title.replace("'", "''") + "'"
