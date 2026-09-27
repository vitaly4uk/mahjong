"""The project's single django-ninja API (`/api/`): background photo
(`/api/background/`) + mounting `gameplay.api.router` (`/api/game/...`) under
one CSRF guard. `CsrfOnly` lives here (not in `gameplay/`) because it's a
general, non-game-specific mechanism — an `APIKeyCookie` stub that
authenticates no one (lets anonymous requests through too), but the inherited
`_get_key` forces the regular Django CSRF check on every unsafe request (GET
is left untouched by CSRF). The Django session/CSRF cookie is issued to every
visitor automatically via SessionMiddleware/CsrfViewMiddleware.
"""
import random

import requests
from django.conf import settings
from django.contrib.staticfiles.storage import staticfiles_storage
from django.core.cache import cache
from ninja import NinjaAPI
from ninja.security import APIKeyCookie

from gameplay.api import router as gameplay_router

from .schemas import BackgroundResponse, VersionResponse

# Zen/Eastern themes for a relaxing game background — agreed as part of the background design.
PEXELS_QUERIES = [
    'zen garden',
    'bamboo',
    'japanese garden',
    'tea ceremony',
    'koi pond',
]

PEXELS_POOL_CACHE_KEY = 'pexels_pool'
PEXELS_POOL_TTL = 60 * 60  # 1 hour — goes easy on the Pexels rate limit (200 requests/hour)


class CsrfOnly(APIKeyCookie):
    def authenticate(self, request, key):
        return True


# CsrfOnly authenticates everyone (see its docstring), so without this the
# interactive docs (/api/docs) and raw schema (/api/openapi.json) would be
# public in production too — both need disabling independently (NinjaAPI
# treats them as separate URLs). Both stay available in dev.
api = NinjaAPI(
    auth=CsrfOnly(),
    docs_url='/docs' if settings.DEBUG else None,
    openapi_url='/openapi.json' if settings.DEBUG else None,
)
api.add_router('/game', gameplay_router)


def get_build_version():
    """Hash of the `collectstatic` manifest (`staticfiles.json`) — already
    unique per deploy (WhiteNoise/Django regenerates it whenever the content
    of even one static file changes), so it's a cheap indicator of "the client
    is holding a stale version". Empty string in local dev if collectstatic
    hasn't run yet, or under a non-manifest storage backend (config/tests.py:
    SmokeTests swaps STORAGES to plain StaticFilesStorage, which has no
    manifest_hash attribute at all)."""
    return getattr(staticfiles_storage, 'manifest_hash', '')


def _fetch_pool():
    """Fetches a fresh pool of photos from Pexels. Returns [] on any error."""
    query = random.choice(PEXELS_QUERIES)
    try:
        response = requests.get(
            'https://api.pexels.com/v1/search',
            params={'query': query, 'orientation': 'landscape', 'per_page': 30, 'size': 'large'},
            headers={'Authorization': settings.PEXELS_API_KEY},
            timeout=5,
        )
        response.raise_for_status()
        data = response.json()
    except (requests.RequestException, ValueError):
        return []

    photos = data.get('photos') or []
    pool = []
    for photo in photos:
        src = photo.get('src') or {}
        url = src.get('large2x') or src.get('large')
        if not url:
            continue
        pool.append({
            'url': url,
            'photographer': photo.get('photographer', ''),
            'photographer_url': photo.get('photographer_url', ''),
        })
    return pool


@api.get('/background/', response=BackgroundResponse)
def background(request):
    """Returns a random background photo from Pexels (via a cached pool) or {"url": null}."""
    if not settings.PEXELS_API_KEY:
        return {'url': None}

    pool = cache.get(PEXELS_POOL_CACHE_KEY)
    if not pool:
        pool = _fetch_pool()
        if pool:
            cache.set(PEXELS_POOL_CACHE_KEY, pool, PEXELS_POOL_TTL)

    if not pool:
        return {'url': None}

    return random.choice(pool)


@api.get('/version/', response=VersionResponse)
def version(request):
    """Current build version — the client checks it against
    `window.MAHJONG_VERSION` (injected into templates/game.html with the same
    value) before starting a new game and reloads the page if they've
    diverged (a stale standalone app on iOS/macOS that hasn't updated in a
    while)."""
    return {'version': get_build_version()}
