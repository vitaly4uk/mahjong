# --- JS bundle stage ---
# esbuild склеює граф ES-модулів static/game/*.js в один мініфікований bundle.js.
# Живе лише тут (у прод-образ node не тягнеться), локальна розробка вантажить сирі
# модулі напряму — див. templates/game.html ({% if debug %}).
FROM node:20-slim AS jsbuild
WORKDIR /app
COPY static/game/ ./static/game/
RUN npx --yes esbuild@0.24.2 static/game/main.js \
    --bundle --minify --format=esm --outfile=static/game/bundle.js

# --- Python stage ---
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

# gettext (msgfmt) — compiles locale/*.po into .mo below; .mo is a build
# artifact (.gitignore), regenerated on every image build from the committed
# .po sources.
RUN apt-get update && apt-get install -y --no-install-recommends gettext \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project --no-dev

COPY . .
# Свіжозбудований bundle.js кладемо поверх (у git його немає — .gitignore), щоб саме
# він потрапив у collectstatic-маніфест.
COPY --from=jsbuild /app/static/game/bundle.js static/game/bundle.js
RUN uv sync --locked --no-dev

# -l/--locale scoped to our own catalogs — without it compilemessages also
# walks every installed package's own locale/ (Django itself, etc.), which is
# pointless work (those .mo ship precompiled already) and slows the build.
RUN uv run manage.py compilemessages --locale=uk --locale=en

RUN uv run manage.py collectstatic --noinput

ENV PATH="/app/.venv/bin:$PATH"

CMD ["sh", "-c", "gunicorn config.wsgi:application --bind 0.0.0.0:$PORT"]
