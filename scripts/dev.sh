#!/usr/bin/env bash
# One-command local dev: Tailwind watcher + esbuild watcher in the
# background, Django runserver in the foreground. Ctrl-C stops all three
# (the trap kills the background watchers when this script exits, however
# it exits).
#
# The esbuild watcher builds the SAME static/game/bundle.js that
# templates/game.html always loads now (no more {% if debug %} raw-module
# path) — unminified + --sourcemap here for readable stack traces/devtools
# breakpoints on the actual source files; the Dockerfile's prod build stays
# minified, no sourcemap, same output filename (never committed — both are
# .gitignore'd build artifacts, just built by a different esbuild
# invocation depending on context).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# `--watch=always`/`--watch=forever` (not plain `--watch`, respectively for
# Tailwind/esbuild) — both CLIs otherwise treat a closed/non-interactive
# stdin (exactly our case here: backgrounded, no TTY) as "stop watching",
# print their startup banner, and exit 0 immediately without building or
# erroring — silently producing no output file at all.
npx @tailwindcss/cli -i assets/tailwind.src.css -o static/game/tailwind.css --watch=always &
TAILWIND_PID=$!

npx --yes esbuild@0.24.2 static/game/main.js \
  --bundle --sourcemap --format=esm --outfile=static/game/bundle.js --watch=forever &
ESBUILD_PID=$!

trap 'kill "$TAILWIND_PID" "$ESBUILD_PID" 2>/dev/null' EXIT

uv run manage.py runserver
