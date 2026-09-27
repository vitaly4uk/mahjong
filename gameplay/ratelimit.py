"""Shared per-IP fixed-window rate limiting via Django's cache — used by both
`gameplay/api.py` (the gameplay endpoints' quotas) and
`gameplay/middleware.py` (the anonymous-identity creation quota). Pulled out
on its own so the two don't duplicate `_client_ip`/the counter logic.
"""
from django.core.cache import cache

RATE_LIMIT_WINDOW_SECONDS = 300


def client_ip(request):
    """The client's real IP: production goes through Cloudflare Tunnel (see
    CLAUDE.md), so REMOTE_ADDR is the proxy's own address, the same for every
    player. CF-Connecting-IP is the header Cloudflare itself sets with the
    real client IP; locally (without Cloudflare) it's absent, so falling back
    to REMOTE_ADDR remains correct for the dev server.
    """
    return request.META.get('HTTP_CF_CONNECTING_IP') or request.META.get('REMOTE_ADDR', 'unknown')


# Note: without a dedicated CACHES backend (config/settings.py), Django uses
# LocMemCache — a per-process counter, so the effective limit is
# ≈ limit × the number of gunicorn workers, not an exact global limit.
# Acceptable at this project's scale; if an exact limit is ever needed, a
# shared cache backend (Redis/Memcached) is required.
def rate_limited(request, action, limit, window_seconds=RATE_LIMIT_WINDOW_SECONDS):
    """A simple fixed-window per-IP rate quota via Django cache."""
    key = f'gameplay:ratelimit:{action}:{client_ip(request)}'
    count = cache.get(key, 0)
    if count >= limit:
        return True
    cache.set(key, count + 1, window_seconds)
    return False
