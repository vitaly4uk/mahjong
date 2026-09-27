"""Anonymous player identity — one Django User+Profile per client, resolved/
created before the view is called and available as request.profile (the same
convention as the built-in request.user). Scoped to the /api/game/ prefix —
so we don't spawn anonymous User rows on every hit to /admin/,
/api/background/, or static files.
"""
import uuid

from django.contrib.auth.models import User
from django.http import JsonResponse
from django.urls import Resolver404, resolve
from django.utils.translation import gettext as _

from .models import Profile
from .ratelimit import rate_limited

PLAYER_COOKIE_NAME = 'mahjong_player'
PLAYER_COOKIE_SALT = 'mahjong.player'  # separate namespace for django.core.signing
PLAYER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2  # 2 years
PLAYER_IDENTITY_PATH_PREFIX = '/api/game/'
# A budget on minting brand-new Users/Profiles, not on gameplay itself — a
# returning player with a valid signed cookie is never affected by this.
# Kept generous relative to the per-endpoint quotas in gameplay/api.py
# because a legitimate burst of first-time visitors behind the same IP
# (office/NAT/CGNAT) is normal; an unbounded loop against an unknown or
# unrated path (gameplay/api.py: GET /stats, GET /daily have none of their
# own) is not.
NEW_PROFILE_RATE_LIMIT = 20
NEW_PROFILE_RATE_LIMIT_WINDOW_SECONDS = 60 * 60


class PlayerIdentityMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith(PLAYER_IDENTITY_PATH_PREFIX):
            # Resolve before touching the DB: request.path.startswith alone
            # would mint a User+Profile for ANY subpath, including a typo'd
            # or nonexistent one that 404s right after — an easy unbounded
            # loop for a crawler or a broken client. A returning player (a
            # valid signed cookie) is looked up below regardless — never
            # rate-limited, never re-created; only a first-time visitor on a
            # REAL endpoint reaches the creation quota.
            try:
                resolve(request.path)
            except Resolver404:
                pass
            else:
                existing = self._lookup_profile(request)
                if existing is not None:
                    request.profile = existing
                # The quota gates CREATION itself, checked before any row is
                # written — checking after create() would let an
                # over-quota request still mint the row and only withhold
                # the response, which defeats the point.
                elif rate_limited(
                    request, 'new_profile', NEW_PROFILE_RATE_LIMIT,
                    NEW_PROFILE_RATE_LIMIT_WINDOW_SECONDS,
                ):
                    return JsonResponse(
                        {'detail': _('too many requests, slow down')}, status=429,
                    )
                else:
                    request.profile = self._create_profile()

        response = self.get_response(request)

        profile = getattr(request, 'profile', None)
        if profile is not None:
            current = request.get_signed_cookie(
                PLAYER_COOKIE_NAME, salt=PLAYER_COOKIE_SALT, default=None,
            )
            if current != str(profile.public_id):
                response.set_signed_cookie(
                    PLAYER_COOKIE_NAME, str(profile.public_id), salt=PLAYER_COOKIE_SALT,
                    max_age=PLAYER_COOKIE_MAX_AGE, httponly=True,
                    secure=request.is_secure(), samesite='Lax',
                )
        return response

    @staticmethod
    def _lookup_profile(request):
        """A returning player only, by a valid signed cookie — never creates
        anything, so it's exempt from the new-profile rate limit."""
        public_id = request.get_signed_cookie(
            PLAYER_COOKIE_NAME, salt=PLAYER_COOKIE_SALT, default=None,
        )
        if not public_id:
            return None
        return Profile.objects.select_related('user').filter(public_id=public_id).first()

    @staticmethod
    def _create_profile():
        # create_user(password=None) already sets make_password(None) —
        # an unusable password, no separate set_unusable_password() needed.
        user = User.objects.create_user(username=f'anon-{uuid.uuid4().hex[:12]}')
        return Profile.objects.create(user=user)
