from unittest.mock import patch

import requests
from django.conf import settings
from django.core.cache import cache, caches
from django.test import TestCase, override_settings

from .api import PEXELS_POOL_CACHE_KEY

# CompressedManifestStaticFilesStorage (the real STORAGES['staticfiles'] —
# config/settings.py) requires a staticfiles.json manifest from
# `collectstatic`, which CI doesn't run (bundle.js/tailwind.css are build
# artifacts, not present here at all). Swap in the plain filesystem storage
# so {% static %} in templates/game.html resolves without a manifest —
# matches get_build_version()'s own documented local-dev fallback
# (config/api.py), so the smoke test only asserts presence, not a value.
_SMOKE_TEST_STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'},
}


class BackgroundApiTests(TestCase):
    def tearDown(self):
        cache.delete(PEXELS_POOL_CACHE_KEY)

    @override_settings(PEXELS_API_KEY='')
    def test_background_without_api_key_returns_null_url(self):
        response = self.client.get('/api/background/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(), {'url': None, 'photographer': None, 'photographer_url': None},
        )

    @override_settings(PEXELS_API_KEY='test-key')
    @patch('config.api.requests.get')
    def test_background_with_api_key_returns_photo_from_pool(self, mock_get):
        mock_get.return_value.raise_for_status.return_value = None
        mock_get.return_value.json.return_value = {
            'photos': [{
                'src': {'large2x': 'https://example.com/photo.jpg'},
                'photographer': 'Jane Doe',
                'photographer_url': 'https://example.com/jane',
            }],
        }
        response = self.client.get('/api/background/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            'url': 'https://example.com/photo.jpg',
            'photographer': 'Jane Doe',
            'photographer_url': 'https://example.com/jane',
        })

    @override_settings(PEXELS_API_KEY='test-key')
    @patch('config.api.requests.get', side_effect=requests.RequestException('network error'))
    def test_background_pexels_failure_returns_null_url(self, mock_get):
        response = self.client.get('/api/background/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['url'], None)


class SmokeTests(TestCase):
    """The one place that ever renders '/' — a broken template or a stale
    {% static %} reference otherwise ships to production undetected (no
    other test in the project touches home_view/get_build_version)."""

    def test_suite_runs_on_locmem_cache(self):
        # Regression guard: CI (and any local run without REDIS_URL) must
        # exercise the LocMemCache path settings.py falls back to, not a
        # real Redis — the many `cache.clear()` calls across the test suite
        # (gameplay/tests.py) would otherwise FLUSHDB whatever REDIS_URL
        # points at. See CLAUDE.md ("Configuration via env" / REDIS_URL).
        self.assertEqual(
            type(caches['default']).__module__, 'django.core.cache.backends.locmem',
        )

    @override_settings(STORAGES=_SMOKE_TEST_STORAGES)
    def test_homepage_renders_and_injects_build_version(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'window.MAHJONG_VERSION', response.content)

    def test_version_endpoint_returns_a_version_key(self):
        response = self.client.get('/api/version/')
        self.assertEqual(response.status_code, 200)
        self.assertIn('version', response.json())

    def test_openapi_docs_only_public_in_debug(self):
        # config/api.py builds the NinjaAPI singleton once at import time
        # from settings.DEBUG, so override_settings can't flip this
        # retroactively — instead assert the two endpoints agree with
        # whatever settings.DEBUG actually is for this test run (True
        # locally via .env, False in CI, where DEBUG now defaults to False).
        expected = 200 if settings.DEBUG else 404
        self.assertEqual(self.client.get('/api/docs').status_code, expected)
        self.assertEqual(self.client.get('/api/openapi.json').status_code, expected)
