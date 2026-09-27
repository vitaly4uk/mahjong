"""Per-IP rate limiting on top of django-ninja's own `ninja.throttling`
(the project already depends on django-ninja — no need for a second
library, and no need to hand-roll the cache-window logic ninja already
implements in `SimpleRateThrottle`).

`IpRateThrottle` is the one piece worth owning: ninja's built-in
`AnonRateThrottle` skips throttling entirely once `request.auth` is set
(`get_cache_key` returns None), but `config/api.py: CsrfOnly` authenticates
*every* request — it's a CSRF gate, not real auth — so `request.auth` is
always truthy and `AnonRateThrottle` would silently throttle nothing here.
`IpRateThrottle` always keys on IP, and identifies it via `CF-Connecting-IP`
(production sits behind a Cloudflare Tunnel — `REMOTE_ADDR` would just see
the proxy's own address) rather than ninja's default X-Forwarded-For
parsing, which nothing here sets.

Used directly as a `throttle=` on `gameplay/api.py` routes (ninja checks it
before the view runs, raising `ninja.errors.Throttled` -> 429 itself), and
called manually via `.allow_request(request)` from
`gameplay/middleware.py`, which runs outside ninja's own routing and so
can't use the `throttle=` operation kwarg.
"""
from ninja.throttling import SimpleRateThrottle

RATE_LIMIT_WINDOW_SECONDS = 300


class IpRateThrottle(SimpleRateThrottle):
    def __init__(self, scope, num_requests, window_seconds=RATE_LIMIT_WINDOW_SECONDS):
        self.scope = scope
        super().__init__(rate=f'{num_requests}/{window_seconds}s')

    def get_ident(self, request):
        return request.META.get('HTTP_CF_CONNECTING_IP') or super().get_ident(request)

    def get_cache_key(self, request):
        # Always throttle by IP — see module docstring for why this can't
        # just be ninja's AnonRateThrottle.
        return self.cache_format % {'scope': self.scope, 'ident': self.get_ident(request)}
