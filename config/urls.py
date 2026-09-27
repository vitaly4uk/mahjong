"""
URL configuration for config project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.0/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.shortcuts import render
from django.urls import include, path
from django.views.decorators.cache import cache_control
from django.views.i18n import JavaScriptCatalog

from config.api import api, get_build_version
from gameplay.layouts import list_boards


# A plain function (not TemplateView + extra_context): extra_context is
# evaluated once, at urls.py import time — fine for version/debug (process-
# wide constants), but list_boards() translates board names via the CURRENT
# request's active language (gameplay/layouts.py: gettext(layout.name)),
# which only exists once LocaleMiddleware has run for a real request. Baking
# it into extra_context would freeze every board name in whatever language
# happened to be active at server startup — so boards must be computed here,
# per request.
def home_view(request):
    return render(request, 'game.html', {
        'version': get_build_version(),
        'boards': list_boards(),
    })


# no-cache (not "no caching" but "always revalidate via ETag/Last-Modified") —
# so a long-open standalone app on iOS/macOS gets fresh HTML whenever it does
# reload (see config/api.py: /version/).
home_view = cache_control(no_cache=True, must_revalidate=True)(home_view)

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', api.urls),
    # set_language view (POST target for the in-game language switcher) — sets
    # the django_language cookie, no i18n_patterns/URL prefixes involved.
    path('i18n/', include('django.conf.urls.i18n')),
    # gettext/ngettext/interpolate globals for static/game/main.js (canvas UI
    # text) — see templates/game.html, loaded as a classic <script> before the
    # ES-module bundle so the globals exist by the time it runs. No `packages=`
    # (default None = all available translations) — our djangojs catalog lives
    # in project-level locale/ (LOCALE_PATHS), not inside an app's own locale/.
    path('jsi18n/', JavaScriptCatalog.as_view(), name='javascript-catalog'),
    path('', home_view, name='home'),
]
