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
FROM node:20-slim AS jsbuild
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY assets/ ./assets/
COPY static/game/ ./static/game/
COPY templates/ ./templates/
RUN npx --yes esbuild@0.24.2 static/game/main.js \
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

# -l/--locale scoped to our own catalogs — without it compilemessages also
# walks every installed package's own locale/ (Django itself, etc.), which is
# pointless work (those .mo ship precompiled already) and slows the build.
RUN uv run manage.py compilemessages --locale=uk --locale=en

RUN uv run manage.py collectstatic --noinput

ENV PATH="/app/.venv/bin:$PATH"

CMD ["sh", "-c", "gunicorn config.wsgi:application --bind 0.0.0.0:$PORT"]
