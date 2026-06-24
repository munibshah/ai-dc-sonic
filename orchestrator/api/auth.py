"""
Session-cookie identity (custom magic-link auth — replaces Cloudflare Access).

The booking Worker issues a signed `aidc_auth` cookie after a magic-link login:

    aidc_auth = base64url(JSON{email,iat,exp}) "." base64url(HMAC-SHA256(payloadB64, secret))

Both the Worker and this orchestrator verify it with the same shared secret
(AIDC_AUTH_SECRET == the Worker's AUTH_SIGNING_SECRET). Pure stdlib — no network.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Optional

SESSION_COOKIE = "aidc_auth"


def _secret() -> str:
    return os.environ.get("AIDC_AUTH_SECRET", "")


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _b64url_no_pad(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def verify_session(value: Optional[str]) -> Optional[str]:
    """Verify a session-cookie value; return the lowercased email or None."""
    secret = _secret()
    if not value or not secret or "." not in value:
        return None
    payload_b64, sig = value.split(".", 1)
    expected = _b64url_no_pad(
        hmac.new(secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except (ValueError, json.JSONDecodeError):
        return None
    email = payload.get("email")
    exp = payload.get("exp")
    if not email or not exp or float(exp) * 1000 < time.time() * 1000:
        return None
    return str(email).strip().lower()


def _cookie_from_header(cookie_header: Optional[str], name: str) -> Optional[str]:
    if not cookie_header:
        return None
    for part in cookie_header.split(";"):
        k, _, v = part.strip().partition("=")
        if k == name:
            return v
    return None


def email_from_cookie_header(cookie_header: Optional[str]) -> Optional[str]:
    """Resolve the caller's email from a raw Cookie header string."""
    return verify_session(_cookie_from_header(cookie_header, SESSION_COOKIE))
