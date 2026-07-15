FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project --no-dev

COPY . .
RUN uv sync --locked --no-dev

RUN uv run manage.py collectstatic --noinput

ENV PATH="/app/.venv/bin:$PATH"

CMD gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8000}
