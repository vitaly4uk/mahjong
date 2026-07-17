import random

import requests
from django.conf import settings
from django.core.cache import cache
from django.http import JsonResponse

# Дзен/східні теми для релаксуючого фону гри — узгоджено в дизайні фону.
PEXELS_QUERIES = [
    'zen garden',
    'bamboo',
    'japanese garden',
    'tea ceremony',
    'koi pond',
]

PEXELS_POOL_CACHE_KEY = 'pexels_pool'
PEXELS_POOL_TTL = 60 * 60  # 1 година — щадить ліміт Pexels (200 запитів/год)


def _fetch_pool():
    """Тягне свіжий пул фото з Pexels. Повертає [] за будь-якої помилки."""
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


def background(request):
    """Віддає випадкове фонове фото з Pexels (через кешований пул) або {"url": null}."""
    if not settings.PEXELS_API_KEY:
        return JsonResponse({'url': None})

    pool = cache.get(PEXELS_POOL_CACHE_KEY)
    if not pool:
        pool = _fetch_pool()
        if pool:
            cache.set(PEXELS_POOL_CACHE_KEY, pool, PEXELS_POOL_TTL)

    if not pool:
        return JsonResponse({'url': None})

    return JsonResponse(random.choice(pool))
