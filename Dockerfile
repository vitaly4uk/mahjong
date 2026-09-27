# --- JS/CSS bundle stage ---
# esbuild assembles the ES-module graph in static/game/*.js into one
# minified bundle.js. Lives only here (node isn't pulled into the prod
# image); templates/game.html loads that same single bundle.js in both dev
# and prod — dev is just built/watched locally instead (scripts/dev.sh).
#
# Tailwind (tailwind.src.css → static/game/tailwind.css) is built in this
# same stage — unlike esbuild, Tailwind v4's `@import "tailwindcss"`
# resolves as a regular Node package (not bare npx: 'tailwindcss' has to be
# in node_modules, hence package.json/-lock.json + npm ci), and `@source`
# scans templates/*.html for the actual classes used — so templates/ is
# also copied into this stage.
# assets/tailwind.src.css lives outside static/ — otherwise whitenoise's
# collectstatic post-processor (the Python stage below) tries to rewrite
# url()-like tokens in every .css under static/, including
# `@import "tailwindcss"` in the source, and fails with MissingFileError (a
# documented WhiteNoise+Tailwind pitfall, not our own invention — the same
# thing the django-tailwind-cli docs recommend around).
FROM node:24-slim AS jsbuild
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY assets/ ./assets/
COPY static/game/ ./static/game/
COPY templates/ ./templates/
RUN npx --yes esbuild@0.28.2 static/game/main.js \
    --bundle --minify --format=esm --outfile=static/game/bundle.js
RUN npx tailwindcss -i assets/tailwind.src.css \
    -o static/game/tailwind.css --minify

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
# Overlay the freshly built bundle.js/tailwind.css (they aren't in git —
# .gitignore), so it's these that end up in the collectstatic manifest.
COPY --from=jsbuild /app/static/game/bundle.js static/game/bundle.js
COPY --from=jsbuild /app/static/game/tailwind.css static/game/tailwind.css
RUN uv sync --locked --no-dev

# DJANGO_DEBUG=True here only, for this build-time RUN's own process env —
# NOT a Dockerfile ENV, so it never becomes part of the image and can't leak
# into the running container. It exists solely so manage.py's settings
# import succeeds during the build itself (compilemessages/collectstatic
# below need nothing security-sensitive — just a working SECRET_KEY/
# ALLOWED_HOSTS default, which DEBUG mode already provides — config/
# settings.py: `if DEBUG` fallback). dokku doesn't inject the app's real
# config vars (DJANGO_SECRET_KEY etc.) at `docker build` time, only at
# `docker run`, where dokku's own DJANGO_DEBUG=False config
# (DEPLOY.local.md: "Setting env vars on first deploy") overrides whatever
# the image happens to default to — so this has zero effect on the actual
# running app.
#
# --locale only restricts which LANGUAGES are compiled, not which paths are
# walked: compilemessages does its own os.walk(".") looking for every
# directory named locale/, and by this point uv sync has already created
# .venv — without --ignore it also finds and recompiles every installed
# package's own uk/en catalogs (Django's conf/locale, each django.contrib.*),
# which is pointless work AND overwrites their precompiled .mo files.
# --ignore prunes those directories out of the walk before it ever descends
# into them.
RUN DJANGO_DEBUG=True uv run manage.py compilemessages --locale=uk --locale=en \
    --ignore='.venv' --ignore='node_modules' --ignore='staticfiles'

RUN DJANGO_DEBUG=True uv run manage.py collectstatic --noinput

ENV PATH="/app/.venv/bin:$PATH"

CMD ["sh", "-c", "gunicorn config.wsgi:application --bind 0.0.0.0:$PORT"]
