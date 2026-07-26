"""Anonymous player identity — one Django User+Profile per client, resolved/
created before the view is called and available as request.profile (the same
convention as the built-in request.user). Scoped to the /api/game/ prefix —
so we don't spawn anonymous User rows on every hit to /admin/,
/api/background/, or static files.
"""
import uuid

from django.contrib.auth.models import User

from .models import Profile

PLAYER_COOKIE_NAME = 'mahjong_player'
PLAYER_COOKIE_SALT = 'mahjong.player'  # separate namespace for django.core.signing
PLAYER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2  # 2 years
PLAYER_IDENTITY_PATH_PREFIX = '/api/game/'


class PlayerIdentityMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith(PLAYER_IDENTITY_PATH_PREFIX):
            request.profile = self._get_or_create_profile(request)

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
    def _get_or_create_profile(request):
        public_id = request.get_signed_cookie(
            PLAYER_COOKIE_NAME, salt=PLAYER_COOKIE_SALT, default=None,
        )
        profile = (
            Profile.objects.select_related('user').filter(public_id=public_id).first()
            if public_id else None
        )
        if profile is None:
            # create_user(password=None) already sets make_password(None) —
            # an unusable password, no separate set_unusable_password() needed.
            user = User.objects.create_user(username=f'anon-{uuid.uuid4().hex[:12]}')
            profile = Profile.objects.create(user=user)
        return profile
