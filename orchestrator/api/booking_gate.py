"""
Fabric-holder gate.

The lab is a single shared fabric. The booking Worker decides *who* holds it
right now; this module is how the orchestrator *enforces* that — it gates the
mutating routes (start / reset / solve / console) so a learner without the
current slot can't wipe the fabric out from under whoever booked it.

Identity comes from the signed `aidc_auth` session cookie that the booking
Worker issues after a magic-link login (see auth.py). We ask the booking Worker
(`GET /api/holder/current`, guarded by a shared secret) which email holds the
fabric now, and allow the action iff they match.

Config (env):
  AIDC_BOOKING_ENFORCE   "1" to enforce; anything else (default) = open.
                         Off for local dev / LOCAL=1 (no auth cookie in front).
  AIDC_BOOKING_URL       base URL of the booking Worker (workers.dev for the
                         server-to-server holder call)
  AIDC_BOOKING_SECRET    shared secret == the Worker's ORCH_SHARED_SECRET
  AIDC_AUTH_SECRET       HMAC secret == the Worker's AUTH_SIGNING_SECRET
  AIDC_BOOKING_FAIL_OPEN "1" to allow on booking-service errors (friendlier),
                         default "0" = deny (preserves the exclusivity guarantee).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException, Request

from . import auth


def _enabled() -> bool:
    return os.environ.get("AIDC_BOOKING_ENFORCE", "0") == "1"


def _fail_open() -> bool:
    return os.environ.get("AIDC_BOOKING_FAIL_OPEN", "0") == "1"


def caller_email(request: Request) -> Optional[str]:
    """The signed-in email for this request (from the aidc_auth cookie), if any."""
    return auth.email_from_cookie_header(request.headers.get("cookie"))


def _current_holder() -> tuple[Optional[str], Optional[str]]:
    """Ask the booking Worker who holds the fabric now.

    Returns (holder_email, ends_at_iso). Raises RuntimeError on transport error.
    """
    base = os.environ.get("AIDC_BOOKING_URL", "").rstrip("/")
    secret = os.environ.get("AIDC_BOOKING_SECRET", "")
    if not base or not secret:
        raise RuntimeError("booking gate enabled but AIDC_BOOKING_URL/SECRET unset")
    req = urllib.request.Request(
        f"{base}/api/holder/current",
        # A non-default User-Agent is required: Cloudflare's Browser Integrity
        # Check bans the stock "Python-urllib/x.y" signature at the edge (error
        # 1010), so the request never reaches the Worker.
        headers={"X-Orch-Secret": secret, "User-Agent": "aidc-orchestrator/1.0"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise RuntimeError(f"booking service unreachable: {e}") from e
    holder = body.get("holder_email")
    return (holder.strip().lower() if holder else None), body.get("ends_at")


def _fmt_until(ends_at: Optional[str]) -> str:
    if not ends_at:
        return ""
    try:
        dt = datetime.fromisoformat(ends_at.replace("Z", "+00:00")).astimezone(timezone.utc)
        return f" until {dt.strftime('%H:%M UTC')}"
    except ValueError:
        return ""


def require_fabric_holder(request: Request) -> Optional[str]:
    """FastAPI dependency: allow only the current slot holder to mutate the fabric.

    Returns the caller's email (or None when enforcement is off) so handlers can
    attribute the action. Raises 423 when someone else holds the fabric, 403 when
    the caller is unauthenticated under enforcement, 503 when the booking service
    can't be reached (unless AIDC_BOOKING_FAIL_OPEN=1).
    """
    if not _enabled():
        return caller_email(request)  # may be None; harmless when open

    email = caller_email(request)
    if not email:
        raise HTTPException(status_code=403, detail="Sign in to use the lab.")

    try:
        holder, ends_at = _current_holder()
    except RuntimeError as e:
        if _fail_open():
            return email
        raise HTTPException(status_code=503, detail=str(e))

    if holder is None:
        raise HTTPException(
            status_code=423,
            detail="No active reservation — book a slot to use the fabric.",
        )
    if holder != email:
        raise HTTPException(
            status_code=423,
            detail=f"Fabric reserved by another learner{_fmt_until(ends_at)}.",
        )
    return email


def require_fabric_resettable(request: Request) -> Optional[str]:
    """FastAPI dependency for the end-session / expiry baseline reset.

    Looser than require_fabric_holder: a reset-to-baseline is allowed when the
    caller currently holds the fabric (an explicit "end session early") OR when
    *nobody* holds it (the caller's window has just lapsed — the timer expired).
    It is denied only when a *different* learner holds the fabric now, so one
    learner can never wipe another's live session out from under them.
    """
    if not _enabled():
        return caller_email(request)

    email = caller_email(request)
    if not email:
        raise HTTPException(status_code=403, detail="Sign in to use the lab.")

    try:
        holder, ends_at = _current_holder()
    except RuntimeError as e:
        if _fail_open():
            return email
        raise HTTPException(status_code=503, detail=str(e))

    if holder is not None and holder != email:
        raise HTTPException(
            status_code=423,
            detail=f"Fabric reserved by another learner{_fmt_until(ends_at)}.",
        )
    return email


def ws_denial(ws) -> Optional[str]:
    """WebSocket variant of the gate (the console shell).

    Returns None if the caller may open a shell, else a short close-reason
    string (WebSocket close reasons are length-limited, so keep it terse).
    """
    if not _enabled():
        return None
    email = auth.email_from_cookie_header(ws.headers.get("cookie"))
    if not email:
        return "sign in to use the console"
    try:
        holder, _ = _current_holder()
    except RuntimeError:
        return None if _fail_open() else "booking service unavailable"
    if holder is None:
        return "no active reservation"
    if holder != email:
        return "fabric reserved by another learner"
    return None
