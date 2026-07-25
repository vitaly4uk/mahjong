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
from django.conf import settings
from django.contrib import admin
from django.urls import path
from django.views.decorators.cache import cache_control
from django.views.generic import TemplateView

from config.api import api, get_build_version

# no-cache (не «без кешу», а «завжди ревалідуй через ETag/Last-Modified») —
# щоб довго відкритий standalone-застосунок на iOS/macOS отримував свіжий
# HTML щоразу, коли він таки перезавантажується (див. config/api.py: /version/).
home_view = cache_control(no_cache=True, must_revalidate=True)(
    TemplateView.as_view(
        template_name='game.html',
        # debug — щоб шаблон обрав сирі ES-модулі (dev) чи мініфікований bundle.js
        # (prod). Явно, бо context_processors.debug дає debug лише для INTERNAL_IPS.
        extra_context={'version': get_build_version(), 'debug': settings.DEBUG},
    )
)

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', api.urls),
    path('', home_view, name='home'),
]
