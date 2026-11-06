"""Users and roles.

admin     everything, including Settings (fleet registry, GCS adapters, alert thresholds, users)
operator  monitor, acknowledge alerts, tag flights, run the demo planner
viewer    monitor only (read-only)
"""
import hashlib
import hmac
import os
import time

from fastapi import HTTPException
from itsdangerous import BadSignature, URLSafeTimedSerializer

from . import config

ROLES = ("admin", "operator", "viewer")
RANK = {"viewer": 0, "operator": 1, "admin": 2}
COOKIE = "twin_session"
signer = URLSafeTimedSerializer(config.SECRET_KEY, salt="twin-login")
_cache = {}


def hash_pw(pw, iterations=200_000):
    salt = os.urandom(16).hex()
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), iterations).hex()
    return f"pbkdf2${iterations}${salt}${h}"


def check_pw(pw, stored):
    try:
        _, it, salt, h = stored.split("$")
        got = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it)).hex()
        return hmac.compare_digest(got, h)
    except Exception:
        return False


def bootstrap(store):
    """First start: create the users from TWIN_USERS / TWIN_PASSWORD (the first one is admin, the rest operators)."""
    if store.users():
        return
    for i, (name, pw) in enumerate(config.USERS.items()):
        store.save_user(name, hash_pw(pw), "admin" if i == 0 else "operator", name)


def login(store, username, pw):
    u = store.user(username)
    if not u or not check_pw(pw, u["pw_hash"]):
        return None
    store.touch_login(username)
    return u


def session_cookie(username):
    return signer.dumps(username)


def current_user(store, request):
    tok = request.cookies.get(COOKIE)
    if not tok:
        return None
    try:
        name = signer.loads(tok, max_age=7 * 24 * 3600)
    except BadSignature:
        return None
    hit = _cache.get(name)
    if hit and time.time() - hit[0] < 10:
        return hit[1]
    u = store.user(name)
    if u:
        u = {"username": u["username"], "role": u["role"], "full_name": u["full_name"]}
    _cache[name] = (time.time(), u)
    return u


def forget(username):
    _cache.pop(username, None)


def require(store, request, role="viewer"):
    u = current_user(store, request)
    if not u:
        raise HTTPException(401, "login required")
    if RANK.get(u["role"], -1) < RANK[role]:
        raise HTTPException(403, f"needs the {role} role")
    return u
