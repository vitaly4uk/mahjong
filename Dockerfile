# --- JS/CSS bundle stage ---
# esbuild склеює граф ES-модулів static/game/*.js в один мініфікований bundle.js.
# Живе лише тут (у прод-образ node не тягнеться), локальна розробка вантажить сирі
# модулі напряму — див. templates/game.html ({% if debug %}).
#
# Tailwind (tailwind.src.css → static/game/tailwind.css) збирається тут же —
# на відміну від esbuild, Tailwind v4's `@import "tailwindcss"` резолвиться
# як звичайний Node-пакет (не bare npx: 'tailwindcss' має бути в node_modules,
# звідси package.json/-lock.json + npm ci), і `@source` сканує templates/*.html
# на реальні класи — тому templates/ теж копіюється в цей стейдж.
# assets/tailwind.src.css живе поза static/ — інакше whitenoise's
# collectstatic post-processor (Python-стейдж нижче) намагається
# переписати url()-подібні токени в кожному .css під static/, включно з
# `@import "tailwindcss"` у джерелі, і падає з MissingFileError (задокументована
# пастка WhiteNoise+Tailwind, не власний винахід — те саме радять доки
# django-tailwind-cli).
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
# Свіжозбудовані bundle.js/tailwind.css кладемо поверх (у git їх немає —
# .gitignore), щоб саме вони потрапили у collectstatic-маніфест.
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
