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

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project --no-dev

COPY . .
# Свіжозбудований bundle.js кладемо поверх (у git його немає — .gitignore), щоб саме
# він потрапив у collectstatic-маніфест.
COPY --from=jsbuild /app/static/game/bundle.js static/game/bundle.js
RUN uv sync --locked --no-dev

RUN uv run manage.py collectstatic --noinput

ENV PATH="/app/.venv/bin:$PATH"

CMD ["sh", "-c", "gunicorn config.wsgi:application --bind 0.0.0.0:$PORT"]
