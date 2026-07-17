from unittest.mock import patch

import requests
from django.core.cache import cache
from django.test import TestCase, override_settings

from .api import PEXELS_POOL_CACHE_KEY


class BackgroundApiTests(TestCase):
    def tearDown(self):
        cache.delete(PEXELS_POOL_CACHE_KEY)

    @override_settings(PEXELS_API_KEY='')
    def test_background_without_api_key_returns_null_url(self):
        response = self.client.get('/api/background/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'url': None, 'photographer': None, 'photographer_url': None})

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
